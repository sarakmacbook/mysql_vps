# Dockbase — self-hosted database panel

## One-command VPS install

Install Dockbase on a fresh Ubuntu or Debian VPS with this command:

```sh
curl -fsSL https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/install.py | sudo python3 -
```

The installer sets up Docker if needed, installs and starts the panel, then prints its URL. Open `http://YOUR_SERVER_IP:3000` and create your access key. To choose a different port, add `--port 8080` after the `-`.

A small web control panel for launching common database engines as persistent Docker containers. Select an engine, set the container/database/username/port/host, and deploy. The panel generates strong passwords and displays a ready-to-copy connection URL, for example:

```text
mysql://user:password@db-host:3306/p2p
```

## Supported engines

| Engine | Image | Default port | Connection URL |
| --- | --- | ---: | --- |
| MySQL | `mysql:8.4` | 3306 | `mysql://user:password@host:3306/database` |
| PostgreSQL | `postgres:17-alpine` | 5432 | `postgresql://user:password@host:5432/database` |
| MariaDB | `mariadb:11` | 3306 | `mysql://user:password@host:3306/database` |
| MongoDB | `mongo:8` | 27017 | `mongodb://user:password@host:27017/database?authSource=admin` |
| Redis | `redis:7-alpine` | 6379 | `redis://:password@host:6379/0` |

Each database gets a named Docker volume and `unless-stopped` restart policy. The volume is labeled `database-panel.managed=true`. Removing a container from the panel deliberately keeps its volume and data; `uninstall.sh` erases both.

## VPS installer details

The command above supports **Ubuntu 16.04 or newer** and **Debian 9 or newer**. It installs Docker Engine if needed, downloads Dockbase, builds the panel container, and starts it:

```sh
curl -fsSL https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/install.py | sudo python3 -
```

Python 3's standard library is sufficient; no pip packages are required. The Python entry point runs the same Linux installer, preserving its Docker setup and OS compatibility behavior. To choose a different port or install directory, pass options after `-`:

```sh
curl -fsSL https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/install.py | sudo python3 - --port 8080 --install-dir /opt/dockbase
```

The shell installer remains available as an alternative:

```sh
curl -fsSL https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/install.sh | sudo bash
```

If you already have this repository checked out on the VPS, run `sudo python3 install.py` from its directory. This installs on an Ubuntu/Debian VPS. **It does not install Docker inside Railway or Render**; those platforms do not expose the Docker socket this panel needs.

The installer prints the panel URL when it finishes. Open it on a trusted network and create your access key in the first-run setup screen. Setup is available only until the first key is created, and the key verifier is saved in a persistent Docker volume. If you selected port `8080`, open `http://YOUR_SERVER_IP:8080`.

The install directory is `/opt/dockbase`. Re-running the installer updates and restarts the panel: `sudo python3 /opt/dockbase/install.py` (or `sudo /opt/dockbase/install.sh`). With Docker Compose it uses `docker compose up -d --build`; on hosts without Compose v2 (common on Ubuntu 16.04) it falls back to `docker build` + `docker run`, so nothing extra is required. The container mounts `/var/run/docker.sock` so it can provision database containers on the host.

If the installer stops with a Docker daemon error such as `connect: no such file or directory` for `/var/run/docker.sock`, Docker is not running. Start it with `sudo systemctl start docker` (or `sudo service docker start`), confirm `sudo docker info` succeeds, then run the install command again.

Existing installs keep their configured `PANEL_TOKEN` for compatibility. If you no longer have that key and want to use first-run setup instead, remove the `PANEL_TOKEN=...` line from `/opt/dockbase/.env` and rerun the installer. Only do this while the panel is reachable by trusted users; the first visitor to setup can claim the panel.

### Older releases (Ubuntu 16.04, 20.04; Debian 9/10)

The installer adapts to end-of-life and older releases:

- **Docker:** it first tries the official `get.docker.com` script. If that refuses the release, it adds Docker's APT repository for the release codename and installs `docker-ce`; if Docker publishes no packages for that codename any more, it falls back to the distribution's `docker.io` package. Existing Docker older than 17.03 is upgraded when possible.
- **APT:** if `apt-get update` fails (expired release files), Ubuntu sources are switched to `old-releases.ubuntu.com`, with a `*.dockbase-backup` copy of each file kept next to it.
- **No Compose needed:** the panel is a single container. Compose v2 is used when present and skipped otherwise.
- **Old Docker:** volumes are labeled with `docker volume create --label` (available since Docker 1.13) instead of the `--mount ...,volume-label=` option (Docker 18.09+), so the complete uninstall works on old engines too. Engine 1.13 (the default `docker.io` on 16.04) still cannot run the panel; the installer then asks you to install a newer Docker.

Ubuntu 16.04 and 20.04 standard support has ended, so treat these paths as best-effort, not a guarantee of upstream package availability. The main limit is Docker itself: Ubuntu 16.04's newest available engine is 19.03, and Docker Hub now publishes many official images only as OCI indexes, which very old engines may refuse to pull. If image pulls or the panel build fail on 16.04, the practical fix is to upgrade the operating system.

## Complete uninstall

`uninstall.sh` reverses the installer and **permanently erases every database and all of its data**:

```sh
sudo /opt/dockbase/uninstall.sh
```

It asks for confirmation, then removes the panel container and image (found by name or its `dockbase.managed` label, so both the Compose and `docker run` install paths are covered), all database containers created by the panel, their data volumes, cached database images, and the `/opt/dockbase` directory (including the access key). Run it straight from GitHub if the directory is already gone:

```sh
curl -fsSL https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/uninstall.sh | sudo bash
```

Options:

| Option | Effect |
| --- | --- |
| `-y`, `--yes` | Skip the confirmation prompt (required when stdin is not a terminal) |
| `--purge-docker` | Also remove Docker Engine and `/var/lib/docker` — every other container, image, and volume on the server is destroyed |
| `--keep-docker` | Never ask about Docker, even if the installer originally added it |
| `-d DIR`, `--install-dir DIR` | Uninstall from a directory other than `/opt/dockbase` |
| `--force` | Skip the safety check that the directory looks like Dockbase |

Docker is only offered for removal when `install.sh` installed it. If Docker and the `/var/lib/docker` directory are removed, the panel is gone along with all of its data; anything else on the server that relied on Docker is erased too, so take backups first.

For local development, install Node.js 20+ and Docker Engine, then run `npm start`. Open `http://YOUR_SERVER:3000` and create an access key in the first-run setup screen. The key must be at least 16 characters; its verifier is saved under `state/` (ignored by Git). To skip setup and configure a key manually, use `PANEL_TOKEN='use-a-long-random-secret-here' PORT=3000 npm start`.

The panel is privileged: it controls Docker and can create or remove containers. Put it behind HTTPS and a trusted network/reverse proxy, and keep the panel key private. During first-run setup, restrict access to a trusted network so an unintended visitor cannot claim the initial setup.

## Railway and Render

This repository includes a Railway Dockerfile configuration (`railway.json`) and a Render Blueprint (`render.yaml`). Both use `/api/health` as the service health check. To deploy the panel UI, import this repository into Railway or Render and provide a strong `PANEL_TOKEN` (Render generates one from the Blueprint; set one in Railway's service variables). Open the service URL and sign in with that key. The PostgreSQL engine is already listed in the database catalog.

**Important limitation:** Railway and Render web services do not provide the host Docker daemon/socket that this panel requires to launch database containers. The panel UI can run there, but its Deploy and installation-management actions will report that Docker is unavailable. These manifests are suitable for viewing the UI/catalog, not for operating the panel. For a fully functional panel, install it on a Docker-enabled VPS using the installer above.

If you want a managed PostgreSQL database on Railway or Render, create a PostgreSQL service using that platform's dashboard instead. That database is managed by the platform and is separate from this panel; this app does not provision or display a managed service's connection details. Keep database credentials private and use the platform's private/internal connection URL where possible.

## Network and data notes

- Database ports are published on all host interfaces so clients can connect using the displayed host and port. **Restrict these ports with your VPS firewall** to only trusted IP addresses; do not expose database ports openly to the internet.
- The host field changes the connection URL shown in the UI; it does not configure DNS or the firewall. Enter the IP address or DNS name clients should use.
- Generated connection URLs are shown immediately after install and kept in the current browser tab’s session storage for convenience. They are not saved by this panel on the server. Copy and store them securely.
- Credentials are applied as Docker environment variables during initialization. For MySQL/MariaDB the application user gets the displayed password, while the database root user gets a separate random password that is not shown.
- Persisted data lives in named Docker volumes (`<container-name>-data`) labeled `database-panel.managed=true`. Back up those volumes using your normal Docker backup procedure.

## Tests

```sh
npm test
```
