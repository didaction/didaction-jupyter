import runpy
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest
from traitlets.config import Config

from services.gateway.app import main
from services.gateway.app.config import Settings
from services.gateway.app.jupyter_adapter import JupyterNotebookTransport


@pytest.mark.parametrize(
    "path",
    ["../escape", "/etc", "a/../b", "a\\b", "%2e%2e", "a?b", "a#b", ".git", "a//b", "a\x00b"],
)
def test_directory_rejects_escaping_paths(path: str, tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        Settings(workspace=tmp_path).confined_directory(path)


def test_server_rejects_symlink_outside_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "escape").symlink_to(outside)
    monkeypatch.setenv("DIDACTION_NOTEBOOK_WORKSPACE", str(root))
    monkeypatch.setenv("DIDACTION_JUPYTER_TOKEN", "test-only")
    module = runpy.run_path(
        "services/jupyter/jupyter_server_config.py", init_globals={"get_config": Config}
    )
    manager = module["ConfinedContentsManager"](root_dir=str(root))
    from tornado.web import HTTPError

    with pytest.raises(HTTPError):
        manager._get_os_path("escape/notebook.ipynb")
    assert manager._get_os_path("inside.ipynb") == str(root / "inside.ipynb")


@pytest.mark.asyncio
async def test_listing_filters_and_scopes_entries(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = JupyterNotebookTransport(Settings())

    async def request(*args: Any, **kwargs: Any) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "content": [
                    {"type": "notebook", "path": "lesson/a.ipynb"},
                    {"type": "directory", "path": "lesson/sub"},
                    {"type": "file", "path": "lesson/token.txt"},
                    {"type": "notebook", "path": "elsewhere/b.ipynb"},
                    {"type": "directory", "path": "../outside"},
                ]
            },
        )

    monkeypatch.setattr(adapter, "_request", request)
    result = await adapter.list_notebooks("lesson")
    assert [entry["path"] for entry in result["entries"]] == ["lesson/sub", "lesson/a.ipynb"]


@pytest.mark.asyncio
async def test_tabs_and_idempotency_are_notebook_scoped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main.transport, "ready", True)
    monkeypatch.setattr(main, "result_cache", {})

    async def execute(command: Any, path: str) -> Any:
        return {"cells": [{"id": "cell", "cell_type": "markdown", "source": path, "metadata": {}}]}

    monkeypatch.setattr(main.transport, "execute", execute)
    body = {
        "type": "query",
        "query": "full",
        "protocol_version": 1,
        "command_id": str(uuid4()),
        "idempotency_key": "same-key",
        "timeout_ms": 1000,
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app), base_url="http://test"
    ) as client:
        for path in ["one.ipynb", "sub/two.ipynb", "one.ipynb"]:
            result = await client.post(
                "/api/v1/commands", headers={"x-notebook-path": path}, json=body
            )
            assert result.status_code == 200
            assert result.json()["snapshot"]["notebook"]["path"] == path
        rejected = await client.get("/api/v1/notebooks", params={"directory": "../outside"})
        assert rejected.status_code == 400
