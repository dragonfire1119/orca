// Why: the client deploy step rewrites `${remoteDir}/.version` on every
// version-hash mismatch, but a daemon launched by an earlier deploy keeps
// running its in-memory copy of the OLD code until it is killed. Once the
// daemon writes its in-memory version into `${remoteDir}/.running-version`
// at startup, the client can probe that file to distinguish "code on disk
// is current" from "code actually executing is current", and force a fresh
// daemon launch on mismatch instead of attaching the new --connect bridge
// to a stale daemon that mishandles the protocol and tears the channel
// down in a tight reconnect loop.

import { join } from 'path'
import { readFileSync } from 'fs'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'

export async function runningRelayMatchesDeployed(
  conn: SshConnection,
  remoteRelayDir: string,
  localRelayDir: string | null
): Promise<boolean> {
  let expectedVersion: string | null = null
  if (localRelayDir) {
    try {
      expectedVersion = readFileSync(join(localRelayDir, '.version'), 'utf-8').trim()
    } catch {
      /* fall through */
    }
  }
  // Why: missing local .version means the build artifact predates the
  // content-hash version marker. Attaching is the right default for
  // back-compat — any future deploy will rewrite the marker.
  if (!expectedVersion) {
    return true
  }

  let runningVersion: string | null = null
  try {
    const out = await execCommand(
      conn,
      `cat ${shellEscape(`${remoteRelayDir}/.running-version`)} 2>/dev/null || echo MISSING`
    )
    const trimmed = out.trim()
    runningVersion = trimmed && trimmed !== 'MISSING' ? trimmed : null
  } catch {
    /* unreadable — fall through to attach */
  }
  // Why: missing .running-version means the running daemon predates this
  // fix (no marker writer). Attaching is the safe default to avoid killing
  // a healthy old daemon with live PTYs; the next redeploy that runs into
  // a real protocol mismatch is bounded by ssh.ts's exponential backoff.
  if (!runningVersion) {
    return true
  }
  return runningVersion === expectedVersion
}

// Why: TERM gives the daemon's SIGTERM handler a chance to call shutdown(),
// which removes the socket file and lets PTY children exit cleanly. The
// follow-up rm covers daemons that ignore TERM (e.g. stuck in an awaited
// I/O). We do not use SIGKILL — a stuck daemon that will not TERM is a
// separate bug and force-killing it would orphan PTY children.
export async function killStaleRelayDaemon(
  conn: SshConnection,
  remoteRelayDir: string,
  sockFile: string
): Promise<void> {
  const escapedDir = shellEscape(remoteRelayDir)
  // Why: pgrep matches by full command line so we do not touch unrelated
  // node processes on the same host. `|| true` keeps the chain alive even
  // when pgrep finds nothing or is missing entirely (very minimal sshd
  // shells); the rm at the end then ensures stale sock/marker files do
  // not block a fresh launch.
  const killCmd = [
    `pids=$(pgrep -f "node relay.js --detached" 2>/dev/null || true)`,
    `if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; sleep 1; fi`,
    `rm -f ${shellEscape(sockFile)} ${shellEscape(`${remoteRelayDir}/.running-version`)} 2>/dev/null || true`
  ].join(' && ')
  try {
    await execCommand(conn, `cd ${escapedDir} && ${killCmd}`)
  } catch (err) {
    console.warn(
      '[ssh-relay] Failed to clean up stale daemon:',
      err instanceof Error ? err.message : String(err)
    )
  }
}
