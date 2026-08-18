/**
 * The concurrency ceiling, and the two things a model can now do about it —
 * against a REAL Claude Code subprocess and the REAL tool runtime.
 *
 * The production trace this exists for: an agent hit
 * `limits.maxConcurrentSessions` three times while believing it had opened two
 * sessions. Two of the four slots were held by sessions from EARLIER runs of the
 * same host service — one parked 1h32m on a permission prompt nobody answered —
 * and the refusal named only the limit, so the agent could not tell which
 * sessions existed, let alone which were abandoned. It closed its own
 * still-wanted plan session by guesswork.
 *
 * Two specs, one per fix, both end to end:
 *
 * 1. the refusal NAMES the sessions holding the slots (id, cwd, age, what is
 *    pending), `claude_code_list` returns the same inventory on demand, and
 *    closing the session the refusal recommended frees the slot for real;
 * 2. `limits.idleTimeoutMs` reclaims an ABANDONED session — and never one a
 *    human is mid-decision on, which is exactly the state the 1h32m session was
 *    in and the reason the sweep alone could not have saved that trace.
 */

import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'

import {
  LIVE, LIVE_TIMEOUT_MS, mountLiveTools, removeCwd, scriptApproval, sleep, tmpCwd, waitForAsync,
} from './helpers.ts'

/** One `claude_code_list` entry, in the shape these specs read it. */
interface ListEntry {
  readonly session_id: string
  readonly status: string
  readonly cwd: string
  readonly age_ms: number
  readonly pending_asks: number
  readonly pending_ask_details: readonly { readonly kind: string, readonly tool_name?: string }[]
  readonly close_reason?: string
}

/** The idle ceiling the reaping spec runs at — a few seconds, so the sweep is observable in a test. */
const IDLE_CEILING_MS = 5_000

/**
 * How long to wait for the sweep to act: reap latency is up to ~1.25x the
 * ceiling (one timer at a quarter of it), plus room for a real close.
 */
const REAP_BUDGET_MS = 30_000

/** A prompt that reliably makes the CLI ask for a `Write` permission. */
const WRITE_PROMPT
  = 'Use the Write tool to create a file named notes.txt in the current working directory whose entire '
  + 'contents are exactly: alpha\nThen reply with one short sentence confirming you wrote it.'

describe.skipIf(!LIVE)('the SESSION_LIMIT refusal and claude_code_list, live (DSH_CC_LIVE=1)', () => {
  it(
    'names both sessions holding the slots, lists them, and frees one on close',
    async () => {
      // Two directories, because the cwd is the field that says WHOSE session a
      // session is — the one thing a caller staring at two opaque UUIDs can act
      // on. A refusal that named neither is what the trace produced.
      const apiCwd = tmpCwd('limit-api')
      const webCwd = tmpCwd('limit-web')
      const harness = await mountLiveTools({
        claudeCode: { prewarm: false, limits: { maxConcurrentSessions: 2 } },
      })
      try {
        const first = await harness.call('claude_code_open', { cwd: apiCwd }, { agent: harness.root.agent })
        expect(first.isError, JSON.stringify(first.error)).toBe(false)
        const firstId = (first.value as { session_id: string }).session_id

        const second = await harness.call('claude_code_open', { cwd: webCwd }, { agent: harness.root.agent })
        expect(second.isError, JSON.stringify(second.error)).toBe(false)
        const secondId = (second.value as { session_id: string }).session_id

        // The third open: refused, and the refusal has to be actionable.
        const third = await harness.call('claude_code_open', { cwd: apiCwd }, { agent: harness.root.agent })
        expect(third.isError).toBe(true)
        expect(third.error?.info?.code).toBe('SESSION_LIMIT')
        const refusal = third.error?.message ?? ''
        // Both sessions, by id AND by working directory.
        expect(refusal).toContain(firstId)
        expect(refusal).toContain(secondId)
        expect(refusal).toContain(apiCwd)
        expect(refusal).toContain(webCwd)
        // The fact the production agent could not deduce.
        expect(refusal).toContain('SERVICE-WIDE')
        expect(refusal).toContain('OTHER dsh sessions')
        // …and the two concrete next actions.
        expect(refusal).toContain('claude_code_list')
        expect(refusal).toContain('Best candidate to close:')
        // Printed on purpose: this message is the deliverable of the whole
        // change, and a live run is where its real wording can be read.
        console.log(`\n--- verbatim SESSION_LIMIT message a model now reads ---\n${refusal}\n---\n`)

        // The same inventory, on demand, without having to fail an open first.
        const listed = await harness.call('claude_code_list', {}, { agent: harness.root.agent })
        expect(listed.isError, JSON.stringify(listed.error)).toBe(false)
        const { sessions } = listed.value as unknown as { sessions: ListEntry[] }
        expect(sessions).toHaveLength(2)
        expect([...sessions.map(entry => entry.session_id)].sort()).toEqual([firstId, secondId].sort())
        expect([...sessions.map(entry => entry.cwd)].sort()).toEqual([apiCwd, webCwd].sort())
        expect(sessions.every(entry => entry.age_ms >= 0)).toBe(true)

        // Close the one the refusal recommended, and the slot is genuinely free:
        // this is the step the production agent had to guess at.
        const candidate = /Best candidate to close: (\S+)/.exec(refusal)?.[1]
        expect(candidate === firstId || candidate === secondId).toBe(true)
        const closed = await harness.call(
          'claude_code_close', { session_id: candidate }, { agent: harness.root.agent })
        expect(closed.isError, JSON.stringify(closed.error)).toBe(false)

        const retried = await harness.call('claude_code_open', { cwd: apiCwd }, { agent: harness.root.agent })
        expect(retried.isError, JSON.stringify(retried.error)).toBe(false)

        // Two live again, and the closed one is only visible when asked for.
        const after = await harness.call('claude_code_list', {}, { agent: harness.root.agent })
        expect((after.value as unknown as { sessions: ListEntry[] }).sessions).toHaveLength(2)
        const withClosed = await harness.call(
          'claude_code_list', { include_closed: true }, { agent: harness.root.agent })
        const closedEntry = (withClosed.value as unknown as { sessions: ListEntry[] })
          .sessions.find(entry => entry.session_id === candidate)
        expect(closedEntry?.close_reason).toBe('closed')
      } finally {
        await harness.dispose()
        removeCwd(apiCwd)
        removeCwd(webCwd)
      }
    },
    LIVE_TIMEOUT_MS)
})

describe.skipIf(!LIVE)('opt-in idle reaping, live (DSH_CC_LIVE=1)', () => {
  it(
    'reclaims an abandoned session and never one a human is mid-decision on',
    async () => {
      const idleCwd = tmpCwd('reap-idle')
      const blockedCwd = tmpCwd('reap-blocked')
      const harness = await mountLiveTools({
        claudeCode: { prewarm: false, limits: { idleTimeoutMs: IDLE_CEILING_MS } },
      })
      try {
        // The human who never clicks — the 1h32m session, in a test.
        const scripted = scriptApproval(
          harness.ctx,
          async (_request: ApprovalRequest): Promise<ApprovalOutcome> =>
            await new Promise<ApprovalOutcome>(() => {}))

        const abandoned = await harness.call('claude_code_open', { cwd: idleCwd }, { agent: harness.root.agent })
        expect(abandoned.isError, JSON.stringify(abandoned.error)).toBe(false)
        const abandonedId = (abandoned.value as { session_id: string }).session_id

        const blocked = await harness.call('claude_code_open', { cwd: blockedCwd }, { agent: harness.root.agent })
        expect(blocked.isError, JSON.stringify(blocked.error)).toBe(false)
        const blockedId = (blocked.value as { session_id: string }).session_id

        // Give the second one something a human must approve, and never answer.
        const sent = await harness.call(
          'claude_code_send',
          { session_id: blockedId, message: WRITE_PROMPT, mode: 'followup' },
          { agent: harness.root.agent })
        expect(sent.isError, JSON.stringify(sent.error)).toBe(false)

        // Wait until the ask is genuinely pending — asserting on the sweep
        // before the CLI has raised anything would prove nothing.
        const pending = await waitForAsync(
          async () => {
            const listed = await harness.call('claude_code_list', {}, { agent: harness.root.agent })
            return (listed.value as unknown as { sessions: ListEntry[] }).sessions
          },
          entries => entries.some(entry => entry.session_id === blockedId && entry.pending_asks > 0),
          90_000)
        const blockedEntry = pending.find(entry => entry.session_id === blockedId)
        expect(blockedEntry?.pending_asks).toBeGreaterThan(0)
        expect(scripted.requests.length).toBeGreaterThan(0)

        // The abandoned session has been idle since it opened; the sweep takes it.
        const swept = await waitForAsync(
          async () => {
            const listed = await harness.call('claude_code_list', {}, { agent: harness.root.agent })
            return (listed.value as unknown as { sessions: ListEntry[] }).sessions
          },
          entries => !entries.some(entry => entry.session_id === abandonedId),
          REAP_BUDGET_MS)
        expect(swept.map(entry => entry.session_id)).not.toContain(abandonedId)

        // …and it says WHY it vanished, which is the whole point of a session
        // nobody asked to close.
        const status = await harness.call(
          'claude_code_status', { session_id: abandonedId }, { agent: harness.root.agent })
        expect(status.isError, JSON.stringify(status.error)).toBe(false)
        expect(status.value).toMatchObject({ status: 'closed', close_reason: 'reaped' })

        // The blocked one is STILL THERE, well past the ceiling: reaping it
        // would deny a person's decision for them.
        await sleep(IDLE_CEILING_MS * 2)
        const stillThere = await harness.call('claude_code_list', {}, { agent: harness.root.agent })
        const survivors = (stillThere.value as unknown as { sessions: ListEntry[] }).sessions
        expect(survivors.map(entry => entry.session_id)).toContain(blockedId)
        expect(survivors.find(entry => entry.session_id === blockedId)?.pending_asks).toBeGreaterThan(0)

        scripted.dispose()
      } finally {
        await harness.dispose()
        removeCwd(idleCwd)
        removeCwd(blockedCwd)
      }
    },
    LIVE_TIMEOUT_MS)
})
