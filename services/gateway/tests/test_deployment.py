import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import httpx
import pytest

from deploy.runtime_entrypoint import secret_environment
from services.gateway.app import main
from services.gateway.app.config import Settings
from services.gateway.app.jupyter_adapter import AdapterError, JupyterNotebookTransport
from services.gateway.app.models import Command


@pytest.mark.asyncio
async def test_interrupt_bypasses_busy_execution_lock(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = JupyterNotebookTransport(Settings())
    lock = asyncio.Lock()
    adapter.locks["test.ipynb"] = lock
    kernel = Mock()
    monkeypatch.setattr(adapter, "_ensure_kernel", AsyncMock(return_value=kernel))
    monkeypatch.setattr(adapter, "_read_notebook", AsyncMock(return_value={"cells": []}))
    async with lock:
        await asyncio.wait_for(
            adapter.execute(
                Command(
                    protocol_version=1,
                    timeout_ms=1000,
                    type="interrupt_kernel",
                    command_id=uuid4(),
                    idempotency_key="interrupt-test",
                ),
                "test.ipynb",
            ),
            timeout=1,
        )
    kernel.interrupt.assert_called_once()


def test_token_file_is_private_configuration(tmp_path: Path) -> None:
    token = tmp_path / "token"
    token.write_text("private-test-value\n")
    settings = Settings(jupyter_token_file=token)
    assert settings.jupyter_token == "private-test-value"  # noqa: S105
    assert "private-test-value" not in repr(settings)
    assert "jupyter_token" not in settings.model_dump()


@pytest.mark.parametrize(
    "url", ["file:///tmp/x", "http://user:secret@host", "https://host?token=x"]
)
def test_rejects_credentials_in_connection_url(url: str) -> None:
    with pytest.raises(ValueError):
        Settings(jupyter_url=url)


def test_kernel_secrets_are_explicit_and_confined(tmp_path: Path) -> None:
    (tmp_path / "provider").write_text("example-secret\n")
    assert secret_environment('{"PROVIDER_TOKEN":"provider"}', tmp_path) == {
        "PROVIDER_TOKEN": "example-secret"
    }
    for mapping in ['{"TOKEN":"../outside"}', '{"JUPYTER_TOKEN":"provider"}', "[]"]:
        with pytest.raises(ValueError):
            secret_environment(mapping, tmp_path)


@pytest.mark.asyncio
async def test_readiness_requires_configured_kernel(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = JupyterNotebookTransport(Settings(kernel_name="missing"))

    async def request(method: str, route: str, **kwargs: Any) -> httpx.Response:
        return httpx.Response(200, json={"kernelspecs": {"python3": {}}})

    monkeypatch.setattr(adapter, "_request", request)
    with pytest.raises(AdapterError, match="Configured kernelspec"):
        await adapter.discover()
    assert not adapter.ready
    adapter.settings.kernel_name = "python3"
    await adapter.discover()
    assert adapter.ready


@pytest.mark.asyncio
async def test_download_uses_jupyter_not_local_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": []}

    async def execute(command: Any, path: str) -> Any:
        assert path == "remote.ipynb"
        assert command.type == "query"
        return notebook

    monkeypatch.setattr(main, "current_notebook", "remote.ipynb")
    monkeypatch.setattr(main.transport, "execute", execute)
    from starlette.requests import Request

    response = await main.download_notebook(Request({"type": "http", "headers": []}))
    assert response.status_code == 200
    assert b'"nbformat": 4' in response.body
