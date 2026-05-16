export type CrashReportStatus = 'pending' | 'sent' | 'dismissed'
export type CrashReportSource = 'renderer' | 'child'

export type CrashReportDetailValue = string | number | boolean | null

export type CrashReportRecord = {
  id: string
  createdAt: string
  status: CrashReportStatus
  source: CrashReportSource
  processType: string
  reason: string
  exitCode: number | null
  appVersion: string
  platform: NodeJS.Platform
  osRelease: string
  arch: string
  electronVersion: string
  chromeVersion: string
  details: Record<string, CrashReportDetailValue>
}

export type CrashReportCreateInput = Omit<
  CrashReportRecord,
  'id' | 'createdAt' | 'status' | 'details'
> & {
  details: Record<string, unknown>
}

export type CrashReportSubmitArgs = {
  reportId?: string
  notes?: string
  submitAnonymously?: boolean
  githubLogin: string | null
  githubEmail: string | null
}

export type CrashReportSubmitResult =
  | { ok: true; report: CrashReportRecord }
  | { ok: false; status: number | null; error: string; report?: CrashReportRecord }

const MAX_STRING_DETAIL_LENGTH = 240
const SECRET_PATTERNS = [
  /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b([A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@)(?=[^/\s]+)/g,
  /\b(token|api[_-]?key|secret|password)=([^&\s]+)/gi
]

const PATH_PATTERNS = [
  /\/Users\/[^\s"'`<>)]+/g,
  /\/home\/[^\s"'`<>)]+/g,
  /[A-Za-z]:\\Users\\[^\s"'`<>)]+/g,
  /\\\\[^\\\s"'`<>)]+\\[^\s"'`<>)]+/g
]

export function isCrashReportReason(reason: string): boolean {
  return ['crashed', 'oom', 'killed', 'integrity-failure', 'memory-eviction'].includes(reason)
}

export function sanitizeCrashReportString(value: string): string {
  let sanitized = value
  for (const pattern of PATH_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[redacted-path]')
  }
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match, key?: string) => {
      if (key && /^(token|api[_-]?key|secret|password)$/i.test(key)) {
        return `${key}=[redacted]`
      }
      return match.includes('@') ? '[redacted-credential]@' : '[redacted-secret]'
    })
  }
  return sanitized.length > MAX_STRING_DETAIL_LENGTH
    ? `${sanitized.slice(0, MAX_STRING_DETAIL_LENGTH)}...`
    : sanitized
}

export function sanitizeCrashReportDetails(
  details: Record<string, unknown>
): Record<string, CrashReportDetailValue> {
  const sanitized: Record<string, CrashReportDetailValue> = {}
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeCrashReportString(value)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = value
    } else if (typeof value === 'boolean' || value === null) {
      sanitized[key] = value
    }
  }
  return sanitized
}

export function formatCrashReportText(report: CrashReportRecord, notes?: string): string {
  const lines = [
    '[Crash Report]',
    '',
    `Report ID: ${report.id}`,
    `Created: ${report.createdAt}`,
    `Status: ${report.status}`,
    `Source: ${report.source}`,
    `Process: ${report.processType}`,
    `Reason: ${report.reason}`,
    `Exit code: ${report.exitCode ?? 'unknown'}`,
    `App version: ${report.appVersion}`,
    `Platform: ${report.platform} ${report.osRelease} ${report.arch}`,
    `Electron: ${report.electronVersion}`,
    `Chrome: ${report.chromeVersion}`
  ]

  const details = Object.entries(report.details)
  if (details.length > 0) {
    lines.push('', 'Details:')
    for (const [key, value] of details) {
      lines.push(`- ${key}: ${String(value)}`)
    }
  }

  const trimmedNotes = notes?.trim()
  if (trimmedNotes) {
    lines.push('', 'User notes:', sanitizeCrashReportString(trimmedNotes))
  }

  return lines.join('\n')
}
