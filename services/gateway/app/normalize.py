import base64
from typing import Any


def normalize_cells(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, dict) and "cells" in raw:
        raw = raw["cells"]
    if isinstance(raw, dict) and "result" in raw:
        raw = raw["result"]
    if not isinstance(raw, list):
        raw = [] if raw in ({}, None) else [raw]
    cells: list[dict[str, Any]] = []
    for index, item in enumerate(raw[:2000]):
        if not isinstance(item, dict):
            continue
        outputs = []
        for output in item.get("outputs", [])[:128]:
            if not isinstance(output, dict):
                continue
            output_type = output.get("output_type")
            if output_type == "stream":
                outputs.append(
                    {
                        "kind": "stream",
                        "name": output.get("name", "stdout"),
                        "text": _text(output.get("text", "")),
                    }
                )
            elif output_type == "error":
                outputs.append(
                    {
                        "kind": "error",
                        "name": _text(output.get("ename", "Error")),
                        "message": _text(output.get("evalue", "")),
                        "traceback": [_text(v) for v in output.get("traceback", [])[:64]],
                    }
                )
            elif output_type in {"execute_result", "display_data"}:
                data = output.get("data", {})
                if isinstance(data, dict) and "image/png" in data:
                    outputs.append(
                        {"kind": "rich", "mime": "image/png", "data": _text(data["image/png"])}
                    )
                elif isinstance(data, dict) and "image/svg+xml" in data:
                    svg = _text(data["image/svg+xml"])
                    encoded = base64.b64encode(svg.encode()).decode()
                    outputs.append({"kind": "rich", "mime": "image/svg+xml", "data": encoded})
                else:
                    text = data.get("text/plain", "") if isinstance(data, dict) else ""
                    outputs.append({"kind": "text", "text": _text(text)})
        cells.append(
            {
                "id": item.get("id") or f"position-{index}",
                "cell_type": item.get("cell_type", "raw"),
                "source": _text(item.get("source", ""))[:262_144],
                "metadata": item.get("metadata", {}),
                "execution_count": item.get("execution_count"),
                "outputs": outputs,
            }
        )
    return cells


def _text(value: Any) -> str:
    if isinstance(value, list):
        text = "".join(str(part) for part in value)
    else:
        text = str(value)
    return text
