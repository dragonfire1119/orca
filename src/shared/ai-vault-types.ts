import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './types'

export const AI_VAULT_AGENTS = ['claude', 'codex'] as const satisfies readonly TuiAgent[]

export type AiVaultAgent = (typeof AI_VAULT_AGENTS)[number]
export type AiVaultScope = 'workspace' | 'all'
export type AiVaultSort = 'updated' | 'created'
export type AiVaultGroup = 'folder' | 'agent'

export type AiVaultSession = {
  id: string
  agent: AiVaultAgent
  sessionId: string
  title: string
  cwd: string | null
  branch: string | null
  model: string | null
  filePath: string
  createdAt: string | null
  updatedAt: string | null
  modifiedAt: string
  messageCount: number
  totalTokens: number
  resumeCommand: string
}

export type AiVaultScanIssue = {
  agent: AiVaultAgent
  path: string
  message: string
}

export type AiVaultListArgs = {
  limit?: number
  force?: boolean
}

export type AiVaultListResult = {
  sessions: AiVaultSession[]
  issues: AiVaultScanIssue[]
  scannedAt: string
}

export function buildAiVaultResumeCommand(args: {
  agent: AiVaultAgent
  sessionId: string
  cwd: string | null
  platform: NodeJS.Platform
  commandOverride?: string | null
}): string {
  const { agent, sessionId, cwd, platform, commandOverride } = args
  const baseCommand = commandOverride?.trim() || TUI_AGENT_CONFIG[agent].launchCmd
  const sessionArg = quoteShellArg(sessionId, platform)
  const resumeCommand =
    agent === 'claude'
      ? `${baseCommand} --resume ${sessionArg}`
      : `${baseCommand} resume ${sessionArg}`

  if (!cwd) {
    return resumeCommand
  }

  if (platform === 'win32') {
    const inner = `cd /d ${quoteWindowsCmdArg(cwd)} && ${resumeCommand}`
    return `cmd /d /s /c ${quoteWindowsCmdArg(inner)}`
  }

  return `cd ${quoteShellArg(cwd, platform)} && ${resumeCommand}`
}

function quoteShellArg(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return quoteWindowsCmdArg(value)
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
