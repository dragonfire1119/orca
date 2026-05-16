import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Clipboard, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { CrashReportRecord } from '../../../../shared/crash-reporting'
import type { GitHubViewer } from '../../../../shared/types'

type SubmitIdentity = {
  githubLogin: string | null
  githubEmail: string | null
}

function getSubmitIdentity(viewer: GitHubViewer | null, anonymous: boolean): SubmitIdentity {
  if (anonymous || !viewer) {
    return { githubLogin: null, githubEmail: null }
  }
  return { githubLogin: viewer.login, githubEmail: viewer.email }
}

function formatSummary(report: CrashReportRecord): string {
  return `${report.processType} ${report.reason}${
    report.exitCode === null ? '' : ` (exit ${report.exitCode})`
  }`
}

export function CrashReportDialog(): React.JSX.Element {
  const promptedThisLaunch = useRef(false)
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<CrashReportRecord | null>(null)
  const [notes, setNotes] = useState('')
  const [viewer, setViewer] = useState<GitHubViewer | null>(null)
  const [submitAnonymously, setSubmitAnonymously] = useState(false)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const loadPendingReport = async (promptIfPresent: boolean): Promise<void> => {
    setLoading(true)
    try {
      const pending = await window.api.crashReports.getLatestPending()
      setReport(pending)
      if (pending && promptIfPresent) {
        setOpen(true)
      }
    } catch (error) {
      console.error('Failed to load crash report:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (promptedThisLaunch.current) {
      return
    }
    promptedThisLaunch.current = true
    void loadPendingReport(true)
  }, [])

  useEffect(() => {
    return window.api.ui.onOpenCrashReport(() => {
      void loadPendingReport(false).then(() => setOpen(true))
    })
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    void window.api.gh
      .viewer()
      .then((nextViewer) => {
        if (!cancelled) {
          setViewer(nextViewer)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setViewer(null)
          console.error('Failed to load GitHub viewer for crash report:', error)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const handleCopy = async (): Promise<void> => {
    const result = await window.api.crashReports.copyLatestDiagnostics(
      report ? { reportId: report.id } : {}
    )
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Crash report copied.')
  }

  const handleDismiss = async (): Promise<void> => {
    if (report?.status === 'pending') {
      await window.api.crashReports.dismiss({ reportId: report.id })
    }
    setOpen(false)
  }

  const handleSubmit = async (): Promise<void> => {
    if (!report) {
      return
    }
    setSubmitting(true)
    try {
      const identity = getSubmitIdentity(viewer, submitAnonymously)
      const result = await window.api.crashReports.submit({
        reportId: report.id,
        notes,
        submitAnonymously,
        githubLogin: identity.githubLogin,
        githubEmail: identity.githubEmail
      })
      if (!result.ok) {
        throw new Error(result.error)
      }
      setReport(result.report)
      setNotes('')
      toast.success('Crash report sent.')
      setOpen(false)
    } catch (error) {
      toast.error('Failed to send crash report.')
      console.error('Failed to submit crash report:', error)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (submitting && !nextOpen) {
          return
        }
        setOpen(nextOpen)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <AlertTriangle className="size-4 text-destructive" />
            Orca crashed last session
          </DialogTitle>
          <DialogDescription className="text-xs">
            Send a privacy-safe diagnostic report so we can investigate without asking you to find
            system crash files.
          </DialogDescription>
        </DialogHeader>

        {report ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs">
              <div className="font-medium text-foreground">{formatSummary(report)}</div>
              <div className="mt-1 text-muted-foreground">
                {new Date(report.createdAt).toLocaleString()} · {report.platform} {report.arch} ·
                Orca {report.appVersion}
              </div>
            </div>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={4}
              placeholder="Optional: what were you doing when it crashed?"
              className="min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            {viewer ? (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={submitAnonymously}
                  onChange={(event) => setSubmitAnonymously(event.target.checked)}
                  className="size-3.5 rounded border border-border bg-background align-middle accent-foreground"
                />
                Submit anonymously instead of as {viewer.login}
              </label>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
            {loading ? 'Checking for crash reports...' : 'No pending crash report is available.'}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleCopy} disabled={!report}>
            <Clipboard className="size-3.5" />
            Copy Details
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDismiss}
            disabled={submitting}
          >
            Don&apos;t Send
          </Button>
          <Button type="button" size="sm" onClick={handleSubmit} disabled={!report || submitting}>
            <Send className="size-3.5" />
            Send Report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
