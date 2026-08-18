/**
 * The production failure, reproduced end to end and now passing.
 *
 * A dsh agent delegated to Claude Code. The CLI raised a `Write` permission and
 * a HUMAN — answering in the dsh web UI — had not clicked yet. Every tool the
 * agent had said the same thing: `claude_code_open` blocked ten minutes and
 * THREW, `claude_code_wait` threw twice more, and `claude_code_status` said
 * "running, 1 pending ask(s)" without ever naming what to approve. The
 * delegating model read the throws as failure, cancelled, and opened a fresh
 * session. Three sessions, ~30 minutes, step 2 of 13 never finished.
 *
 * This spec is that exact loop against a REAL Claude Code subprocess and the
 * REAL `ApprovalService`, with the only change that matters: the human here is
 * scripted to take ~8 seconds. So the short `claude_code_wait` polls genuinely
 * expire while an approval is genuinely pending, which is the state the old code
 * could only express as a thrown `CC_TIMEOUT`.
 *
 * What it asserts, in the order a delegating model would experience it:
 *
 * 1. a 2-second wait that expires while the human is deciding RESOLVES — never
 *    `isError` — with `status: 'running'`;
 * 2. its `pending_ask_details` NAME the pending ask (kind, the `Write` tool, the
 *    reason sentence the human is reading), and the count matches the list;
 * 3. the rendered text tells the model a human must answer in the dsh UI and
 *    that waiting again — not cancelling, not re-opening — is the next step;
 * 4. a LATER wait on the SAME session returns the completed turn's result;
 * 5. the file is actually on disk, i.e. the approval really was answered and
 *    the work really did happen on the first session.
 *
 * Nothing here cancels and nothing re-opens: one session, from open to result.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'

import {
  LIVE, LIVE_TIMEOUT_MS, mountLiveTools, removeCwd, scriptApproval, sleep, tmpCwd,
} from './helpers.ts'

/** How long the scripted human "thinks" before approving — several short polls' worth. */
const HUMAN_DELAY_MS = 8_000

/** The short poll the production trace never had: expiry is a value, not a failure. */
const POLL_MS = 2_000

/** Give the whole poll loop room for the model's own latency on top of the human's. */
const LOOP_BUDGET_MS = 90_000

const PROMPT
  = 'Use the Write tool to create a file named notes.txt in the current working directory whose entire '
  + 'contents are exactly: alpha\nThen reply with one short sentence confirming you wrote it.'

/** One `claude_code_wait` value, in the shape this spec reads it. */
interface WaitValue {
  readonly status: string
  readonly result?: string
  readonly session_id?: string
  readonly pending_asks?: number
  readonly pending_ask_details?: readonly {
    readonly kind: string
    readonly tool_name?: string
    readonly reason?: string
    readonly waiting_ms: number
  }[]
}

describe.skipIf(!LIVE)('claude_code_wait — blocked on a human, live (DSH_CC_LIVE=1)', () => {
  it(
    'resolves as running with the pending Write ask named, then returns the result on a later wait',
    async () => {
      const cwd = tmpCwd('tools-pending-human')
      const harness = await mountLiveTools()
      try {
        // The human in the dsh web UI: reachable, but not instant.
        const scripted = scriptApproval(harness.ctx, async (): Promise<ApprovalOutcome> => {
          await sleep(HUMAN_DELAY_MS)
          return 'allowed-once'
        })

        // Open IDLE and send separately, so the turn under test is driven by
        // `claude_code_wait` — the tool the production trace failed on — rather
        // than by the sync open's own ten-minute ceiling.
        const openResult = await harness.call('claude_code_open', { cwd }, { agent: harness.root.agent })
        expect(openResult.isError, JSON.stringify(openResult.error)).toBe(false)
        const sessionId = (openResult.value as { session_id: string }).session_id

        const sent = await harness.call(
          'claude_code_send',
          { session_id: sessionId, message: PROMPT, mode: 'followup' },
          { agent: harness.root.agent })
        expect(sent.isError, JSON.stringify(sent.error)).toBe(false)

        // The loop the delegating model runs: poll, and keep polling.
        let blocked: WaitValue | undefined
        let blockedText = ''
        let completed: WaitValue | undefined
        let polls = 0
        const deadline = Date.now() + LOOP_BUDGET_MS
        while (Date.now() < deadline) {
          const waited = await harness.call(
            'claude_code_wait',
            { session_id: sessionId, timeout_ms: POLL_MS },
            { agent: harness.root.agent })
          polls += 1
          // THE regression, asserted on every single poll: an unfinished turn
          // is never an error. One `isError: true` here is what cost thirty
          // minutes and three subprocesses.
          expect(waited.isError, JSON.stringify(waited.error)).toBe(false)
          const value = waited.value as unknown as WaitValue

          if (value.result !== undefined) {
            completed = value
            break
          }
          // Not finished: it must say so as a VALUE, with the id to wait on again.
          expect(value.status).toBe('running')
          expect(value.session_id).toBe(sessionId)
          expect(value.pending_asks).toBe(value.pending_ask_details?.length)
          if ((value.pending_ask_details?.length ?? 0) > 0 && blocked === undefined) {
            blocked = value
            blockedText = String((waited.content[0] as { text?: unknown }).text ?? '')
          }
        }

        // 1-2. The turn was observed BLOCKED on a named ask, not merely slow.
        expect(blocked, 'no poll ever observed the pending approval').toBeDefined()
        expect(blocked?.pending_asks).toBe(1)
        const [ask] = blocked?.pending_ask_details ?? []
        expect(ask?.kind).toBe('permission')
        expect(ask?.tool_name).toBe('Write')
        // The CLI's own rendered sentence — the words the human is reading in
        // the dsh UI, not a paraphrase invented on this side.
        expect(ask?.reason ?? '').toContain('notes.txt')
        expect(ask?.waiting_ms).toBeGreaterThanOrEqual(0)

        // 3. And the prose says who has to act and what to do next.
        // eslint-disable-next-line no-console -- this string is the deliverable; print it for the run log.
        console.log(`\n=== what the model sees while a human decides ===\n${blockedText}\n===\n`)
        expect(blockedText).toContain(`session ${sessionId} is still running (status: running)`)
        expect(blockedText).toContain('BLOCKED on 1 ask a human must answer in the dsh UI')
        expect(blockedText).toContain('permission ask for tool "Write"')
        expect(blockedText).toContain(`claude_code_wait with session_id ${sessionId} again`)
        expect(blockedText).toContain('Do NOT cancel this turn and do NOT open another Claude Code session')

        // 4. A later wait — on the SAME session, after no cancel and no re-open
        //    — returns the finished turn.
        expect(completed, 'the turn never completed').toBeDefined()
        expect(completed?.status).toBe('idle')
        expect((completed?.result ?? '').length).toBeGreaterThan(0)
        expect(completed).not.toHaveProperty('pending_asks')
        expect(polls).toBeGreaterThan(1)

        // 5. The human's approval really did land, and the work really happened.
        expect(scripted.requests.length).toBeGreaterThanOrEqual(1)
        const target = join(cwd, 'notes.txt')
        expect(existsSync(target), 'notes.txt was never written').toBe(true)
        expect(readFileSync(target, 'utf8')).toContain('alpha')

        // Nothing pends once it is over.
        const status = await harness.call(
          'claude_code_status', { session_id: sessionId }, { agent: harness.root.agent })
        expect(status.value).toMatchObject({ status: 'idle', pending_asks: 0, pending_ask_details: [] })

        await harness.call('claude_code_close', { session_id: sessionId }, { agent: harness.root.agent })
        scripted.dispose()
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
