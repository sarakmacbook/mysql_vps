#!/usr/bin/env bash
# Dockbase uninstaller: removes the panel, every database container and data
# volume it created, its files, and (optionally) Docker Engine itself.
set -Eeuo pipefail

INSTALL_DIR="${DOCKBASE_INSTALL_DIR:-/opt/dockbase}"
STATE_FILE_NAME=".dockbase-install-state"
PANEL_CONTAINER="dockbase-panel"
PANEL_IMAGE="dockbase-panel:latest"
DB_IMAGES=(mysql:8.4 postgres:17-alpine mariadb:11 mongo:8 redis:7-alpine)

ASSUME_YES=0
PURGE_DOCKER=0
KEEP_DOCKER=0
FORCE=0
ORIGINAL_ARGS=("$@")

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
info() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
Dockbase uninstaller: permanently removes Dockbase and every database it created.

Usage: uninstall.sh [options]

Options:
  -y, --yes             Do not ask for confirmation (required without a terminal).
      --purge-docker    Also remove Docker Engine and everything in /var/lib/docker.
      --keep-docker     Leave Docker installed, even if this installer added it.
  -d, --install-dir P   Directory to erase (default: /opt/dockbase).
      --force           Skip the "this does not look like Dockbase" safety check.
  -h, --help            Show this help.

Environment:
  DOCKBASE_INSTALL_DIR  Same as --install-dir.

Examples:
  curl -fsSL https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/uninstall.sh | sudo bash
  sudo /opt/dockbase/uninstall.sh
  sudo /opt/dockbase/uninstall.sh --yes --purge-docker
EOF
}

while (( $# )); do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    --purge-docker) PURGE_DOCKER=1 ;;
    --keep-docker) KEEP_DOCKER=1 ;;
    --force) FORCE=1 ;;
    -d|--install-dir)
      (( $# >= 2 )) || fail '--install-dir requires a path.'
      INSTALL_DIR="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1 (use --help)" ;;
  esac
  shift
done
(( PURGE_DOCKER && KEEP_DOCKER )) && fail '--purge-docker and --keep-docker cannot be combined.'
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'Run as root, for example: curl -fsSL https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/uninstall.sh | sudo bash'

if command -v realpath >/dev/null 2>&1; then
  install_dir_real="$(realpath -m -- "$INSTALL_DIR")"
elif command -v readlink >/dev/null 2>&1; then
  install_dir_real="$(readlink -m -- "$INSTALL_DIR")"
else
  install_dir_real="$INSTALL_DIR"
fi
[[ "$install_dir_real" == /* ]] || fail "Install directory must be an absolute path (got: $INSTALL_DIR)."
case "$install_dir_real" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib32|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/var/lib|/var/www)
    fail "Refusing to delete $install_dir_real. Point --install-dir at the Dockbase directory." ;;
esac

# Never run from inside the directory we are about to delete: copy ourselves out first.
script_source="${BASH_SOURCE[0]:-}"
if [[ -n "$script_source" && -f "$script_source" && "${DOCKBASE_UNINSTALL_RELOCATED:-0}" != 1 ]]; then
  script_dir="$(cd -- "$(dirname -- "$script_source")" && pwd -P)"
  case "$script_dir/" in
    "$install_dir_real"/*)
      relocated="$(mktemp "${TMPDIR:-/tmp}/dockbase-uninstall.XXXXXX")"
      cp -- "$script_source" "$relocated"
      printf 'Re-launching the uninstaller from %s.\n' "$relocated"
      DOCKBASE_UNINSTALL_RELOCATED=1 exec bash "$relocated" "${ORIGINAL_ARGS[@]}"
      ;;
  esac
fi
cd /

looks_like_dockbase=0
for marker in compose.yaml Dockerfile server.js package.json; do
  if [[ -e "$install_dir_real/$marker" ]]; then looks_like_dockbase=1; break; fi
done
if [[ -d "$install_dir_real" ]] && (( ! looks_like_dockbase && ! FORCE )); then
  fail "$install_dir_real does not look like a Dockbase install (no compose.yaml or server.js). Use --force if you are sure."
fi

docker_installed_by_dockbase=0
if [[ -r "$install_dir_real/$STATE_FILE_NAME" ]] && grep -q '^DOCKER_INSTALLED_BY_DOCKBASE=1$' "$install_dir_real/$STATE_FILE_NAME" 2>/dev/null; then
  docker_installed_by_dockbase=1
fi

have_tty=0
if { : < /dev/tty; } 2>/dev/null; then have_tty=1; fi

prompt_yes_no() {
  local prompt="$1" reply=''
  (( have_tty )) || return 1
  printf '%s [y/N] ' "$prompt" > /dev/tty || return 1
  IFS= read -r reply < /dev/tty || return 1
  [[ "$reply" == [yY] || "$reply" == [yY][eE][sS] ]]
}

# --- Discover what Dockbase left behind ---------------------------------------
docker_ready=0
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    docker_ready=1
  elif command -v systemctl >/dev/null 2>&1 && systemctl start docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker_ready=1
  else
    warn 'Docker is installed but the daemon is not reachable; container and volume cleanup will be skipped.'
  fi
fi

managed_containers=()
managed_names=()
volumes=()
panel_present=0

add_volume() { local existing; for existing in "${volumes[@]}"; do [[ "$existing" == "$1" ]] && return 0; done; volumes+=("$1"); }

if (( docker_ready )); then
  mapfile -t managed_containers < <(docker ps -aq --filter label=database-panel.managed=true 2>/dev/null || true)
  mapfile -t managed_names < <(docker ps -a --filter label=database-panel.managed=true --format '{{.Names}}' 2>/dev/null || true)
  for container in "${managed_containers[@]}"; do
    while IFS= read -r volume; do
      [[ -n "$volume" ]] && add_volume "$volume"
    done < <(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' "$container" 2>/dev/null || true)
  done
  # Volumes carry the managed label too, so data left behind by removed containers is found as well.
  while IFS= read -r volume; do
    [[ -n "$volume" ]] && add_volume "$volume"
  done < <(docker volume ls -q --filter label=database-panel.managed=true 2>/dev/null || true)
  if docker inspect "$PANEL_CONTAINER" >/dev/null 2>&1; then
    panel_present=1
  else
    # Installs without Docker Compose start the panel with `docker run --label dockbase.managed=true`.
    panel_labeled="$(docker ps -aq --filter label=dockbase.managed=true 2>/dev/null | head -n1 || true)"
    if [[ -n "$panel_labeled" ]]; then
      panel_present=1
      PANEL_CONTAINER="$panel_labeled"
    fi
  fi
fi

panel_image_present=0
if (( docker_ready )) && docker image inspect "$PANEL_IMAGE" >/dev/null 2>&1; then panel_image_present=1; fi

nothing_to_do=1
(( panel_present || panel_image_present )) && nothing_to_do=0
(( ${#managed_containers[@]} )) && nothing_to_do=0
(( ${#volumes[@]} )) && nothing_to_do=0
[[ -e "$install_dir_real" ]] && nothing_to_do=0

info ''
info 'Dockbase uninstaller'
info '===================='
info ''
if (( nothing_to_do )); then
  info 'No Dockbase installation, containers, or volumes were found. Nothing to remove.'
  exit 0
fi

info 'This will permanently erase:'
(( panel_present || panel_image_present )) && info "  - the Dockbase panel container and image ($PANEL_IMAGE)"
if (( ${#managed_containers[@]} )); then
  info "  - ${#managed_containers[@]} database container(s): ${managed_names[*]}"
fi
if (( ${#volumes[@]} )); then
  info "  - ${#volumes[@]} data volume(s), including all database data: ${volumes[*]}"
fi
[[ -e "$install_dir_real" ]] && info "  - the installation directory $install_dir_real (including the panel access key)"
info ''
info 'This cannot be undone.'

if (( ASSUME_YES )); then
  :
elif (( have_tty )); then
  prompt_yes_no 'Erase Dockbase and all of its database data now?' || { info 'Aborted. Nothing was changed.'; exit 0; }
else
  fail 'No terminal available for confirmation. Re-run with --yes to erase Dockbase non-interactively.'
fi

# --- Remove containers, volumes, and images -----------------------------------
if (( docker_ready )); then
  if [[ -f "$install_dir_real/compose.yaml" ]] && docker compose version >/dev/null 2>&1; then
    if ( cd "$install_dir_real" && docker compose down --remove-orphans ); then
      info 'Stopped the panel compose project.'
    else
      warn 'docker compose down reported an error; continuing.'
    fi
  fi

  if (( panel_present )); then
    docker rm -f "$PANEL_CONTAINER" >/dev/null 2>&1 && info "Removed container $PANEL_CONTAINER." || warn "Could not remove container $PANEL_CONTAINER."
  fi

  if (( ${#managed_containers[@]} )); then
    if docker rm -f "${managed_containers[@]}" >/dev/null 2>&1; then
      info "Removed ${#managed_containers[@]} database container(s)."
    else
      warn 'Some database containers could not be removed.'
    fi
  fi

  if (( ${#volumes[@]} )); then
    removed_volumes=0
    for volume in "${volumes[@]}"; do
      if docker volume rm "$volume" >/dev/null 2>&1; then removed_volumes=$((removed_volumes + 1)); else warn "Could not remove volume $volume (still in use?)."; fi
    done
    info "Removed $removed_volumes of ${#volumes[@]} data volume(s)."
  fi

  if (( panel_image_present )); then
    docker image rm "$PANEL_IMAGE" >/dev/null 2>&1 && info "Removed image $PANEL_IMAGE." || warn "Could not remove image $PANEL_IMAGE."
  fi

  removed_images=0
  for image in "${DB_IMAGES[@]}"; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      if docker image rm "$image" >/dev/null 2>&1; then removed_images=$((removed_images + 1)); fi
    fi
  done
  (( removed_images )) && info "Removed $removed_images cached database image(s)."
else
  info 'Skipped container and volume cleanup because Docker is unavailable.'
fi

# --- Remove installation files ------------------------------------------------
if [[ -e "$install_dir_real" ]]; then
  rm -rf --one-file-system -- "$install_dir_real" || fail "Could not delete $install_dir_real. Remove it manually."
  info "Deleted $install_dir_real."
fi

# --- Optionally remove Docker Engine ------------------------------------------
remove_docker() {
  local pkg
  local installed=()
  if ! command -v docker >/dev/null 2>&1 && [[ ! -d /var/lib/docker ]]; then
    info 'Docker is not installed; nothing to remove.'
    return 0
  fi
  info ''
  info 'Removing Docker Engine and all remaining Docker data...'
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now docker.service docker.socket containerd.service >/dev/null 2>&1 || true
  fi
  if command -v dpkg-query >/dev/null 2>&1; then
    for pkg in docker-ce docker-ce-cli docker-ce-rootless-extras docker-buildx-plugin docker-compose-plugin docker-compose-v2 containerd.io docker.io docker-doc podman-docker; do
      if dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null | grep -qx 'installed'; then installed+=("$pkg"); fi
    done
  fi
  if (( ${#installed[@]} )); then
    apt-get purge -y "${installed[@]}" >/dev/null 2>&1 || warn 'Some Docker packages could not be purged; finish manually with apt-get purge docker-ce docker-ce-cli containerd.io.'
    apt-get autoremove --purge -y >/dev/null 2>&1 || true
  else
    warn 'No Docker packages found with dpkg; remove Docker manually if it was installed another way.'
  fi
  rm -rf /var/lib/docker /var/lib/containerd /etc/docker /run/docker.sock /var/run/docker.sock
  rm -f /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/docker.sources \
        /etc/apt/keyrings/docker.asc /etc/apt/keyrings/docker.gpg /usr/share/keyrings/docker-archive-keyring.gpg
  groupdel docker >/dev/null 2>&1 || true
  hash -r
  if command -v docker >/dev/null 2>&1; then
    warn 'The docker command is still on PATH; remove it manually.'
  else
    info 'Docker Engine removed.'
  fi
}

if (( PURGE_DOCKER )); then
  remove_docker
elif (( KEEP_DOCKER )); then
  info ''
  info 'Docker was left installed.'
elif (( docker_installed_by_dockbase )) && command -v docker >/dev/null 2>&1; then
  info ''
  if prompt_yes_no 'This installer added Docker Engine. Remove Docker too? This deletes EVERY container, image, and volume on this server, not only Dockbase.'; then
    remove_docker
  else
    info 'Docker was left installed.'
  fi
else
  info ''
  info 'Docker was left installed (use --purge-docker if you want it removed too).'
fi

info ''
info 'Dockbase has been uninstalled.'
if [[ -n "$script_source" && -f "$script_source" && "${DOCKBASE_UNINSTALL_RELOCATED:-0}" = 1 ]]; then
  rm -f -- "$script_source"
fi
