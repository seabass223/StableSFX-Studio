"""Call one StableSFX MCP tool using the exact server entry registered in ~/.claude.json.

usage: python scripts/mcp-call.py <tool> '<json args>'
"""

import asyncio
import json
import sys
from pathlib import Path

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


async def main(tool: str, args: dict) -> None:
    entry = json.loads((Path.home() / ".claude.json").read_text(encoding="utf-8"))["mcpServers"]["stablesfx"]
    params = StdioServerParameters(command=entry["command"], args=entry["args"], env=entry.get("env"))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool, args, read_timeout_seconds=300)
            if getattr(result, "is_error", False):
                raise SystemExit("tool error: " + "".join(getattr(c, "text", "") for c in result.content))
            payload = getattr(result, "structured_content", None) or json.loads("".join(getattr(c, "text", "") for c in result.content))
            print(json.dumps(payload, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}))
