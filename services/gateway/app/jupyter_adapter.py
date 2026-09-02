import asyncio
import hashlib
import json
from collections.abc import AsyncIterator, Callable
from copy import deepcopy
from pathlib import Path
from typing import Any

import httpx
import nbformat
from jupyter_kernel_client import KernelClient
from jupyter_kernel_client.client import output_hook  # type: ignore[import-untyped]

from .config import Settings
from .models import Command


class AdapterError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable


class JupyterNotebookTransport:
    """Bounded direct adapter for Jupyter Contents, Sessions, Kernels and channels."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.ready = False
        self.profile: dict[str, Any] = {}
        self.revisions: dict[str, tuple[str, int]] = {}
        self.kernels: dict[str, KernelClient] = {}
        self.session_ids: dict[str, str] = {}
        self.locks: dict[str, asyncio.Lock] = {}

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"token {self.settings.jupyter_token}"}

    async def discover(self) -> dict[str, Any]:
        self.ready = False
        response = await self._request("GET", "/api/status")
        if response.status_code != 200:
            raise AdapterError("disconnected", "Jupyter Server is unavailable", True)
        response = await self._request("GET", "/api/kernelspecs")
        if response.status_code != 200:
            raise AdapterError("disconnected", "Jupyter kernelspec discovery failed", True)
        if self.settings.kernel_name not in response.json().get("kernelspecs", {}):
            raise AdapterError("unsupported_operation", "Configured kernelspec is not installed")
        response = await self._request("GET", "/api/contents", params={"content": 0})
        if response.status_code != 200:
            raise AdapterError("disconnected", "Jupyter Contents is unavailable", True)
        self.profile = {
            "adapter": "jupyter",
            "services": ["contents", "sessions", "kernels", "kernel_channels"],
        }
        self.ready = True
        return self.profile

    async def close(self) -> None:
        clients = list(self.kernels.values())
        self.kernels.clear()
        for client in clients:
            await asyncio.to_thread(client.stop, False)
        self.ready = False

    async def execute(self, command: Command, notebook_path: str | None) -> Any:
        if command.type == "setup":
            path = self.settings.confined_path(command.path or "")
            await self._ensure_notebook(path, bool(command.create))
            await self._ensure_kernel(path, command.kernel or self.settings.kernel_name)
            return await self._read_notebook(path)

        if notebook_path is None:
            raise AdapterError("invalid_input", "No notebook is open")
        path = self.settings.confined_path(notebook_path)
        lock = self.locks.setdefault(path, asyncio.Lock())
        async with lock:
            if command.type in {"query", "reconnect"}:
                await self._ensure_kernel(path, command.kernel or self.settings.kernel_name)
            elif command.type == "modify_cells":
                notebook = await self._read_notebook(path)
                self._apply_changes(notebook, command.changes or [])
                await self._save_notebook(path, notebook)
            elif command.type == "execute_cell":
                notebook = await self._read_notebook(path)
                cell = self._cell(notebook, command.cell_id)
                if cell.get("cell_type") != "code":
                    raise AdapterError("invalid_input", "Only code cells can execute")
                kernel = await self._ensure_kernel(
                    path, command.kernel or self.settings.kernel_name
                )
                try:
                    reply = await asyncio.wait_for(
                        asyncio.to_thread(
                            kernel.execute,
                            self._source(cell.get("source", "")),
                            timeout=command.timeout_ms / 1000,
                        ),
                        command.timeout_ms / 1000 + 1,
                    )
                except TimeoutError as error:
                    await asyncio.to_thread(kernel.interrupt)
                    raise AdapterError(
                        "timeout", "Cell execution timed out and was interrupted", True
                    ) from error
                cell["execution_count"] = reply.get("execution_count")
                cell["outputs"] = reply.get("outputs", [])[:128]
                await self._save_notebook(path, notebook)
            elif command.type == "complete":
                kernel = await self._ensure_kernel(
                    path, command.kernel or self.settings.kernel_name
                )
                return await asyncio.to_thread(
                    self._complete,
                    kernel,
                    command.code or "",
                    command.cursor_pos
                    if command.cursor_pos is not None
                    else len(command.code or ""),
                    command.timeout_ms / 1000,
                )
            elif command.type == "inspect":
                kernel = await self._ensure_kernel(
                    path, command.kernel or self.settings.kernel_name
                )
                return await asyncio.to_thread(
                    self._inspect,
                    kernel,
                    command.code or "",
                    command.cursor_pos
                    if command.cursor_pos is not None
                    else len(command.code or ""),
                    command.timeout_ms / 1000,
                )
            elif command.type == "interrupt_kernel":
                kernel = await self._ensure_kernel(
                    path, command.kernel or self.settings.kernel_name
                )
                await asyncio.to_thread(kernel.interrupt)
            elif command.type == "restart_kernel":
                kernel = await self._ensure_kernel(
                    path, command.kernel or self.settings.kernel_name
                )
                await asyncio.to_thread(kernel.restart)
            elif command.type == "create_checkpoint":
                response = await self._request("POST", f"/api/contents/{path}/checkpoints")
                if response.status_code != 201:
                    raise AdapterError(
                        "transport_error", "Notebook checkpoint could not be created", True
                    )
            elif command.type == "rename_notebook":
                new_path = self.settings.confined_path(command.path or "")
                response = await self._request(
                    "PATCH", f"/api/contents/{path}", json={"path": new_path}
                )
                if response.status_code != 200:
                    raise AdapterError("transport_error", "Notebook could not be renamed", True)
                if session_id := self.session_ids.pop(path, None):
                    await self._request(
                        "PATCH", f"/api/sessions/{session_id}", json={"path": new_path}
                    )
                    self.session_ids[new_path] = session_id
                if kernel := self.kernels.pop(path, None):
                    self.kernels[new_path] = kernel
                if revision := self.revisions.pop(path, None):
                    self.revisions[new_path] = revision
                path = new_path
            elif command.type == "close":
                kernel = self.kernels.pop(path, None)
                if kernel:
                    await asyncio.to_thread(kernel.stop, False)
            else:
                raise AdapterError("unsupported_operation", "Unsupported notebook command")
            return await self._read_notebook(path)

    async def execute_stream(
        self, command: Command, notebook_path: str | None
    ) -> AsyncIterator[Any]:
        if command.type != "execute_cell":
            raise AdapterError("unsupported_operation", "Only cell execution can stream")
        if notebook_path is None:
            raise AdapterError("invalid_input", "No notebook is open")
        path = self.settings.confined_path(notebook_path)
        lock = self.locks.setdefault(path, asyncio.Lock())
        async with lock:
            notebook = await self._read_notebook(path)
            cell = self._cell(notebook, command.cell_id)
            if cell.get("cell_type") != "code":
                raise AdapterError("invalid_input", "Only code cells can execute")
            kernel = await self._ensure_kernel(path, command.kernel or self.settings.kernel_name)
            cell["execution_count"] = None
            cell["outputs"] = []
            await self._save_notebook(path, notebook)
            yield deepcopy(notebook)

            loop = asyncio.get_running_loop()
            updates: asyncio.Queue[list[dict[str, Any]]] = asyncio.Queue()

            def progress(outputs: list[dict[str, Any]]) -> None:
                loop.call_soon_threadsafe(updates.put_nowait, deepcopy(outputs))

            execution = asyncio.create_task(
                asyncio.to_thread(
                    self._execute_with_progress,
                    kernel,
                    self._source(cell.get("source", "")),
                    command.timeout_ms / 1000,
                    progress,
                )
            )
            while not execution.done() or not updates.empty():
                try:
                    outputs = await asyncio.wait_for(updates.get(), timeout=0.05)
                except TimeoutError:
                    continue
                cell["outputs"] = outputs[:128]
                await self._save_notebook(path, notebook)
                yield deepcopy(notebook)
            try:
                reply = await execution
            except TimeoutError as error:
                await asyncio.to_thread(kernel.interrupt)
                raise AdapterError(
                    "timeout", "Cell execution timed out and was interrupted", True
                ) from error
            cell["execution_count"] = reply.get("execution_count")
            cell["outputs"] = reply.get("outputs", [])[:128]
            await self._save_notebook(path, notebook)
            yield deepcopy(notebook)

    @staticmethod
    def _execute_with_progress(
        kernel: KernelClient,
        source: str,
        timeout: float,
        progress: Callable[[list[dict[str, Any]]], None],
    ) -> dict[str, Any]:
        outputs: list[dict[str, Any]] = []

        def capture(message: dict[str, Any]) -> set[int]:
            changed = set(output_hook(outputs, message))
            if changed:
                persisted_outputs = deepcopy(outputs)
                for output in persisted_outputs:
                    output.pop("transient", None)
                progress(persisted_outputs)
            return changed

        reply = kernel._manager.client.execute_interactive(
            source,
            silent=False,
            store_history=True,
            allow_stdin=False,
            stop_on_error=True,
            timeout=timeout,
            output_hook=capture,
        )
        content = reply["content"]
        for output in outputs:
            output.pop("transient", None)
        return {
            "execution_count": content.get("execution_count"),
            "outputs": outputs,
            "status": content["status"],
        }

    async def _request(self, method: str, route: str, **kwargs: Any) -> httpx.Response:
        try:
            async with httpx.AsyncClient(timeout=self.settings.timeout_seconds) as client:
                response = await client.request(
                    method,
                    f"{self.settings.jupyter_url}{route}",
                    headers=self.headers,
                    **kwargs,
                )
        except httpx.HTTPError as error:
            raise AdapterError("disconnected", "Jupyter Server is disconnected", True) from error
        return response

    async def _ensure_notebook(self, path: str, create: bool) -> None:
        response = await self._request("GET", f"/api/contents/{path}", params={"content": 1})
        if response.status_code == 200:
            return
        if response.status_code != 404 or not create:
            raise AdapterError("invalid_input", "Notebook does not exist")
        if Path(path).name == "notebook-parity-demo.ipynb":
            notebook = nbformat.v4.new_notebook(
                cells=[
                    nbformat.v4.new_markdown_cell(
                        "# Direct Jupyter notebook\n"
                        "Edit and run real IPython cells. Press Tab at the end of code "
                        "for kernel completions. Double-click this rendered cell to edit.\n\n"
                        "## Most-used notebook primitives\n"
                        "- [x] CommonMark tasks, **emphasis**, and `inline code`\n"
                        "- [x] Keyboard execution, completion, inspection, and structural edits\n\n"
                        "| Primitive | Gesture |\n| --- | --- |\n"
                        "| Complete | Tab |\n| Inspect | Shift+Tab |\n\n"
                        "Math notation is bounded and readable: $value = 40 + 2$."
                    ),
                    nbformat.v4.new_code_cell("values = [2, 5, 3, 7, 4]\nmax(values)"),
                    nbformat.v4.new_code_cell(
                        "from IPython.display import HTML, display\n"
                        "display(HTML('<table><tr><th>Feature</th><th>Status</th></tr>' "
                        "+ '<tr><td>HTML table</td><td>bounded</td></tr></table>'))"
                    ),
                    nbformat.v4.new_code_cell(
                        "from IPython.display import SVG, display\n"
                        "bars = ''.join(\n"
                        '    f\'<rect x="{30+i*55}" y="{180-v*20}" width="36" \''
                        '    f\'height="{v*20}" fill="#2d698f"/>\'\n'
                        "    for i, v in enumerate(values)\n"
                        ")\n"
                        "display(SVG(f'''<svg xmlns=\"http://www.w3.org/2000/svg\" "
                        'width="360" height="210" viewBox="0 0 360 210">'
                        '<rect width="360" height="210" fill="white"/>'
                        '<line x1="20" y1="180" x2="340" y2="180" '
                        'stroke="#53636b"/>{bars}<text x="20" y="24" '
                        'font-family="sans-serif" font-size="16">Basic graph output'
                        "</text></svg>'''))"
                    ),
                ]
            )
        else:
            notebook = nbformat.v4.new_notebook(cells=[nbformat.v4.new_code_cell("")])
        await self._save_notebook(path, notebook)

    async def _read_notebook(self, path: str) -> Any:
        response = await self._request(
            "GET", f"/api/contents/{path}", params={"content": 1, "type": "notebook"}
        )
        if response.status_code != 200:
            raise AdapterError("transport_error", "Notebook could not be read", True)
        content = response.json().get("content")
        try:
            notebook = nbformat.from_dict(content)
            nbformat.validate(notebook)
        except Exception as error:
            raise AdapterError(
                "malformed_response", "Jupyter returned an invalid notebook"
            ) from error
        if len(notebook.cells) > 2000:
            raise AdapterError("bounds_exceeded", "Notebook contains too many cells")
        changed = False
        for cell in notebook.cells:
            if not cell.get("id"):
                cell["id"] = nbformat.corpus.words.generate_corpus_id()
                changed = True
        if changed:
            await self._save_notebook(path, notebook)
        return notebook

    async def _save_notebook(self, path: str, notebook: Any) -> None:
        nbformat.validate(notebook)
        encoded = json.dumps(notebook)
        if len(encoded.encode()) > self.settings.response_limit:
            raise AdapterError("bounds_exceeded", "Notebook exceeded the configured limit")
        response = await self._request(
            "PUT",
            f"/api/contents/{path}",
            json={"type": "notebook", "format": "json", "content": notebook},
        )
        if response.status_code not in {200, 201}:
            raise AdapterError("transport_error", "Notebook could not be saved", True)

    async def _ensure_kernel(self, path: str, kernel_name: str) -> KernelClient:
        existing = self.kernels.get(path)
        if existing and await asyncio.to_thread(existing.is_alive):
            return existing
        response = await self._request("GET", "/api/sessions")
        sessions = response.json() if response.status_code == 200 else []
        session = next((item for item in sessions if item.get("path") == path), None)
        if session is None:
            response = await self._request(
                "POST",
                "/api/sessions",
                json={
                    "path": path,
                    "name": Path(path).name,
                    "type": "notebook",
                    "kernel": {"name": kernel_name},
                },
            )
            if response.status_code != 201:
                raise AdapterError("transport_error", "Kernel session could not start", True)
            session = response.json()
        kernel_id = session["kernel"]["id"]
        client = KernelClient(
            server_url=self.settings.jupyter_url,
            token=self.settings.jupyter_token,
            kernel_id=kernel_id,
        )
        await asyncio.to_thread(client.start)
        self.kernels[path] = client
        self.session_ids[path] = session["id"]
        return client

    def _complete(
        self, kernel: KernelClient, code: str, cursor_pos: int, timeout: float
    ) -> dict[str, Any]:
        client = kernel._manager.client  # The pinned client exposes the protocol client here.
        message_id = client.complete(code, cursor_pos)
        while True:
            message = client.get_shell_msg(timeout=timeout)
            if message.get("parent_header", {}).get("msg_id") == message_id:
                content = message.get("content", {})
                return {
                    "matches": [str(value)[:512] for value in content.get("matches", [])[:100]],
                    "cursor_start": int(content.get("cursor_start", cursor_pos)),
                    "cursor_end": int(content.get("cursor_end", cursor_pos)),
                }

    def _inspect(
        self, kernel: KernelClient, code: str, cursor_pos: int, timeout: float
    ) -> dict[str, Any]:
        client = kernel._manager.client
        message_id = client.inspect(code, cursor_pos, detail_level=0)
        while True:
            message = client.get_shell_msg(timeout=timeout)
            if message.get("parent_header", {}).get("msg_id") == message_id:
                content = message.get("content", {})
                data = content.get("data", {})
                text = data.get("text/plain", "") if isinstance(data, dict) else ""
                return {"found": bool(content.get("found")), "text": str(text)[:32_768]}

    @staticmethod
    def _source(value: Any) -> str:
        return "".join(value) if isinstance(value, list) else str(value)

    @staticmethod
    def _cell(notebook: Any, cell_id: str | None) -> Any:
        for cell in notebook.cells:
            if cell.get("id") == cell_id:
                return cell
        raise AdapterError("invalid_input", "Cell identity is stale")

    def _apply_changes(self, notebook: Any, changes: list[dict[str, Any]]) -> None:
        for change in changes:
            operation = change.get("operation")
            if operation == "insert":
                value = change.get("cell", {})
                kind = value.get("cell_type", "code")
                factory = {
                    "code": nbformat.v4.new_code_cell,
                    "markdown": nbformat.v4.new_markdown_cell,
                    "raw": nbformat.v4.new_raw_cell,
                }.get(kind)
                if factory is None:
                    raise AdapterError("invalid_input", "Unsupported cell type")
                cell = factory(
                    self._source(value.get("source", "")), metadata=value.get("metadata", {})
                )
                cell["id"] = value.get("id") or nbformat.corpus.words.generate_corpus_id()
                notebook.cells.insert(
                    min(int(change.get("index", len(notebook.cells))), len(notebook.cells)), cell
                )
            else:
                cell = self._cell(notebook, change.get("cell_id"))
                index = notebook.cells.index(cell)
                if operation == "delete":
                    notebook.cells.pop(index)
                elif operation == "move":
                    notebook.cells.pop(index)
                    notebook.cells.insert(
                        min(int(change.get("index", 0)), len(notebook.cells)), cell
                    )
                elif operation == "update":
                    source = change.get("source")
                    metadata = change.get("metadata")
                    kind = change.get("cell_type") or cell.get("cell_type")
                    if source is not None:
                        cell["source"] = source
                    if metadata is not None:
                        cell["metadata"] = metadata
                    if kind != cell.get("cell_type"):
                        replacement = {
                            "code": nbformat.v4.new_code_cell,
                            "markdown": nbformat.v4.new_markdown_cell,
                            "raw": nbformat.v4.new_raw_cell,
                        }[kind](
                            self._source(cell.get("source", "")), metadata=cell.get("metadata", {})
                        )
                        replacement["id"] = cell["id"]
                        notebook.cells[index] = replacement
                elif operation == "clear_outputs":
                    if cell.get("cell_type") != "code":
                        raise AdapterError("invalid_input", "Only code cells have outputs")
                    cell["outputs"] = []
                    cell["execution_count"] = None
                else:
                    raise AdapterError("unsupported_operation", "Unsupported cell mutation")

    def revision_for(self, path: str, cells: list[dict[str, Any]]) -> int:
        digest = hashlib.sha256(json.dumps(cells, sort_keys=True).encode()).hexdigest()
        previous_digest, previous_revision = self.revisions.get(path, ("", 0))
        revision = previous_revision + 1 if digest != previous_digest else previous_revision
        self.revisions[path] = (digest, revision)
        return revision
