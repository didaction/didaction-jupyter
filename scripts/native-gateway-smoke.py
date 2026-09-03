"""Real native gateway contract checks. Only temporary notebooks from smoke.sh."""

import json
import os
import time
import uuid

import httpx


def command(kind: str, **kwargs: object) -> dict:
    return {
        "protocol_version": 1,
        "command_id": str(uuid.uuid4()),
        "idempotency_key": str(uuid.uuid4()),
        "expected_revision": None,
        "timeout_ms": 30000,
        "type": kind,
        **kwargs,
    }


with httpx.Client(base_url=os.environ["DIDACTION_GATEWAY_URL"], timeout=45) as client:
    path = "native-contract.ipynb"
    a = {"x-notebook-path": path}
    joined = client.post("/api/v1/collaboration/join", headers=a).json()
    a["x-notebook-client"] = joined["token"]
    assert joined["is_driver"], joined
    b = {"x-notebook-path": "other.ipynb"}
    observer = client.post("/api/v1/collaboration/join", headers=b).json()
    b["x-notebook-client"] = observer["token"]
    assert not observer["is_driver"], observer

    def call(kind: str, **kwargs: object) -> dict:
        value = client.post("/api/v1/commands", headers=a, json=command(kind, **kwargs)).json()
        assert not value.get("error"), value
        return value

    state = call("setup", path=path, kernel="python3", create=True)
    for endpoint in ["commands", "commands/stream"]:
        denied = client.post(
            f"/api/v1/{endpoint}",
            headers=b,
            json=command("execute_cell", cell_id="x"),
        ).text
        assert "not_driver" in denied, denied
    # Public IDs are not private capabilities.
    forged = client.post(
        "/api/v1/commands",
        headers={**a, "x-notebook-client": joined["client_id"]},
        json=command("restart_kernel"),
    ).json()
    assert forged["error"]["code"] == "not_driver", forged

    cell = state["snapshot"]["cells"][0]["id"]
    change = command(
        "modify_cells", changes=[{"operation": "update", "cell_id": cell, "source": "x = 42\nx"}]
    )
    first = client.post("/api/v1/commands", headers=a, json=change).json()
    assert not first.get("error"), first
    assert client.post("/api/v1/commands", headers=a, json=change).json() == first
    changed_key = {**change, "changes": [{"operation": "delete", "cell_id": cell}]}
    assert (
        client.post("/api/v1/commands", headers=a, json=changed_key).json()["error"]["code"]
        == "duplicate_command"
    )
    stale = client.post(
        "/api/v1/commands",
        headers=a,
        json=command(
            "modify_cells", expected_revision=0, changes=[{"operation": "delete", "cell_id": cell}]
        ),
    ).json()
    assert stale["error"]["code"] == "stale_revision", stale
    state = call("execute_cell", cell_id=cell)
    assert "42" in json.dumps(state["snapshot"]["cells"][0]["outputs"])
    assert call("inspect", code="len", cursor_pos=3)["inspection"]["found"]
    call("create_checkpoint")
    exported = client.get("/api/v1/download", headers=a)
    assert exported.json()["nbformat"] == 4
    assert path in client.get("/api/v1/notebooks").text
    for bad in ["../secret", "/secret", "a%2f..%2fb", ".secret", "a\\b"]:
        response = client.get("/api/v1/notebooks", params={"directory": bad})
        assert response.status_code == 400, bad
    assert (
        client.post(
            "/api/v1/commands", headers=a, json=command("query", query="full", protocol_version=2)
        ).json()["error"]["code"]
        == "unsupported_version"
    )
    assert (
        client.post(
            "/api/v1/collaboration/join", headers={"origin": "https://untrusted.invalid"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/v1/commands",
            headers={**a, "content-type": "application/json"},
            content='{"data":"' + "a" * 310000 + '"}',
        ).status_code
        == 413
    )

    joined_other = client.post(
        "/api/v1/collaboration/join", headers={**a, "x-notebook-path": "other.ipynb"}
    ).json()
    assert joined_other["is_driver"]
    view = {
        "protocol_version": 1,
        "notebook_path": "other.ipynb",
        "scroll_fraction": 0.4,
        "selected_cell_id": cell,
    }
    assert client.post(
        "/api/v1/collaboration/view",
        headers={**a, "x-notebook-target-client": a["x-notebook-client"]},
        json=view,
    ).json()["ok"]
    assert (
        client.get("/api/v1/collaboration/view", headers=b).json()["view"]["selected_cell_id"]
        == cell
    )
    assert client.post(f"/api/v1/collaboration/driver/{observer['client_id']}", headers=a).json()[
        "ok"
    ]
    assert (
        client.post("/api/v1/commands", headers=a, json=command("restart_kernel")).json()["error"][
            "code"
        ]
        == "not_driver"
    )
    assert client.post(f"/api/v1/collaboration/driver/{joined['client_id']}", headers=b).json()[
        "ok"
    ]

    # Socket departure must not cancel execution or allow premature ownership handoff.
    call(
        "modify_cells",
        changes=[
            {
                "operation": "update",
                "cell_id": cell,
                "source": (
                    "import time\nprint('before', flush=True)\n"
                    "time.sleep(1)\nprint('after', flush=True)"
                ),
            }
        ],
    )
    with client.stream(
        "POST", "/api/v1/commands/stream", headers=a, json=command("execute_cell", cell_id=cell)
    ) as response:
        next(response.iter_lines())
    time.sleep(0.2)
    handoff = client.post(f"/api/v1/collaboration/driver/{observer['client_id']}", headers=a).json()
    assert handoff["code"] == "execution_rejected", handoff
    time.sleep(1.3)
    assert "after" in json.dumps(call("query", query="full")["snapshot"]["cells"][0]["outputs"])

    # Timeout is cached and quarantines writes until an explicit restart.
    call(
        "modify_cells",
        changes=[{"operation": "update", "cell_id": cell, "source": "import time\ntime.sleep(10)"}],
    )
    timeout = command("execute_cell", cell_id=cell, timeout_ms=150)
    failure = client.post("/api/v1/commands", headers=a, json=timeout).json()
    assert failure["error"]["code"] == "timeout", failure
    assert client.post("/api/v1/commands", headers=a, json=timeout).json() == failure
    assert (
        client.post(
            "/api/v1/commands", headers=a, json=command("execute_cell", cell_id=cell)
        ).json()["error"]["code"]
        == "execution_rejected"
    )
    call("restart_kernel")
    call("modify_cells", changes=[{"operation": "update", "cell_id": cell, "source": "6 * 7"}])
    assert "42" in json.dumps(call("execute_cell", cell_id=cell)["snapshot"]["cells"][0]["outputs"])
    renamed = call("rename_notebook", path="native-renamed.ipynb")
    assert renamed["snapshot"]["notebook"]["path"] == "native-renamed.ipynb"
    a["x-notebook-path"] = "native-renamed.ipynb"
    assert not client.get("/api/v1/collaboration/events", headers=a).is_error
    call("close")
    client.post("/api/v1/collaboration/leave", headers=a)
    client.post("/api/v1/collaboration/leave", headers={**a, "x-notebook-path": "other.ipynb"})
    client.post("/api/v1/collaboration/leave", headers=b)
    assert os.environ["DIDACTION_JUPYTER_TOKEN"] not in exported.text

print(
    "Rust gateway contracts: PASS "
    "(ownership, follow, idempotency, bounds, timeout, reconnect, rename)"
)
