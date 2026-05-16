/* eslint-disable max-lines -- Why: discovery, parsing, command construction, and normalization share one narrow transcript shape. Keeping them together makes resume bugs easier to audit. */
import { createReadStream } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { createInterface } from 'readline'
import { readdir, stat } from 'fs/promises'
import {
  buildAiVaultResumeCommand,
  type AiVaultAgent,
  type AiVaultListResult,
  type AiVaultScanIssue,
  type AiVaultSession
} from '../../shared/ai-vault-types'

const DEFAULT_LIMIT = 1000
const DEFAULT_SCAN_LIMIT_PER_AGENT = 1000
const SESSION_PARSE_CONCURRENCY = 8
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const CODEX_SESSIONS_DIR = join(
  process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
  'sessions'
)

type AiVaultScanOptions = {
  claudeProjectsDir?: string
  codexSessionsDir?: string
  limit?: number
  limitPerAgent?: number
  platform?: NodeJS.Platform
}

type FileWithMtime = {
  path: string
  mtimeMs: number
  modifiedAt: string
}

type SessionFileCandidate = {
  agent: AiVaultAgent
  file: FileWithMtime
}

type SessionParseResult = {
  session: AiVaultSession | null
  issue: AiVaultScanIssue | null
}

type SessionAccumulator = {
  agent: AiVaultAgent
  sessionId: string
  title: string | null
  fallbackTitle: string | null
  cwd: string | null
  branch: string | null
  model: string | null
  filePath: string
  createdAt: string | null
  updatedAt: string | null
  modifiedAt: string
  messageCount: number
  totalTokens: number
  latestTimestampMs: number
}

type CodexUsageSnapshot = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export async function scanAiVaultSessions(
  options: AiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  const limit = clampPositiveInteger(options.limit, DEFAULT_LIMIT)
  const limitPerAgent = clampPositiveInteger(options.limitPerAgent, DEFAULT_SCAN_LIMIT_PER_AGENT)
  const platform = options.platform ?? process.platform
  const issues: AiVaultScanIssue[] = []

  const [claudeFiles, codexFiles] = await Promise.all([
    listRecentJsonlFiles(
      options.claudeProjectsDir ?? CLAUDE_PROJECTS_DIR,
      limitPerAgent,
      'claude',
      issues
    ),
    listRecentJsonlFiles(
      options.codexSessionsDir ?? CODEX_SESSIONS_DIR,
      limitPerAgent,
      'codex',
      issues
    )
  ])

  const candidates = [
    ...claudeFiles.map((file): SessionFileCandidate => ({ agent: 'claude', file })),
    ...codexFiles.map((file): SessionFileCandidate => ({ agent: 'codex', file }))
  ].sort((left, right) => right.file.mtimeMs - left.file.mtimeMs)

  const parsedSessions = await parseSessionCandidates({
    candidates,
    limit,
    platform,
    issues
  })

  const sessions = parsedSessions
    .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
    .slice(0, limit)

  return {
    sessions,
    issues,
    scannedAt: new Date().toISOString()
  }
}

async function parseSessionCandidates(args: {
  candidates: SessionFileCandidate[]
  limit: number
  platform: NodeJS.Platform
  issues: AiVaultScanIssue[]
}): Promise<AiVaultSession[]> {
  const sessions: AiVaultSession[] = []
  let index = 0

  while (index < args.candidates.length) {
    if (canStopParsingSessions(sessions, args.limit, args.candidates[index]?.file.mtimeMs)) {
      break
    }

    const remaining = args.candidates.length - index
    const needed = Math.max(args.limit - sessions.length, 1)
    const batchSize = Math.min(SESSION_PARSE_CONCURRENCY, needed, remaining)
    const batch = args.candidates.slice(index, index + batchSize)
    const results = await Promise.all(
      batch.map((candidate) => parseSessionCandidate(candidate, args.platform))
    )

    for (const result of results) {
      if (result.issue) {
        args.issues.push(result.issue)
      }
      if (result.session) {
        sessions.push(result.session)
      }
    }

    index += batchSize
  }

  return sessions
}

async function parseSessionCandidate(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform
): Promise<SessionParseResult> {
  try {
    const session =
      candidate.agent === 'claude'
        ? await parseClaudeSessionFile(candidate.file, platform)
        : await parseCodexSessionFile(candidate.file, platform)
    return { session, issue: null }
  } catch (err) {
    return {
      session: null,
      issue: {
        agent: candidate.agent,
        path: candidate.file.path,
        message: errorMessage(err)
      }
    }
  }
}

function canStopParsingSessions(
  sessions: AiVaultSession[],
  limit: number,
  nextCandidateMtimeMs: number | undefined
): boolean {
  if (sessions.length < limit || typeof nextCandidateMtimeMs !== 'number') {
    return false
  }
  const visibleCutoff = sessions
    .map(sessionSortTime)
    .sort((left, right) => right - left)
    .at(limit - 1)

  // Transcript mtime is already our discovery bound and fallback sort key; older
  // files cannot displace the current visible set once the cutoff is newer.
  return typeof visibleCutoff === 'number' && nextCandidateMtimeMs < visibleCutoff
}

export async function parseClaudeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({
    agent: 'claude',
    file,
    sessionId: sessionIdFromFileName(file.path)
  })
  let metaTitle: string | null = null

  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    const record = parseJsonObject(line)
    if (!record) {
      continue
    }

    if (typeof record.sessionId === 'string' && record.sessionId.trim()) {
      accumulator.sessionId = record.sessionId.trim()
    }
    updateTimeline(accumulator, extractString(record.timestamp))
    updateLatestLocation(accumulator, record)

    if (record.type === 'user') {
      accumulator.messageCount++
      const title = extractMessageText(record.message)
      if (title && record.isMeta !== true && !accumulator.title) {
        accumulator.title = title
      } else if (title && !metaTitle) {
        metaTitle = title
      }
      continue
    }

    if (record.type === 'assistant') {
      accumulator.messageCount++
      const message = asRecord(record.message)
      const model = extractString(message?.model)
      if (model) {
        accumulator.model = model
      }
      accumulator.totalTokens += claudeUsageTotal(message?.usage)
    }
  }

  accumulator.fallbackTitle = metaTitle
  return finalizeSession(accumulator, platform)
}

export async function parseCodexSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({
    agent: 'codex',
    file,
    sessionId: sessionIdFromFileName(file.path)
  })
  let previousTotals: CodexUsageSnapshot | null = null

  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    const record = parseJsonObject(line)
    if (!record) {
      continue
    }

    updateTimeline(accumulator, extractString(record.timestamp))

    const payload = asRecord(record.payload)
    if (record.type === 'session_meta' && payload) {
      const sessionId = extractString(payload.id)
      if (sessionId) {
        accumulator.sessionId = sessionId
      }
      const cwd = extractString(payload.cwd)
      if (cwd) {
        accumulator.cwd = cwd
      }
      accumulator.branch = extractGitBranch(payload.git) ?? accumulator.branch
      continue
    }

    if (record.type === 'turn_context' && payload) {
      const cwd = extractString(payload.cwd)
      if (cwd) {
        accumulator.cwd = cwd
      }
      const model = extractModel(payload)
      if (model) {
        accumulator.model = model
      }
      continue
    }

    if (!payload) {
      continue
    }

    if (record.type === 'response_item' && payload.type === 'message') {
      accumulator.messageCount++
      if (payload.role === 'user' && !accumulator.title) {
        accumulator.title = extractContentText(payload.content)
      }
      continue
    }

    if (record.type !== 'event_msg') {
      continue
    }

    if (payload.type === 'user_message') {
      accumulator.messageCount++
      if (!accumulator.title) {
        accumulator.title = extractContentText(payload.message)
      }
      continue
    }

    if (payload.type === 'agent_message') {
      accumulator.messageCount++
      continue
    }

    if (payload.type !== 'token_count') {
      continue
    }

    const info = asRecord(payload.info)
    if (!info) {
      continue
    }
    const totalUsage = normalizeCodexUsage(info.total_token_usage)
    const lastUsage = normalizeCodexUsage(info.last_token_usage)
    const delta = totalUsage ? subtractCodexUsage(totalUsage, previousTotals) : lastUsage
    if (totalUsage) {
      previousTotals = totalUsage
    }
    if (delta) {
      accumulator.totalTokens += delta.totalTokens
    }
    const model = extractModel(payload)
    if (model) {
      accumulator.model = model
    }
  }

  return finalizeSession(accumulator, platform)
}

async function listRecentJsonlFiles(
  rootDir: string,
  limit: number,
  agent: AiVaultAgent,
  issues: AiVaultScanIssue[]
): Promise<FileWithMtime[]> {
  const paths = await walkJsonlFiles(rootDir, agent, issues)
  const files: FileWithMtime[] = []
  for (const path of paths) {
    try {
      const fileStat = await stat(path)
      files.push({
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString()
      })
    } catch (err) {
      issues.push({ agent, path, message: errorMessage(err) })
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit)
}

async function walkJsonlFiles(
  dirPath: string,
  agent: AiVaultAgent,
  issues: AiVaultScanIssue[]
): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkJsonlFiles(fullPath, agent, issues)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath)
    }
  }
  return files
}

function createAccumulator(args: {
  agent: AiVaultAgent
  file: FileWithMtime
  sessionId: string
}): SessionAccumulator {
  return {
    agent: args.agent,
    sessionId: args.sessionId,
    title: null,
    fallbackTitle: null,
    cwd: null,
    branch: null,
    model: null,
    filePath: args.file.path,
    createdAt: null,
    updatedAt: null,
    modifiedAt: args.file.modifiedAt,
    messageCount: 0,
    totalTokens: 0,
    latestTimestampMs: 0
  }
}

function finalizeSession(
  accumulator: SessionAccumulator,
  platform: NodeJS.Platform
): AiVaultSession | null {
  const sessionId = accumulator.sessionId.trim()
  if (!sessionId) {
    return null
  }
  const title =
    accumulator.title ||
    accumulator.fallbackTitle ||
    `${accumulator.agent === 'claude' ? 'Claude' : 'Codex'} ${sessionId.slice(0, 8)}`

  return {
    id: `${accumulator.agent}:${sessionId}:${accumulator.filePath}`,
    agent: accumulator.agent,
    sessionId,
    title,
    cwd: accumulator.cwd,
    branch: accumulator.branch,
    model: accumulator.model,
    filePath: accumulator.filePath,
    createdAt: accumulator.createdAt,
    updatedAt: accumulator.updatedAt,
    modifiedAt: accumulator.modifiedAt,
    messageCount: accumulator.messageCount,
    totalTokens: accumulator.totalTokens,
    resumeCommand: buildAiVaultResumeCommand({
      agent: accumulator.agent,
      sessionId,
      cwd: accumulator.cwd,
      platform
    })
  }
}

function updateTimeline(accumulator: SessionAccumulator, timestamp: string | null): void {
  if (!timestamp) {
    return
  }
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) {
    return
  }
  const iso = new Date(parsed).toISOString()
  if (!accumulator.createdAt || parsed < Date.parse(accumulator.createdAt)) {
    accumulator.createdAt = iso
  }
  if (!accumulator.updatedAt || parsed >= Date.parse(accumulator.updatedAt)) {
    accumulator.updatedAt = iso
    accumulator.latestTimestampMs = parsed
  }
}

function updateLatestLocation(
  accumulator: SessionAccumulator,
  record: Record<string, unknown>
): void {
  const timestamp = extractString(record.timestamp)
  const parsed = timestamp ? Date.parse(timestamp) : accumulator.latestTimestampMs
  if (!Number.isFinite(parsed) || parsed < accumulator.latestTimestampMs) {
    return
  }
  const cwd = extractString(record.cwd)
  const branch = extractString(record.gitBranch)
  if (cwd) {
    accumulator.cwd = cwd
  }
  if (branch) {
    accumulator.branch = branch
  }
}

function sessionSortTime(session: AiVaultSession): number {
  return Date.parse(session.updatedAt ?? session.modifiedAt)
}

function sessionIdFromFileName(filePath: string): string {
  const fileName = basename(filePath, '.jsonl')
  const match = fileName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  return match?.[0] ?? fileName
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  if (!line.trim()) {
    return null
  }
  try {
    const parsed = JSON.parse(line) as unknown
    return asRecord(parsed)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function extractString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function extractModel(value: unknown): string | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  return (
    extractString(record.model) ||
    extractString(record.model_name) ||
    extractString(asRecord(record.metadata)?.model) ||
    extractString(asRecord(record.info)?.model) ||
    null
  )
}

function extractGitBranch(value: unknown): string | null {
  const git = asRecord(value)
  if (!git) {
    return null
  }
  return extractString(git.branch) || extractString(git.current_branch)
}

function extractMessageText(value: unknown): string | null {
  const message = asRecord(value)
  if (!message) {
    return null
  }
  return extractContentText(message.content)
}

function extractContentText(value: unknown): string | null {
  if (typeof value === 'string') {
    return normalizeTitleText(value)
  }
  if (!Array.isArray(value)) {
    return null
  }
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    const record = asRecord(item)
    const text = extractString(record?.text) || extractString(record?.content)
    if (text) {
      parts.push(text)
    }
  }
  return normalizeTitleText(parts.join(' '))
}

function normalizeTitleText(value: string): string | null {
  const withoutReminders = value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!withoutReminders) {
    return null
  }
  if (/^# AGENTS\.md instructions for\b/i.test(withoutReminders)) {
    return null
  }
  if (/^<INSTRUCTIONS>/i.test(withoutReminders)) {
    return null
  }
  return withoutReminders.length > 96 ? `${withoutReminders.slice(0, 93)}...` : withoutReminders
}

function claudeUsageTotal(value: unknown): number {
  const usage = asRecord(value)
  if (!usage) {
    return 0
  }
  return (
    numberValue(usage.input_tokens) +
    numberValue(usage.output_tokens) +
    numberValue(usage.cache_read_input_tokens) +
    numberValue(usage.cache_creation_input_tokens)
  )
}

function normalizeCodexUsage(value: unknown): CodexUsageSnapshot | null {
  const usage = asRecord(value)
  if (!usage) {
    return null
  }
  const inputTokens = numberValue(usage.input_tokens)
  const cachedInputTokens = numberValue(usage.cached_input_tokens ?? usage.cache_read_input_tokens)
  const outputTokens = numberValue(usage.output_tokens)
  const reasoningOutputTokens = numberValue(usage.reasoning_output_tokens)
  const totalTokens = numberValue(usage.total_tokens)

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens
  }
}

function subtractCodexUsage(
  current: CodexUsageSnapshot,
  previous: CodexUsageSnapshot | null
): CodexUsageSnapshot {
  return {
    inputTokens: Math.max(current.inputTokens - (previous?.inputTokens ?? 0), 0),
    cachedInputTokens: Math.max(current.cachedInputTokens - (previous?.cachedInputTokens ?? 0), 0),
    outputTokens: Math.max(current.outputTokens - (previous?.outputTokens ?? 0), 0),
    reasoningOutputTokens: Math.max(
      current.reasoningOutputTokens - (previous?.reasoningOutputTokens ?? 0),
      0
    ),
    totalTokens: Math.max(current.totalTokens - (previous?.totalTokens ?? 0), 0)
  }
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
