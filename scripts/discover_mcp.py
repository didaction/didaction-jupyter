#!/usr/bin/env python3
"""Discover the pinned mcp-jupyter HTTP profile; emits JSON and no credentials."""

import asyncio
import json
import os

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


async def main() -> None:
    endpoint = os.environ.get("DIDACTION_MCP_URL", "http://127.0.0.1:8090/mcp/")
    async with streamablehttp_client(endpoint) as (read, write, _):
        async with ClientSession(read, write) as session:
            initialized = await session.initialize()
            tools = await session.list_tools()
            print(
                json.dumps(
                    {
                        "endpoint_path": "/mcp/",
                        "server": initialized.serverInfo.model_dump(mode="json"),
                        "protocol_version": initialized.protocolVersion,
                        "tools": [
                            tool.model_dump(mode="json", exclude_none=True) for tool in tools.tools
                        ],
                    },
                    indent=2,
                    sort_keys=True,
                )
            )


if __name__ == "__main__":
    asyncio.run(main())
