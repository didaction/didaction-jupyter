import asyncio
from typing import Any
from uuid import uuid4

import httpx
import pytest

from services.gateway.app import main
from services.gateway.app.collaboration import Collaboration
from services.gateway.app.jupyter_adapter import AdapterError


def test_driver_handoff_lease_and_notebook_scope() -> None:
    now = [0.0]
    hub = Collaboration(clock=lambda: now[0])
    first = hub.join("one.ipynb")
    second = hub.join("one.ipynb")
    other = hub.join("two.ipynb")
    assert first["is_driver"] and not second["is_driver"] and not other["is_driver"]
    with pytest.raises(AdapterError):
        hub.require_driver("one.ipynb", second["token"])
    with pytest.raises(AdapterError):
        hub.require_driver("two.ipynb", first["token"])
    joined = hub.join("two.ipynb", first["token"])
    assert joined["client_id"] == first["client_id"] and joined["is_driver"]
    hub.change_driver("one.ipynb", second["client_id"])
    hub.require_driver("one.ipynb", second["token"])
    with pytest.raises(AdapterError):
        hub.require_driver("one.ipynb", first["token"])
    with pytest.raises(AdapterError):
        hub.require_driver("two.ipynb", first["token"])
    hub.join("two.ipynb", second["token"])
    hub.require_driver("two.ipynb", second["token"])
    now[0] = 40
    hub.member("one.ipynb", first["token"])
    now[0] = 46
    hub.require_driver("one.ipynb", first["token"])


def test_policy_is_replaceable_and_handoff_waits_for_commands() -> None:
    hub = Collaboration(elect=lambda clients: None)
    first = hub.join("one.ipynb")
    assert not first["is_driver"]
    hub.change_driver("one.ipynb", first["client_id"])
    hub.rooms["one.ipynb"].active = 1
    with pytest.raises(AdapterError):
        hub.change_driver("one.ipynb", first["client_id"])


def test_workspace_identity_survives_partial_close_and_handoff_checks_all_commands() -> None:
    hub = Collaboration()
    driver = hub.join("a.ipynb")
    hub.join("b.ipynb", driver["token"])
    observer = hub.join("c.ipynb")
    assert not observer["is_driver"]
    assert observer["driver_id"] == driver["client_id"]
    with pytest.raises(AdapterError):
        hub.join("d.ipynb", "forged")
    hub.leave("a.ipynb", driver["token"])
    hub.require_driver("b.ipynb", driver["token"])
    hub.rooms["b.ipynb"].active = 1
    with pytest.raises(AdapterError):
        hub.change_driver("c.ipynb", observer["client_id"])
    hub.rooms["b.ipynb"].active = 0
    hub.change_driver("b.ipynb", observer["client_id"])
    hub.require_driver("c.ipynb", observer["token"])
    assert not hub.state("b.ipynb", driver["token"])["is_driver"]


@pytest.mark.asyncio
async def test_follow_is_workspace_wide_even_without_shared_notebooks() -> None:
    hub = Collaboration()
    driver = hub.join("a.ipynb")
    observer = hub.join("b.ipynb")
    hub.publish_view("a.ipynb", driver["token"], "a.ipynb", driver["token"], 0.5, "cell")
    view = (await hub.wait_view("b.ipynb", observer["token"], -1))["view"]
    assert view["notebook_path"] == "a.ipynb"
    assert view["selected_cell_id"] == "cell"


@pytest.mark.asyncio
async def test_rename_moves_ownership_and_waiting_subscription() -> None:
    hub = Collaboration()
    member = hub.join("old.ipynb")
    task = asyncio.create_task(hub.wait("old.ipynb", member["token"], member["sequence"]))
    await asyncio.sleep(0)
    hub.rename("old.ipynb", "new.ipynb")
    assert (await task)["notebook_path"] == "new.ipynb"
    hub.require_driver("new.ipynb", member["token"])
    with pytest.raises(AdapterError):
        hub.require_driver("old.ipynb", member["token"])
    assert hub.event_path("old.ipynb", member["token"]) == "new.ipynb"
    assert hub.event_path("old.ipynb", "wrong-token") == "old.ipynb"


@pytest.mark.asyncio
async def test_fanout_wakes_all_readers_and_coalesces_clear_output() -> None:
    hub = Collaboration()
    driver = hub.join("one.ipynb")
    observers = [hub.join("one.ipynb") for _ in range(2)]
    seq = hub.rooms["one.ipynb"].sequence
    tasks = [asyncio.create_task(hub.wait("one.ipynb", m["token"], seq)) for m in observers]
    await asyncio.sleep(0)
    hub.publish("one.ipynb", driver["token"], {"cells": [{"outputs": ["old"]}]})
    hub.publish("one.ipynb", driver["token"], {"cells": [{"outputs": []}]})
    for state in await asyncio.gather(*tasks):
        assert state["snapshot"]["cells"][0]["outputs"] == []
        assert "token" not in state


@pytest.mark.asyncio
async def test_http_observer_cannot_mutate_execute_or_handoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main, "collaboration", Collaboration())
    headers = {"x-notebook-path": "shared.ipynb"}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app), base_url="http://test"
    ) as client:
        driver = (await client.post("/api/v1/collaboration/join", headers=headers)).json()
        observer = (await client.post("/api/v1/collaboration/join", headers=headers)).json()
        observer_headers = {**headers, "x-notebook-client": observer["token"]}
        cases: list[tuple[str, dict[str, Any]]] = [
            ("modify_cells", {"changes": [{"operation": "delete", "cell_id": "cell"}]}),
            ("execute_cell", {"cell_id": "cell"}),
            ("interrupt_kernel", {}),
            ("restart_kernel", {}),
            ("setup", {"path": "shared.ipynb", "create": True}),
            ("create_checkpoint", {}),
            ("rename_notebook", {"path": "new.ipynb"}),
        ]
        for kind, values in cases:
            body = {
                "protocol_version": 1,
                "command_id": str(uuid4()),
                "idempotency_key": "same-key",
                "timeout_ms": 1000,
                "type": kind,
                **values,
            }
            result = await client.post("/api/v1/commands", headers=observer_headers, json=body)
            assert result.json()["error"]["code"] == "not_driver"
            if kind == "execute_cell":
                stream = await client.post(
                    "/api/v1/commands/stream", headers=observer_headers, json=body
                )
                assert stream.json()["error"]["code"] == "not_driver"
        denied = await client.post(
            f"/api/v1/collaboration/driver/{observer['client_id']}", headers=observer_headers
        )
        assert denied.status_code == 403
        allowed = await client.post(
            f"/api/v1/collaboration/driver/{observer['client_id']}",
            headers={**headers, "x-notebook-client": driver["token"]},
        )
        assert allowed.status_code == 200
        main.collaboration.require_driver("shared.ipynb", observer["token"])
        denied = await client.post(
            "/api/v1/collaboration/join", headers={**headers, "origin": "http://evil"}
        )
        assert denied.status_code == 403
