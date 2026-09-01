import os
from pathlib import Path

c = get_config()  # noqa: F821
workspace = Path(os.environ.get("DIDACTION_NOTEBOOK_WORKSPACE", "./.runtime/notebooks")).resolve()
workspace.mkdir(parents=True, exist_ok=True)

c.ServerApp.ip = os.environ.get("DIDACTION_JUPYTER_HOST", "127.0.0.1")
c.ServerApp.port = int(os.environ.get("DIDACTION_JUPYTER_PORT", "8888"))
c.ServerApp.open_browser = False
c.ServerApp.root_dir = str(workspace)
c.ServerApp.allow_remote_access = False
c.IdentityProvider.token = os.environ["DIDACTION_JUPYTER_TOKEN"]
c.ServerApp.disable_check_xsrf = False
c.ServerApp.allow_origin = ""
c.ServerApp.terminals_enabled = False
c.ServerApp.shutdown_no_activity_timeout = 0
