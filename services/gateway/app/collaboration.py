"""Single-process notebook ownership and latest-state fanout, independent of HTTP.

Capabilities are private, public client IDs are not credentials. Full snapshots
coalesce safely: a slow reader receives the latest state, not an unbounded queue.
"""

import asyncio
import math
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
    view: dict[str, Any] | None = None
    view_sequence: int = 0
    view_changed: asyncio.Event = field(default_factory=asyncio.Event)


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
        self.members: dict[str, Member] = {}
        self.driver: str | None = None
        self.presence = Room()

    def refresh_members(self) -> None:
        if any(room.active for room in self.rooms.values()):
            return
        expired = [
            token
            for token, member in self.members.items()
            if member.departed or self.clock() - member.touched > 45
        ]
        for token in expired:
            del self.members[token]
            for room in self.rooms.values():
                room.members.pop(token, None)
        clients = [member.client_id for member in self.members.values()]
        elected = self.driver if self.driver in clients else self.elect(clients)
        if expired or elected != self.driver:
            self.set_driver(elected)

    def set_driver(self, client_id: str | None) -> None:
        changed = self.driver != client_id
        self.driver = client_id
        if changed:
            self.clear_view(self.presence)
        for room in self.rooms.values():
            room.driver = client_id
            self.notify(room)

    def notify(self, room: Room) -> None:
        room.sequence += 1
        room.changed.set()
        room.changed = asyncio.Event()

    def room(self, path: str) -> Room:
        self.refresh_members()
        if path not in self.rooms and len(self.rooms) >= 256:
            raise AdapterError("bounds_exceeded", "Gateway session limit reached; restart gateway")
        return self.rooms.setdefault(path, Room(driver=self.driver))

    def join(self, path: str, token: str = "") -> dict[str, Any]:
        room = self.room(path)
        if token:
            member = self.members.get(token)
            if member is None or member.departed:
                raise AdapterError("not_driver", "Workspace session expired; reconnect", True)
            member.touched = self.clock()
        else:
            if len(self.members) >= 32:
                raise AdapterError("bounds_exceeded", "Workspace collaborator limit reached")
            token = secrets.token_urlsafe(32)
            member = Member(secrets.token_hex(12), self.clock())
            self.members[token] = member
        room.members[token] = member
        self.set_driver(self.driver or self.elect([m.client_id for m in self.members.values()]))
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
        self.room(path)
        if any(room.active for room in self.rooms.values()):
            raise AdapterError(
                "execution_rejected", "Wait for the active command before handoff", True
            )
        if client_id not in [m.client_id for m in self.members.values() if not m.departed]:
            raise AdapterError("invalid_input", "Target collaborator is not connected")
        self.set_driver(client_id)

    def clear_view(self, room: Room) -> None:
        room.view = None
        room.view_sequence += 1
        room.view_changed.set()
        room.view_changed = asyncio.Event()

    def publish_view(
        self,
        path: str,
        token: str,
        target: str,
        target_token: str,
        fraction: float,
        selected_cell_id: str | None = None,
    ) -> None:
        """Transport-neutral presence; neither notebook contents nor revisions change.

        The publisher must drive both the anchor and active notebook. This proves
        continuity across notebook-scoped identities without trusting a public ID.
        """
        self.require_driver(path, token)
        self.require_driver(target, target_token)
        if not math.isfinite(fraction) or not 0 <= fraction <= 1:
            raise AdapterError("invalid_input", "Scroll fraction must be between zero and one")
        if selected_cell_id is not None and (
            not isinstance(selected_cell_id, str) or not 1 <= len(selected_cell_id) <= 128
        ):
            raise AdapterError("invalid_input", "Invalid followed cell ID")
        room = self.presence
        view = {
            "protocol_version": 1,
            "notebook_path": target,
            "scroll_fraction": fraction,
            "selected_cell_id": selected_cell_id,
            "driver_id": self.driver,
        }
        if room.view == view:
            return
        room.view = view
        room.view_sequence += 1
        room.view_changed.set()
        room.view_changed = asyncio.Event()

    async def wait_view(self, path: str, token: str, after: int) -> dict[str, Any]:
        self.member(path, token)
        room = self.presence
        if room.view_sequence <= after:
            try:
                await asyncio.wait_for(room.view_changed.wait(), 10)
            except TimeoutError:
                pass
        self.member(path, token)
        return {"sequence": room.view_sequence, "view": room.view}

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
        self.rooms[path].members.pop(token, None)
        if not any(token in room.members for room in self.rooms.values()):
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
            "clients": [m.client_id for m in self.members.values() if not m.departed],
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
