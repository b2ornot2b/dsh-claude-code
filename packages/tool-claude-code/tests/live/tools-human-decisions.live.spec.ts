/**
 * The operator's misgrading, reproduced LIVE and now answerable.
 *
 * Step 4 of the 13-step acceptance run: a human REJECTED a `Bash` permission in
 * the dsh UI. The deny path was fail-closed and correct — `marker2.txt` was
 * never created — and the delegating agent still reported "the denial was not
 * properly propagated to the session; the file was created despite the denial".
 * It had no evidence a person had acted, so it invented an explanation for a
 * result it could not otherwise account for.
 *
 * Scenario one is that exact step against a REAL Claude Code subprocess and the
 * REAL `ApprovalService`, with a scripted answerer standing in for the person at
 * the keyboard. Three assertions, in the order the agent got them wrong:
 *
 * 1. the file is NOT on disk — the deny really did stop the tool call;
 * 2. the completed turn's `human_decisions` names `Bash`, `outcome: 'rejected'`,
 *    `decided_by: 'human'`;
 * 3. the rendered prose SAYS a human rejected it, in the dsh UI, in words the
 *    agent can repeat instead of guessing.
 *
 * Scenario two is the same denial produced by a TIMEOUT plus the `deny` fallback
 * — nobody ever answers — and asserts the mirror image: the prose must NOT
 * attribute it to a human. This is the failure mode the fix could introduce on
 * its own, from the opposite direction: an agent reading a machine's fail-closed
 * deny and reporting that the operator refused.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'

import {
  LIVE, LIVE_TIMEOUT_MS, mountLiveTools, removeCwd, scriptApproval, tmpCwd, waitForAsync,
} from './helpers.ts'

/** The step-4 prompt: one denied `Bash` call, and nothing else to do. */
const PROMPT
  = 'Use the Bash tool to run exactly: touch marker2.txt\n'
  + 'Then reply with one short sentence saying whether the file was created.'

/** How long each `claude_code_wait` poll parks for. */
const POLL_MS = 5_000

/** Give the whole poll loop room for the model's own latency. */
const LOOP_BUDGET_MS = 120_000

/** The bounded ask wait for scenario two: short enough to elapse, long enough to be real. */
const ASK_TIMEOUT_MS = 8_000

/** One `claude_code_wait` value, in the shape this spec reads it. */
interface WaitValue {
  readonly status: string
  readonly result?: string
  readonly human_decisions?: readonly {
    readonly kind: string
    readonly tool_name?: string
    readonly reason?: string
    readonly outcome: string
    readonly decided_by: string
    readonly detail?: string
  }[]
}

/**
 * Drive one turn to completion through `claude_code_wait`, polling the way a
 * delegating agent does.
 * @param harness - the mounted live composition.
 * @param sessionId - the session to wait on.
 * @returns the completed turn's value and its rendered text.
 */
async function runTurn(
  harness: Awaited<ReturnType<typeof mountLiveTools>>,
  sessionId: string,
): Promise<{ value: WaitValue, text: string }> {
  let rendered = ''
  const value = await waitForAsync(
    async () => {
      const waited = await harness.call(
        'claude_code_wait',
        { session_id: sessionId, timeout_ms: POLL_MS },
        { agent: harness.root.agent })
      expect(waited.isError, JSON.stringify(waited.error)).toBe(false)
      rendered = String((waited.content[0] as { text?: unknown }).text ?? '')
      return waited.value as unknown as WaitValue
    },
    candidate => candidate.result !== undefined,
    LOOP_BUDGET_MS,
    500)
  return { value, text: rendered }
}

describe.skipIf(!LIVE)('human decisions, live (DSH_CC_LIVE=1)', () => {
  it(
    'a human REJECTION is on the record: no file, outcome rejected, and prose that says a human did it',
    async () => {
      const cwd = tmpCwd('tools-human-reject')
      const harness = await mountLiveTools()
      try {
        // The person at the keyboard, clicking "reject" in the dsh UI.
        const scripted = scriptApproval(harness.ctx, 'rejected')

        const opened = await harness.call('claude_code_open', { cwd }, { agent: harness.root.agent })
        expect(opened.isError, JSON.stringify(opened.error)).toBe(false)
        const sessionId = (opened.value as { session_id: string }).session_id

        const sent = await harness.call(
          'claude_code_send',
          { session_id: sessionId, message: PROMPT, mode: 'followup' },
          { agent: harness.root.agent })
        expect(sent.isError, JSON.stringify(sent.error)).toBe(false)

        const { value, text } = await runTurn(harness, sessionId)

        // eslint-disable-next-line no-console -- this string is the deliverable; print it for the run log.
        console.log(`\n=== what the model sees after a human REJECTS ===\n${text}\n===\n`)

        // 1. The deny was fail-closed and correct. This is the fact the agent
        //    denied outright ("the file was created despite the denial").
        expect(existsSync(join(cwd, 'marker2.txt')), 'marker2.txt must NOT exist after a rejection').toBe(false)

        // 2. And the turn's own result now carries the evidence for it.
        expect(scripted.requests.length).toBeGreaterThanOrEqual(1)
        const decisions = value.human_decisions ?? []
        const rejection = decisions.find(entry => entry.tool_name === 'Bash' && entry.outcome === 'rejected')
        expect(rejection, `no Bash rejection in ${JSON.stringify(decisions)}`).toBeDefined()
        expect(rejection?.kind).toBe('permission')
        expect(rejection?.decided_by).toBe('human')
        // The words the human was shown, not a paraphrase invented on this side.
        expect(rejection?.reason ?? '').toContain('marker2.txt')

        // 3. The sentence a delegating agent repeats instead of guessing.
        expect(text).toContain('permission for Bash')
        expect(text).toContain('REJECTED by a human in the dsh UI')

        await harness.call('claude_code_close', { session_id: sessionId }, { agent: harness.root.agent })
        scripted.dispose()
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'a TIMEOUT denial is reported as policy, and the prose never attributes it to a human',
    async () => {
      const cwd = tmpCwd('tools-human-timeout')
      // A bounded wait plus the default `deny` fallback: the same denial, with
      // nobody behind it.
      const harness = await mountLiveTools({ claudeCode: { ask: { timeoutMs: ASK_TIMEOUT_MS, fallback: 'deny' } } })
      try {
        // Nobody ever answers. The ask can only be settled by the table's timeout.
        const off = harness.ctx.on('approval/request', async () => await new Promise<ApprovalOutcome>(() => {}))

        const opened = await harness.call('claude_code_open', { cwd }, { agent: harness.root.agent })
        expect(opened.isError, JSON.stringify(opened.error)).toBe(false)
        const sessionId = (opened.value as { session_id: string }).session_id

        const sent = await harness.call(
          'claude_code_send',
          { session_id: sessionId, message: PROMPT, mode: 'followup' },
          { agent: harness.root.agent })
        expect(sent.isError, JSON.stringify(sent.error)).toBe(false)

        const { value, text } = await runTurn(harness, sessionId)

        // eslint-disable-next-line no-console -- this string is the deliverable; print it for the run log.
        console.log(`\n=== what the model sees when NOBODY answers ===\n${text}\n===\n`)

        expect(existsSync(join(cwd, 'marker2.txt')), 'marker2.txt must NOT exist after a fallback deny').toBe(false)
        const decisions = value.human_decisions ?? []
        const denial = decisions.find(entry => entry.tool_name === 'Bash')
        expect(denial, `no Bash settle in ${JSON.stringify(decisions)}`).toBeDefined()
        expect(denial?.decided_by).toBe('policy')
        expect(denial?.outcome).toBe('timed-out')
        // THE negative property: the same deny, and nothing here may read as a
        // person's refusal.
        expect(text).toContain('NOT a human decision')
        expect(text).not.toContain('by a human in the dsh UI')

        await harness.call('claude_code_close', { session_id: sessionId }, { agent: harness.root.agent })
        off()
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
