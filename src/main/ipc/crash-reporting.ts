import { clipboard, ipcMain } from 'electron'
import {
  formatCrashReportText,
  type CrashReportSubmitArgs,
  type CrashReportSubmitResult
} from '../../shared/crash-reporting'
import { submitFeedback } from './feedback'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'

const inFlightSubmissions = new Set<string>()

export function registerCrashReportingHandlers(store: CrashReportStore): void {
  ipcMain.removeHandler('crashReports:getLatestPending')
  ipcMain.handle('crashReports:getLatestPending', () => store.getLatestPending())

  ipcMain.removeHandler('crashReports:dismiss')
  ipcMain.handle('crashReports:dismiss', async (_event, args: { reportId: string }) =>
    store.dismiss(args.reportId)
  )

  ipcMain.removeHandler('crashReports:copyLatestDiagnostics')
  ipcMain.handle(
    'crashReports:copyLatestDiagnostics',
    async (_event, args?: { reportId?: string }) => {
      const report = args?.reportId
        ? await store.getById(args.reportId)
        : await store.getLatestPending()
      if (!report) {
        return { ok: false as const, error: 'No crash report available.' }
      }
      clipboard.writeText(formatCrashReportText(report))
      return { ok: true as const }
    }
  )

  ipcMain.removeHandler('crashReports:submit')
  ipcMain.handle(
    'crashReports:submit',
    async (_event, args: CrashReportSubmitArgs): Promise<CrashReportSubmitResult> => {
      const report = args.reportId
        ? await store.getById(args.reportId)
        : await store.getLatestPending()
      if (!report) {
        return { ok: false, status: null, error: 'No crash report available.' }
      }
      if (report.status !== 'pending') {
        return { ok: true, report }
      }
      if (inFlightSubmissions.has(report.id)) {
        return {
          ok: false,
          status: null,
          error: 'Crash report submission already in progress.',
          report
        }
      }

      inFlightSubmissions.add(report.id)
      try {
        const result = await submitFeedback({
          feedback: formatCrashReportText(report, args.notes),
          submitAnonymously: args.submitAnonymously,
          githubLogin: args.githubLogin,
          githubEmail: args.githubEmail
        })
        if (!result.ok) {
          return { ...result, report }
        }
        const sent = await store.markSent(report.id)
        return { ok: true, report: sent ?? report }
      } finally {
        inFlightSubmissions.delete(report.id)
      }
    }
  )
}
