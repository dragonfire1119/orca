/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appMock, browserWindowMock, nativeUpdaterMock, autoUpdaterMock, isMock, killAllPtyMock } =
  vi.hoisted(() => {
    const appEventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
    const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

    const appOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = appEventHandlers.get(event) ?? []
      handlers.push(handler)
      appEventHandlers.set(event, handlers)
      return appMock
    })

    const appEmit = (event: string, ...args: unknown[]) => {
      for (const handler of appEventHandlers.get(event) ?? []) {
        handler(...args)
      }
    }

    const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = eventHandlers.get(event) ?? []
      handlers.push(handler)
      eventHandlers.set(event, handlers)
      return autoUpdaterMock
    })

    const emit = (event: string, ...args: unknown[]) => {
      for (const handler of eventHandlers.get(event) ?? []) {
        handler(...args)
      }
    }

    const reset = () => {
      appEventHandlers.clear()
      appOn.mockClear()
      eventHandlers.clear()
      on.mockClear()
      autoUpdaterMock.checkForUpdates.mockReset()
      autoUpdaterMock.downloadUpdate.mockReset()
      autoUpdaterMock.quitAndInstall.mockReset()
      autoUpdaterMock.setFeedURL.mockClear()
    }

    const autoUpdaterMock = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      on,
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
      setFeedURL: vi.fn(),
      emit,
      reset
    }

    return {
      appMock: {
        isPackaged: true,
        getVersion: vi.fn(() => '1.0.51'),
        on: appOn,
        emit: appEmit,
        quit: vi.fn()
      },
      browserWindowMock: {
        getAllWindows: vi.fn(() => [])
      },
      nativeUpdaterMock: {
        on: vi.fn()
      },
      autoUpdaterMock,
      isMock: { dev: false },
      killAllPtyMock: vi.fn()
    }
  })

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: vi.fn() },
  net: { fetch: vi.fn() }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('./ipc/pty', () => ({
  killAllPty: killAllPtyMock
}))

vi.mock('./updater-nudge', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))

const { fetchNewerReleaseTagMock } = vi.hoisted(() => ({
  fetchNewerReleaseTagMock: vi.fn()
}))

vi.mock('./updater-prerelease-feed', () => ({
  fetchNewerReleaseTag: fetchNewerReleaseTagMock,
  getReleaseDownloadUrl: (tag: string) =>
    `https://github.com/stablyai/orca/releases/download/${tag}`
}))

vi.mock('./updater-changelog', () => ({
  fetchChangelog: vi.fn().mockResolvedValue(null)
}))

const TRANSITION_MESSAGE = 'Unable to find latest version on GitHub'
const ONE_HOUR_MS = 60 * 60 * 1000
const RETRY_DELAY_MS = 30 * 1000

function makeBenignReleaseTransitionFailure(): void {
  autoUpdaterMock.checkForUpdates.mockImplementation(() => {
    autoUpdaterMock.emit('checking-for-update')
    queueMicrotask(() => {
      autoUpdaterMock.emit('error', new Error(TRANSITION_MESSAGE))
    })
    return Promise.reject(new Error(TRANSITION_MESSAGE))
  })
}

describe('updater check failure handling', () => {
  beforeEach(() => {
    vi.resetModules()
    autoUpdaterMock.reset()
    nativeUpdaterMock.on.mockReset()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.quit.mockReset()
    appMock.isPackaged = true
    isMock.dev = false
    killAllPtyMock.mockReset()
    fetchNewerReleaseTagMock.mockReset().mockResolvedValue(null)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('schedules a silent 30s retry on the first benign release-transition failure', async () => {
    vi.useFakeTimers()
    makeBenignReleaseTransitionFailure()

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    // Drain the microtasks so the rejected promise / 'error' event run.
    await vi.advanceTimersByTimeAsync(0)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    // Status stays at 'checking' across the 30s wait — no toast, no idle.
    expect(statuses).toContainEqual({ state: 'checking', userInitiated: true })
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: 'error' }))
    expect(statuses).not.toContainEqual({ state: 'idle' })

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    // After 30s the silent retry fires.
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('schedules a 1h backstop alongside the 30s retry so app-nap can recover the cadence', async () => {
    vi.useFakeTimers()
    makeBenignReleaseTransitionFailure()

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    // Capture timer count after setup (background nudge poll, 24h auto-check).
    const baselineTimerCount = vi.getTimerCount()

    checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)

    // Two new timers must be scheduled: the 30s retry AND the 1h backstop.
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 2)
  })

  it('surfaces the calmer copy after the 30s retry also fails benignly', async () => {
    vi.useFakeTimers()
    makeBenignReleaseTransitionFailure()

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statuses).toContainEqual(
      expect.objectContaining({
        state: 'error',
        userInitiated: true,
        message: expect.stringContaining("Couldn't reach the update server")
      })
    )
  })

  it('clears the 1h backstop on benign recurrence so it does not duplicate the rescheduled retry', async () => {
    vi.useFakeTimers()
    makeBenignReleaseTransitionFailure()

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(0)

    const callsAfterInitial = autoUpdaterMock.checkForUpdates.mock.calls.length
    expect(callsAfterInitial).toBe(1)

    // 30s: silent retry fires (call #2)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    // Recurrence path scheduled a fresh 1h retry (autoUpdateCheckTimer)
    // and cleared the original 1h backstop. Advance past 1h: only the
    // rescheduled retry should fire — not also the cleared backstop.
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('silently drops a background benign recurrence to idle', async () => {
    vi.useFakeTimers()
    makeBenignReleaseTransitionFailure()

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdates } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdates()

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statuses).toContainEqual({ state: 'idle' })
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: 'error' }))
  })

  it('schedules a retry for a benign latest-mac.yml failure too', async () => {
    vi.useFakeTimers()
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit(
          'error',
          new Error('Cannot find channel "latest-mac.yml" update info: HttpError: 404')
        )
      })
      return Promise.reject(
        new Error('Cannot find channel "latest-mac.yml" update info: HttpError: 404')
      )
    })

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(0)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('clears the retry flag when the retry succeeds with update-available', async () => {
    vi.useFakeTimers()

    let attempt = 0
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      attempt += 1
      if (attempt === 1) {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', new Error(TRANSITION_MESSAGE))
        })
        return Promise.reject(new Error(TRANSITION_MESSAGE))
      }
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statuses).toContainEqual(
      expect.objectContaining({ state: 'available', version: '1.0.61' })
    )

    // After the retry succeeded, the 1h backstop was cleared and the flag
    // was reset. Advance past 1h: no third checkForUpdates call.
    const callsAfterSuccess = autoUpdaterMock.checkForUpdates.mock.calls.length
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS + 1)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(callsAfterSuccess)

    // And a manual click after the cycle ended is no longer guarded.
    checkForUpdatesFromMenu()
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(callsAfterSuccess + 1)
  })

  it('guards a manual click during the 30s retry wait', async () => {
    vi.useFakeTimers()
    makeBenignReleaseTransitionFailure()

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(0)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    // Concurrent click during the wait window — must not start a new check.
    checkForUpdatesFromMenu()
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('clears pending retry timers on before-quit', async () => {
    vi.useFakeTimers()
    makeBenignReleaseTransitionFailure()

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(0)
    const callsAfterInitial = autoUpdaterMock.checkForUpdates.mock.calls.length

    // Fire before-quit while the 30s retry and 1h backstop are pending.
    appMock.emit('before-quit', { preventDefault: () => {} })

    // Advance past both timer delays — neither should fire.
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS + 1)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(callsAfterInitial)
  })

  it('re-resolves the prerelease feed on the silent retry', async () => {
    vi.useFakeTimers()
    appMock.getVersion.mockReturnValue('1.3.17-rc.1')
    fetchNewerReleaseTagMock.mockResolvedValue('v1.3.17-rc.2')
    makeBenignReleaseTransitionFailure()

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchNewerReleaseTagMock).toHaveBeenCalledTimes(1)

    // Drive the 30s retry. The retry must re-read the atom feed so a tag
    // that has since propagated gets picked up.
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchNewerReleaseTagMock).toHaveBeenCalledTimes(2)
  })

  it('falls through immediately for a non-transition benign failure', async () => {
    vi.useFakeTimers()
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(0)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    // No retry scheduling for net::ERR_FAILED — fall straight through to the
    // calmer toast.
    expect(statuses).toContainEqual(
      expect.objectContaining({
        state: 'error',
        userInitiated: true,
        message: expect.stringContaining("Couldn't reach the update server")
      })
    )
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 1)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('clears retry state on a non-benign error so subsequent manual clicks are not stranded', async () => {
    vi.useFakeTimers()

    let attempt = 0
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      attempt += 1
      if (attempt === 1) {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', new Error(TRANSITION_MESSAGE))
        })
        return Promise.reject(new Error(TRANSITION_MESSAGE))
      }
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('something is very wrong'))
      })
      return Promise.reject(new Error('something is very wrong'))
    })

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    // Non-benign error must clear the retry flag — a follow-up manual click
    // should NOT be silently dropped.
    checkForUpdatesFromMenu()
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })
})
