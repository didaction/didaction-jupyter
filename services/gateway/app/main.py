import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

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


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings.workspace.mkdir(parents=True, exist_ok=True)
    try:
        await transport.discover()
    except AdapterError as error:
        logger.error("Jupyter compatibility check failed: %s", error.code)
    yield
    await transport.close()


app = FastAPI(title="didaction notebook gateway", version="1", lifespan=lifespan)


@app.middleware("http")
async def bounds(request: Request, call_next: Any) -> Any:
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
    return JSONResponse(
        status_code=200 if transport.ready else 503,
        content={
            "status": "ready" if transport.ready else "not_ready",
            "jupyter_profile": transport.profile if transport.ready else None,
        },
    )


@app.post("/api/v1/commands", response_model=CommandResult)
async def command_endpoint(command: Command) -> CommandResult:
    global current_notebook
    cached = result_cache.get(command.idempotency_key)
    if cached is not None:
        return cached
    base_revision = None
    try:
        if not transport.ready:
            await transport.discover()
        if command.type == "setup":
            current_notebook = settings.confined_path(command.path or "")
        if current_notebook and current_notebook in transport.revisions:
            base_revision = transport.revisions[current_notebook][1]
        if (
            command.expected_revision is not None
            and base_revision is not None
            and command.expected_revision != base_revision
        ):
            raise AdapterError(
                "stale_revision", "Notebook revision changed; refresh and retry", True
            )
        raw = await transport.execute(command, current_notebook)
        if command.type == "complete":
            result = CommandResult(
                command_id=command.command_id,
                idempotency_key=command.idempotency_key,
                base_revision=base_revision,
                committed_revision=base_revision,
                completion=raw,
            )
            result_cache[command.idempotency_key] = result
            return result
        if current_notebook is None:
            raise AdapterError("invalid_input", "No notebook is open")
        query = command.model_copy(update={"type": "query", "query": "full"})
        raw = await transport.execute(query, current_notebook)
        cells = normalize_cells(raw)
        revision = transport.revision_for(current_notebook, cells)
        snapshot = {
            "protocol_version": 1,
            "schema_version": 1,
            "notebook": {"path": current_notebook, "workspace": "local"},
            "kernel": {
                "name": command.kernel or "python3",
                "display_name": command.kernel or "Python 3 (ipykernel)",
                "session_id": None,
                "state": "idle",
            },
            "revision": revision,
            "cells": cells,
            "selected_cell_id": cells[0]["id"] if cells else None,
        }
        result = CommandResult(
            command_id=command.command_id,
            idempotency_key=command.idempotency_key,
            base_revision=base_revision,
            committed_revision=revision,
            snapshot=snapshot,
        )
    except AdapterError as error:
        result = CommandResult(
            command_id=command.command_id,
            idempotency_key=command.idempotency_key,
            base_revision=base_revision,
            error=GatewayError(code=error.code, message=error.message, retryable=error.retryable),
        )
    result_cache[command.idempotency_key] = result
    return result


@app.exception_handler(json.JSONDecodeError)
async def malformed(_: Request, __: json.JSONDecodeError) -> JSONResponse:
    return JSONResponse(
        status_code=400, content={"code": "invalid_input", "message": "Malformed JSON"}
    )
