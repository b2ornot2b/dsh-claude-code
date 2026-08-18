/**
 * Human-in-the-loop ergonomics: what the tools do while a person has not
 * answered yet.
 *
 * The regression under test is a real production trace. An agent delegated to
 * Claude Code, the CLI raised a `Write` permission, and the human had not
 * answered it. `claude_code_open` blocked for ten minutes and threw
 * `CC_TIMEOUT`; `claude_code_wait` did the same, twice; `claude_code_status`
 * said "1 pending ask(s)" and nothing more. The delegating model — reading a
 * thrown error as a failure, with no way to name what a human was supposed to
 * do — cancelled the turn and opened a fresh session. Three times. ~30 minutes.
 * Step 2 of 13 never finished.
 *
 * So the properties here are behavioural, not cosmetic:
 *
 * 1. an unfinished turn is a VALUE (`status: 'running'`), never a thrown error;
 * 2. that value NAMES the tool and the reason a human is being shown;
 * 3. an omitted `timeout_ms` is one minute, not the ten-minute ceiling;
 * 4. the prose the model reads says a human must answer in the dsh UI and that
 *    waiting again — not cancelling, not re-opening — is the next step.
 *
 * Every `result.value` assertion is also a schema round trip: the real tool
 * runtime validates each canonical value against the tool's `output.schema`
 * (with `additionalProperties: false`) before handing it back.
 */

import { CcSession, ClaudeCodeError } from '@deepseek-ai/dsh-claude-code'
import type { CcMessageEnvelope, CcPendingAsk } from '@deepseek-ai/dsh-claude-code'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CWD, fakeAgent, firstQuery, mountTools, settle, waitFor } from './harness.ts'
import type { ToolHarness } from './harness.ts'
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS } from '../src/index.ts'
import {
  answerInDshUi, formatWaiting, projectPendingAsks, renderPendingAsks, renderStillRunning,
} from '../src/pending.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** The seam's own "your bounded wait elapsed" failure — what `waitCapped` translates. */
function seamTimeout(): ClaudeCodeError {
  return new ClaudeCodeError('claude-code: waitForResult timed out', 'TIMEOUT')
}

/**
 * Replace the seam's bounded wait with a spy that records the cap it was handed
 * and expires immediately.
 *
 * This is how the default/clamp matrix is asserted WITHOUT sleeping: the number
 * under test is the argument the tool layer passes to the seam, and stubbing the
 * seam observes it directly instead of inferring it from wall-clock behaviour
 * (which would mean a real 60-second test).
 * @returns the recorded caps, in call order.
 */
function recordWaits(): number[] {
  const seen: number[] = []
  vi.spyOn(CcSession.prototype, 'waitForResult').mockImplementation(
    async (timeoutMs?: number): Promise<CcMessageEnvelope> => {
      seen.push(timeoutMs ?? Number.NaN)
      return await Promise.reject(seamTimeout())
    })
  return seen
}

/**
 * Open a session and park one unanswerable `Write` permission on it, exactly as
 * the production trace did.
 *
 * The ask target's `approval` seam never resolves — that IS the scenario: the
 * prompt is up in the dsh web UI and nobody has clicked anything. Everything
 * below it is real: the real `CcAskRouter`, the real `CcAskTable`, the real
 * session actor.
 * @param harness - the mounted composition.
 * @param title - the CLI's pre-rendered approval sentence.
 * @returns the session id the ask is pending on.
 */
async function parkOneApproval(harness: ToolHarness, title: string): Promise<string> {
  const opened = await harness.call('claude_code_open', { cwd: CWD })
  const sessionId = (opened.value as { session_id: string }).session_id
  const query = await firstQuery(harness)

  harness.ctx.claudeCode.attachAskTarget(sessionId as never, {
    agent: fakeAgent(),
    delegated: false,
    approval: { request: async () => await new Promise<never>(() => {}) },
  })

  await harness.call('claude_code_send', {
    session_id: sessionId, message: 'write notes.txt', mode: 'followup',
  })
  // The CLI asks permission and blocks on the answer, which never comes.
  void query.options.canUseTool?.(
    'Write',
    { file_path: '/private/tmp/scratch/notes.txt', content: 'alpha' },
    { signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'req_1', title })
  await settle()
  return sessionId
}

/** The text block of a tool result. */
function text(result: { content: unknown[] }): string {
  return String((result.content[0] as { text?: unknown }).text ?? '')
}

describe('claude_code_wait: the wait budget', () => {
  it('waits 60s — NOT the 10-minute ceiling — when timeout_ms is omitted', async () => {
    const harness = await mountTools()
    const seen = recordWaits()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id

      const result = await harness.call('claude_code_wait', { session_id: sessionId })

      // The whole point: an unattended poll costs a minute, not ten. Defaulting
      // to the ceiling is what turned every "is it done yet?" into a ten-minute
      // block ending in a throw.
      expect(seen).toEqual([DEFAULT_WAIT_TIMEOUT_MS])
      expect(seen).toEqual([60_000])
      expect(result.isError, JSON.stringify(result.error)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  it('clamps an oversized explicit timeout_ms to the 10-minute ceiling', async () => {
    const harness = await mountTools()
    const seen = recordWaits()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id

      await harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: 5_000_000 })
      // A caller may ask for a long block; it may not ask for an unbounded one.
      expect(seen).toEqual([MAX_WAIT_TIMEOUT_MS])
      expect(seen).toEqual([600_000])

      // A sane explicit value is honored verbatim, rounded to whole ms.
      await harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: 1234.6 })
      expect(seen[1]).toBe(1235)

      // Nonsense (zero, negative, non-finite) falls back to the default rather
      // than to an instant expiry that would look like a hung session.
      await harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: -1 })
      expect(seen[2]).toBe(DEFAULT_WAIT_TIMEOUT_MS)
    } finally {
      await harness.dispose()
    }
  })
})

describe('claude_code_wait: an elapsed wait resolves', () => {
  it('returns status running with the pending ask named, instead of throwing', async () => {
    const harness = await mountTools()
    try {
      const sessionId = await parkOneApproval(harness, 'Write: /private/tmp/scratch/notes.txt')

      const result = await harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: 5 })

      // THE regression. A thrown CC_TIMEOUT here is what produced three
      // sessions and thirty wasted minutes.
      expect(result.isError, JSON.stringify(result.error)).toBe(false)
      expect(result.value).toEqual({
        status: 'running',
        session_id: sessionId,
        pending_asks: 1,
        pending_ask_details: [{
          kind: 'permission',
          tool_name: 'Write',
          reason: 'Write: /private/tmp/scratch/notes.txt',
          waiting_ms: expect.any(Number),
        }],
      })

      // …and the session is untouched: still open, still running, still holding
      // the same unanswered ask. Waiting again is genuinely the right move.
      expect(harness.ctx.claudeCode.get(sessionId as never)?.status).toBe('running')
      expect(harness.ctx.claudeCode.get(sessionId as never)?.pendingAsks).toBe(1)
    } finally {
      await harness.dispose()
    }
  })

  it('renders prose naming the tool, the reason, and waiting again as the next step', async () => {
    const harness = await mountTools()
    try {
      const sessionId = await parkOneApproval(harness, 'Write: /private/tmp/scratch/notes.txt')
      const result = await harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: 5 })
      const rendered = text(result)

      expect(rendered).toContain(`session ${sessionId} is still running (status: running)`)
      expect(rendered).toContain('BLOCKED on 1 ask a human must answer in the dsh UI')
      expect(rendered).toContain('permission ask for tool "Write"')
      expect(rendered).toContain('reason: Write: /private/tmp/scratch/notes.txt')
      expect(rendered).toContain(`claude_code_wait with session_id ${sessionId} again`)
      expect(rendered).toContain('Do NOT cancel this turn and do NOT open another Claude Code session')
      // The one word it must never look like.
      expect(result.isError).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  it('still returns a completed turn\'s result, usage and cost unchanged', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)
      await harness.call('claude_code_send', { session_id: sessionId, message: 'go', mode: 'followup' })

      const pending = harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: 5000 })
      await query.emitResult('success', {
        result: 'all done',
        usage: { input_tokens: 7, output_tokens: 3 },
        total_cost_usd: 0.5,
      })
      const waited = await pending

      // The happy path is byte-identical to before this change: no session_id,
      // no pending_asks, no pending_ask_details bolted onto a finished turn.
      expect(waited.value).toEqual({
        status: 'idle',
        result: 'all done',
        usage: { input_tokens: 7, output_tokens: 3 },
        cost_usd: 0.5,
      })
      expect(text(waited)).toBe('all done')
    } finally {
      await harness.dispose()
    }
  })
})

describe('claude_code_wait: the photo finish', () => {
  it('hands back a result that landed in the same tick the wait expired, instead of losing it', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)
      await harness.call('claude_code_send', { session_id: sessionId, message: 'go', mode: 'followup' })

      // The race, made deterministic. The seam's timeout is a `setTimeout` that
      // rejects a parked waiter, so a result arriving in the same tick loses by
      // microtasks: the caller would be told "still running" about a turn that
      // has already finished, and would only be handed the answer a whole poll
      // later. This stub reproduces exactly that ordering — the result lands,
      // THEN the bounded wait reports it elapsed.
      vi.spyOn(CcSession.prototype, 'waitForResult').mockImplementation(
        async (): Promise<CcMessageEnvelope> => {
          await query.emitResult('success', {
            result: 'all done', usage: { input_tokens: 7, output_tokens: 3 }, total_cost_usd: 0.5,
          })
          return await Promise.reject(seamTimeout())
        })

      const waited = await harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: 5 })

      // Exactly one outcome, and it is the real one. No `pending_asks`, no
      // "still running" prose for a turn that produced an answer.
      expect(waited.isError, JSON.stringify(waited.error)).toBe(false)
      expect(waited.value).toEqual({
        status: 'idle',
        result: 'all done',
        usage: { input_tokens: 7, output_tokens: 3 },
        cost_usd: 0.5,
      })
      expect(text(waited)).toBe('all done')
    } finally {
      await harness.dispose()
    }
  })

  it('never passes off the PREVIOUS turn\'s result as this turn\'s', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)

      // Turn one completes and is cached as the session's `lastResult`.
      await harness.call('claude_code_send', { session_id: sessionId, message: 'first', mode: 'followup' })
      await query.emitResult('success', { result: 'first answer' })

      // Turn two goes out and produces nothing before the wait elapses. The
      // rescue above keys on the envelope's IDENTITY precisely so this case
      // stays "still running" — reporting "first answer" for a turn that never
      // finished would be a fabricated result, which is worse than a slow one.
      await harness.call('claude_code_send', { session_id: sessionId, message: 'second', mode: 'followup' })
      vi.spyOn(CcSession.prototype, 'waitForResult').mockImplementation(
        async (): Promise<CcMessageEnvelope> => await Promise.reject(seamTimeout()))

      const waited = await harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: 5 })

      expect(waited.value).toEqual({
        status: 'running',
        session_id: sessionId,
        pending_asks: 0,
        pending_ask_details: [],
      })
      expect(waited.value).not.toHaveProperty('result')
      expect(text(waited)).toContain('the current turn has not produced a result yet')
    } finally {
      await harness.dispose()
    }
  })
})

describe('the count and the details can never disagree', () => {
  it('reports one entry per counted ask, and a status read off the same snapshot', async () => {
    const harness = await mountTools()
    try {
      const sessionId = await parkOneApproval(harness, 'Write: /private/tmp/scratch/notes.txt')
      const query = await firstQuery(harness)
      // A second, different ask on the same session: a count of 2 with one
      // description would be the same half-signal as a count of 1 with none.
      void query.options.canUseTool?.(
        'Bash',
        { command: 'rm -rf /private/tmp/scratch' },
        {
          signal: new AbortController().signal,
          toolUseID: 'toolu_2',
          requestId: 'req_2',
          title: 'Bash: rm -rf /private/tmp/scratch',
        })
      await settle()

      const waited = await harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: 5 })
      const value = waited.value as { status: string, pending_asks: number, pending_ask_details: unknown[] }

      expect(value.pending_asks).toBe(value.pending_ask_details.length)
      expect(value.pending_asks).toBe(2)
      // Status, count and details all come from ONE `snapshot()`, so they
      // describe the same instant: "idle with 2 pending" cannot be produced.
      expect(value.status).toBe('running')

      const status = await harness.call('claude_code_status', { session_id: sessionId })
      const snapshot = status.value as { pending_asks: number, pending_ask_details: unknown[] }
      expect(snapshot.pending_asks).toBe(snapshot.pending_ask_details.length)
      expect(text(waited)).toContain('BLOCKED on 2 asks a human must answer in the dsh UI')
      expect(text(waited)).toContain('permission ask for tool "Bash" — reason: Bash: rm -rf /private/tmp/scratch')
    } finally {
      await harness.dispose()
    }
  })
})

describe('a session that closed while an ask was pending', () => {
  it('answers claude_code_status without throwing, with nothing stale left pending', async () => {
    const harness = await mountTools()
    try {
      const sessionId = await parkOneApproval(harness, 'Write: /private/tmp/scratch/notes.txt')
      expect(harness.ctx.claudeCode.get(sessionId as never)?.pendingAsks).toBe(1)

      await harness.call('claude_code_close', { session_id: sessionId })

      // The close path denies every pending ask BEFORE the tombstone is taken,
      // so the tombstone cannot freeze an ask that no longer exists.
      const status = await harness.call('claude_code_status', { session_id: sessionId })
      expect(status.isError, JSON.stringify(status.error)).toBe(false)
      expect(status.value).toMatchObject({
        status: 'closed',
        close_reason: 'closed',
        pending_asks: 0,
        pending_ask_details: [],
      })
      // And above all: it must NOT tell the model to keep waiting on a session
      // that is gone. That advice is only ever correct for a live one.
      expect(text(status)).not.toContain('a human must answer')
      expect(text(status)).not.toContain('claude_code_wait')
    } finally {
      await harness.dispose()
    }
  })

  it('answers for a CRASHED session too, and still refuses to wait on it', async () => {
    const harness = await mountTools()
    try {
      const sessionId = await parkOneApproval(harness, 'Write: /private/tmp/scratch/notes.txt')
      const query = await firstQuery(harness)

      // The subprocess dies mid-turn: the seam closes the session itself.
      query.endStream()
      await waitFor(
        () => harness.ctx.claudeCode.get(sessionId as never)?.status === 'closed',
        'the dead subprocess to close its session')

      const status = await harness.call('claude_code_status', { session_id: sessionId })
      expect(status.isError, JSON.stringify(status.error)).toBe(false)
      expect(status.value).toMatchObject({
        status: 'closed', close_reason: 'crashed', pending_asks: 0, pending_ask_details: [],
      })
      expect(text(status)).not.toContain('a human must answer')

      // A wait on a dead session is still an ERROR. Resolving with "running"
      // here would be the mirror image of the original bug: telling a model to
      // keep waiting for something that can never arrive.
      const waited = await harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: 5 })
      expect(waited.isError).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})

describe('claude_code_open: a synchronous open that outlives its ceiling', () => {
  it('resolves with the session branch, the id, and what is pending — session still open', async () => {
    const harness = await mountTools()
    try {
      // Expire the sync open's own wait without sleeping for ten minutes.
      vi.spyOn(CcSession.prototype, 'waitForResult').mockImplementation(
        async (): Promise<CcMessageEnvelope> => await Promise.reject(seamTimeout()))

      const result = await harness.call('claude_code_open', { cwd: CWD, prompt: 'write notes.txt' })

      expect(result.isError, JSON.stringify(result.error)).toBe(false)
      expect(result.value).toEqual({
        kind: 'session',
        session_id: expect.any(String),
        status: 'running',
        pending_asks: 0,
        pending_ask_details: [],
      })
      // No `result` field: nothing finished, and inventing an empty answer would
      // be worse than saying so.
      expect(result.value).not.toHaveProperty('result')

      const sessionId = (result.value as { session_id: string }).session_id
      // The open never closes the session — that was already true, and it is the
      // whole reason returning the id is useful.
      expect(harness.ctx.claudeCode.get(sessionId as never)?.status).toBe('running')
      expect(text(result)).toContain(`session ${sessionId} is still running (status: running)`)
      expect(text(result)).toContain(`claude_code_wait with session_id ${sessionId} again`)
    } finally {
      await harness.dispose()
    }
  })
})

describe('claude_code_status: what is pending, not just how many', () => {
  it('carries the pending ask details and tells the model who has to act', async () => {
    const harness = await mountTools()
    try {
      const sessionId = await parkOneApproval(harness, 'Write: /private/tmp/scratch/notes.txt')

      const status = await harness.call('claude_code_status', { session_id: sessionId })

      expect(status.isError, JSON.stringify(status.error)).toBe(false)
      expect(status.value).toMatchObject({
        status: 'running',
        pending_asks: 1,
        pending_ask_details: [{
          kind: 'permission',
          tool_name: 'Write',
          reason: 'Write: /private/tmp/scratch/notes.txt',
          waiting_ms: expect.any(Number),
        }],
      })

      const rendered = text(status)
      expect(rendered).toContain(`session ${sessionId}: running, 1 pending ask(s)`)
      expect(rendered).toContain('permission ask for tool "Write"')
      expect(rendered).toContain('reason: Write: /private/tmp/scratch/notes.txt')
      expect(rendered).toContain(answerInDshUi(sessionId))
    } finally {
      await harness.dispose()
    }
  })

  it('reports an empty details array — never an absent one — when nothing pends', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id

      const status = await harness.call('claude_code_status', { session_id: sessionId })
      // Absent would make "nothing is pending" indistinguishable from "this
      // build cannot tell you".
      expect(status.value).toEqual({ status: 'idle', pending_asks: 0, pending_ask_details: [] })
      // …and the guidance block stays out of the way when there is nothing to say.
      expect(text(status)).toBe(`session ${sessionId}: idle, 0 pending ask(s)`)
    } finally {
      await harness.dispose()
    }
  })
})

describe('the pending-ask projection and its prose', () => {
  /**
   * One seam-shaped pending ask.
   * @param overrides - fields to change.
   * @returns the ask.
   */
  function ask(overrides: Partial<CcPendingAsk> = {}): CcPendingAsk {
    return {
      requestId: 'req_1',
      kind: 'permission',
      toolName: 'Write',
      reason: 'Write: /private/tmp/scratch/notes.txt',
      since: 1_000_000,
      startedAt: 1_000_000,
      ...overrides,
    }
  }

  /** The same ask with no `reason` at all — an older CLI that sent no title. */
  const reasonless: CcPendingAsk = {
    requestId: 'req_1', kind: 'permission', toolName: 'Write', since: 1_000_000, startedAt: 1_000_000,
  }

  it('projects epoch "since" into an elapsed "waiting_ms" the model can actually read', () => {
    // Fake time so the projection is exact rather than "about ten minutes".
    vi.useFakeTimers()
    vi.setSystemTime(1_600_000)

    expect(projectPendingAsks([ask()], Date.now())).toEqual([{
      kind: 'permission',
      tool_name: 'Write',
      reason: 'Write: /private/tmp/scratch/notes.txt',
      waiting_ms: 600_000,
    }])
  })

  it('omits an absent reason and never reports a negative age from a clock that stepped back', () => {
    expect(projectPendingAsks([reasonless], 1_002_000)).toEqual([
      { kind: 'permission', tool_name: 'Write', waiting_ms: 2000 },
    ])
    expect(projectPendingAsks([ask()], 999_000)[0]?.waiting_ms).toBe(0)
  })

  it('formats a duration the way a person reads one', () => {
    expect(formatWaiting(0)).toBe('0s')
    expect(formatWaiting(9_400)).toBe('9s')
    expect(formatWaiting(59_999)).toBe('59s')
    expect(formatWaiting(60_000)).toBe('1m 00s')
    expect(formatWaiting(603_000)).toBe('10m 03s')
    expect(formatWaiting(4_320_000)).toBe('1h 12m')
  })

  it('renders one pending ask verbatim', () => {
    expect(renderPendingAsks(projectPendingAsks([ask()], 1_600_000))).toBe(
      '  1. permission ask for tool "Write" — reason: Write: /private/tmp/scratch/notes.txt'
      + ' — pending 10m 00s')
  })

  it('renders a tool-less, reason-less ask without inventing either', () => {
    expect(renderPendingAsks([{ kind: 'question', waiting_ms: 5_000 }])).toBe(
      '  1. question ask for tool "unknown" — pending 5s')
  })

  it('renders the blocked-on-a-human message in full, verbatim', () => {
    // This string is the deliverable. If it drifts into vagueness — drops the
    // session id, drops the reason, stops naming the dsh UI, stops saying what
    // to do next — a delegating model goes back to cancelling and re-opening.
    expect(renderStillRunning('sess-1', 'running', projectPendingAsks([ask()], 1_600_000))).toBe(
      'session sess-1 is still running (status: running) and is BLOCKED on 1 ask a human must answer in '
      + 'the dsh UI:\n'
      + '  1. permission ask for tool "Write" — reason: Write: /private/tmp/scratch/notes.txt'
      + ' — pending 10m 00s\n'
      + 'This is the normal human-in-the-loop state, not a failure: a person has to answer in the dsh web '
      + 'UI before this turn can continue, and no tool call here can answer for them. The correct next '
      + 'step is to call claude_code_wait with session_id sess-1 again and keep waiting. Do NOT cancel '
      + 'this turn and do NOT open another Claude Code session — a new session raises the same ask, and '
      + 'this one would still be unanswered.')
  })

  it('pluralizes, and numbers, more than one pending ask', () => {
    const rendered = renderStillRunning('sess-1', 'running', projectPendingAsks(
      [ask(), ask({ requestId: 'req_2', kind: 'question', toolName: 'AskUserQuestion', reason: 'Which db?' })],
      1_600_000))
    expect(rendered).toContain('BLOCKED on 2 asks a human must answer in the dsh UI')
    expect(rendered).toContain('  2. question ask for tool "AskUserQuestion" — reason: Which db? — pending 10m 00s')
  })

  it('renders a slow turn with nothing pending as "not yet", never as a failure', () => {
    expect(renderStillRunning('sess-1', 'running', [])).toBe(
      'session sess-1 is still running (status: running): the current turn has not produced a result yet, '
      + 'and nothing is waiting on a human. Nothing failed and the session is untouched — call '
      + 'claude_code_wait with session_id sess-1 again to keep waiting (raise timeout_ms for a longer '
      + 'poll). Do NOT open another Claude Code session for this work.')
  })
})
