"""Smoke-test the StableSFX MCP server over stdio, exactly as Claude Code launches it.

usage: python scripts/mcp-smoke.py <python.exe> <PYTHONPATH> <export dir>
"""

import asyncio
import json
import sys

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


def payload(result) -> object:
    structured = getattr(result, "structured_content", None)
    if structured:
        return structured
    text = "".join(getattr(c, "text", "") for c in result.content)
    try:
        return json.loads(text)
    except ValueError:
        return text


async def main(python: str, pythonpath: str, export_dir: str) -> None:
    params = StdioServerParameters(
        command=python, args=["-m", "stablesfx_engine", "mcp"], env={"PYTHONPATH": pythonpath, "PYTHONWARNINGS": "ignore"}
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print("tools:", sorted(t.name for t in tools.tools))

            async def call(name: str, args: dict) -> object:
                r = await session.call_tool(name, args, read_timeout_seconds=300)
                if getattr(r, "isError", False) or getattr(r, "is_error", False):
                    raise RuntimeError(f"{name} failed: {payload(r)}")
                return payload(r)

            status = await call("engine_status", {})
            print("engine:", status.get("device_name"), status.get("loaded_model"))
            gen = await call("generate_sfx", {
                "prompt": "retro arcade coin pickup, bright metallic ding", "duration": 0.8, "variations": 3,
                "folder": "Claude/Test", "tags": ["mcp-test"],
                "post": [{"op": "trim_silence"}, {"op": "normalize", "mode": "peak", "target": -1}],
            })
            first = gen["results"][0]
            for r in gen["results"]:
                print("generated:", r["id"], r["duration"], r["peak_db"], r["envelope"])
            mod = await call("modify_sfx", {"source": first["id"], "strength": 0.25, "variations": 1, "folder": "Claude/Test"})
            print("clone:", mod["results"][0]["id"], mod["results"][0]["envelope"])
            proc = await call("process_sfx", {"source": first["id"], "ops": [{"op": "pitch", "semitones": 5}], "folder": "Claude/Test", "name": "coin_high"})
            print("processed:", proc["result"]["id"])
            lst = await call("list_library", {"folder": "Claude/Test"})
            print("library items in Claude/Test:", len(lst["items"]))
            info = await call("get_sfx", {"source": first["path"]})
            print("get_sfx seed/model:", info["seed"], info["model"])
            exp = await call("export_sfx", {"sources": [first["id"], proc["result"]["id"]], "dest_dir": export_dir, "format": "wav", "bit_depth": 16, "channels": 1, "name_template": "coin_{index}"})
            print("exported:", exp["files"])
            org = await call("organize_sfx", {"source": first["id"], "add_tags": ["coin"], "starred": True})
            print("organized tags:", org["tags"])
            presets = await call("list_presets", {"category": "Pickups"})
            print("presets:", [p["name"] for p in presets["presets"]])


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:4]))
