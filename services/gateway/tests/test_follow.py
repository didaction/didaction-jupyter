import asyncio
from uuid import uuid4

import httpx
import pytest

from services.gateway.app import main
from services.gateway.app.collaboration import Collaboration
from services.gateway.app.jupyter_adapter import AdapterError


@pytest.mark.asyncio
async def test_follow_presence_is_authorized_and_separate_from_notebook_updates() -> None:
    hub = Collaboration()
    driver = hub.join("a.ipynb")
    observer = hub.join("a.ipynb")
    target = hub.join("b.ipynb", driver["token"])
    revision_events = hub.rooms["a.ipynb"].sequence
    waiter = asyncio.create_task(
        hub.wait_view("a.ipynb", observer["token"], hub.presence.view_sequence)
    )
    await asyncio.sleep(0)
    hub.publish_view("a.ipynb", driver["token"], "b.ipynb", target["token"], 0.75, "cell-2")
    event = await waiter
    assert event["view"]["notebook_path"] == "b.ipynb"
    assert event["view"]["scroll_fraction"] == 0.75
    assert event["view"]["selected_cell_id"] == "cell-2"
    sequence = event["sequence"]
    hub.publish_view("a.ipynb", driver["token"], "b.ipynb", target["token"], 0.75, "cell-3")
    assert (await hub.wait_view("a.ipynb", observer["token"], sequence))["view"][
        "selected_cell_id"
    ] == "cell-3"
    assert "snapshot" not in event and "token" not in str(event)
    assert hub.rooms["a.ipynb"].sequence == revision_events
    for source_token, target_token, fraction in [
        (observer["token"], target["token"], 0.1),
        (driver["token"], "wrong", 0.1),
        (driver["token"], target["token"], float("nan")),
        (driver["token"], target["token"], 2),
    ]:
        with pytest.raises(AdapterError):
            hub.publish_view("a.ipynb", source_token, "b.ipynb", target_token, fraction)
    hub.change_driver("a.ipynb", observer["client_id"])
    assert (await hub.wait_view("a.ipynb", observer["token"], -1))["view"] is None


@pytest.mark.asyncio
async def test_follow_http_input_is_confined_and_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "collaboration", Collaboration())
    path = f"follow-{uuid4()}.ipynb"
    member = main.collaboration.join(path)
    headers = {
        "x-notebook-path": path,
        "x-notebook-client": member["token"],
        "x-notebook-target-client": member["token"],
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app), base_url="http://test"
    ) as client:
        body = {"protocol_version": 1, "notebook_path": path, "scroll_fraction": 0.5}
        assert (
            await client.post("/api/v1/collaboration/view", headers=headers, json=body)
        ).status_code == 200
        for invalid_id in ["", "x" * 129, 42]:
            assert (
                await client.post(
                    "/api/v1/collaboration/view",
                    headers=headers,
                    json={**body, "selected_cell_id": invalid_id},
                )
            ).status_code == 422
        assert (
            await client.post(
                "/api/v1/collaboration/view", headers=headers, json={**body, "scroll_fraction": 2}
            )
        ).status_code == 422
        assert (
            await client.post(
                "/api/v1/collaboration/view",
                headers=headers,
                json={**body, "notebook_path": "../escape.ipynb"},
            )
        ).status_code == 400
