import logging
from pathlib import Path
from uuid import UUID

import httpx
import nbformat
import pytest

from services.gateway.app.config import Settings
from services.gateway.app.jupyter_adapter import AdapterError, JupyterNotebookTransport
from services.gateway.app.models import Command
from services.gateway.app.normalize import normalize_cells
from services.gateway.app.redaction import REDACTED, RedactingFilter, redact


def make_command(kind: str, **values: object) -> Command:
    return Command.model_validate(
        {
            "protocol_version": 1,
            "command_id": UUID(int=1),
            "idempotency_key": "one",
            "timeout_ms": 1000,
            "type": kind,
            **values,
        }
    )


@pytest.mark.parametrize(
    "path",
    ["../bad.ipynb", "/tmp/bad.ipynb", "a//b.ipynb", "a/./b.ipynb"],  # noqa: S108
)
def test_path_confinement(path: str, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="path_rejected"):
        Settings(workspace=tmp_path).confined_path(path)


def test_startup_notebook_and_kernel_are_configuration(tmp_path: Path) -> None:
    settings = Settings(
        workspace=tmp_path,
        notebook_path="course/week-1.ipynb",
        kernel_name="python-custom",
    )

    assert settings.startup_notebook() == "course/week-1.ipynb"
    assert settings.kernel_name == "python-custom"


@pytest.mark.asyncio
async def test_discovery_reports_startup_race_as_typed_disconnect(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def disconnected(*args: object, **kwargs: object) -> None:
        raise httpx.ConnectError("not ready")

    monkeypatch.setattr(httpx.AsyncClient, "request", disconnected)
    adapter = JupyterNotebookTransport(Settings(workspace=tmp_path))

    with pytest.raises(AdapterError) as error:
        await adapter.discover()

    assert error.value.code == "disconnected"
    assert error.value.retryable is True


def test_direct_mutations_preserve_stable_identity(tmp_path: Path) -> None:
    adapter = JupyterNotebookTransport(Settings(workspace=tmp_path))
    notebook = nbformat.v4.new_notebook(cells=[nbformat.v4.new_code_cell("first", id="stable")])
    adapter._apply_changes(
        notebook,
        [
            {"operation": "update", "cell_id": "stable", "source": "changed"},
            {
                "operation": "insert",
                "index": 0,
                "cell": {"id": "new", "cell_type": "markdown", "source": "# Note"},
            },
            {"operation": "move", "cell_id": "stable", "index": 0},
        ],
    )
    assert [cell.id for cell in notebook.cells] == ["stable", "new"]
    assert notebook.cells[0].source == "changed"


def test_delete_and_type_conversion(tmp_path: Path) -> None:
    adapter = JupyterNotebookTransport(Settings(workspace=tmp_path))
    notebook = nbformat.v4.new_notebook(
        cells=[
            nbformat.v4.new_code_cell("print(1)", id="a"),
            nbformat.v4.new_code_cell("remove", id="b"),
        ]
    )
    adapter._apply_changes(
        notebook,
        [
            {"operation": "update", "cell_id": "a", "cell_type": "markdown"},
            {"operation": "delete", "cell_id": "b"},
        ],
    )
    assert notebook.cells[0].cell_type == "markdown"
    assert notebook.cells[0].id == "a"
    assert len(notebook.cells) == 1


def test_clear_outputs_resets_execution_state(tmp_path: Path) -> None:
    adapter = JupyterNotebookTransport(Settings(workspace=tmp_path))
    cell = nbformat.v4.new_code_cell("1 + 1", id="a", execution_count=4)
    cell.outputs = [nbformat.v4.new_output("execute_result", data={"text/plain": "2"})]
    notebook = nbformat.v4.new_notebook(cells=[cell])

    adapter._apply_changes(notebook, [{"operation": "clear_outputs", "cell_id": "a"}])

    assert notebook.cells[0].outputs == []
    assert notebook.cells[0].execution_count is None


def test_stale_cell_is_typed_error(tmp_path: Path) -> None:
    adapter = JupyterNotebookTransport(Settings(workspace=tmp_path))
    notebook = nbformat.v4.new_notebook()
    with pytest.raises(AdapterError, match="Cell identity is stale"):
        adapter._apply_changes(notebook, [{"operation": "delete", "cell_id": "missing"}])


def test_normalizes_text_errors_and_png() -> None:
    cells = normalize_cells(
        {
            "cells": [
                {
                    "id": "stable",
                    "cell_type": "code",
                    "source": "plot()",
                    "outputs": [
                        {"output_type": "stream", "name": "stdout", "text": "ready\n"},
                        {"output_type": "display_data", "data": {"image/png": "abc"}},
                    ],
                }
            ]
        }
    )
    assert cells[0]["id"] == "stable"
    assert cells[0]["outputs"][1] == {"kind": "rich", "mime": "image/png", "data": "abc"}


def test_normalizes_bounded_html_table_as_rich_output() -> None:
    cells = normalize_cells(
        [
            {
                "id": "a",
                "cell_type": "code",
                "source": "table",
                "outputs": [
                    {
                        "output_type": "display_data",
                        "data": {"text/html": "<table><tr><td>42</td></tr></table>"},
                    }
                ],
            }
        ]
    )

    assert cells[0]["outputs"][0] == {
        "kind": "rich",
        "mime": "text/html",
        "data": "<table><tr><td>42</td></tr></table>",
    }


def test_completion_bounds_model() -> None:
    command = make_command("complete", code="value.bi", cursor_pos=8)
    assert command.cursor_pos == 8
    with pytest.raises(ValueError):
        make_command("complete")


def test_inspection_bounds_model() -> None:
    command = make_command("inspect", code="value", cursor_pos=5)
    assert command.cursor_pos == 5
    with pytest.raises(ValueError):
        make_command("inspect")


def test_redacts_sensitive_data(caplog: pytest.LogCaptureFixture) -> None:
    assert redact({"token": "secret", "nested": {"source": "value = 42"}}) == {
        "token": REDACTED,
        "nested": {"source": REDACTED},
    }
    logger = logging.getLogger("redaction-test")
    logger.addFilter(RedactingFilter())
    with caplog.at_level(logging.INFO):
        logger.info("payload=%s", {"authorization": "secret"})
    assert "secret" not in caplog.text
