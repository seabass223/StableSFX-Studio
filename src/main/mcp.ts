/** Registers the StableSFX MCP server in Claude Code's user config (~/.claude.json). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpStatus } from '@shared/ipc'
import { HOME, pythonExe } from './engine'

const CLAUDE_JSON = path.join(os.homedir(), '.claude.json')
const NAME = 'stablesfx'

function desired(): { type: 'stdio'; command: string; args: string[]; env: Record<string, string> } {
  return {
    type: 'stdio',
    command: pythonExe(),
    args: ['-m', 'stablesfx_engine', 'mcp'],
    env: { PYTHONPATH: path.join(HOME, 'engine'), PYTHONWARNINGS: 'ignore' }
  }
}

function read(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'))
  } catch {
    return {}
  }
}

export function mcpStatus(): McpStatus {
  const want = desired()
  const servers = (read().mcpServers ?? {}) as Record<string, { command?: string; args?: string[] }>
  const current = servers[NAME]
  return {
    registered: Boolean(current),
    configPath: CLAUDE_JSON,
    command: want.command,
    args: want.args,
    env: want.env,
    matches: Boolean(current && current.command === want.command && JSON.stringify(current.args) === JSON.stringify(want.args))
  }
}

/** Claude Code rewrites ~/.claude.json often: back up, write atomically, re-read to verify. */
export function registerMcp(): McpStatus {
  const raw = fs.existsSync(CLAUDE_JSON) ? fs.readFileSync(CLAUDE_JSON, 'utf8') : '{}'
  const config = JSON.parse(raw) as Record<string, unknown>
  if (fs.existsSync(CLAUDE_JSON)) fs.writeFileSync(`${CLAUDE_JSON}.stablesfx-backup`, raw)
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  servers[NAME] = desired()
  config.mcpServers = servers
  const tmp = `${CLAUDE_JSON}.stablesfx-tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
  fs.renameSync(tmp, CLAUDE_JSON)
  const status = mcpStatus()
  if (!status.matches) throw new Error('~/.claude.json was rewritten concurrently; try again')
  return status
}
