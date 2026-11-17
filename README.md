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

Each database gets a named Docker volume and `unless-stopped` restart policy. Removing a container from the panel deliberately keeps its volume and data.

## Start the panel

Requirements: Node.js 20+ and a working Docker Engine, with permission for the Node process to use Docker.

```sh
npm start
```

Open `http://YOUR_SERVER:3000`. On first startup the server prints a **panel access key** to its terminal. Save it and enter it in the sign-in screen. To use a stable key across restarts, set it before launching:

```sh
PANEL_TOKEN='use-a-long-random-secret-here' PORT=3000 npm start
```

The panel binds to `0.0.0.0`. Treat access to it as privileged: it controls Docker and can create or remove containers. Put it behind HTTPS and a trusted network/reverse proxy, and keep the panel key private.

## Network and data notes

- Database ports are published on all host interfaces so clients can connect using the displayed host and port. **Restrict these ports with your VPS firewall** to only trusted IP addresses; do not expose database ports openly to the internet.
- The host field changes the connection URL shown in the UI; it does not configure DNS or the firewall. Enter the IP address or DNS name clients should use.
- Generated connection URLs are shown immediately after install and kept in the current browser tab’s session storage for convenience. They are not saved by this panel on the server. Copy and store them securely.
- Credentials are applied as Docker environment variables during initialization. For MySQL/MariaDB the application user gets the displayed password, while the database root user gets a separate random password that is not shown.
- Persisted data lives in named Docker volumes (`<container-name>-data`). Back up those volumes using your normal Docker backup procedure.

## Tests

```sh
npm test
```
