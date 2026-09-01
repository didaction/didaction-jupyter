import logging
from pathlib import Path
from uuid import UUID

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


def test_completion_bounds_model() -> None:
    command = make_command("complete", code="value.bi", cursor_pos=8)
    assert command.cursor_pos == 8
    with pytest.raises(ValueError):
        make_command("complete")


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
