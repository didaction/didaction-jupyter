import json
import logging
from pathlib import Path
from uuid import UUID

import pytest

from services.gateway.app.config import Settings
from services.gateway.app.mcp_adapter import AdapterError, McpNotebookTransport, compact_profile
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
