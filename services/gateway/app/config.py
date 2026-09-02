from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DIDACTION_", extra="ignore")
    jupyter_url: str = "http://127.0.0.1:8888"
    jupyter_token: str = Field(default="", repr=False, exclude=True)
    jupyter_token_file: Path | None = Field(default=None, repr=False, exclude=True)
    static_dir: Path | None = None
    workspace: Path = Path(".runtime/notebooks")
    notebook_path: str = "notebook-parity-demo.ipynb"
    kernel_name: str = "python3"
    request_limit: int = Field(default=300_000, ge=1, le=4_000_000)
    response_limit: int = Field(default=4_000_000, ge=1, le=8_000_000)
    timeout_seconds: float = Field(default=30.0, ge=0.1, le=120.0)

    @model_validator(mode="after")
    def connection_settings(self) -> "Settings":
        url = urlsplit(self.jupyter_url)
        if (
            url.scheme not in {"http", "https"}
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError("Jupyter URL must be HTTP(S), without credentials, query or fragment")
        self.jupyter_url = self.jupyter_url.rstrip("/")
        if self.jupyter_token_file is not None:
            self.jupyter_token = self.jupyter_token_file.read_text().strip()
            if not self.jupyter_token or len(self.jupyter_token) > 4096:
                raise ValueError("Invalid Jupyter token file")
        return self

    def confined_path(self, raw: str) -> str:
        if not raw or len(raw) > 512 or raw.startswith(("/", "\\")):
            raise ValueError("path_rejected")
        parts = raw.replace("\\", "/").split("/")
        if any(part in {"", ".", ".."} for part in parts):
            raise ValueError("path_rejected")
        if not raw.endswith(".ipynb"):
            raw += ".ipynb"
        root = self.workspace.resolve()
        candidate = (root / raw).resolve()
        if root not in candidate.parents:
            raise ValueError("path_rejected")
        return raw

    def startup_notebook(self) -> str:
        return self.confined_path(self.notebook_path)
