import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import unquote, urlsplit
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from .collaboration import Collaboration
from .config import Settings
from .jupyter_adapter import AdapterError, JupyterNotebookTransport
from .models import Command, CommandResult, GatewayError
from .normalize import normalize_cells
from .redaction import RedactingFilter

settings = Settings()
transport = JupyterNotebookTransport(settings)
logger = logging.getLogger("didaction.gateway")
logger.addFilter(RedactingFilter())
current_notebook: str | None = None
result_cache: dict[str, CommandResult] = {}
collaboration = Collaboration()
executions: set[asyncio.Task[None]] = set()


def client_token(request: Request) -> str:
    return request.headers.get("x-notebook-client", "")


def writes(command: Command) -> bool:
    return command.type not in {"query", "reconnect", "complete", "inspect"} and not (
        command.type == "setup" and not command.create
    )


def begin_command(command: Command, path: str, token: str) -> bool:
    if not writes(command):
        return False
    collaboration.require_driver(path, token)
    room = collaboration.room(path)
    if command.type == "rename_notebook" and len(room.members) > 1:
        raise AdapterError(
            "unsupported_operation", "Close other collaborators before renaming this notebook"
        )
    if command.type == "rename_notebook" and (
        command.path in collaboration.rooms or len(collaboration.redirects) >= 256
    ):
        raise AdapterError(
            "unsupported_operation", "Rename target has an existing session or rename limit reached"
        )
    if room.active and command.type != "interrupt_kernel":
        raise AdapterError(
            "execution_rejected", "Another command is running; retry when idle", True
        )
    room.active += 1
    return True


def request_notebook(request: Request) -> str:
    raw = request.headers.get("x-notebook-path")
    return settings.confined_path(
        unquote(raw, errors="strict") if raw else current_notebook or settings.startup_notebook()
    )


def snapshot_result(
    command: Command,
    raw: Any,
    notebook_path: str,
    base_revision: int | None,
    kernel_state: str = "idle",
) -> CommandResult:
    cells = normalize_cells(raw)
    revision = transport.revision_for(notebook_path, cells)
    snapshot = {
        "protocol_version": 1,
        "schema_version": 1,
        "notebook": {"path": notebook_path, "workspace": "local"},
        "kernel": {
            "name": settings.kernel_name,
            "display_name": settings.kernel_name,
            "session_id": None,
            "state": kernel_state,
        },
        "revision": revision,
        "cells": cells,
        "selected_cell_id": cells[0]["id"] if cells else None,
    }
    return CommandResult(
        command_id=command.command_id,
        idempotency_key=command.idempotency_key,
        base_revision=base_revision,
        committed_revision=revision,
        snapshot=snapshot,
    )


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings.workspace.mkdir(parents=True, exist_ok=True)
    try:
        await transport.discover()
    except AdapterError as error:
        logger.error("Jupyter compatibility check failed: %s", error.code)
    yield
    if executions:
        await asyncio.gather(*executions, return_exceptions=True)
    await transport.close()


app = FastAPI(title="didaction notebook gateway", version="1", lifespan=lifespan)


@app.middleware("http")
async def bounds(request: Request, call_next: Any) -> Any:
    origin = request.headers.get("origin")
    if origin and urlsplit(origin).netloc != request.url.netloc:
        return JSONResponse(status_code=403, content={"code": "invalid_input"})
    length = int(request.headers.get("content-length", "0") or "0")
    if length > settings.request_limit:
        return JSONResponse(status_code=413, content={"code": "bounds_exceeded"})
    response = await call_next(request)
    return response


@app.get("/healthz")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
async def ready() -> JSONResponse:
    try:
        await transport.discover()
    except (AdapterError, ValueError):
        transport.ready = False
    return JSONResponse(
        status_code=200 if transport.ready else 503,
        content={
            "status": "ready" if transport.ready else "not_ready",
            "jupyter_profile": transport.profile if transport.ready else None,
        },
    )


@app.get("/api/v1/config")
async def public_config() -> dict[str, str]:
    """Return only the immutable, non-secret notebook startup selection."""
    return {"path": settings.startup_notebook(), "kernel": settings.kernel_name}


@app.post("/api/v1/commands", response_model=CommandResult)
async def command_endpoint(command: Command, request: Request) -> CommandResult:
    path = request_notebook(request)
    if command.type == "setup" and not request.headers.get("x-notebook-path"):
        path = settings.confined_path(command.path or "")
    active = False
    try:
        active = begin_command(command, path, client_token(request))
        result = await run_command(command, request)
        if command.type == "rename_notebook" and result.snapshot is not None:
            new_path = settings.confined_path(command.path or "")
            collaboration.rename(path, new_path)
            path = new_path
        if result.snapshot is not None and (active or collaboration.room(path).snapshot is None):
            collaboration.publish(path, client_token(request), result.snapshot)
        return result
    except AdapterError as error:
        return CommandResult(
            command_id=command.command_id,
            idempotency_key=command.idempotency_key,
            error=GatewayError(code=error.code, message=error.message, retryable=error.retryable),
        )
    finally:
        if active:
            collaboration.room(path).active -= 1


async def run_command(command: Command, request: Request) -> CommandResult:
    global current_notebook
    notebook_path = request_notebook(request)
    if command.type == "setup" and not request.headers.get("x-notebook-path"):
        notebook_path = settings.confined_path(command.path or "")
    room = collaboration.room(notebook_path)
    if command.type in {"query", "reconnect"} and room.active and room.snapshot is not None:
        # Reading during execution must not wait behind the kernel lock.
        return CommandResult(
            command_id=command.command_id,
            idempotency_key=command.idempotency_key,
            base_revision=command.expected_revision,
            committed_revision=room.snapshot["revision"],
            snapshot=room.snapshot,
        )
    cache_key = f"{notebook_path}:{client_token(request)}:{command.idempotency_key}"
    cached = result_cache.get(cache_key)
    if cached is not None:
        return cached
    base_revision = None
    try:
        if command.kernel and command.kernel != settings.kernel_name:
            raise AdapterError("unsupported_operation", "Kernel is fixed at startup")
        if not transport.ready:
            await transport.discover()
        if command.type == "setup":
            requested_path = settings.confined_path(command.path or "")
            if request.headers.get("x-notebook-path") and requested_path != notebook_path:
                raise AdapterError(
                    "invalid_input", "Notebook identity does not match request scope"
                )
            notebook_path = requested_path
        if notebook_path in transport.revisions:
            base_revision = transport.revisions[notebook_path][1]
        if (
            command.expected_revision is not None
            and base_revision is not None
            and command.expected_revision != base_revision
        ):
            raise AdapterError(
                "stale_revision", "Notebook revision changed; refresh and retry", True
            )
        raw = await transport.execute(command, notebook_path)
        if command.type == "setup" and not request.headers.get("x-notebook-path"):
            current_notebook = notebook_path
        if command.type == "rename_notebook":
            notebook_path = settings.confined_path(command.path or "")
        if command.type in {"complete", "inspect"}:
            result = CommandResult(
                command_id=command.command_id,
                idempotency_key=command.idempotency_key,
                base_revision=base_revision,
                committed_revision=base_revision,
                completion=raw if command.type == "complete" else None,
                inspection=raw if command.type == "inspect" else None,
            )
            result_cache[cache_key] = result
            return result
        if command.type != "interrupt_kernel":
            query = command.model_copy(update={"type": "query", "query": "full"})
            raw = await transport.execute(query, notebook_path)
        result = snapshot_result(command, raw, notebook_path, base_revision)
    except AdapterError as error:
        result = CommandResult(
            command_id=command.command_id,
            idempotency_key=command.idempotency_key,
            base_revision=base_revision,
            error=GatewayError(code=error.code, message=error.message, retryable=error.retryable),
        )
    result_cache[cache_key] = result
    return result


@app.post("/api/v1/commands/stream")
async def command_stream(command: Command, request: Request) -> StreamingResponse:
    notebook_path = request_notebook(request)
    cache_key = f"{notebook_path}:{client_token(request)}:{command.idempotency_key}"

    async def events() -> AsyncIterator[str]:
        if command.type != "execute_cell":
            error = CommandResult(
                command_id=command.command_id,
                idempotency_key=command.idempotency_key,
                error=GatewayError(
                    code="unsupported_operation",
                    message="Only cell execution supports streaming",
                    retryable=False,
                ),
            )
            yield f"{error.model_dump_json()}\n"
            return
        cached = result_cache.get(cache_key)
        if cached is not None:
            yield f"{cached.model_dump_json()}\n"
            return
        base_revision = None
        try:
            if not transport.ready:
                await transport.discover()
            if notebook_path in transport.revisions:
                base_revision = transport.revisions[notebook_path][1]
            if (
                command.expected_revision is not None
                and base_revision is not None
                and command.expected_revision != base_revision
            ):
                raise AdapterError(
                    "stale_revision", "Notebook revision changed; refresh and retry", True
                )
            final: CommandResult | None = None
            async for raw in transport.execute_stream(command, notebook_path):
                final = snapshot_result(
                    command, raw, notebook_path, base_revision, kernel_state="busy"
                )
                yield f"{final.model_dump_json()}\n"
            if final is None or final.snapshot is None:
                raise AdapterError("malformed_response", "Execution returned no notebook state")
            final.snapshot["kernel"]["state"] = "idle"
            result_cache[cache_key] = final
            yield f"{final.model_dump_json()}\n"
        except AdapterError as error:
            result = CommandResult(
                command_id=command.command_id,
                idempotency_key=command.idempotency_key,
                base_revision=base_revision,
                error=GatewayError(
                    code=error.code, message=error.message, retryable=error.retryable
                ),
            )
            yield f"{result.model_dump_json()}\n"

    async def guarded_events() -> AsyncIterator[str]:
        active = False
        try:
            active = begin_command(command, notebook_path, client_token(request))
            async for line in events():
                result = CommandResult.model_validate_json(line)
                if result.snapshot is not None:
                    collaboration.publish(notebook_path, client_token(request), result.snapshot)
                yield line
        except AdapterError as error:
            result = CommandResult(
                command_id=command.command_id,
                idempotency_key=command.idempotency_key,
                error=GatewayError(
                    code=error.code, message=error.message, retryable=error.retryable
                ),
            )
            yield f"{result.model_dump_json()}\n"
        finally:
            if active:
                collaboration.room(notebook_path).active -= 1

    # Accepted execution belongs to the notebook, not the requesting socket.
    # A driver reload must not release ownership while its kernel still runs.
    queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=16)

    def enqueue(line: str | None) -> None:
        if queue.full():
            queue.get_nowait()
        queue.put_nowait(line)

    async def produce() -> None:
        try:
            async for line in guarded_events():
                enqueue(line)
        except Exception:
            failure = CommandResult(
                command_id=command.command_id,
                idempotency_key=command.idempotency_key,
                error=GatewayError(
                    code="transport_error",
                    message="Execution connection failed; refresh before retrying",
                    retryable=True,
                ),
            )
            enqueue(f"{failure.model_dump_json()}\n")
        finally:
            enqueue(None)

    task = asyncio.create_task(produce())
    executions.add(task)
    task.add_done_callback(executions.discard)

    async def consume() -> AsyncIterator[str]:
        while (line := await queue.get()) is not None:
            yield line

    return StreamingResponse(
        consume(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@app.get("/api/v1/download")
async def download_notebook(request: Request) -> Response:
    notebook_path = request_notebook(request)
    notebook = await transport.execute(
        Command(
            type="query",
            protocol_version=1,
            command_id=uuid4(),
            idempotency_key="download",
            timeout_ms=30000,
            query="full",
        ),
        notebook_path,
    )
    encoded = json.dumps(notebook).encode()
    if len(encoded) > settings.response_limit:
        return JSONResponse(status_code=413, content={"code": "bounds_exceeded"})
    return Response(
        encoded,
        media_type="application/x-ipynb+json",
        headers={"Content-Disposition": 'attachment; filename="notebook.ipynb"'},
    )


@app.exception_handler(json.JSONDecodeError)
async def malformed(_: Request, __: json.JSONDecodeError) -> JSONResponse:
    return JSONResponse(
        status_code=400, content={"code": "invalid_input", "message": "Malformed JSON"}
    )


@app.exception_handler(ValueError)
async def invalid_path(_: Request, __: ValueError) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={
            "code": "path_rejected",
            "message": "Choose a notebook inside the configured workspace",
        },
    )


@app.get("/api/v1/notebooks")
async def notebooks(directory: str = "") -> JSONResponse:
    try:
        return JSONResponse(await transport.list_notebooks(directory))
    except AdapterError as error:
        return JSONResponse(status_code=400, content={"code": error.code, "message": error.message})


@app.exception_handler(AdapterError)
async def collaboration_error(_: Request, error: AdapterError) -> JSONResponse:
    return JSONResponse(status_code=403, content={"code": error.code, "message": error.message})


@app.post("/api/v1/collaboration/join")
async def join_notebook(request: Request) -> JSONResponse:
    return JSONResponse(
        collaboration.join(request_notebook(request)), headers={"Cache-Control": "no-store"}
    )


class FollowViewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocol_version: int = Field(ge=1, le=1)
    notebook_path: str = Field(min_length=1, max_length=512)
    scroll_fraction: float = Field(ge=0, le=1, allow_inf_nan=False)


@app.post("/api/v1/collaboration/view")
async def publish_view(view: FollowViewInput, request: Request) -> dict[str, bool]:
    collaboration.publish_view(
        request_notebook(request),
        client_token(request),
        settings.confined_path(view.notebook_path),
        request.headers.get("x-notebook-target-client", ""),
        view.scroll_fraction,
    )
    return {"ok": True}


@app.get("/api/v1/collaboration/view")
async def follow_view(request: Request, after: int = -1) -> JSONResponse:
    return JSONResponse(
        await collaboration.wait_view(request_notebook(request), client_token(request), after),
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/v1/collaboration/events")
async def collaboration_events(request: Request, after: int = -1) -> JSONResponse:
    return JSONResponse(
        await collaboration.wait(
            collaboration.event_path(request_notebook(request), client_token(request)),
            client_token(request),
            after,
        ),
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/v1/collaboration/driver/{target}")
async def change_driver(target: str, request: Request) -> dict[str, bool]:
    path = request_notebook(request)
    collaboration.require_driver(path, client_token(request))
    collaboration.change_driver(path, target)
    return {"ok": True}


@app.post("/api/v1/collaboration/leave")
async def leave_notebook(request: Request) -> dict[str, bool]:
    collaboration.leave(request_notebook(request), client_token(request))
    return {"ok": True}


if settings.static_dir is not None:
    app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="frontend")
