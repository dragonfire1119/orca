import { describe, expect, it } from 'vitest'
import {
  formatCrashReportText,
  isCrashReportReason,
  sanitizeCrashReportDetails,
  sanitizeCrashReportString,
  type CrashReportRecord
} from './crash-reporting'

describe('crash-reporting shared helpers', () => {
  it('redacts paths and common secret-shaped strings', () => {
    const text =
      'file /Users/alice/project/.env C:\\Users\\bob\\repo token=abc123 ghp_abcdefghijklmnopqrstuvwxyz'

    expect(sanitizeCrashReportString(text)).toBe(
      'file [redacted-path] [redacted-path] token=[redacted] [redacted-secret]'
    )
  })

  it('keeps details on a strict primitive allowlist', () => {
    expect(
      sanitizeCrashReportDetails({
        name: 'GPU /home/alice/repo',
        code: 9,
        crashed: true,
        missing: null,
        nested: { nope: true },
        infinite: Number.POSITIVE_INFINITY
      })
    ).toEqual({
      name: 'GPU [redacted-path]',
      code: 9,
      crashed: true,
      missing: null
    })
  })

  it('recognizes crash reasons captured by Electron process-gone events', () => {
    expect(isCrashReportReason('crashed')).toBe(true)
    expect(isCrashReportReason('memory-eviction')).toBe(true)
    expect(isCrashReportReason('clean-exit')).toBe(false)
  })

  it('formats reports without route or URL fields', () => {
    const report: CrashReportRecord = {
      id: 'crash-1',
      createdAt: '2026-05-16T01:00:00.000Z',
      status: 'pending',
      source: 'renderer',
      processType: 'renderer',
      reason: 'crashed',
      exitCode: 5,
      appVersion: '1.0.0',
      platform: 'darwin',
      osRelease: '25.0.0',
      arch: 'arm64',
      electronVersion: '41.0.0',
      chromeVersion: '141.0.0',
      details: { reason: 'native crash' }
    }

    const text = formatCrashReportText(report, 'saw /Users/me/project')

    expect(text).toContain('[Crash Report]')
    expect(text).toContain('User notes:')
    expect(text).toContain('[redacted-path]')
    expect(text).not.toContain('Route:')
    expect(text).not.toContain('URL:')
  })
})
