import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from uuid import UUID

import pytest

from services.gateway.app.config import Settings
from services.gateway.app.mcp_adapter import (
    EMPTY_CELL_SENTINEL,
    AdapterError,
    McpNotebookTransport,
    compact_profile,
)
from services.gateway.app.models import Command
from services.gateway.app.normalize import normalize_cells
from services.gateway.app.redaction import REDACTED, RedactingFilter, redact


class FakeSession:
    def __init__(self, cells: list[dict[str, Any]]):
        self.cells = cells
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def call_tool(self, tool: str, arguments: dict[str, Any]) -> Any:
        self.calls.append((tool, arguments))
        content: Any = self.cells if tool == "query_notebook" else {}
        return SimpleNamespace(isError=False, structuredContent=content, content=[])


@asynccontextmanager
async def fake_session(session: FakeSession) -> AsyncIterator[FakeSession]:
    yield session


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


def test_schema_fixture_profile() -> None:
    fixture = json.loads(Path("tests/fixtures/mcp-jupyter-2.0.2-tools.json").read_text())
    tools = [
        {
            "name": name,
            "inputSchema": {
                "required": value["required"],
                "properties": {key: {} for key in value["properties"]},
            },
        }
        for name, value in fixture["tools"].items()
    ]
    assert compact_profile(tools)["tools"] == fixture["tools"]


def test_every_mapping_and_rejections(tmp_path: Path) -> None:
    adapter = McpNotebookTransport(Settings(workspace=tmp_path))
    tool, args = adapter.map_command(make_command("setup", path="demo.ipynb"), None)
    assert (tool, args["notebook_path"]) == ("setup_notebook", "demo.ipynb")
    assert adapter.map_command(make_command("query"), "demo.ipynb")[0] == "query_notebook"
    assert (
        adapter.map_command(make_command("execute_cell", cell_id="position-2"), "demo.ipynb")[0]
        == "execute_notebook_code"
    )
    change = {"operation": "insert", "index": 0, "cell": {"cell_type": "code", "source": "1+1"}}
    assert (
        adapter.map_command(make_command("modify_cells", changes=[change]), "demo.ipynb")[0]
        == "modify_notebook_cells"
    )
    with pytest.raises(AdapterError, match="Direct code execution"):
        adapter.map_command(make_command("execute_code", code="!pip install bad"), "demo.ipynb")


def test_blank_cell_is_encoded_only_at_mcp_boundary(tmp_path: Path) -> None:
    adapter = McpNotebookTransport(Settings(workspace=tmp_path))
    change = {
        "operation": "insert",
        "index": 0,
        "cell": {"cell_type": "code", "source": ""},
    }

    _, args = adapter.map_command(make_command("modify_cells", changes=[change]), "demo.ipynb")

    assert args["cell_content"] == EMPTY_CELL_SENTINEL
    assert (
        normalize_cells([{"cell_type": "code", "source": EMPTY_CELL_SENTINEL}])[0]["source"] == ""
    )


async def test_move_maps_to_bounded_delete_and_reinsert(tmp_path: Path) -> None:
    adapter = McpNotebookTransport(Settings(workspace=tmp_path))
    session = FakeSession(
        [
            {"cell_type": "code", "source": ["first\n"]},
            {"cell_type": "markdown", "source": "second"},
        ]
    )
    cast(Any, adapter).session = lambda: fake_session(session)
    change = {"operation": "move", "cell_id": "position-0", "index": 1}

    await adapter.execute(make_command("modify_cells", changes=[change]), "demo.ipynb")

    assert [call[0] for call in session.calls] == [
        "query_notebook",
        "modify_notebook_cells",
        "modify_notebook_cells",
    ]
    assert session.calls[1][1]["operation"] == "delete"
    assert session.calls[2][1] == {
        "notebook_path": "demo.ipynb",
        "operation": "add_code",
        "cell_content": "first\n",
        "position_index": 1,
        "execute": False,
    }


async def test_markdown_edit_uses_typed_operation(tmp_path: Path) -> None:
    adapter = McpNotebookTransport(Settings(workspace=tmp_path))
    session = FakeSession([{"cell_type": "markdown", "source": "old"}])
    cast(Any, adapter).session = lambda: fake_session(session)
    change = {
        "operation": "update",
        "cell_id": "position-0",
        "source": "new",
        "cell_type": "markdown",
    }

    await adapter.execute(make_command("modify_cells", changes=[change]), "demo.ipynb")

    assert session.calls[-1][1]["operation"] == "edit_markdown"


async def test_cell_type_conversion_deletes_and_reinserts(tmp_path: Path) -> None:
    adapter = McpNotebookTransport(Settings(workspace=tmp_path))
    session = FakeSession([{"cell_type": "code", "source": "print(1)"}])
    cast(Any, adapter).session = lambda: fake_session(session)
    change = {
        "operation": "update",
        "cell_id": "position-0",
        "source": "# explanation",
        "cell_type": "markdown",
    }

    await adapter.execute(make_command("modify_cells", changes=[change]), "demo.ipynb")

    assert [
        arguments["operation"]
        for tool, arguments in session.calls
        if tool == "modify_notebook_cells"
    ] == [
        "delete",
        "add_markdown",
    ]


@pytest.mark.parametrize(
    "path",
    ["../bad.ipynb", "/tmp/bad.ipynb", "a//b.ipynb", "a/./b.ipynb"],  # noqa: S108
)
def test_path_confinement(path: str, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="path_rejected"):
        Settings(workspace=tmp_path).confined_path(path)


def test_normalizes_and_bounds_outputs() -> None:
    cells = normalize_cells(
        [
            {
                "cell_type": "code",
                "source": ["value\n"],
                "outputs": [{"output_type": "stream", "name": "stdout", "text": ["42\n"]}],
            }
        ]
    )
    assert cells[0]["id"] == "position-0"
    assert cells[0]["outputs"][0]["text"] == "42\n"


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
