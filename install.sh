#!/usr/bin/env bash
# Dockbase installer for Ubuntu (16.04 and newer) and Debian (9 and newer).
# Older, end-of-life releases are supported on a best-effort basis: the
# installer falls back to old-releases.ubuntu.com and to Docker's APT
# repository when get.docker.com no longer supports the release.
set -Eeuo pipefail

REPO_TARBALL="https://codeload.github.com/sarakmacbook/mysql_vps/tar.gz/refs/heads/main"
INSTALL_DIR="${DOCKBASE_INSTALL_DIR:-/opt/dockbase}"
PANEL_PORT="${PANEL_PORT:-${PORT:-3000}}"
MIN_DOCKER_VERSION="17.03"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
info() { printf '%s\n' "$*"; }

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "Run as root, for example: curl -fsSL https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/install.sh | sudo bash"
[[ -r /etc/os-release ]] || fail 'Cannot identify this Linux distribution.'
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail "This one-command installer currently supports Ubuntu (16.04 and newer) and Debian (9 and newer), detected: ${PRETTY_NAME:-unknown}." ;;
esac
export DEBIAN_FRONTEND=noninteractive

codename="${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}"
if [[ -z "$codename" && -r /etc/lsb-release ]]; then
  codename="$(sed -n 's/^DISTRIB_CODENAME=//p' /etc/lsb-release 2>/dev/null | head -n1)"
fi
if [[ -z "$codename" ]] && command -v lsb_release >/dev/null 2>&1; then
  codename="$(lsb_release -sc 2>/dev/null || true)"
fi

# --- APT helpers (with end-of-life release fallback) --------------------------
apt_update() { apt-get update -qq >/dev/null 2>&1; }
apt_install() { apt-get install -y -qq "$@" >/dev/null 2>&1; }

point_apt_at_old_releases() {
  [[ "${ID:-}" == ubuntu ]] || return 1
  info 'Package lists could not be updated. If this Ubuntu release is past end of life, retrying with old-releases.ubuntu.com...'
  local file
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do
    [[ -f "$file" ]] || continue
    [[ -f "$file.dockbase-backup" ]] || cp -a "$file" "$file.dockbase-backup"
    sed -i -E 's#https?://(archive|security)\.ubuntu\.com(/ubuntu)?#http://old-releases.ubuntu.com/ubuntu#g' "$file" 2>/dev/null || true
  done
  apt_update
}

ensure_apt_works() {
  apt_update && return 0
  point_apt_at_old_releases && return 0
  return 1
}

ensure_tools() {
  local tool missing=()
  for tool in curl tar; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
  (( ${#missing[@]} )) || return 0
  info "Installing required tools: ${missing[*]}..."
  ensure_apt_works || true
  apt_install ca-certificates "${missing[@]}" || true
  for tool in "${missing[@]}"; do
    command -v "$tool" >/dev/null 2>&1 || fail "Could not install $tool with apt. On end-of-life releases, check /etc/apt/sources.list or install $tool manually and retry."
  done
}

# --- Docker helpers -----------------------------------------------------------
start_docker_service() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || systemctl start docker >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    service docker start >/dev/null 2>&1 || true
  fi
}

docker_ready() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }
docker_server_version() { docker version --format '{{.Server.Version}}' 2>/dev/null || true; }

version_ge() {
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

try_convenience_script() {
  info 'Trying the official Docker install script (get.docker.com)...'
  if curl -fsSL --retry 2 --max-time 120 https://get.docker.com -o "$tmp_dir/get-docker.sh" 2>/dev/null \
    && sh "$tmp_dir/get-docker.sh"; then
    start_docker_service
    docker_ready && return 0
  fi
  warn 'get.docker.com could not install Docker on this release. Falling back to Docker'"'"'s APT repository.'
  return 1
}

try_docker_repository() {
  [[ -n "$codename" ]] || { warn 'Could not determine the release codename; skipping the Docker APT repository.'; return 1; }
  info "Installing Docker Engine from download.docker.com ($ID $codename)..."
  ensure_apt_works || { warn 'apt-get update failed; cannot use Docker'"'"'s APT repository.'; return 1; }
  apt_install ca-certificates curl gnupg || apt_install ca-certificates curl gnupg2 || true
  install -m 0755 -d /etc/apt/keyrings
  install -m 0755 -d /etc/apt/sources.list.d
  if ! curl -fsSL --retry 2 --max-time 60 "https://download.docker.com/linux/${ID}/gpg" -o "$tmp_dir/docker.gpg" 2>/dev/null; then
    warn 'Could not download the Docker repository signing key.'
    return 1
  fi
  # Trust the key the modern way (signed-by) when gpg can dearmor it; old releases fall back to apt-key.
  if command -v gpg >/dev/null 2>&1 && gpg --batch --yes --dearmor < "$tmp_dir/docker.gpg" > "$tmp_dir/docker-keyring.gpg" 2>/dev/null; then
    install -m 0644 "$tmp_dir/docker-keyring.gpg" /etc/apt/keyrings/docker.gpg
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/%s %s stable\n' \
      "$(dpkg --print-architecture)" "$ID" "$codename" > /etc/apt/sources.list.d/docker.list
  elif command -v apt-key >/dev/null 2>&1 && apt-key add "$tmp_dir/docker.gpg" >/dev/null 2>&1; then
    printf 'deb [arch=%s] https://download.docker.com/linux/%s %s stable\n' \
      "$(dpkg --print-architecture)" "$ID" "$codename" > /etc/apt/sources.list.d/docker.list
  else
    warn 'Could not trust the Docker repository signing key (gpg/apt-key).'
    return 1
  fi
  if ! apt_update; then
    warn "Docker does not publish packages for $ID $codename anymore."
    rm -f /etc/apt/sources.list.d/docker.list
    return 1
  fi
  if ! apt_install docker-ce docker-ce-cli containerd.io; then
    warn 'Could not install docker-ce from the Docker repository.'
    return 1
  fi
  # Compose v2 is not published for every old release; the panel works without it.
  apt_install docker-compose-plugin || warn 'docker-compose-plugin is unavailable; the panel will be managed directly with docker run.'
  apt_install docker-buildx-plugin || true
  start_docker_service
  # On very old releases the daemon and CLI can start a few seconds apart.
  local attempt
  for attempt in 1 2 3 4 5 6; do
    docker_ready && return 0
    sleep 2
    start_docker_service
  done
  warn 'Docker packages were installed but the daemon did not start. Check "systemctl status docker" or /var/log/upstart/docker.log.'
  return 1
}

try_distro_packages() {
  info 'Installing Docker from the distribution packages (docker.io)...'
  ensure_apt_works || return 1
  apt_install docker.io || return 1
  apt_install docker-compose-v2 || apt_install docker-compose || true
  start_docker_service
  docker_ready && return 0
  warn 'The distribution Docker package installed but the daemon did not start.'
  return 1
}

install_docker() {
  try_convenience_script && return 0
  try_docker_repository && return 0
  try_distro_packages && return 0
  return 1
}

# --- Preflight ----------------------------------------------------------------
ensure_tools

[[ "$PANEL_PORT" =~ ^[0-9]+$ ]] && (( PANEL_PORT >= 1 && PANEL_PORT <= 65535 )) || fail 'PANEL_PORT must be a number between 1 and 65535.'

docker_installed_by_dockbase=0
if ! command -v docker >/dev/null 2>&1; then
  docker_installed_by_dockbase=1
  printf '\nInstalling Docker Engine...\n'
  install_docker || fail "Could not install Docker Engine on ${PRETTY_NAME:-this system}. The distribution's own package (Docker 1.13) is too old for the panel. Install Docker Engine 17.03 or newer from download.docker.com, then run this installer again."
else
  start_docker_service
fi
docker_ready || fail 'Docker is installed but the daemon is unavailable. Start Docker and run this installer again.'

docker_version="$(docker_server_version)"
if [[ -n "$docker_version" ]] && ! version_ge "$docker_version" "$MIN_DOCKER_VERSION"; then
  warn "Docker ${docker_version} is older than ${MIN_DOCKER_VERSION} and cannot run the panel reliably; trying to upgrade it..."
  if try_docker_repository; then
    docker_version="$(docker_server_version)"
  else
    fail "Docker ${docker_version} is too old. Install Docker Engine 17.03 or newer from download.docker.com and run this installer again."
  fi
fi
info "Using Docker ${docker_version:-unknown}."
if [[ -n "$docker_version" ]] && ! version_ge "$docker_version" "20.10"; then
  warn "Docker ${docker_version} is old. Current Docker Hub images may fail to pull on engines this old; if image pulls or the panel build fail, upgrade the operating system and Docker."
fi

# The panel is a single container, so Docker Compose is optional.
panel_method='docker'
if docker compose version >/dev/null 2>&1; then panel_method='compose'; fi

# --- Install files ------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
script_source="${BASH_SOURCE[0]:-}"
script_dir=""
if [[ -n "$script_source" && -f "$script_source" && -f "$(dirname "$script_source")/Dockerfile" ]]; then
  script_dir="$(cd "$(dirname "$script_source")" && pwd -P)"
fi

copy_panel_files() {
  local src="$1" file
  if [[ "$(cd "$src" && pwd -P)" == "$(cd "$INSTALL_DIR" && pwd -P)" ]]; then
    info 'Installer is running from the install directory; reusing files already there.'
    return 0
  fi
  cp -a "$src"/Dockerfile "$src"/compose.yaml "$src"/.dockerignore "$src"/package.json "$src"/server.js "$src"/install.sh "$src"/uninstall.sh "$src"/public "$INSTALL_DIR"/
  # install.py is the Python entry point; tolerate sources predating it.
  for file in install.py; do
    [[ -f "$src/$file" ]] && cp -a "$src/$file" "$INSTALL_DIR"/
  done
}

if [[ -n "$script_dir" ]]; then
  printf '\nInstalling Dockbase from %s...\n' "$script_dir"
  copy_panel_files "$script_dir"
else
  printf '\nDownloading Dockbase...\n'
  curl --fail --location --retry 3 --silent --show-error "$REPO_TARBALL" | tar -xz --strip-components=1 -C "$tmp_dir"
  copy_panel_files "$tmp_dir"
fi
chmod 755 "$INSTALL_DIR/install.sh" "$INSTALL_DIR/uninstall.sh"

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  umask 077
  printf 'PANEL_PORT=%s\n' "$PANEL_PORT" > "$INSTALL_DIR/.env"
else
  chmod 600 "$INSTALL_DIR/.env"
  if ! grep -q '^PANEL_PORT=' "$INSTALL_DIR/.env"; then printf 'PANEL_PORT=%s\n' "$PANEL_PORT" >> "$INSTALL_DIR/.env"; fi
fi
chmod 600 "$INSTALL_DIR/.env"

# --- Build and start ----------------------------------------------------------
if [[ "$panel_method" == compose ]]; then
  printf '\nBuilding and starting the panel with Docker Compose...\n'
  ( cd "$INSTALL_DIR" && docker compose up -d --build )
else
  printf '\nBuilding and starting the panel with docker build + docker run...\n'
  docker build -t dockbase-panel:latest "$INSTALL_DIR"
  docker volume create --label database-panel.managed=true dockbase-panel-config >/dev/null
  docker rm -f dockbase-panel >/dev/null 2>&1 || true
  docker run -d --name dockbase-panel --restart unless-stopped \
    --env-file "$INSTALL_DIR/.env" \
    --publish "${PANEL_PORT}:3000" \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume dockbase-panel-config:/app/state \
    --init --security-opt no-new-privileges:true \
    --label dockbase.managed=true \
    dockbase-panel:latest >/dev/null
fi

umask 077
{
  printf 'DOCKER_INSTALLED_BY_DOCKBASE=%s\n' "$(( docker_installed_by_dockbase ))"
  printf 'PANEL_RUN_METHOD=%s\n' "$panel_method"
  printf 'DOCKER_VERSION=%s\n' "${docker_version:-unknown}"
} > "$INSTALL_DIR/.dockbase-install-state"
if (( docker_installed_by_dockbase )); then
  printf 'Docker was installed by this installer. Use "uninstall.sh --purge-docker" to remove Docker as well.\n'
fi

public_ip="YOUR_SERVER_IP_OR_DOMAIN"
printf '\nDockbase is ready: http://%s:%s\n' "$public_ip" "$PANEL_PORT"
printf 'Open the panel URL and create your access key during first-time setup.\n'
printf 'Keep your key private. The panel can control Docker on this server.\n'
printf 'Restrict database ports to trusted IPs in your VPS firewall.\n'
printf 'Installed at %s\n' "$INSTALL_DIR"
printf 'Panel management: %s\n' "$([[ "$panel_method" == compose ]] && echo 'docker compose' || echo 'docker run (Docker Compose is not installed)')"
printf 'Update with the same command you used to install, or restart with: sudo %s/install.sh\n' "$INSTALL_DIR"
printf 'Uninstall completely (removes all databases and their data) with: sudo %s/uninstall.sh\n' "$INSTALL_DIR"
