/**
 * Phase 5 orderings probe: what the six tools do when calls INTERLEAVE.
 *
 * Every case here is one a model can produce without trying — it has several
 * tools and no ordering guarantee between them — and every one of them has a
 * failure mode worse than a wrong answer: a tool call that never returns, an
 * unhandled rejection that takes the process down, or a session left running
 * with nothing tracking it. So the assertions are deliberately about the
 * PROPERTY (bounded, routable, no orphan) rather than about which side of a race
 * won, and the ones that genuinely are races (a timeout landing with a result)
 * accept either winner while insisting the session stays usable.
 *
 * The seam is the real one on a fake SDK backend (see `harness.ts`); nothing
 * here spawns a subprocess.
 */

import { describe, expect, it } from 'vitest'

import { CWD, firstQuery, mountTools, settle, waitFor } from './harness.ts'
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, SYNC_OPEN_TIMEOUT_MS } from '../src/index.ts'

describe('close during a synchronous open', () => {
  it('fails the parked open with the seam\'s SESSION_CLOSED instead of hanging to the cap', async () => {
    const harness = await mountTools()
    try {
      const pending = harness.call('claude_code_open', { cwd: CWD, prompt: 'a long answer' })
      const query = await firstQuery(harness)
      await waitFor(() => query.sent.length === 1, 'the opening prompt to reach the subprocess')
      const sessionId = harness.ctx.claudeCode.list()[0]?.id
      expect(sessionId).toBeTypeOf('string')

      // The turn is in flight and the open is parked on `waitForResult`. Closing
      // now must resolve that wait — the alternative is a tool call that returns
      // in ten minutes.
      const closed = await harness.call('claude_code_close', { session_id: String(sessionId) })
      expect(closed.value).toEqual({ closed: true })

      const result = await pending
      expect(result.isError).toBe(true)
      // The seam's own code, re-thrown untouched: this is NOT the tool layer's
      // CC_TIMEOUT, because nothing timed out and the session is not still open.
      expect(result.error?.info?.code).toBe('SESSION_CLOSED')
      expect(harness.ctx.claudeCode.session(sessionId as never)).toBeUndefined()
      expect(query.closed).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('caps a synchronous open at the same ceiling claude_code_wait clamps to', () => {
    // Both paths share `waitCapped`, so one cap tested against the clock (the
    // `timeout_ms: 5` case in tools.spec.ts) covers both — provided they really
    // are the same number.
    expect(SYNC_OPEN_TIMEOUT_MS).toBe(600_000)
    expect(MAX_WAIT_TIMEOUT_MS).toBe(SYNC_OPEN_TIMEOUT_MS)
    // The DEFAULT is deliberately NOT the ceiling: an omitted `timeout_ms` used
    // to buy a ten-minute block ending in a throw, which is what taught the
    // model in the production trace to give up on the session. See
    // `pending.spec.ts` for the clamping/defaulting matrix.
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(60_000)
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBeLessThan(MAX_WAIT_TIMEOUT_MS)
  })
})

describe('calls that arrive after the session is gone', () => {
  it('answers CC_NO_SESSION for a send, a wait and a cancel issued after close', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      await harness.call('claude_code_close', { session_id: sessionId })

      // `claude_code_status` is deliberately NOT in this list — see the test
      // below. Every tool here needs a live actor to drive.
      const calls: Array<[string, Record<string, unknown>]> = [
        ['claude_code_send', { session_id: sessionId, message: 'still there?', mode: 'followup' }],
        ['claude_code_wait', { session_id: sessionId, timeout_ms: 50 }],
        ['claude_code_cancel', { session_id: sessionId }],
      ]
      for (const [toolName, args] of calls) {
        const result = await harness.call(toolName, args)
        expect(result.isError, `${toolName} after close should fail`).toBe(true)
        // A CLOSED session is the same failure as an unknown one: there is
        // nothing to send to, and the model's remedy is identical (open one).
        expect(result.error?.info?.code, `${toolName} code`).toBe('CC_NO_SESSION')
        expect(String(result.error?.message), `${toolName} message`).toContain(sessionId)
      }
    } finally {
      await harness.dispose()
    }
  })

  it('answers claude_code_status for a closed session, with the reason it closed', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      await harness.call('claude_code_close', { session_id: sessionId })

      // The one tool whose whole job is answering "what happened to it?".
      // CC_NO_SESSION would say "it was never opened here", which is false and
      // sends the model off to open a second session.
      const status = await harness.call('claude_code_status', { session_id: sessionId })
      expect(status.isError).toBe(false)
      expect(status.value).toMatchObject({ status: 'closed', close_reason: 'closed', pending_asks: 0 })
    } finally {
      await harness.dispose()
    }
  })

  it('still answers CC_NO_SESSION from claude_code_status for an id nothing here ever opened', async () => {
    const harness = await mountTools()
    try {
      const stranger = '11111111-2222-4333-8444-555555555555'
      const result = await harness.call('claude_code_status', { session_id: stranger })
      expect(result.isError).toBe(true)
      expect(result.error?.info?.code).toBe('CC_NO_SESSION')
    } finally {
      await harness.dispose()
    }
  })
})

describe('a wait whose timeout races the result', () => {
  it('returns exactly one of the two outcomes, bounded, leaving the session usable', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)
      await harness.call('claude_code_send', {
        session_id: sessionId, message: 'go', mode: 'followup',
      })

      // A one-millisecond cap and a result emitted in the same macrotask: which
      // one lands first is genuinely undefined, and BOTH answers are correct.
      const pending = harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: 1 })
      await query.emitResult('success', { result: 'just in time' })
      const waited = await pending

      // BOTH winners now resolve — the timeout no longer has an error branch —
      // so the property is "one of the two canonical values, never a failure".
      expect(waited.isError, JSON.stringify(waited.error)).toBe(false)
      if ((waited.value as { result?: string }).result === undefined) {
        expect(waited.value).toMatchObject({
          status: 'running', session_id: sessionId, pending_asks: 0, pending_ask_details: [],
        })
      } else {
        expect(waited.value).toMatchObject({ status: 'idle', result: 'just in time' })
      }
      // Either way the turn really did complete and the session is still there…
      expect(harness.ctx.claudeCode.get(sessionId as never)?.status).toBe('idle')
      // …and a second wait resolves from the cached result rather than parking
      // for the full ceiling, so a model that timed out is never stuck.
      const again = await harness.call('claude_code_wait', { session_id: sessionId })
      expect(again.isError, JSON.stringify(again.error)).toBe(false)
      expect(again.value).toMatchObject({ status: 'idle', result: 'just in time' })
    } finally {
      await harness.dispose()
    }
  })

  it('cancels a turn that finishes first without failing the cancel', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)
      await harness.call('claude_code_send', {
        session_id: sessionId, message: 'go', mode: 'followup',
      })
      await query.emitResult('success', { result: 'already done' })

      // The model saw "running" a moment ago and cancels an idle session: an
      // interrupt with nothing to interrupt is a no-op, not an error.
      const cancelled = await harness.call('claude_code_cancel', { session_id: sessionId })
      expect(cancelled.isError, JSON.stringify(cancelled.error)).toBe(false)
      expect(cancelled.value).toEqual({ still_queued: [] })
      expect(harness.ctx.claudeCode.get(sessionId as never)?.status).toBe('idle')
    } finally {
      await harness.dispose()
    }
  })
})

describe('the whole surface under teardown', () => {
  it('leaves no unhandled rejection behind when a session is disposed mid-turn', async () => {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const harness = await mountTools({ jobs: true })
      const result = await harness.call('claude_code_open', {
        cwd: CWD, prompt: 'work forever', background: true,
      })
      const sessionId = (result.value as { ccSessionId: string }).ccSessionId
      await harness.call('claude_code_send', {
        session_id: sessionId, message: 'and again', mode: 'followup',
      })
      // Nothing waits for that turn: the composition goes away underneath it.
      await harness.dispose()
      await settle()
      await settle()

      expect(seen).toEqual([])
      // Teardown settled the job rather than stranding it `running`.
      await expect(harness.jobs?.hooks[0]?.done).resolves.toMatchObject({ status: 'completed' })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
