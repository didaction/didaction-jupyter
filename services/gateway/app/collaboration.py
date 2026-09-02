"""Single-process notebook ownership and latest-state fanout, independent of HTTP.

Capabilities are private, public client IDs are not credentials. Full snapshots
coalesce safely: a slow reader receives the latest state, not an unbounded queue.
"""

import asyncio
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .jupyter_adapter import AdapterError


@dataclass
class Member:
    client_id: str
    touched: float
    departed: bool = False


@dataclass
class Room:
    members: dict[str, Member] = field(default_factory=dict)
    driver: str | None = None
    sequence: int = 0
    snapshot: dict[str, Any] | None = None
    origin: str | None = None
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    active: int = 0


def first_connected(clients: list[str]) -> str | None:
    return clients[0] if clients else None


class Collaboration:
    def __init__(
        self,
        elect: Callable[[list[str]], str | None] = first_connected,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.rooms: dict[str, Room] = {}
        self.redirects: dict[tuple[str, str], str] = {}
        self.elect = elect
        self.clock = clock

    def notify(self, room: Room) -> None:
        room.sequence += 1
        room.changed.set()
        room.changed = asyncio.Event()

    def room(self, path: str) -> Room:
        if path not in self.rooms and len(self.rooms) >= 256:
            raise AdapterError("bounds_exceeded", "Gateway session limit reached; restart gateway")
        room = self.rooms.setdefault(path, Room())
        # Never transfer ownership while an accepted command is running.
        if not room.active:
            expired = [
                k for k, m in room.members.items() if m.departed or self.clock() - m.touched > 45
            ]
            for token in expired:
                del room.members[token]
            clients = [m.client_id for m in room.members.values()]
            if room.driver not in clients:
                room.driver = self.elect(clients)
            if expired:
                self.notify(room)
        return room

    def join(self, path: str) -> dict[str, Any]:
        room = self.room(path)
        if len(room.members) >= 32:
            raise AdapterError("bounds_exceeded", "Notebook collaborator limit reached")
        token = secrets.token_urlsafe(32)
        member = Member(secrets.token_hex(12), self.clock())
        room.members[token] = member
        if room.driver is None:
            room.driver = self.elect([m.client_id for m in room.members.values()])
        self.notify(room)
        return {"token": token, **self.state(path, token)}

    def member(self, path: str, token: str) -> Member:
        member = self.room(path).members.get(token)
        if member is None or member.departed:
            raise AdapterError("not_driver", "Reconnect to join this notebook", True)
        member.touched = self.clock()
        return member

    def require_driver(self, path: str, token: str) -> None:
        member = self.member(path, token)
        if self.room(path).driver != member.client_id:
            raise AdapterError("not_driver", "Read-only: only the notebook driver may change it")

    def change_driver(self, path: str, client_id: str) -> None:
        """Policy-neutral handoff. The calling adapter must authorize the caller."""
        room = self.room(path)
        if room.active:
            raise AdapterError(
                "execution_rejected", "Wait for the active command before handoff", True
            )
        if client_id not in [m.client_id for m in room.members.values()]:
            raise AdapterError("invalid_input", "Target collaborator is not connected")
        room.driver = client_id
        self.notify(room)

    def rename(self, old: str, new: str) -> None:
        room = self.rooms.pop(old)
        self.rooms[new] = room
        for key, target in list(self.redirects.items()):
            if target == old:
                self.redirects[key] = new
        for token in room.members:
            self.redirects[(old, token)] = new
        self.notify(room)

    def event_path(self, path: str, token: str) -> str:
        # Only event readers follow an authorized rename. Commands at an old
        # notebook address are never silently forwarded to a different file.
        return self.redirects.get((path, token), path)

    def leave(self, path: str, token: str) -> None:
        member = self.member(path, token)
        member.departed = True
        self.room(path)

    def publish(self, path: str, token: str, snapshot: dict[str, Any]) -> None:
        room = self.room(path)
        if room.snapshot is not None and snapshot.get("revision", -1) < room.snapshot.get(
            "revision", -1
        ):
            return
        room.snapshot = snapshot
        room.origin = room.members[token].client_id if token in room.members else None
        self.notify(room)

    def state(self, path: str, token: str) -> dict[str, Any]:
        member = self.member(path, token)
        room = self.room(path)
        return {
            "notebook_path": path,
            "client_id": member.client_id,
            "driver_id": room.driver,
            "is_driver": room.driver == member.client_id,
            "clients": [m.client_id for m in room.members.values()],
            "sequence": room.sequence,
            "origin": room.origin,
            "snapshot": room.snapshot,
        }

    async def wait(self, path: str, token: str, after: int) -> dict[str, Any]:
        self.member(path, token)
        room = self.room(path)
        if room.sequence <= after:
            try:
                await asyncio.wait_for(room.changed.wait(), 10)
            except TimeoutError:
                pass
        return self.state(self.event_path(path, token), token)
