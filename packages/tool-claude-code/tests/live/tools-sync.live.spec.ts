/**
 * Stage 2 — `claude_code_open` (sync) → `claude_code_send` → `claude_code_wait`
 * → `claude_code_status` → `claude_code_close`, driven THROUGH `ctx.tools.execute`
 * against a REAL Claude Code subprocess: the deepseek-harness-invokes-claude-code
 * path, end to end.
 *
 * What this proves that `packages/claude-code/tests/live/` cannot: the TOOL
 * layer's own sequencing (`src/open.ts`'s open → mirror → send order), its
 * schema round trip through the real `ToolRuntime`, and that the approval
 * audit pair lands in the DELEGATING agent's session log while the mirrored
 * transcript lands in a SEPARATE session keyed by the Claude Code session id
 * (D1) — not the same log, by design.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  LIVE, LIVE_TIMEOUT_MS, mountLiveTools, removeCwd, scriptApproval, TOOL_NAMES, tmpCwd,
  waitForSessionProcessCount,
} from './helpers.ts'

describe.skipIf(!LIVE)('claude_code_* tools, live sync path (DSH_CC_LIVE=1)', () => {
  it(
    'opens through the tool runtime, creates a file via Bash, mirrors coherently, then follows up and closes',
    async () => {
      const cwd = tmpCwd('tools-sync')
      const harness = await mountLiveTools()
      try {
        for (const name of TOOL_NAMES) expect(harness.ctx.tools.get(name)).toBeDefined()

        const target = join(cwd, 'hello.txt')
        const approvals = scriptApproval(harness.ctx, 'allowed-once')

        const openResult = await harness.call(
          'claude_code_open',
          {
            cwd,
            prompt: `Use the Bash tool to run exactly: printf 'hello' > ${target}\n`
              + 'Do it directly, do not ask first. Then reply with one short sentence confirming it ran.',
          },
          { agent: harness.root.agent },
        )

        expect(openResult.isError, JSON.stringify(openResult.error)).toBe(false)
        const opened = openResult.value as {
          kind: string
          session_id: string
          status: string
          result?: string
        }
        expect(opened.kind).toBe('session')
        expect(typeof opened.session_id).toBe('string')
        expect(opened.status).toBe('idle')
        expect(typeof opened.result).toBe('string')
        expect((opened.result ?? '').length).toBeGreaterThan(0)

        // The file really exists — the whole point of routing through approval
        // rather than a scripted `canUseTool`.
        expect(existsSync(target)).toBe(true)
        expect(readFileSync(target, 'utf8')).toBe('hello')

        // --- the mirrored dsh session (SessionStore.get by ccSessionId) ------
        const mirrored = harness.ctx.sessions.get(opened.session_id as never)
        expect(mirrored, 'the CC session id must resolve to a mirrored dsh session').toBeDefined()
        if (mirrored === undefined) throw new Error('unreachable')
        const mirroredTypes = mirrored.events.map(event => event.type)
        expect(mirroredTypes).toContain('turn/start')
        expect(mirroredTypes).toContain('turn/end')
        expect(mirroredTypes).toContain('tool/call')
        expect(mirroredTypes).toContain('tool/result')
        const bashCall = mirrored.events.find(event => event.type === 'tool/call' && event.data.name === 'Bash')
        expect(bashCall, 'a Bash tool/call must be mirrored').toBeDefined()

        // --- the approval audit pair sits in the DELEGATING agent's session --
        // (a DIFFERENT session from the mirror above: the tool creates the
        // mirror under the CC session id, not the delegating agent's own id).
        expect(harness.root.session.id).not.toBe(opened.session_id)
        const rootTypes = harness.root.session.events.map(event => event.type)
        expect(rootTypes).toContain('approval/asked')
        expect(rootTypes).toContain('approval/decided')
        expect(approvals.requests.length).toBeGreaterThanOrEqual(1)
        const asked = harness.root.session.events.find(event => event.type === 'approval/asked')
        if (asked?.type !== 'approval/asked') throw new Error('missing approval/asked')
        // The callId the audit pair references is the one the MIRROR (not the
        // root session) streamed for the Bash call — the correlation §4.4 exists for.
        if (bashCall?.type !== 'tool/call') throw new Error('missing tool/call')
        expect(asked.data.callId).toBe(bashCall.data.callId)

        // --- claude_code_send (followup) --------------------------------------
        const sendResult = await harness.call(
          'claude_code_send',
          { session_id: opened.session_id, message: 'Append the word " world" to the same file. Then confirm in one sentence.', mode: 'followup' },
          { agent: harness.root.agent },
        )
        expect(sendResult.isError, JSON.stringify(sendResult.error)).toBe(false)

        // --- claude_code_wait --------------------------------------------------
        const waitResult = await harness.call(
          'claude_code_wait',
          { session_id: opened.session_id, timeout_ms: LIVE_TIMEOUT_MS },
          { agent: harness.root.agent },
        )
        expect(waitResult.isError, JSON.stringify(waitResult.error)).toBe(false)
        const waited = waitResult.value as { status: string, result?: string }
        expect(waited.status).toBe('idle')
        expect(typeof waited.result).toBe('string')
        expect(existsSync(target)).toBe(true)
        expect(readFileSync(target, 'utf8')).toContain('world')

        // --- claude_code_status --------------------------------------------------
        const statusResult = await harness.call(
          'claude_code_status', { session_id: opened.session_id }, { agent: harness.root.agent })
        expect(statusResult.isError, JSON.stringify(statusResult.error)).toBe(false)
        const status = statusResult.value as { status: string, pending_asks: number }
        expect(status.status).toBe('idle')
        expect(status.pending_asks).toBe(0)

        // --- claude_code_close -----------------------------------------------
        const closeResult = await harness.call(
          'claude_code_close', { session_id: opened.session_id }, { agent: harness.root.agent })
        expect(closeResult.isError, JSON.stringify(closeResult.error)).toBe(false)
        expect(closeResult.value).toEqual({ closed: true })
        expect(harness.ctx.claudeCode.get(opened.session_id as never)).toBeUndefined()

        // Subprocess is really gone (scoped orphan check per D — never a whole-machine count).
        await waitForSessionProcessCount(opened.session_id, 0, 15_000)
        approvals.dispose()
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS * 3,
  )
})
