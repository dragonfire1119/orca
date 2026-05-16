# Crash Reporting Flow

## Summary

Users should report an Orca crash through an in-app recovery prompt shown on the next launch, with
manual access from `Help -> Report Crash...`. Orca records a small, privacy-safe crash envelope in
the main process when Electron reports a renderer or child-process failure. The next healthy
renderer lets the user review the summary, add optional context, send it, copy it, or decline.
Main also keeps a tiny memory-only ring buffer of privacy-safe app breadcrumbs and persists a
snapshot only when a crash is recorded.

The first version should reuse the existing feedback transport rather than introducing minidump
upload. That keeps the system shippable while preserving the core product promise: users do not
need to find OS crash files, terminal logs, or local paths to tell us what broke.

## Problem

- `src/main/window/createMainWindow.ts:463` handles `render-process-gone` only to reset markdown-editor focus. Crashes are not surfaced to users.
- `src/main/ipc/feedback.ts` already accepts free-form `feedback` plus optional identity and main-owned app/OS metadata, but there is no crash-specific IPC lane.
- `src/preload/index.ts` and `src/preload/api-types.ts` expose only `feedback.submit`; renderer code cannot query/dismiss/copy pending crash diagnostics.
- `src/main/menu/register-app-menu.ts` and its callsite in `src/main/index.ts` have no crash-report action in Help.
- Support receives low-signal reports like "Orca crashed" without version, OS, process type, or
  Electron reason, so follow-up starts by asking for details the app already knows.

## Goal

After a process crash, Orca should let users review and submit a privacy-safe crash report from inside the app, without finding OS crash files.

Success means:

- A user who restarts after a crash sees a single clear recovery prompt.
- Sending the report takes one click, with optional notes for the repro path.
- The user can inspect/copy the exact diagnostic text before sending.
- No terminal output, prompt content, environment variables, repo content, absolute paths, or secrets
  are collected by default.
- The engineering team receives enough structured context to group incidents by build, platform,
  process, reason, exit code, and the last few coarse app states.

## Non-goals

- No automatic minidump upload (`crashReporter.start`) in this pass.
- No scraping/parsing OS crash files (`.ips`, Windows WER, Linux coredumps).
- No collection of terminal output, prompt content, env vars, tokens, cookies, repo file content, or absolute local/remote paths.
- No modal shown during a currently unstable/crashing renderer. Capture happens in main; reporting
  waits until a healthy renderer exists.
- No crash report for normal app quit, reload, or renderer exits that Electron classifies outside
  the crash-like reason allowlist.
- No continuous disk writes for activity breadcrumbs. They live in memory and are written only with
  a crash report.

## User Journey

| Step              | Surface          | User Need                                        | System Behavior                                                                                 |
| ----------------- | ---------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Crash happens     | Main process     | Preserve useful diagnostics even if UI is gone   | Record a sanitized pending report plus recent app breadcrumbs in `userData/crash-reports.json`. |
| User reopens Orca | Renderer boot    | Understand what happened without losing momentum | Prompt once per launch if a pending report exists.                                              |
| Review            | Dialog           | Know what will be shared                         | Show process/reason/exit code, timestamp, app version, OS/arch, and a short privacy statement.  |
| Add context       | Dialog textarea  | Explain the repro in their words                 | Optional notes, sanitized before transport.                                                     |
| Send              | Primary action   | Submit quickly                                   | Post through main-owned feedback transport; mark `sent` only after success.                     |
| Copy instead      | Secondary action | Share manually in GitHub/Slack/email             | Copy the exact report text to clipboard without changing status.                                |
| Decline           | Secondary action | Opt out of this incident                         | Mark report `dismissed`; do not prompt for that report again.                                   |

Manual path: `Help -> Report Crash...` opens the same dialog. If no pending report exists, show a
quiet empty state and offer `Copy Details` only when a report is available. A future version can add
"Report a problem..." for non-crash feedback, but crash reporting should stay focused on recorded
incidents.

## UX Spec

Use a modal dialog because this is a post-crash decision and should not be buried in the sidebar.
Keep it small, direct, and consistent with Orca's quiet monochrome style.

- Title: `Orca crashed last session`
- Description: `Send a privacy-safe diagnostic report so we can investigate without asking you to find system crash files.`
- Summary row: `{processType} {reason} (exit {exitCode})`, then `{timestamp} · {platform} {arch} · Orca {appVersion}`
- Notes placeholder: `Optional: what were you doing when it crashed?`
- Identity checkbox when GitHub identity is available: `Submit anonymously instead of as {login}`
- Primary action: `Send Report`
- Secondary actions: `Copy Details`, `Don't Send`
- Success toast: `Crash report sent.`
- Copy toast: `Crash report copied.`
- Submit failure toast: `Failed to send crash report.`
- Empty state: `No pending crash report is available.`

Rules:

- Prompt once per app launch, not repeatedly while the user works.
- Closing the dialog without `Don't Send` should only hide it for this launch; it should not mutate
  report state. Explicit decline marks `dismissed`.
- If submit fails because the user is offline or the endpoint is down, keep the report `pending` so
  `Help -> Report Crash...` can retry.
- If the report was already sent or dismissed by another window, show the terminal status and avoid
  double-posting.

## Design

1. **Shared crash schema (`src/shared/crash-reporting.ts`)**
   - `CrashReportRecord`: `id`, `createdAt`, `status` (`pending|sent|dismissed`), `source` (`renderer|child`), `processType`, `reason`, `exitCode`, `appVersion`, `platform`, `osRelease`, `arch`, `electronVersion`, `chromeVersion`, sanitized `details`, and optional sanitized `breadcrumbs`.
   - Keep `details` strict-allowlist only. Redact path-like strings (`/Users/...`, `C:\\Users\\...`, `\\\\server\\...`) and obvious secret patterns.
   - Breadcrumbs are capped to 30 entries and use the same primitive allowlist/redaction as
     `details`.
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

4. **Memory-only breadcrumbs**
   - Add `src/main/crash-reporting/crash-breadcrumb-store.ts` as a fixed-size in-memory ring buffer.
   - Record coarse, non-content app events such as `app_started`, `main_window_created`,
     `main_window_loaded`, `settings_opened`, `feature_tour_opened`, `crash_report_opened`, and
     `agent_state_changed`.
   - Store only event name, timestamp, and primitive metadata such as app platform, packaged/dev
     state, agent type, and agent state.
   - Never record prompts, terminal output, URLs, file names, repo names, branch names, absolute
     paths, or workspace IDs.
   - Snapshot breadcrumbs into the crash record only inside `recordProcessGoneCrash`; no background
     persistence.

5. **IPC surface**
   - Add `src/main/ipc/crash-reporting.ts`; register from `registerCoreHandlers` (same lifecycle as `feedback`).
   - Handlers:
     - `crashReports:getLatestPending`
     - `crashReports:dismiss`
     - `crashReports:copyLatestDiagnostics`
     - `crashReports:submit`
   - `submit` builds text payload beginning `[Crash Report]` and posts through existing `submitFeedback` path, including the same identity/anonymity args shape used by `feedback:submit`.
   - Mark `sent` only after confirmed `{ ok: true }`; keep `pending` on all failures.

6. **Preload + types**
   - Extend `src/preload/index.ts` and `src/preload/api-types.ts` with `window.api.crashReports` methods matching IPC.

7. **UI + menu integration**
   - Add renderer crash-report dialog with summary, optional notes, and actions: `Send Report`, `Copy Details`, `Don’t Send`.
   - On renderer boot, query `getLatestPending`; if present, prompt once per app launch.
   - Add `Help -> Report Crash...` in `register-app-menu.ts` via new option `onOpenCrashReport(window?)`, following existing `onOpenFeatureTour(window?)` targeting pattern so it routes to the invoking window.
   - Main sends `ui:openCrashReport`; renderer opens dialog and loads latest pending record.

8. **Support intake**
   - Prefix submitted feedback with `[Crash Report]` so the current feedback receiver can route or
     filter it without a transport migration.
   - Keep the structured fields in stable `Key: Value` lines so support tooling can group by
     `App version`, `Platform`, `Process`, `Reason`, and `Exit code`.
   - Treat user notes as untrusted free text: sanitize before submission and never parse them for
     secrets or internal routing.

9. **Future backend split**
   - If crash volume grows, add a dedicated `POST /v1/crash-reports` endpoint that accepts a JSON
     body matching `CrashReportRecord` plus sanitized notes.
   - Keep the client-side review flow unchanged; only swap the main-process transport.
   - Add server-side grouping keys: `appVersion`, `platform`, `arch`, `processType`, `reason`,
     `exitCode`, `electronVersion`, and a normalized details hash.

## Edge Cases / Consistency

- Renderer unavailable during crash: capture is main-owned, so no renderer dependency.
- Multi-window safety: crash events are process-level; keep one shared store and route Help-menu action to originating window while reading shared pending state.
- Submit race (button double-click or two windows): enforce single-flight per report id; second submit returns current status.
- Dismiss vs submit race: terminal state transition rule (`pending -> sent|dismissed` once) to prevent flip-flop.
- Offline/server error: preserve `pending`; surface same error semantics as current feedback flow.
- External file mutation/deletion: on read failure, reset in-memory cache from disk best-effort; if missing, recreate file lazily.
- Crash loop: app should still start if `crash-reports.json` is corrupt or locked. The store must
  recover as empty instead of blocking window creation.
- SSH workspaces: do not assume the crash came from local project files. The crash envelope should
  describe Orca/Electron process state, not workspace file state.
- Web build: expose no-op crash-report APIs so shared renderer code can mount safely outside
  Electron.
- Breadcrumb overhead: recording is O(1) against a 30-entry array and does not touch disk until a
  crash report is already being persisted.

## Privacy Boundary

Allowed by default:

- Orca version, Electron version, Chrome version.
- OS platform, OS release, CPU architecture.
- Electron process type, crash reason, exit code.
- Small allowlisted primitive detail values after redaction.
- Coarse app breadcrumbs with primitive, sanitized metadata.
- Optional user notes after string sanitization.
- GitHub login/email only when the user does not choose anonymous submission.

Disallowed by default:

- Terminal scrollback, prompt text, model output, shell commands, env vars, cookies, tokens, API keys.
- Repository names, branch names, file content, diffs, task prompts, issue titles, or URLs.
- Absolute local paths, UNC paths, remote SSH paths, and workspace roots.
- OS minidumps or native crash logs in this pass.

## Feasibility Notes

- Reusing feedback transport is feasible now: `submitFeedback` already sends arbitrary text plus app/OS metadata through main-process `net.fetch` (CORS-safe for `file://` renderer).
- This is not “free”: requires new shared types, store, IPC, preload types, menu option plumbing, and renderer dialog state.

## Metrics

Track product-health metrics without adding crash payload telemetry:

- `pending_crash_reports_created`: count by app version, platform, process type, reason.
- `crash_report_prompt_shown`: count by app version/platform.
- `crash_report_sent`: count by app version/platform/process/reason.
- `crash_report_dismissed`: count by app version/platform/process/reason.
- `crash_report_submit_failed`: count by status class (`network`, `4xx`, `5xx`, `unknown`).

Operational targets:

- At least 30% of recorded pending crashes become sent reports.
- Less than 2% duplicate submissions per report id.
- 95% of report submissions complete or fail visibly within 5 seconds.
- Support can group the top crash signatures weekly without asking users for OS crash files.

## Rollout

1. Shared types + redaction tests.
2. Main store + persistence/concurrency tests.
3. Capture wiring tests for `render-process-gone` and `child-process-gone`.
4. IPC + preload API tests for get/dismiss/copy/submit.
5. Menu plumbing + renderer dialog behavior tests.
6. Manual validation: synthetic pending report shows prompt; Help entry opens dialog; copy works; failed submit stays pending.

## Open Questions

- Should `Don't Send` be a permanent dismissal or only a "not now" action? Current design treats it
  as permanent for that incident to avoid nagging after a crash.
- Should `Copy Details` leave a report pending? Current design says yes because copying may be used
  before manual sharing or retrying later.
- Should crash reports ignore telemetry opt-out? Current design treats this as explicit user
  submission, separate from passive telemetry, and still offers anonymous submission.
