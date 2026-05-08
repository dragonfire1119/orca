import { useAppStore } from '@/store'

/**
 * Open Settings → Developer Permissions. The exact pane key, repoId, and
 * sectionId must stay in lockstep across every entry point — extracting them
 * here is the only place this shape needs to be edited if the settings
 * routing ever changes.
 *
 * The pane itself (DeveloperPermissionsPane, shipped in #1233) handles the
 * Superset-shaped UX: per-row status polling and `x-apple.systempreferences:`
 * deep-links into the matching Privacy & Security panes. Both the passive
 * MacPermissionsHint banner and the reactive permission-denied toast in
 * pty-connection.ts route through this single entry point.
 */
export function openDeveloperPermissionsSettings(): void {
  const state = useAppStore.getState()
  state.openSettingsTarget({
    pane: 'developer-permissions',
    repoId: null,
    sectionId: 'developer-permissions'
  })
  state.openSettingsPage()
}
