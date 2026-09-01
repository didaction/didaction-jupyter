from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DIDACTION_", extra="ignore")
    jupyter_url: str = "http://127.0.0.1:8888"
    jupyter_token: str = ""
    workspace: Path = Path(".runtime/notebooks")
    request_limit: int = Field(default=300_000, ge=1, le=4_000_000)
    response_limit: int = Field(default=4_000_000, ge=1, le=8_000_000)
    timeout_seconds: float = Field(default=30.0, ge=0.1, le=120.0)

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
