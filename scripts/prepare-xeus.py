"""Build the optional, lockfile-pinned xeus browser assets (no host kernel)."""

import hashlib
import shutil
import subprocess
import tempfile
from pathlib import Path

import empack
import yaml

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "deploy/xeus/explicit.lock"
RUNTIME = ROOT / ".runtime"
RUNTIME.mkdir(exist_ok=True)
fingerprint = hashlib.sha256(LOCK.read_bytes()).hexdigest()[:16]
prefix = RUNTIME / f"xeus-{fingerprint}" / "didaction-xeus"
micromamba = shutil.which("micromamba")
if micromamba is None:
    raise SystemExit("Install micromamba first (tested with 2.9.0).")
subprocess.run(  # noqa: S603 - trusted build tool and repository-owned lockfile, no shell
    [
        micromamba,
        "create",
        "--no-rc",
        "-y",
        "--no-pyc",
        "--prefix",
        str(prefix),
        "--root-prefix",
        str(RUNTIME / "xeus-mamba"),
        "--platform",
        "emscripten-wasm32",
        "--relocate-prefix",
        "",
        "--file",
        str(LOCK),
    ],
    check=True,
)
# uv's environment may not be sys.prefix; locate empack's installed data explicitly.
config = Path(empack.__file__).resolve().parents[4] / "share/empack/empack_config.yaml"
if not config.is_file():
    raise SystemExit(f"Missing empack build configuration: {config}")
with tempfile.TemporaryDirectory(prefix="xeus-pack-", dir=RUNTIME) as temp:
    build = Path(temp)
    settings = yaml.safe_load(config.read_text())
    # xeus's pyjs bridge does not implement pyodide.ffi.to_js(dict_converter=...).
    # Omit the optional HTTP patch; XPythonShell already handles ImportError.
    settings["packages"]["pyodide-http"] = {"exclude_patterns": [{"pattern": "**"}]}
    local_config = build / "empack.yaml"
    local_config.write_text(yaml.safe_dump(settings))
    subprocess.run(  # noqa: S603 - fixed build command, no user input
        [  # noqa: S607 - uv supplies the locked environment's jupyter on PATH
            "jupyter",
            "lite",
            "build",
            "--lite-dir",
            str(build),
            "--output-dir",
            str(build / "site"),
            f"--XeusAddon.prefix={prefix}",
            "--XeusAddon.default_channels=https://prefix.dev/emscripten-forge-4x,https://prefix.dev/conda-forge",
            f"--XeusAddon.empack_config={local_config}",
        ],
        cwd=build,
        check=True,
    )
    shutil.copytree(build / "site/xeus", ROOT / "web/public/xeus", dirs_exist_ok=True)
subprocess.run(["node", "scripts/build-xeus-worker.mjs"], cwd=ROOT, check=True)  # noqa: S607
print("Prepared xeus-python browser assets in web/public/xeus")
