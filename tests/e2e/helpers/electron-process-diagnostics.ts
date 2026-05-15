import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'

const ELECTRON_PROCESS_LOG_LIMIT = 20_000
const electronProcessLogs = new WeakMap<ElectronApplication, string[]>()

function formatTestTitle(testInfo: TestInfo): string {
  const info = testInfo as TestInfo & { title?: unknown; titlePath?: unknown }
  if (typeof info.titlePath === 'function') {
    const titlePath = info.titlePath()
    if (Array.isArray(titlePath) && titlePath.length > 0) {
      return titlePath.join(' > ')
    }
  }
  if (Array.isArray(info.titlePath) && info.titlePath.length > 0) {
    return info.titlePath.join(' > ')
  }
  return typeof info.title === 'string' && info.title ? info.title : 'unknown test'
}

function appendElectronProcessLog(app: ElectronApplication, line: string): void {
  const logs = electronProcessLogs.get(app)
  if (!logs) {
    return
  }
  logs.push(line)
  while (logs.join('').length > ELECTRON_PROCESS_LOG_LIMIT && logs.length > 1) {
    logs.shift()
  }
}

export function attachElectronProcessDiagnostics(
  app: ElectronApplication,
  testInfo: TestInfo
): void {
  const logs: string[] = []
  electronProcessLogs.set(app, logs)
  const child = app.process()
  const testTitle = formatTestTitle(testInfo)

  child.stdout?.on('data', (chunk: Buffer | string) => {
    appendElectronProcessLog(app, `[stdout] ${chunk.toString()}`)
  })
  child.stderr?.on('data', (chunk: Buffer | string) => {
    appendElectronProcessLog(app, `[stderr] ${chunk.toString()}`)
  })
  child.on('exit', (code, signal) => {
    appendElectronProcessLog(
      app,
      `[process] Electron exited for ${testTitle} with code=${code ?? 'null'} signal=${
        signal ?? 'null'
      }\n`
    )
  })
  child.on('error', (error) => {
    appendElectronProcessLog(app, `[process] Electron process error for ${testTitle}: ${error}\n`)
  })
}

export function reportElectronProcessFailure(
  label: string,
  error: unknown,
  app: ElectronApplication,
  testInfo: TestInfo
): void {
  const logs = electronProcessLogs.get(app)?.join('').trim()
  console.error(`[orca-e2e] ${label} for ${formatTestTitle(testInfo)}:`, error)
  console.error(
    logs
      ? `[orca-e2e] Electron process output:\n${logs}`
      : '[orca-e2e] No Electron process output captured.'
  )
}
