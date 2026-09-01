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
    gateway_url = os.environ.get("DIDACTION_GATEWAY_URL", "http://127.0.0.1:8080")
    request = urllib.request.Request(  # noqa: S310 - test URL is supplied by the local harness.
        f"{gateway_url}/api/v1/commands",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=40) as response:  # noqa: S310
        return json.load(response)


def call_stream(payload: dict[str, object]) -> list[dict[str, object]]:
    gateway_url = os.environ.get("DIDACTION_GATEWAY_URL", "http://127.0.0.1:8080")
    request = urllib.request.Request(  # noqa: S310 - local acceptance harness.
        f"{gateway_url}/api/v1/commands/stream",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    events = []
    with urllib.request.urlopen(request, timeout=40) as response:  # noqa: S310
        for line in response:
            if line.strip():
                events.append(json.loads(line))
    return events


def insert_cell(revision: int, index: int, source: str, cell_type: str = "code") -> dict:
    cell_id = str(uuid.uuid4())
    result = call(
        command(
            "modify_cells",
            revision,
            changes=[
                {
                    "operation": "insert",
                    "index": index,
                    "cell": {
                        "id": cell_id,
                        "cell_type": cell_type,
                        "source": source,
                        "metadata": {},
                        "execution_count": None,
                        "outputs": [],
                    },
                }
            ],
        )
    )
    assert not result.get("error"), result
    assert any(cell["id"] == cell_id for cell in result["snapshot"]["cells"]), result
    return result


path = os.environ.get("DIDACTION_SMOKE_PATH", f"acceptance-{uuid.uuid4()}.ipynb")
state = call(command("setup", path=path, kernel="python3", create=True))
assert not state.get("error"), state
revision = state["snapshot"]["revision"]

first = insert_cell(revision, len(state["snapshot"]["cells"]), "value = 40 + 2")
first_id = first["snapshot"]["cells"][-1]["id"]
state = call(command("execute_cell", first["snapshot"]["revision"], cell_id=first_id))
second = insert_cell(state["snapshot"]["revision"], len(state["snapshot"]["cells"]), "value")
second_id = second["snapshot"]["cells"][-1]["id"]
state = call(command("execute_cell", second["snapshot"]["revision"], cell_id=second_id))
assert "42" in json.dumps(state["snapshot"]["cells"]), state

completion = call(
    command(
        "complete",
        state["snapshot"]["revision"],
        code="value.bi",
        cursor_pos=len("value.bi"),
    )
)
assert not completion.get("error"), completion
assert "bit_length" in json.dumps(completion.get("completion")), completion

note = insert_cell(state["snapshot"]["revision"], 0, "## Verified note", cell_type="markdown")
note_id = note["snapshot"]["cells"][0]["id"]
moved = call(
    command(
        "modify_cells",
        note["snapshot"]["revision"],
        changes=[{"operation": "move", "cell_id": note_id, "index": 2}],
    )
)
assert moved["snapshot"]["cells"][2]["id"] == note_id, moved
deleted = call(
    command(
        "modify_cells",
        moved["snapshot"]["revision"],
        changes=[{"operation": "delete", "cell_id": note_id}],
    )
)
assert all(cell["id"] != note_id for cell in deleted["snapshot"]["cells"]), deleted

graph_source = (
    "from IPython.display import SVG, display\n"
    'display(SVG(\'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">\''
    '+\'<rect width="80" height="40" fill="#2d698f"/></svg>\'))'
)
graph = insert_cell(
    deleted["snapshot"]["revision"], len(deleted["snapshot"]["cells"]), graph_source
)
graph_id = graph["snapshot"]["cells"][-1]["id"]
graph = call(command("execute_cell", graph["snapshot"]["revision"], cell_id=graph_id))
assert "image/svg+xml" in json.dumps(graph["snapshot"]["cells"]), graph

stream_source = (
    "from IPython.display import clear_output\nimport time\n"
    "print('obsolete output', flush=True)\ntime.sleep(0.2)\n"
    "clear_output(wait=True)\n"
    "print('latest output', flush=True)\ntime.sleep(0.2)"
)
stream = insert_cell(graph["snapshot"]["revision"], len(graph["snapshot"]["cells"]), stream_source)
stream_id = stream["snapshot"]["cells"][-1]["id"]
stream_events = call_stream(
    command("execute_cell", stream["snapshot"]["revision"], cell_id=stream_id)
)
assert len(stream_events) >= 5, stream_events
assert all(event["snapshot"]["kernel"]["state"] == "busy" for event in stream_events[:-1]), (
    stream_events
)
assert stream_events[-1]["snapshot"]["kernel"]["state"] == "idle", stream_events
assert any(
    "obsolete output" in json.dumps(event["snapshot"]["cells"]) for event in stream_events[:-1]
), stream_events
assert any(
    all(cell["id"] != stream_id or cell["outputs"] == [] for cell in event["snapshot"]["cells"])
    for event in stream_events[1:-1]
), stream_events
stream = stream_events[-1]
stream_cell = next(cell for cell in stream["snapshot"]["cells"] if cell["id"] == stream_id)
assert "latest output" in json.dumps(stream_cell), stream_cell
assert "obsolete output" not in json.dumps(stream_cell["outputs"]), stream_cell

cleared = call(
    command(
        "modify_cells",
        stream["snapshot"]["revision"],
        changes=[{"operation": "clear_outputs", "cell_id": stream_id}],
    )
)
cleared_cell = next(cell for cell in cleared["snapshot"]["cells"] if cell["id"] == stream_id)
assert cleared_cell["outputs"] == [], cleared_cell
refreshed = call(command("query", cleared["snapshot"]["revision"], query="full"))
refreshed_cell = next(cell for cell in refreshed["snapshot"]["cells"] if cell["id"] == stream_id)
assert refreshed_cell["outputs"] == [], refreshed_cell

print(
    "direct Jupyter/ipykernel smoke: PASS "
    "(42, completion, stable edits, SVG graph, intermediate stream/clear/refresh)"
)
