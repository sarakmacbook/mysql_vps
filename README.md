# Dockbase — self-hosted database panel

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

## One-command VPS install

On a fresh **Ubuntu or Debian** VPS, run this as a single command to install Docker Engine if needed, download Dockbase, build the panel container, and start it:

```sh
curl -fsSL https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/install.sh | sudo bash
```

If you already have this repository checked out on the VPS, run `sudo ./install.sh` from its directory instead.

The installer prints the panel URL and a randomly generated access key when it finishes. Save the key, open the URL, and sign in. To choose another port, pass `PANEL_PORT` through sudo:

```sh
curl -fsSL https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/install.sh | sudo PANEL_PORT=8080 bash
```

The install directory is `/opt/dockbase`. Update it with `cd /opt/dockbase && sudo docker compose up -d --build`; stop it with `sudo docker compose down`. The container mounts `/var/run/docker.sock` so it can provision database containers on the host.

## Complete uninstall

`uninstall.sh` reverses the installer and **permanently erases every database and all of its data**:

```sh
sudo /opt/dockbase/uninstall.sh
```

It asks for confirmation, then removes the panel container and image, all database containers created by the panel, their data volumes, cached database images, and the `/opt/dockbase` directory (including the access key). Run it straight from GitHub if the directory is already gone:

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

For local development, install Node.js 20+ and Docker Engine, then run `npm start`. Open `http://YOUR_SERVER:3000`. On first startup the server prints a **panel access key** to its terminal. To set one manually, use `PANEL_TOKEN='use-a-long-random-secret-here' PORT=3000 npm start`.

The panel is privileged: it controls Docker and can create or remove containers. Put it behind HTTPS and a trusted network/reverse proxy, and keep the panel key private.

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
