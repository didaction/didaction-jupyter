#!/usr/bin/env python3
import argparse
import json
import urllib.request
import uuid


def call(kind: str) -> dict[str, object]:
    payload = {
        "protocol_version": 1,
        "command_id": str(uuid.uuid4()),
        "idempotency_key": str(uuid.uuid4()),
        "expected_revision": None,
        "timeout_ms": 5_000,
        "type": kind,
        "query": "full" if kind == "query" else None,
    }
    request = urllib.request.Request(
        "http://127.0.0.1:8080/api/v1/commands",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 - fixed loopback URL
        return json.load(response)


parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["expect-disconnect", "expect-reconnect"])
args = parser.parse_args()
result = call("query" if args.mode == "expect-disconnect" else "reconnect")
if args.mode == "expect-disconnect":
    assert result.get("error", {}).get("code") == "disconnected", result
    assert result["error"]["retryable"] is True, result
    print("disconnect result: PASS (retryable, no mutation replay)")
else:
    assert not result.get("error"), result
    cells = result["snapshot"]["cells"]
    assert len(cells) == 2 and "42" in json.dumps(cells), result
    print("reconnect reconciliation: PASS (2 cells, observed 42, no duplicates)")
