#!/usr/bin/env python3
"""Python one-command entry point for Dockbase's supported Linux installer.

The actual host setup remains in install.sh so the Python and shell commands
share the same Docker installation, OS compatibility, and upgrade behavior.
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

INSTALLER_URL = "https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/install.sh"


def fetch_installer(destination: Path) -> None:
    try:
        with urlopen(INSTALLER_URL, timeout=30) as response, destination.open("wb") as installer:
            shutil.copyfileobj(response, installer)
    except (OSError, URLError) as exc:
        raise RuntimeError("Could not download the Dockbase installer: {}".format(exc)) from exc
    destination.chmod(0o700)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install or update Dockbase on a Docker-enabled Ubuntu or Debian VPS."
    )
    parser.add_argument("--port", type=int, help="Web panel port (default: 3000)")
    parser.add_argument(
        "--install-dir",
        help="Installation directory (default: /opt/dockbase)",
    )
    args = parser.parse_args()

    if platform.system() != "Linux":
        parser.error("This installer runs on a Linux VPS (Ubuntu or Debian), not Railway/Render.")
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        parser.error("Run as root, for example: curl -fsSL https://raw.githubusercontent.com/sarakmacbook/mysql_vps/main/install.py | sudo python3 -")
    if args.port is not None and not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")

    env = os.environ.copy()
    if args.port is not None:
        env["PANEL_PORT"] = str(args.port)
    if args.install_dir:
        env["DOCKBASE_INSTALL_DIR"] = args.install_dir

    local_installer = Path(__file__).resolve().with_name("install.sh")
    temporary_directory = None
    if local_installer.is_file():
        installer_path = local_installer
    else:
        temporary_directory = tempfile.TemporaryDirectory(prefix="dockbase-installer-")
        installer_path = Path(temporary_directory.name) / "install.sh"
        try:
            fetch_installer(installer_path)
        except RuntimeError as exc:
            print("ERROR: {}".format(exc), file=sys.stderr)
            temporary_directory.cleanup()
            return 1

    print("Starting Dockbase's Ubuntu/Debian VPS installer...", flush=True)
    try:
        return subprocess.run(["bash", str(installer_path)], env=env, check=False).returncode
    except FileNotFoundError:
        print("ERROR: bash is required to run the Linux installer.", file=sys.stderr)
        return 1
    finally:
        if temporary_directory is not None:
            temporary_directory.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
