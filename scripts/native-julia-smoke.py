"""Small real IJulia/Plots acceptance; only use the isolated container harness."""

import os
from uuid import uuid4

import httpx


def main() -> None:
    with httpx.Client(base_url=os.environ["DIDACTION_GATEWAY_URL"], timeout=150) as client:
        config = client.get("/api/v1/config").raise_for_status().json()
        assert config["kernel"] == "julia-course-1.10"
        client.headers["x-notebook-path"] = config["path"]
        joined = client.post("/api/v1/collaboration/join").raise_for_status().json()
        client.headers["x-notebook-client"] = joined["token"]

        def call(kind: str, **values: object) -> dict:
            response = client.post(
                "/api/v1/commands",
                json={
                    "protocol_version": 1,
                    "command_id": str(uuid4()),
                    "idempotency_key": str(uuid4()),
                    "timeout_ms": 120000,
                    "type": kind,
                    **values,
                },
            ).raise_for_status()
            result = response.json()
            assert not result.get("error"), result.get("error")
            return result

        state = call("setup", path=config["path"], kernel=config["kernel"], create=True)
        cell = state["snapshot"]["cells"][0]["id"]
        for source, expected in [
            ("value = 40 + 2\nvalue", "42"),
            ('using Plots\ngr()\nplot([1, 2, 3], [1, 4, 9], label="squares")', "image/"),
            ("value", "42"),
        ]:
            call(
                "modify_cells", changes=[{"operation": "update", "cell_id": cell, "source": source}]
            )
            state = call("execute_cell", cell_id=cell)
            output = state["snapshot"]["cells"][0]["outputs"]
            assert not any(item["kind"] == "error" for item in output), "Julia cell failed"
            assert expected in str(output), "Expected Julia result was missing"
        completion = call("complete", code="prin", cursor_pos=4)
        assert any("print" in match for match in completion["completion"]["matches"])
        client.post("/api/v1/collaboration/leave").raise_for_status()
    print("Rust container / IJulia: PASS (42, static Plots output, kernel persistence, completion)")


if __name__ == "__main__":
    main()
