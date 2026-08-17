/**
 * Stage 2 — the ask channel routed all the way from a REAL Claude Code
 * subprocess THROUGH the tool layer's `resolveAskTarget` (`exec.agent` →
 * `{ agent, delegated }`) to the delegating agent's REAL `ctx.userQuestions`
 * provider, proving the ask target rides through the TOOL boundary, not just
 * the seam boundary `packages/claude-code/tests/live/ask-question.live.spec.ts`
 * already covers.
 */

import { describe, expect, it } from 'vitest'

import { LIVE, LIVE_TIMEOUT_MS, mountLiveTools, removeCwd, scriptQuestionAnswer, tmpCwd } from './helpers.ts'

const PROMPT
  = 'Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: '
  + '"Red" and "Blue". After you get my answer, reply with one short sentence that repeats the '
  + 'color I chose back to me.'

describe.skipIf(!LIVE)('claude_code_open — ask channel through the tool layer, live (DSH_CC_LIVE=1)', () => {
  it(
    'a real AskUserQuestion call is answered by the delegating agent\'s provider, and the answer reaches the result',
    async () => {
      const cwd = tmpCwd('tools-ask-question')
      const harness = await mountLiveTools()
      try {
        const dispose = scriptQuestionAnswer(harness.ctx, 'Blue')

        const openResult = await harness.call(
          'claude_code_open',
          { cwd, prompt: PROMPT },
          { agent: harness.root.agent },
        )
        expect(openResult.isError, JSON.stringify(openResult.error)).toBe(false)
        const opened = openResult.value as { session_id: string, status: string, result?: string }
        expect(opened.status).toBe('idle')
        expect((opened.result ?? '').toLowerCase()).toContain('blue')

        // The AskUserQuestion call was mirrored under the CC session id, and
        // resolved without ever routing through approval (dsh's clarifying
        // questions seam, not the permission seam).
        const mirrored = harness.ctx.sessions.get(opened.session_id as never)
        expect(mirrored).toBeDefined()
        const askCall = mirrored?.events.find(
          event => event.type === 'tool/call' && event.data.name === 'AskUserQuestion')
        expect(askCall, 'AskUserQuestion must be mirrored as a tool/call').toBeDefined()

        await harness.call('claude_code_close', { session_id: opened.session_id }, { agent: harness.root.agent })
        dispose()
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'with no exec.agent (a headless call), the seam fails closed and denies the ask — no hang',
    async () => {
      const cwd = tmpCwd('tools-ask-headless')
      const harness = await mountLiveTools()
      try {
        // No `agent` option: `resolveAskTarget` returns undefined, so the seam
        // attaches NO ask target at all and fails every ask closed.
        const openResult = await harness.call('claude_code_open', { cwd, prompt: PROMPT })
        expect(openResult.isError, JSON.stringify(openResult.error)).toBe(false)
        const opened = openResult.value as { session_id: string, status: string, result?: string }
        expect(opened.status).toBe('idle')
        // The turn still completes (Claude Code proceeds on the deny rather than hanging).
        expect((opened.result ?? '').length).toBeGreaterThan(0)

        await harness.call('claude_code_close', { session_id: opened.session_id })
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
