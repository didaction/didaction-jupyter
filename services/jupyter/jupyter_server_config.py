import os
import socket
from pathlib import Path

from jupyter_server.services.contents.largefilemanager import LargeFileManager
from tornado.web import HTTPError


class ConfinedContentsManager(LargeFileManager):
    """Enforce the mounted root even when notebooks create symlinks."""

    def _get_os_path(self, path):
        candidate = Path(super()._get_os_path(path)).resolve()
        root = Path(self.root_dir).resolve()
        if candidate != root and root not in candidate.parents:
            raise HTTPError(403, "Path is outside the notebook workspace")
        return str(candidate)


c = get_config()  # noqa: F821
workspace = Path(os.environ.get("DIDACTION_NOTEBOOK_WORKSPACE", "./.runtime/notebooks")).resolve()
workspace.mkdir(parents=True, exist_ok=True)

c.ServerApp.ip = os.environ.get("DIDACTION_JUPYTER_HOST", "127.0.0.1")
c.ServerApp.port = int(os.environ.get("DIDACTION_JUPYTER_PORT", "8888"))
c.ServerApp.open_browser = False
c.ServerApp.root_dir = str(workspace)
c.ServerApp.contents_manager_class = ConfinedContentsManager
c.ServerApp.allow_remote_access = False
c.ServerApp.local_hostnames = ["localhost", "jupyter", socket.gethostname()]
c.ServerApp.log_level = "WARN"
c.IdentityProvider.token = (
    Path(os.environ["DIDACTION_JUPYTER_TOKEN_FILE"]).read_text().strip()
    if os.environ.get("DIDACTION_JUPYTER_TOKEN_FILE")
    else os.environ["DIDACTION_JUPYTER_TOKEN"]
)
c.ServerApp.port_retries = 0
c.ServerApp.disable_check_xsrf = False
c.ServerApp.allow_origin = ""
c.ServerApp.terminals_enabled = False
c.ServerApp.shutdown_no_activity_timeout = 0
