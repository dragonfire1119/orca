# Crash Reporting Flow

## Problem

- `src/main/window/createMainWindow.ts:463` handles `render-process-gone` only to reset markdown-editor focus. Crashes are not surfaced to users.
- `src/main/ipc/feedback.ts` already accepts free-form `feedback` plus optional identity and main-owned app/OS metadata, but there is no crash-specific IPC lane.
- `src/preload/index.ts` and `src/preload/api-types.ts` expose only `feedback.submit`; renderer code cannot query/dismiss/copy pending crash diagnostics.
- `src/main/menu/register-app-menu.ts` and its callsite in `src/main/index.ts` have no crash-report action in Help.

## Goal

After a process crash, Orca should let users review and submit a privacy-safe crash report from inside the app, without finding OS crash files.

## Non-goals

- No automatic minidump upload (`crashReporter.start`) in this pass.
- No scraping/parsing OS crash files (`.ips`, Windows WER, Linux coredumps).
- No collection of terminal output, prompt content, env vars, tokens, cookies, repo file content, or absolute local/remote paths.

## Design

1. **Shared crash schema (`src/shared/crash-reporting.ts`)**
   - `CrashReportRecord`: `id`, `createdAt`, `status` (`pending|sent|dismissed`), `source` (`renderer|child`), `processType`, `reason`, `exitCode`, `appVersion`, `platform`, `osRelease`, `arch`, `electronVersion`, `chromeVersion`, and sanitized `details`.
   - Keep `details` strict-allowlist only. Redact path-like strings (`/Users/...`, `C:\\Users\\...`, `\\\\server\\...`) and obvious secret patterns.
   - Do not store route strings/URLs/query fragments in this record; they can contain workspace paths, repo names, or access tokens.

2. **Main-process store (`src/main/crash-reporting/crash-report-store.ts`)**
   - Persist under `app.getPath('userData')/crash-reports.json`.
   - Atomic write (`.tmp` + rename), in-memory serialize writes, cap to newest 5 records.
   - Corrupt JSON: log and recover as empty (never crash app startup).
   - API: `record`, `getLatestPending`, `listRecent`, `markSent`, `dismiss`, `formatDiagnosticText`.

3. **Crash capture wiring**
   - In `createMainWindow.ts`, add a second `render-process-gone` listener that records crashes for reasons: `crashed`, `oom`, `killed`, `integrity-failure`, `memory-eviction`.
   - In `src/main/index.ts`, register `app.on('child-process-gone', ...)` once after app init; capture GPU/utility process failures from this event. Do not rely on deprecated `gpu-process-crashed`.
   - De-duplicate near-simultaneous events (`processType + reason + exitCode` within short window) to avoid double reports from one incident.

4. **IPC surface**
   - Add `src/main/ipc/crash-reporting.ts`; register from `registerCoreHandlers` (same lifecycle as `feedback`).
   - Handlers:
     - `crashReports:getLatestPending`
     - `crashReports:dismiss`
     - `crashReports:copyLatestDiagnostics`
     - `crashReports:submit`
   - `submit` builds text payload beginning `[Crash Report]` and posts through existing `submitFeedback` path, including the same identity/anonymity args shape used by `feedback:submit`.
   - Mark `sent` only after confirmed `{ ok: true }`; keep `pending` on all failures.

5. **Preload + types**
   - Extend `src/preload/index.ts` and `src/preload/api-types.ts` with `window.api.crashReports` methods matching IPC.

6. **UI + menu integration**
   - Add renderer crash-report dialog with summary, optional notes, and actions: `Send Report`, `Copy Details`, `Don’t Send`.
   - On renderer boot, query `getLatestPending`; if present, prompt once per app launch.
   - Add `Help -> Report Crash...` in `register-app-menu.ts` via new option `onOpenCrashReport(window?)`, following existing `onOpenFeatureTour(window?)` targeting pattern so it routes to the invoking window.
   - Main sends `ui:openCrashReport`; renderer opens dialog and loads latest pending record.

## Edge Cases / Consistency

- Renderer unavailable during crash: capture is main-owned, so no renderer dependency.
- Multi-window safety: crash events are process-level; keep one shared store and route Help-menu action to originating window while reading shared pending state.
- Submit race (button double-click or two windows): enforce single-flight per report id; second submit returns current status.
- Dismiss vs submit race: terminal state transition rule (`pending -> sent|dismissed` once) to prevent flip-flop.
- Offline/server error: preserve `pending`; surface same error semantics as current feedback flow.
- External file mutation/deletion: on read failure, reset in-memory cache from disk best-effort; if missing, recreate file lazily.

## Feasibility Notes

- Reusing feedback transport is feasible now: `submitFeedback` already sends arbitrary text plus app/OS metadata through main-process `net.fetch` (CORS-safe for `file://` renderer).
- This is not “free”: requires new shared types, store, IPC, preload types, menu option plumbing, and renderer dialog state.

## Rollout

1. Shared types + redaction tests.
2. Main store + persistence/concurrency tests.
3. Capture wiring tests for `render-process-gone` and `child-process-gone`.
4. IPC + preload API tests for get/dismiss/copy/submit.
5. Menu plumbing + renderer dialog behavior tests.
6. Manual validation: synthetic pending report shows prompt; Help entry opens dialog; copy works; failed submit stays pending.
