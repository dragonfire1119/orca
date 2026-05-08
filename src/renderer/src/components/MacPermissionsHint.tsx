import { ArrowRight, X } from 'lucide-react'

import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { openDeveloperPermissionsSettings } from '@/lib/developer-permissions-settings-link'
import type { WorkspaceVisibleTabType } from '../../../shared/types'

type MacPermissionsHintProps = {
  activeView: 'terminal' | 'settings' | 'tasks'
  activeTabType: WorkspaceVisibleTabType
  activeWorktreeId: string | null
}

// Passive over eager: Superset-style osascript probes at app.whenReady were
// verified to silently fail under TCC (no Privacy → Automation row appears),
// so we rely on discoverability into DeveloperPermissionsPane instead.
export function MacPermissionsHint({
  activeView,
  activeTabType,
  activeWorktreeId
}: MacPermissionsHintProps): React.JSX.Element | null {
  const dismissed = useAppStore((s) => s.terminalMacPermissionsHintDismissed)
  const dismiss = useAppStore((s) => s.dismissTerminalMacPermissionsHint)
  // Why: persisted dismissal arrives async after first paint; without this
  // gate, returning users see the hint flash before the `?? false` hydrate
  // resolves to `true` and removes it.
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)

  // Why: TCC (the macOS permission system) is host-local — a Mac client
  // SSH'd into a remote worktree can't grant permissions on the remote.
  // (The Mac platform check itself lives at the call site so non-Mac
  // platforms don't instantiate the component at all.)
  const isLocalWorktree = getConnectionId(activeWorktreeId) === null
  const isTerminalView =
    activeView === 'terminal' && activeTabType === 'terminal' && activeWorktreeId !== null

  if (!persistedUIReady || !isTerminalView || !isLocalWorktree || dismissed) {
    return null
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
      <span className="flex-1 truncate">Need macOS device permissions for CLIs?</span>
      <button
        type="button"
        onClick={openDeveloperPermissionsSettings}
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-foreground underline-offset-2 hover:bg-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Settings · Permissions
        <ArrowRight className="size-3" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Dismiss permissions hint"
        onClick={dismiss}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}
