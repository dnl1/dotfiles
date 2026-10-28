#!/usr/bin/env python3
"""Apply Pi layers without dropping machine-local packages or runtime state."""
import argparse
import copy
import json
import os
from pathlib import Path
import shutil
import tempfile
import time


def package_key(package, agent_dir):
    source = package if isinstance(package, str) else package["source"]
    if source.startswith("npm:"):
        name = source[4:]
        return "npm:" + (name.rsplit("@", 1)[0] if "@" in name[1:] else name)
    if source.startswith("git:"):
        ref = source.rfind("@")
        return source[:ref] if ref > source.rfind("/") else source
    if source.startswith((".", "/", "~")):
        return str((agent_dir / Path(source).expanduser()).resolve())
    return source


def merge(dst, src, agent_dir):
    for key, value in src.items():
        if key == "packages" and isinstance(value, list):
            controlled = {package_key(p, agent_dir) for p in value}
            dst[key] = copy.deepcopy(value) + [p for p in dst.get(key, []) if package_key(p, agent_dir) not in controlled]
        elif isinstance(value, dict) and isinstance(dst.get(key), dict):
            merge(dst[key], value, agent_dir)
        else:
            dst[key] = copy.deepcopy(value)
    return dst


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        shutil.copy2(path, path.with_name(path.name + f".bak-{time.time_ns()}"))
    fd, temporary = tempfile.mkstemp(prefix=".pi-settings-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, indent=2, ensure_ascii=False)
            output.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply(agent_dir, layers, config_dir=None):
    agent_dir, layers = Path(agent_dir), Path(layers)
    if not (agent_dir / "packages/pi-routing-compat/entry.ts").is_file():
        raise RuntimeError("Build routing-compat before activating the settings layer")
    config_dir = Path(config_dir or os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
    changes = []
    for source, target in (("settings.base.json", agent_dir / "settings.json"),
                           ("claude-bridge.json", agent_dir / "claude-bridge.json"),
                           ("auto-model.json", agent_dir / "auto-model.json"),
                           ("ponytail.json", config_dir / "ponytail/config.json")):
        current = json.loads(target.read_text()) if target.exists() else {}
        value = merge(copy.deepcopy(current), json.loads((layers / source).read_text()), agent_dir)
        if value != current:
            changes.append((target, value))
    for target, value in changes:
        write_json(target, value)
    return [str(path) for path, _ in changes]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("agent_dir", type=Path)
    parser.add_argument("layers", type=Path)
    args = parser.parse_args()
    changed = apply(args.agent_dir, args.layers)
    print("Pi settings: " + (", ".join(changed) if changed else "already current"))
