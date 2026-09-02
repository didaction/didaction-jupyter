"""Operator-configured runtime launcher; never called by notebook commands."""

import json
import os
import re
from pathlib import Path


def secret_environment(mapping: str, directory: Path) -> dict[str, str]:
    values = json.loads(mapping)
    if not isinstance(values, dict):
        raise ValueError("Kernel secret environment must be an object")
    result = {}
    root = directory.resolve()
    for name, filename in values.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) or not isinstance(filename, str):
            raise ValueError("Invalid secret environment mapping")
        if name.startswith(("DIDACTION_", "JUPYTER_")):
            raise ValueError("Kernel secrets cannot override runtime connection configuration")
        path = (root / filename).resolve()
        if root not in path.parents:
            raise ValueError("Secret file is outside the configured directory")
        if path.stat().st_size > 65536:
            raise ValueError("Secret file exceeds limit")
        result[name] = path.read_text().rstrip("\r\n")
    return result


if __name__ == "__main__":
    os.environ.update(
        secret_environment(
            os.environ.get("DIDACTION_KERNEL_SECRET_ENV", "{}"), Path("/run/kernel-secrets")
        )
    )
    os.environ["DIDACTION_JUPYTER_HOST"] = "0.0.0.0"  # noqa: S104
    os.environ["DIDACTION_JUPYTER_PORT"] = "8888"
    # Operator-owned image/PATH, not notebook-supplied executable selection.
    os.execvp("jupyter", ["jupyter", "server", "--config=/opt/didaction/jupyter_server_config.py"])  # noqa: S606, S607
