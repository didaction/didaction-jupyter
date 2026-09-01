#!/usr/bin/env python3
import json
import os
import urllib.request
import uuid


def command(kind: str, revision: int | None = None, **values: object) -> dict[str, object]:
    return {
        "protocol_version": 1,
        "command_id": str(uuid.uuid4()),
        "idempotency_key": str(uuid.uuid4()),
        "expected_revision": revision,
        "timeout_ms": 30_000,
        "type": kind,
        **values,
    }


def call(payload: dict[str, object]) -> dict[str, object]:
    request = urllib.request.Request(
        "http://127.0.0.1:8080/api/v1/commands",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=40) as response:  # noqa: S310 - fixed loopback URL
        return json.load(response)


notebook_path = os.environ.get("DIDACTION_SMOKE_PATH", f"acceptance-{uuid.uuid4()}.ipynb")
setup = call(command("setup", path=notebook_path, kernel="python3", create=True))
assert not setup.get("error"), setup
revision = setup["snapshot"]["revision"]
for source in ("value = 40 + 2", "value"):
    index = len(setup["snapshot"]["cells"])
    inserted = call(
        command(
            "modify_cells",
            revision,
            changes=[
                {
                    "operation": "insert",
                    "index": index,
                    "cell": {
                        "id": str(uuid.uuid4()),
                        "cell_type": "code",
                        "source": source,
                        "metadata": {},
                        "execution_count": None,
                        "outputs": [],
                    },
                }
            ],
        )
    )
    assert not inserted.get("error"), inserted
    revision = inserted["snapshot"]["revision"]
    setup = call(command("execute_cell", revision, cell_id=f"position-{index}"))
    assert not setup.get("error"), setup
    revision = setup["snapshot"]["revision"]
query = call(command("query", revision, query="full"))
assert "42" in json.dumps(query["snapshot"]["cells"]), query
print("real Jupyter/ipykernel/MCP/gateway smoke: PASS (observed 42)")
