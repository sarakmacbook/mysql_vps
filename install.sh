#!/usr/bin/env bash
set -Eeuo pipefail

REPO_TARBALL="https://codeload.github.com/sarakmacbook/mysql_vps/tar.gz/refs/heads/main"
INSTALL_DIR="${DOCKBASE_INSTALL_DIR:-/opt/dockbase}"
PANEL_PORT="${PANEL_PORT:-${PORT:-3000}}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "Run as root, for example: curl -fsSL https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/install.sh | sudo bash"

if [[ ! -r /etc/os-release ]]; then fail 'Cannot identify this Linux distribution.'; fi
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail "This one-command installer currently supports Ubuntu and Debian (detected: ${PRETTY_NAME:-unknown})." ;;
esac

export DEBIAN_FRONTEND=noninteractive
if ! command -v curl >/dev/null || ! command -v tar >/dev/null; then
  apt-get update -y
  apt-get install -y curl ca-certificates tar
fi

docker_was_present=1
if ! command -v docker >/dev/null; then
  docker_was_present=0
  printf '\nInstalling Docker Engine...\n'
  curl -fsSL https://get.docker.com | sh
fi
if command -v systemctl >/dev/null; then systemctl enable --now docker || true; fi
docker info >/dev/null 2>&1 || fail 'Docker is installed but the daemon is unavailable. Start Docker and run this installer again.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required. Install the docker-compose-plugin package and retry.'

[[ "$PANEL_PORT" =~ ^[0-9]+$ ]] && (( PANEL_PORT >= 1 && PANEL_PORT <= 65535 )) || fail 'PANEL_PORT must be a number between 1 and 65535.'
mkdir -p "$INSTALL_DIR"
script_source="${BASH_SOURCE[0]:-}"
script_dir=""
if [[ -n "$script_source" && -f "$(dirname "$script_source")/Dockerfile" ]]; then
  script_dir="$(cd "$(dirname "$script_source")" && pwd)"
fi
if [[ -n "$script_dir" ]]; then
  printf '\nInstalling Dockbase from %s...\n' "$script_dir"
  cp -a "$script_dir"/Dockerfile "$script_dir"/compose.yaml "$script_dir"/.dockerignore "$script_dir"/package.json "$script_dir"/server.js "$script_dir"/uninstall.sh "$script_dir"/public "$INSTALL_DIR"/
else
  printf '\nDownloading Dockbase...\n'
  tmp_extract="$(mktemp -d)"
  trap 'rm -rf "$tmp_extract"' EXIT
  curl --fail --location --retry 3 --silent --show-error "$REPO_TARBALL" | tar -xz --strip-components=1 -C "$tmp_extract"
  cp -a "$tmp_extract"/Dockerfile "$tmp_extract"/compose.yaml "$tmp_extract"/.dockerignore "$tmp_extract"/package.json "$tmp_extract"/server.js "$tmp_extract"/uninstall.sh "$tmp_extract"/public "$INSTALL_DIR"/
  rm -rf "$tmp_extract"
fi
chmod 755 "$INSTALL_DIR/uninstall.sh"
printf 'DOCKER_INSTALLED_BY_DOCKBASE=%s\n' "$(( 1 - docker_was_present ))" > "$INSTALL_DIR/.dockbase-install-state"
if (( docker_was_present == 0 )); then
  printf 'Docker was installed by this installer. Use "uninstall.sh --purge-docker" to remove Docker as well.\n'
fi

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  if command -v openssl >/dev/null; then
    token="$(openssl rand -hex 32)"
  else
    token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  fi
  umask 077
  printf 'PANEL_TOKEN=%s\nPANEL_PORT=%s\n' "$token" "$PANEL_PORT" > "$INSTALL_DIR/.env"
else
  chmod 600 "$INSTALL_DIR/.env"
  if ! grep -q '^PANEL_PORT=' "$INSTALL_DIR/.env"; then printf 'PANEL_PORT=%s\n' "$PANEL_PORT" >> "$INSTALL_DIR/.env"; fi
fi
chmod 600 "$INSTALL_DIR/.env"

printf '\nBuilding and starting the panel...\n'
cd "$INSTALL_DIR"
docker compose up -d --build

public_ip="YOUR_SERVER_IP_OR_DOMAIN"
printf '\nDockbase is ready: http://%s:%s\n' "$public_ip" "$PANEL_PORT"
printf 'Panel access key: '
sed -n 's/^PANEL_TOKEN=//p' "$INSTALL_DIR/.env"
printf '\nKeep this key private. The panel can control Docker on this server.\n'
printf 'Restrict database ports to trusted IPs in your VPS firewall.\n'
printf 'Installed at %s\n' "$INSTALL_DIR"
printf 'Uninstall completely (removes all databases and their data) with: sudo %s/uninstall.sh\n' "$INSTALL_DIR"
