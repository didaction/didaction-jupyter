import asyncio
import hashlib
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.types import TextContent

from .config import Settings
from .models import Command

EXPECTED_TOOLS = {
    "setup_notebook",
    "query_notebook",
    "modify_notebook_cells",
    "execute_notebook_code",
}

# mcp-jupyter 2.0.2 rejects empty add/edit content. Keep its invisible transport
# sentinel private to this adapter and decode it during response normalization.
EMPTY_CELL_SENTINEL = "\u200b"


class AdapterError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable


class McpNotebookTransport:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.ready = False
        self.profile: dict[str, Any] = {}
        self.revisions: dict[str, tuple[str, int]] = {}

    @asynccontextmanager
    async def session(self) -> AsyncIterator[ClientSession]:
        try:
            async with streamablehttp_client(self.settings.mcp_url) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    yield session
        except TimeoutError as error:
            raise AdapterError("timeout", "Notebook service timed out", True) from error
        except AdapterError:
            raise
        except Exception as error:
            raise AdapterError("disconnected", "Notebook service is disconnected", True) from error

    async def discover(self) -> dict[str, Any]:
        async with self.session() as session:
            listed = await asyncio.wait_for(session.list_tools(), self.settings.timeout_seconds)
        profile = compact_profile(
            [tool.model_dump(mode="json", exclude_none=True) for tool in listed.tools]
        )
        fixture = json.loads(Path(self.settings.schema_fixture).read_text())
        if set(profile["tools"]) != EXPECTED_TOOLS or profile["tools"] != fixture["tools"]:
            raise AdapterError("incompatible_mcp_schema", "mcp-jupyter tools/list is incompatible")
        self.profile = profile
        self.ready = True
        return profile

    async def execute(self, command: Command, notebook_path: str | None) -> dict[str, Any]:
        if command.type == "modify_cells" and command.changes:
            change = command.changes[0]
            if change.get("operation") == "move":
                return await self._move_cell(command, notebook_path, change)
            if change.get("operation") == "update" and change.get("cell_type"):
                return await self._update_typed_cell(command, notebook_path, change)
        tool, arguments = self.map_command(command, notebook_path)
        async with self.session() as session:
            return await self._call(session, tool, arguments, command.timeout_ms / 1000)

    async def _call(
        self,
        session: ClientSession,
        tool: str,
        arguments: dict[str, Any],
        timeout_seconds: float,
    ) -> dict[str, Any]:
        result = await asyncio.wait_for(
            session.call_tool(tool, arguments=arguments), timeout_seconds
        )
        if result.isError:
            raise AdapterError("transport_error", "Notebook operation failed", True)
        value = result.structuredContent
        if value is None:
            texts = [item.text for item in result.content if isinstance(item, TextContent)]
            try:
                value = json.loads(texts[0]) if texts else {}
            except (json.JSONDecodeError, IndexError) as error:
                raise AdapterError(
                    "malformed_response", "MCP returned malformed data", True
                ) from error
        encoded = json.dumps(value).encode()
        if len(encoded) > self.settings.response_limit:
            raise AdapterError("bounds_exceeded", "MCP response exceeded the configured limit")
        return value

    async def _move_cell(
        self, command: Command, notebook_path: str | None, change: dict[str, Any]
    ) -> dict[str, Any]:
        path = self._path(notebook_path)
        source_index = _cell_index(change.get("cell_id"))
        target_index = change.get("index")
        if not isinstance(target_index, int) or target_index < 0:
            raise AdapterError("invalid_input", "Move target is invalid")
        timeout = command.timeout_ms / 1000
        async with self.session() as session:
            cells = await self._query_cells(session, path, timeout)
            if source_index >= len(cells) or target_index >= len(cells):
                raise AdapterError("invalid_input", "Move target is outside the notebook")
            cell = cells[source_index]
            cell_type = cell.get("cell_type")
            if cell_type not in {"code", "markdown"}:
                raise AdapterError("unsupported_operation", "Only code and Markdown cells can move")
            await self._call(
                session,
                "modify_notebook_cells",
                {
                    "notebook_path": path,
                    "operation": "delete",
                    "position_index": source_index,
                    "execute": False,
                },
                timeout,
            )
            source = _source(cell.get("source", ""))
            try:
                return await self._add_cell(session, path, cell_type, source, target_index, timeout)
            except AdapterError as error:
                await self._add_cell(session, path, cell_type, source, source_index, timeout)
                raise AdapterError(
                    "transport_error", "Cell move failed and was rolled back", True
                ) from error

    async def _update_typed_cell(
        self, command: Command, notebook_path: str | None, change: dict[str, Any]
    ) -> dict[str, Any]:
        path = self._path(notebook_path)
        index = _cell_index(change.get("cell_id"))
        target_type = change.get("cell_type")
        if target_type not in {"code", "markdown"}:
            raise AdapterError(
                "unsupported_operation", "Only code and Markdown cells can be edited"
            )
        timeout = command.timeout_ms / 1000
        async with self.session() as session:
            cells = await self._query_cells(session, path, timeout)
            if index >= len(cells):
                raise AdapterError("invalid_input", "Cell identity is stale")
            current_type = cells[index].get("cell_type")
            source = change.get("source")
            if source is None:
                source = _source(cells[index].get("source", ""))
            if current_type == target_type:
                return await self._call(
                    session,
                    "modify_notebook_cells",
                    {
                        "notebook_path": path,
                        "operation": f"edit_{target_type}",
                        "cell_content": _mcp_cell_content(source),
                        "position_index": index,
                        "execute": False,
                    },
                    timeout,
                )
            await self._call(
                session,
                "modify_notebook_cells",
                {
                    "notebook_path": path,
                    "operation": "delete",
                    "position_index": index,
                    "execute": False,
                },
                timeout,
            )
            try:
                return await self._add_cell(session, path, target_type, source, index, timeout)
            except AdapterError as error:
                if current_type in {"code", "markdown"}:
                    original_source = _source(cells[index].get("source", ""))
                    await self._add_cell(
                        session, path, current_type, original_source, index, timeout
                    )
                raise AdapterError(
                    "transport_error", "Cell conversion failed and was rolled back", True
                ) from error

    async def _add_cell(
        self,
        session: ClientSession,
        path: str,
        cell_type: str,
        source: str,
        index: int,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        return await self._call(
            session,
            "modify_notebook_cells",
            {
                "notebook_path": path,
                "operation": f"add_{cell_type}",
                "cell_content": _mcp_cell_content(source),
                "position_index": index,
                "execute": False,
            },
            timeout_seconds,
        )

    async def _query_cells(
        self, session: ClientSession, path: str, timeout_seconds: float
    ) -> list[dict[str, Any]]:
        raw = await self._call(
            session,
            "query_notebook",
            {"notebook_path": path, "query_type": "view_source"},
            timeout_seconds,
        )
        if isinstance(raw, dict) and "result" in raw:
            raw = raw["result"]
        if not isinstance(raw, list):
            raise AdapterError("malformed_response", "Notebook query did not return cells", True)
        return [cell for cell in raw if isinstance(cell, dict)]

    def _path(self, notebook_path: str | None) -> str:
        if notebook_path is None:
            raise AdapterError("invalid_input", "No notebook is open")
        return self.settings.confined_path(notebook_path)

    def map_command(
        self, command: Command, notebook_path: str | None
    ) -> tuple[str, dict[str, Any]]:
        if command.type == "setup":
            path = self.settings.confined_path(command.path or "")
            return "setup_notebook", {
                "notebook_path": path,
                "server_url": self.settings.jupyter_url,
            }
        if notebook_path is None:
            raise AdapterError("invalid_input", "No notebook is open")
        path = self.settings.confined_path(notebook_path)
        if command.type in {"query", "reconnect"}:
            return "query_notebook", {"notebook_path": path, "query_type": "view_source"}
        if command.type == "execute_cell":
            index = _cell_index(command.cell_id)
            return "execute_notebook_code", {
                "notebook_path": path,
                "execution_type": "execute_cell",
                "position_index": index,
            }
        if command.type == "modify_cells":
            changes = command.changes or []
            if len(changes) != 1:
                raise AdapterError(
                    "unsupported_operation", "mcp-jupyter requires one cell mutation per command"
                )
            change = changes[0]
            operation = change.get("operation")
            if operation == "move":
                raise AdapterError("unsupported_operation", "mcp-jupyter 2.0.2 cannot move cells")
            cell_type = change.get("cell_type", "code")
            mapping = {
                "insert": f"add_{change.get('cell', {}).get('cell_type', 'code')}",
                "update": f"edit_{cell_type}",
                "delete": "delete",
            }
            if operation not in mapping:
                raise AdapterError("unsupported_operation", "Unsupported cell mutation")
            args: dict[str, Any] = {
                "notebook_path": path,
                "operation": mapping[operation],
                "execute": False,
            }
            if operation == "insert":
                args["cell_content"] = _mcp_cell_content(change["cell"]["source"])
                args["position_index"] = change["index"]
            elif operation == "update":
                args["cell_content"] = _mcp_cell_content(change.get("source", ""))
                args["position_index"] = _cell_index(change.get("cell_id"))
            else:
                args["position_index"] = _cell_index(change.get("cell_id"))
            return "modify_notebook_cells", args
        if command.type == "execute_code":
            raise AdapterError(
                "execution_rejected", "Direct code execution is disabled; insert and execute a cell"
            )
        if command.type in {"interrupt_kernel", "restart_kernel"}:
            raise AdapterError(
                "unsupported_operation", "mcp-jupyter 2.0.2 does not expose kernel control"
            )
        if command.type == "close":
            raise AdapterError("unsupported_operation", "Close is handled by the gateway session")
        raise AdapterError("unsupported_operation", "Unsupported command")

    def revision_for(self, path: str, cells: list[dict[str, Any]]) -> int:
        digest = hashlib.sha256(json.dumps(cells, sort_keys=True).encode()).hexdigest()
        previous_digest, previous_revision = self.revisions.get(path, ("", 0))
        revision = previous_revision + 1 if digest != previous_digest else previous_revision
        self.revisions[path] = (digest, revision)
        return revision


def compact_profile(tools: list[dict[str, Any]]) -> dict[str, Any]:
    compact: dict[str, Any] = {"tools": {}}
    for tool in tools:
        schema = tool["inputSchema"]
        compact["tools"][tool["name"]] = {
            "required": schema.get("required", []),
            "properties": sorted(schema.get("properties", {}).keys()),
        }
    return compact


def _cell_index(cell_id: str | None) -> int:
    if not cell_id or not cell_id.startswith("position-"):
        raise AdapterError("invalid_input", "Cell identity is not a current positional identity")
    try:
        return int(cell_id.removeprefix("position-"))
    except ValueError as error:
        raise AdapterError("invalid_input", "Cell identity is malformed") from error


def _source(value: Any) -> str:
    if isinstance(value, list):
        return "".join(str(part) for part in value)
    return str(value)


def _mcp_cell_content(value: Any) -> str:
    source = _source(value)
    return source if source else EMPTY_CELL_SENTINEL
