#!/usr/bin/env python3
"""Build the local compatibility package from pinned, already-installed packages."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

PINS = {"pi-auto-model": "0.9.1", "pi-codex-native": "0.3.13"}
RUNTIME_DEPS = ("partial-json", "proxy-from-env", "undici")
ASSETS = ("package.json", "entry.ts", "dispatch-context.ts", "compat.patch", "patch-manifest.json", "test",
          "README.md", "NOTICE", "LICENSE.pi-auto-model", "LICENSE.pi-codex-native")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(root):
    result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            key = path.relative_to(root).as_posix()
            if path.is_symlink():
                result[key] = "link:" + os.readlink(path)
            elif path.is_file():
                result[key] = digest(path)
    return result


def install(agent_dir, source=None, host_modules=None):
    source = source or Path(__file__).resolve().parent
    agent_dir = Path(agent_dir).resolve()
    npm = agent_dir / "npm/node_modules"
    for name, version in PINS.items():
        path = npm / name / "package.json"
        if not path.is_file() or json.loads(path.read_text())["version"] != version:
            raise RuntimeError(f"Install npm:{name}@{version} before building routing compatibility")
        if any(p.is_symlink() for p in (npm / name).rglob("*")):
            raise RuntimeError(f"Unexpected symlink in upstream package {name}")
    for name in RUNTIME_DEPS:
        if not (npm / name / "package.json").is_file():
            raise RuntimeError(f"Missing installed dependency: {name}")
    manifest = json.loads((source / "patch-manifest.json").read_text())
    for relative, expected in manifest.items():
        parts = Path(relative).parts
        if len(parts) < 3 or parts[0] != "vendor" or parts[1] not in PINS or ".." in parts:
            raise RuntimeError("Invalid patch manifest path")
        if digest(npm.joinpath(*parts[1:])) != expected["original_sha256"]:
            raise RuntimeError(f"Upstream hash mismatch: {relative}")
    if host_modules is None:
        current = agent_dir / "install/current-version"
        if current.is_file():
            version = current.read_text().strip()
            if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", version):
                raise RuntimeError("Invalid managed Pi version")
            if tuple(map(int, version.split('-')[0].split('+')[0].split('.'))) < (1, 4, 0):
                raise RuntimeError("routing-compat requires Pi 1.4.0 or later; run pi update first")
            host_modules = agent_dir / "install/releases" / version / "node_modules"
    if host_modules is not None:
        host_modules = Path(host_modules).resolve()
        host = host_modules / "@earendil-works/pi-coding-agent/package.json"
        if not host.is_file():
            raise RuntimeError("Pi host node_modules is unavailable")
        version = json.loads(host.read_text())["version"]
        if tuple(map(int, version.split('-')[0].split('+')[0].split('.'))) < (1, 4, 0):
            raise RuntimeError("routing-compat requires Pi 1.4.0 or later")
    packages = agent_dir / "packages"
    packages.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".routing-build-", dir=packages))
    destination = packages / "pi-routing-compat"
    backup = None
    try:
        for asset in ASSETS:
            path = source / asset
            if path.is_dir():
                shutil.copytree(path, stage / asset)
            else:
                shutil.copy2(path, stage / asset)
        for name in PINS:
            shutil.copytree(npm / name, stage / "vendor" / name)
        subprocess.run(["patch", "--batch", "--forward", "-p1", "-i", str(source / "compat.patch")],
                       cwd=stage, check=True, capture_output=True, text=True)
        for relative, expected in manifest.items():
            if digest(stage / relative) != expected["patched_sha256"]:
                raise RuntimeError(f"Patched hash mismatch: {relative}")
        modules = stage / "node_modules"
        modules.mkdir()
        for name in RUNTIME_DEPS:
            (modules / name).symlink_to(os.path.relpath(npm / name, modules))
        if host_modules is not None:
            for name in ("@earendil-works", "typebox", "@types"):
                if (host_modules / name).exists():
                    (modules / name).symlink_to(os.path.relpath(host_modules / name, modules))
        (stage / "vendor/pi-xsettings").symlink_to("pi-codex-native/node_modules/@luan.sh/pi-xsettings")
        if destination.is_dir() and not destination.is_symlink() and inventory(stage) == inventory(destination):
            return False
        if destination.exists() or destination.is_symlink():
            backups = agent_dir / "backups"
            backups.mkdir(exist_ok=True)
            backup = backups / f"pi-routing-compat-{time.time_ns()}"
            destination.rename(backup)
        try:
            stage.rename(destination)
        except BaseException:
            if backup is not None:
                backup.rename(destination)
            raise
        return True
    finally:
        if stage.exists():
            shutil.rmtree(stage)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("agent_dir", type=Path)
    parser.add_argument("--host-modules", type=Path)
    args = parser.parse_args()
    print("routing-compat: " + ("rebuilt" if install(args.agent_dir, host_modules=args.host_modules) else "already current"))
