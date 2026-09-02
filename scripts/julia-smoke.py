"""Execute the trusted course's first nine code cells in the running Julia demo."""

import os
from uuid import uuid4

import httpx


def main() -> None:
    url = os.environ.get("DIDACTION_GATEWAY_URL", "http://127.0.0.1:5174")
    with httpx.Client(base_url=url, timeout=130) as client:
        config = client.get("/api/v1/config").raise_for_status().json()
        assert config["kernel"] == "julia-course-1.10", "Expected Julia course runtime"
        assert config["path"] == "mcs_problem_class1.ipynb", "Expected course notebook"
        client.headers["x-notebook-path"] = config["path"]

        def command(kind: str, **values: object) -> dict:
            response = client.post(
                "/api/v1/commands",
                json={
                    "protocol_version": 1,
                    "command_id": str(uuid4()),
                    "idempotency_key": str(uuid4()),
                    "timeout_ms": 120_000,
                    "type": kind,
                    **values,
                },
            ).raise_for_status()
            result = response.json()
            assert not result.get("error"), "Julia command failed; inspect the notebook"
            return result["snapshot"]

        state = command("setup", path=config["path"], kernel=config["kernel"], create=False)
        cells = [cell for cell in state["cells"] if cell["cell_type"] == "code"][:9]
        assert len(cells) == 9 and not any("@manipulate" in c["source"] for c in cells)
        plots = 0
        for number, cell in enumerate(cells, 1):
            state = command("execute_cell", cell_id=cell["id"], expected_revision=state["revision"])
            actual = next(c for c in state["cells"] if c["id"] == cell["id"])
            assert not any(o["kind"] == "error" for o in actual["outputs"]), (
                f"Course code cell {number} failed; inspect its output"
            )
            plots += any(
                output.get("mime", "").startswith("image/") for output in actual["outputs"]
            )
            print(f"Course code cell {number}: PASS", flush=True)
        assert plots >= 3, "Expected three static plots"
        print(f"Julia course: PASS ({len(cells)} cells, {plots} static plots)")


if __name__ == "__main__":
    main()
