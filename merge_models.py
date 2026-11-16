#!/usr/bin/env python3
"""Merge this repository's models.json into an existing pi models.json.

Existing providers, API keys, and other local settings win; missing providers
and new models are added. The destination is backed up before an atomic write.
"""
import copy
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path


def fail(message: str) -> None:
    print(f"merge_models.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def deep_merge(base, overlay):
    """Return base with overlay winning, recursively. Model lists merge by id."""
    if isinstance(base, dict) and isinstance(overlay, dict):
        result = copy.deepcopy(base)
        for key, value in overlay.items():
            result[key] = deep_merge(result[key], value) if key in result else copy.deepcopy(value)
        return result

    if isinstance(base, list) and isinstance(overlay, list):
        items = [*base, *overlay]
        if items and all(isinstance(item, dict) and "id" in item for item in items):
            result = copy.deepcopy(base)
            indexes = {item["id"]: index for index, item in enumerate(result)}
            for item in overlay:
                index = indexes.get(item["id"])
                if index is None:
                    indexes[item["id"]] = len(result)
                    result.append(copy.deepcopy(item))
                else:
                    result[index] = deep_merge(result[index], item)
            return result
        return copy.deepcopy(overlay)

    return copy.deepcopy(overlay)


def backup_path(destination: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = destination.with_name(f"{destination.name}.bak-{stamp}")
    suffix = 1
    while candidate.exists():
        candidate = destination.with_name(f"{destination.name}.bak-{stamp}-{suffix}")
        suffix += 1
    return candidate


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: merge_models.py SOURCE DESTINATION")

    source_path = Path(sys.argv[1])
    destination = Path(sys.argv[2])

    if not source_path.is_file():
        fail(f"source not found: {source_path}")

    try:
        source = json.loads(source_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read source: {error}")
    if not isinstance(source, dict) or not isinstance(source.get("providers"), dict):
        fail("source must contain a providers object")

    if destination.exists():
        try:
            target = json.loads(destination.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            fail(f"cannot parse existing {destination}: {error}")
        if not isinstance(target, dict) or not isinstance(target.get("providers"), dict):
            fail(f"existing {destination} must contain a providers object")
    else:
        target = {}

    merged = deep_merge(source, target)
    if destination.exists():
        try:
            unchanged = json.loads(destination.read_text(encoding="utf-8")) == merged
        except (OSError, json.JSONDecodeError):
            unchanged = False
        if unchanged:
            print(f"models.json: already up to date ({destination})")
            return

    destination.parent.mkdir(parents=True, exist_ok=True)
    mode = 0o600  # models may contain literal API keys
    backup = None
    if destination.exists():
        backup = backup_path(destination)
        shutil.copyfile(destination, backup)
        os.chmod(backup, 0o600)

    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as temporary:
            temporary.write(json.dumps(merged, ensure_ascii=False, indent=2) + "\n")
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, destination)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise

    providers = merged.get("providers", {})
    model_count = sum(
        len(provider.get("models", []))
        for provider in providers.values()
        if isinstance(provider, dict) and isinstance(provider.get("models"), list)
    )
    if backup:
        print(f"models.json: backed up to {backup}")
    print(f"models.json: merged {len(providers)} provider(s), {model_count} model(s) into {destination}")


if __name__ == "__main__":
    main()
