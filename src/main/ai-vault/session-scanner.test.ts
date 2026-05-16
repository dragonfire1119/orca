import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildAiVaultResumeCommand } from '../../shared/ai-vault-types'
import { scanAiVaultSessions } from './session-scanner'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions', () => {
  it('indexes Claude and Codex transcripts with resume commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-'))
    tempRoots.push(root)
    const claudeRoot = join(root, 'claude-projects')
    const codexRoot = join(root, 'codex-sessions')
    await mkdir(join(claudeRoot, 'project'), { recursive: true })
    await mkdir(join(codexRoot, '2026', '05', '01'), { recursive: true })

    await writeFile(
      join(claudeRoot, 'project', 'claude-session.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-session',
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: '/repo/app',
          gitBranch: 'feature/vault',
          isMeta: false,
          message: { role: 'user', content: 'Implement the vault panel' }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'claude-session',
          timestamp: '2026-05-01T10:02:00.000Z',
          cwd: '/repo/app',
          gitBranch: 'feature/vault',
          message: {
            model: 'claude-sonnet-4-5',
            usage: {
              input_tokens: 100,
              output_tokens: 40,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 5
            }
          }
        })
      ].join('\n')
    )

    await writeFile(
      join(
        codexRoot,
        '2026',
        '05',
        '01',
        'rollout-2026-05-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl'
      ),
      [
        JSON.stringify({
          timestamp: '2026-05-01T11:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: '019f0000-1111-7222-8333-444444444444',
            cwd: '/repo/app/packages/web',
            git: { branch: 'feature/codex-vault' }
          }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T11:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'text', text: '# AGENTS.md instructions for /repo/app <INSTRUCTIONS>' }
            ]
          }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T11:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Fix the resume picker filters' }]
          }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T11:00:03.000Z',
          type: 'turn_context',
          payload: { cwd: '/repo/app/packages/web', model: 'gpt-5.3-codex' }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T11:00:04.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 500,
                cached_input_tokens: 100,
                output_tokens: 125,
                reasoning_output_tokens: 25,
                total_tokens: 625
              }
            }
          }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T11:00:05.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 500,
                cached_input_tokens: 100,
                output_tokens: 125,
                reasoning_output_tokens: 25,
                total_tokens: 625
              }
            }
          }
        })
      ].join('\n')
    )

    const result = await scanAiVaultSessions({
      claudeProjectsDir: claudeRoot,
      codexSessionsDir: codexRoot,
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(2)
    expect(result.sessions.map((session) => session.title).sort()).toEqual([
      'Fix the resume picker filters',
      'Implement the vault panel'
    ])

    const claude = result.sessions.find((session) => session.agent === 'claude')
    expect(claude).toMatchObject({
      sessionId: 'claude-session',
      cwd: '/repo/app',
      branch: 'feature/vault',
      model: 'claude-sonnet-4-5',
      messageCount: 2,
      totalTokens: 155,
      resumeCommand: "cd '/repo/app' && claude --resume 'claude-session'"
    })

    const codex = result.sessions.find((session) => session.agent === 'codex')
    expect(codex).toMatchObject({
      sessionId: '019f0000-1111-7222-8333-444444444444',
      cwd: '/repo/app/packages/web',
      branch: 'feature/codex-vault',
      model: 'gpt-5.3-codex',
      messageCount: 2,
      totalTokens: 625,
      resumeCommand:
        "cd '/repo/app/packages/web' && codex resume '019f0000-1111-7222-8333-444444444444'"
    })
  })
})

describe('buildAiVaultResumeCommand', () => {
  it('wraps Windows cwd changes in cmd so PowerShell and cmd launch the same resume command', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'codex',
        sessionId: 'session-1',
        cwd: 'C:\\Users\\Ada Lovelace\\repo',
        platform: 'win32'
      })
    ).toBe('cmd /d /s /c "cd /d ""C:\\Users\\Ada Lovelace\\repo"" && codex resume ""session-1"""')
  })
})
