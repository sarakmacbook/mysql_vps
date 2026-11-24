# Security policy

Dockbase is a privileged control panel: it talks to the host Docker daemon and can create and remove containers. Treat any deployment of it as security-sensitive infrastructure.

## Reporting a vulnerability

Please do not open a public issue for security problems. Instead, use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability) or contact the maintainer listed on the repository page. Include a description, reproduction steps, and the version/commit you tested.

## Deployment guidance (current best practice)

- Put the panel behind HTTPS (reverse proxy or VPN); never expose it on plain HTTP.
- Keep the panel behind a trusted network; the access key is the only thing standing between a visitor and Docker control.
- Restrict the database ports the panel publishes with your VPS firewall to trusted IPs only.
- Use a strong `PANEL_TOKEN` or the first-run setup key (minimum 16 characters, stored scrypt-hashed with mode `0600`).
- Restart and rotate the panel key if it is ever leaked; the volume data survives only in `dockbase-panel-config`.

## Scope

In scope: the panel server (`server.js`), the web UI (`public/`), the installer scripts, and the Docker configuration. Out of scope: the database engines themselves (report those upstream), and deployments that ignored the guidance above.
