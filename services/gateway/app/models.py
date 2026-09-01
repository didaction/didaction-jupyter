from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Command(StrictModel):
    protocol_version: Literal[1]
    command_id: UUID
    idempotency_key: str = Field(min_length=1, max_length=128)
    expected_revision: int | None = Field(default=None, ge=0)
    timeout_ms: int = Field(gt=0, le=120_000)
    type: Literal[
        "setup",
        "query",
        "modify_cells",
        "execute_cell",
        "execute_code",
        "interrupt_kernel",
        "restart_kernel",
        "complete",
        "reconnect",
        "close",
    ]
    path: str | None = Field(default=None, max_length=512)
    kernel: str | None = Field(default=None, max_length=128)
    create: bool | None = None
    query: Literal["summary", "cells", "full"] | None = None
    changes: list[dict[str, Any]] | None = Field(default=None, max_length=256)
    cell_id: str | None = Field(default=None, max_length=128)
    code: str | None = Field(default=None, max_length=262_144)
    cursor_pos: int | None = Field(default=None, ge=0, le=262_144)

    @model_validator(mode="after")
    def required_by_type(self) -> "Command":
        if self.type == "setup" and self.path is None:
            raise ValueError("setup requires path")
        if self.type == "modify_cells" and not self.changes:
            raise ValueError("modify_cells requires changes")
        if self.type == "execute_cell" and not self.cell_id:
            raise ValueError("execute_cell requires cell_id")
        if self.type == "complete" and self.code is None:
            raise ValueError("complete requires code")
        return self


class GatewayError(StrictModel):
    code: str
    message: str
    retryable: bool = False


class CommandResult(StrictModel):
    protocol_version: Literal[1] = 1
    command_id: UUID
    idempotency_key: str
    base_revision: int | None = None
    committed_revision: int | None = None
    snapshot: dict[str, Any] | None = None
    completion: dict[str, Any] | None = None
    error: GatewayError | None = None
