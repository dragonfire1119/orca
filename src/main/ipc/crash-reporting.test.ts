import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportRecord } from '../../shared/crash-reporting'

const { handlers, clipboardWriteTextMock, submitFeedbackMock } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  clipboardWriteTextMock: vi.fn(),
  submitFeedbackMock: vi.fn()
}))

vi.mock('electron', () => ({
  clipboard: { writeText: clipboardWriteTextMock },
  ipcMain: {
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('./feedback', () => ({
  submitFeedback: (...args: unknown[]) => submitFeedbackMock(...args)
}))

import { registerCrashReportingHandlers } from './crash-reporting'

function report(status: CrashReportRecord['status'] = 'pending'): CrashReportRecord {
  return {
    id: 'crash-1',
    createdAt: '2026-05-16T01:00:00.000Z',
    status,
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    appVersion: '1.0.0',
    platform: process.platform,
    osRelease: 'test',
    arch: process.arch,
    electronVersion: '41',
    chromeVersion: '141',
    details: {}
  }
}

describe('registerCrashReportingHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    clipboardWriteTextMock.mockReset()
    submitFeedbackMock.mockReset()
    submitFeedbackMock.mockResolvedValue({ ok: true })
  })

  it('copies the latest pending diagnostic text to the clipboard', async () => {
    const latest = report()
    registerCrashReportingHandlers({
      getLatestPending: vi.fn(async () => latest),
      getById: vi.fn(async () => latest),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      listRecent: vi.fn(),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:copyLatestDiagnostics')?.(null)

    expect(result).toEqual({ ok: true })
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('[Crash Report]'))
  })

  it('submits through feedback and marks the report sent only after success', async () => {
    const latest = report()
    const sent = report('sent')
    const markSent = vi.fn(async () => sent)
    registerCrashReportingHandlers({
      getLatestPending: vi.fn(async () => latest),
      getById: vi.fn(async () => latest),
      dismiss: vi.fn(),
      markSent,
      listRecent: vi.fn(),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      reportId: latest.id,
      githubLogin: 'me',
      githubEmail: 'me@example.com',
      notes: 'extra'
    })

    expect(result).toEqual({ ok: true, report: sent })
    expect(submitFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        feedback: expect.stringContaining('[Crash Report]'),
        githubLogin: 'me',
        githubEmail: 'me@example.com'
      })
    )
    expect(markSent).toHaveBeenCalledWith(latest.id)
  })

  it('keeps the report pending on feedback failure', async () => {
    submitFeedbackMock.mockResolvedValue({ ok: false, status: 500, error: 'status 500' })
    const latest = report()
    const markSent = vi.fn()
    registerCrashReportingHandlers({
      getLatestPending: vi.fn(async () => latest),
      getById: vi.fn(async () => latest),
      dismiss: vi.fn(),
      markSent,
      listRecent: vi.fn(),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      githubLogin: null,
      githubEmail: null
    })

    expect(result).toMatchObject({ ok: false, status: 500, report: latest })
    expect(markSent).not.toHaveBeenCalled()
  })

  it('does not dismiss a report while submission is in flight', async () => {
    let resolveSubmit: (value: { ok: true }) => void = () => {}
    submitFeedbackMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve
      })
    )
    const latest = report()
    const dismiss = vi.fn()
    registerCrashReportingHandlers({
      getLatestPending: vi.fn(async () => latest),
      getById: vi.fn(async () => latest),
      dismiss,
      markSent: vi.fn(async () => report('sent')),
      listRecent: vi.fn(),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const submitPromise = handlers.get('crashReports:submit')?.(null, {
      reportId: latest.id,
      githubLogin: null,
      githubEmail: null
    })
    await vi.waitFor(() => expect(submitFeedbackMock).toHaveBeenCalled())

    const dismissResult = await handlers.get('crashReports:dismiss')?.(null, {
      reportId: latest.id
    })

    expect(dismissResult).toEqual(latest)
    expect(dismiss).not.toHaveBeenCalled()
    resolveSubmit({ ok: true })
    await expect(submitPromise).resolves.toMatchObject({ ok: true })
  })
})
