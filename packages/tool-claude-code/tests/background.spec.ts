/**
 * Phase 5: `claude_code_open({ background: true })` — the jobs branch.
 *
 * This spec is written against the D10 rules, one test per rule: the
 * jobs-absent error names the packages to load, the abort is re-checked at the
 * last instant the caller still owns the call, `owner` is spread
 * conditionally, and the `JobHooks` are driven by hand to prove `cancel` is
 * synchronous and idempotent, `done` never rejects, and `readOutput` consumes
 * its delta.
 *
 * The job registry here is {@link RecordingJobRegistry}, not
 * `@deepseek-ai/dsh-jobs-local`: a real registry would own the hooks and hide
 * them behind `job_kill`/`job_output`, and it is exactly the hooks that are
 * under test. The real registry is exercised end to end by
 * `tests/composition`.
 */

import { describe, expect, it } from 'vitest'

import { CWD, fakeAgent, firstQuery, mountTools, settle, waitFor } from './harness.ts'
import { jobLabel, MAX_JOB_LABEL_LENGTH, startBackgroundSession } from '../src/background.ts'

describe('background mode without a jobs runtime', () => {
  it('fails with CC_NO_JOBS naming both packages, and opens nothing', async () => {
    const harness = await mountTools()
    try {
      const result = await harness.call('claude_code_open', {
        cwd: CWD, prompt: 'hi', background: true,
      })
      expect(result.isError).toBe(true)
      expect(result.error?.info?.code).toBe('CC_NO_JOBS')
      const message = String(result.error?.message)
      expect(message).toContain('@deepseek-ai/dsh-jobs')
      expect(message).toContain('@deepseek-ai/dsh-tool-jobs')
      expect(harness.fake.queries).toHaveLength(0)
      expect(harness.ctx.claudeCode.list()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
})

describe('the pre-publication abort check', () => {
  it('throws an AbortError-shaped CC_ABORTED and starts no job', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(startBackgroundSession(
        harness.ctx,
        { cwd: CWD, prompt: 'hi' },
        { signal: controller.signal },
      )).rejects.toMatchObject({ name: 'AbortError', code: 'CC_ABORTED' })

      expect(harness.jobs?.started).toEqual([])
      expect(harness.fake.queries).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })
})

describe('the job spec', () => {
  it('registers kind "claude-code" with a prompt-derived label and the calling agent as owner', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      const agent = fakeAgent('agent-42')
      const result = await harness.call(
        'claude_code_open',
        { cwd: CWD, prompt: 'refactor\n  the parser', background: true },
        { agent },
      )

      expect(result.isError, JSON.stringify(result.error)).toBe(false)
      const spec = harness.jobs?.started[0]
      expect(spec?.kind).toBe('claude-code')
      expect(spec?.label).toBe('refactor the parser')
      expect(spec?.owner).toBe(agent)
    } finally {
      await harness.dispose()
    }
  })

  it('omits `owner` entirely for a headless tool call', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      await harness.call('claude_code_open', { cwd: CWD, prompt: 'hi', background: true })
      const spec = harness.jobs?.started[0]
      expect(spec).toBeDefined()
      // Conditional spread, not `owner: undefined`: `exactOptionalPropertyTypes`
      // makes the difference a compile error, and the registry treats a
      // present-but-undefined owner as a bug.
      expect(spec !== undefined && 'owner' in spec).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  it('returns the typed background handle naming the job and the session it opened', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      const result = await harness.call('claude_code_open', {
        cwd: CWD, prompt: 'hi', background: true,
      })
      const value = result.value as { kind: string, jobId: string, ccSessionId: string }
      expect(value.kind).toBe('background')
      expect(value.jobId).toBe('claude-code-1')
      expect(harness.ctx.claudeCode.list().map(session => session.id)).toEqual([value.ccSessionId])
      expect(String((result.content[0] as { text: string }).text))
        .toContain('started background job claude-code-1')
    } finally {
      await harness.dispose()
    }
  })

  it('surfaces a registry refusal (the per-owner job cap) as a tool error, having started nothing', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      // Verbatim shape of `@deepseek-ai/dsh-jobs-local`'s refusal, which it
      // raises BEFORE calling `spec.run()`.
      const cap = new Error(
        'background job limit reached for this owner (limit: 10); use job_kill to stop an unneeded '
        + 'job, wait for it to finish, then retry')
      const registry = harness.jobs
      expect(registry).toBeDefined()
      if (registry !== undefined) registry.startError = cap

      const result = await harness.call(
        'claude_code_open',
        { cwd: CWD, prompt: 'one too many', background: true },
        { agent: fakeAgent('agent-at-the-cap') },
      )

      // A ROUTABLE tool error, not an unhandled crash and not the registry's
      // bare `Error` (which carries no code at all).
      expect(result.isError).toBe(true)
      expect(result.error?.info?.code).toBe('CC_JOB_REJECTED')
      expect(result.error?.info?.name).toBe('ClaudeCodeToolError')
      // The registry's own remedy survives the re-raise verbatim.
      expect(String(result.error?.message)).toContain('background job limit reached')
      expect(String(result.error?.message)).toContain('job_kill')
      // And the refusal really did start nothing: no subprocess, no session.
      expect(harness.jobs?.started).toEqual([])
      expect(harness.fake.queries).toHaveLength(0)
      expect(harness.ctx.claudeCode.list()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  it('leaves nothing running when a registry throws AFTER calling run()', async () => {
    // A contract violation by a third-party jobs provider, not something
    // `@deepseek-ai/dsh-jobs-local` does — but the failure mode if the tool
    // layer trusted the contract is the worst one available: a live subprocess
    // no job tracks, plus an unhandled rejection from the `opened` promise
    // nobody is awaiting any more.
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const harness = await mountTools({ jobs: true })
    try {
      const registry = harness.jobs
      expect(registry).toBeDefined()
      if (registry !== undefined) {
        registry.startError = new Error('registry exploded after run()')
        registry.startErrorTiming = 'after-run'
      }

      const result = await harness.call('claude_code_open', {
        cwd: CWD, prompt: 'hi', background: true,
      })
      expect(result.isError).toBe(true)
      expect(result.error?.info?.code).toBe('CC_JOB_REJECTED')

      // The producer's `run()` did fire and did open a session; the refusal
      // path closed it rather than leaking it.
      await waitFor(() => harness.ctx.claudeCode.list().length === 0, 'the orphaned session to close')
      expect(harness.fake.queries[0]?.closed).toBe(true)
      await settle()
      expect(seen).toEqual([])
    } finally {
      await harness.dispose()
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('derives a one-line label from the cwd when the session opens idle, and elides a long prompt', () => {
    expect(jobLabel({ cwd: '/work/repo' })).toBe('claude code session in /work/repo')
    expect(jobLabel({ cwd: '/work/repo', prompt: '   ' })).toBe('claude code session in /work/repo')
    const label = jobLabel({ cwd: '/work/repo', prompt: 'x'.repeat(500) })
    expect(label).toHaveLength(MAX_JOB_LABEL_LENGTH)
    expect(label.endsWith('…')).toBe(true)
  })
})

describe('the JobHooks contract', () => {
  it('streams each turn as a consuming delta through readOutput', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      const result = await harness.call('claude_code_open', {
        cwd: CWD, prompt: 'first', background: true,
      })
      const sessionId = (result.value as { ccSessionId: string }).ccSessionId
      const hooks = harness.jobs?.hooks[0]
      const query = await firstQuery(harness)

      expect(hooks?.readOutput?.()).toBe('')
      await query.emitResult('success', { result: 'first answer' })
      expect(hooks?.readOutput?.()).toBe('first answer')
      // Consuming: the same text is never handed over twice.
      expect(hooks?.readOutput?.()).toBe('')

      // A background session is still a SESSION: follow-ups keep streaming.
      await harness.call('claude_code_send', {
        session_id: sessionId, message: 'second', mode: 'followup',
      })
      await waitFor(() => query.sent.length === 2, 'the follow-up to reach the subprocess')
      await query.emitResult('success', { result: 'second answer' })
      expect(hooks?.readOutput?.()).toBe('second answer')
    } finally {
      await harness.dispose()
    }
  })

  it('cancels synchronously and idempotently, settling done as killed with the first reason', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      const result = await harness.call('claude_code_open', {
        cwd: CWD, prompt: 'long job', background: true,
      })
      const sessionId = (result.value as { ccSessionId: string }).ccSessionId
      const hooks = harness.jobs?.hooks[0]
      const query = await firstQuery(harness)

      // Synchronous by contract: it returns nothing, it does not await the close.
      expect(hooks?.cancel('killed by test')).toBeUndefined()
      expect(hooks?.cancel('and again')).toBeUndefined()

      await expect(hooks?.done).resolves.toEqual({ status: 'killed', detail: 'killed by test' })
      expect(query.closed).toBe(true)
      expect(harness.ctx.claudeCode.session(sessionId as never)).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  it('settles done as completed when the session is closed through claude_code_close', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      const result = await harness.call('claude_code_open', {
        cwd: CWD, prompt: 'hi', background: true,
      })
      const sessionId = (result.value as { ccSessionId: string }).ccSessionId
      const hooks = harness.jobs?.hooks[0]

      await harness.call('claude_code_close', { session_id: sessionId })
      await expect(hooks?.done).resolves.toEqual({ status: 'completed', detail: 'session closed' })
    } finally {
      await harness.dispose()
    }
  })

  it('settles done as FAILED when the subprocess dies mid-turn', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      const result = await harness.call('claude_code_open', {
        cwd: CWD, prompt: 'a long job', background: true,
      })
      const sessionId = (result.value as { ccSessionId: string }).ccSessionId
      const hooks = harness.jobs?.hooks[0]
      const query = await firstQuery(harness)
      await waitFor(() => query.sent.length === 1, 'the opening prompt to reach the subprocess')

      // Nobody asked for anything: the subprocess dies with the turn in flight.
      // Before the seam's self-close this job stayed `running` forever.
      query.endStream()
      await settle()

      await expect(hooks?.done).resolves.toMatchObject({ status: 'failed' })
      expect(String((await hooks?.done)?.detail)).toContain('mid-turn')
      expect(harness.ctx.claudeCode.get(sessionId as never)).toMatchObject({ closeReason: 'crashed' })
    } finally {
      await harness.dispose()
    }
  })

  it('settles done as COMPLETED when the subprocess exits between turns', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      const result = await harness.call('claude_code_open', {
        cwd: CWD, prompt: 'quick job', background: true,
      })
      const sessionId = (result.value as { ccSessionId: string }).ccSessionId
      const hooks = harness.jobs?.hooks[0]
      const query = await firstQuery(harness)
      await waitFor(() => query.sent.length === 1, 'the opening prompt to reach the subprocess')
      await query.emitResult('success', { result: 'done' })

      query.endStream()
      await settle()

      // Every turn it was given ran; the CLI simply ended. That is not a failure.
      await expect(hooks?.done).resolves.toMatchObject({ status: 'completed' })
      expect(harness.ctx.claudeCode.get(sessionId as never)).toMatchObject({ closeReason: 'exited' })
    } finally {
      await harness.dispose()
    }
  })

  it('settles done exactly once when a crash races a kill, and reports the kill', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      await harness.call('claude_code_open', { cwd: CWD, prompt: 'racing', background: true })
      const hooks = harness.jobs?.hooks[0]
      const query = await firstQuery(harness)
      await waitFor(() => query.sent.length === 1, 'the opening prompt to reach the subprocess')

      // The kill lands first and closes the session; the pump end that follows
      // must not re-settle, and must not relabel a deliberate kill as a crash.
      hooks?.cancel('killed by test')
      query.endStream()
      await settle()

      await expect(hooks?.done).resolves.toEqual({ status: 'killed', detail: 'killed by test' })
    } finally {
      await harness.dispose()
    }
  })

  it('never rejects done, even when the open itself fails', async () => {
    const harness = await mountTools({ jobs: true, breakBackend: true })
    try {
      const result = await harness.call('claude_code_open', {
        cwd: CWD, prompt: 'hi', background: true,
      })
      // The caller learns the truth…
      expect(result.isError).toBe(true)
      expect(result.error?.info?.code).toBe('BACKEND_ERROR')

      // …and the job settled through `done` rather than rejecting it, which the
      // registry would otherwise have to convert into a forced failure.
      const hooks = harness.jobs?.hooks[0]
      const outcome = await hooks?.done
      expect(outcome?.status).toBe('failed')
      expect(String(outcome?.detail)).toContain('refused to start')
      expect(harness.ctx.claudeCode.list()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  it('never wires the caller signal into the published job: aborting the tool call leaves the session running', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      const controller = new AbortController()
      const result = await harness.call(
        'claude_code_open',
        { cwd: CWD, prompt: 'a long job', background: true },
        { agent: fakeAgent(), signal: controller.signal },
      )
      expect(result.isError, JSON.stringify(result.error)).toBe(false)
      const sessionId = (result.value as { ccSessionId: string }).ccSessionId
      const query = await firstQuery(harness)

      // Cancelling the TOOL CALL after the job id was published must not reach
      // the session: from `start()` onwards cancellation belongs to
      // `JobHooks.cancel` alone (delta D10).
      controller.abort()
      await settle()
      await settle()

      expect(query.closed).toBe(false)
      expect(harness.ctx.claudeCode.get(sessionId as never)?.status).toBe('running')
      // The job is still running too — `done` has not settled.
      const hooks = harness.jobs?.hooks[0]
      const outcome = await Promise.race([hooks?.done, settle().then(() => 'still-running' as const)])
      expect(outcome).toBe('still-running')
      // …and the session still works: the turn it was opened with completes.
      await query.emitResult('success', { result: 'finished anyway' })
      expect(hooks?.readOutput?.()).toBe('finished anyway')
    } finally {
      await harness.dispose()
    }
  })

  it('settles exactly once when a kill and a close race, in either order', async () => {
    for (const order of ['close-then-kill', 'kill-then-close'] as const) {
      const harness = await mountTools({ jobs: true })
      try {
        const result = await harness.call('claude_code_open', {
          cwd: CWD, prompt: 'hi', background: true,
        })
        const sessionId = (result.value as { ccSessionId: string }).ccSessionId
        const hooks = harness.jobs?.hooks[0]

        if (order === 'close-then-kill') {
          await harness.call('claude_code_close', { session_id: sessionId })
          hooks?.cancel('too late')
        } else {
          hooks?.cancel('killed first')
          await harness.call('claude_code_close', { session_id: sessionId })
        }
        // A second close (the double-kill the model or a teardown can issue) is
        // still idempotent, and cannot re-settle the job either.
        const again = await harness.call('claude_code_close', { session_id: sessionId })
        expect(again.value, order).toEqual({ closed: true })
        hooks?.cancel('and again')
        await settle()

        // The FIRST settlement wins: a promise resolves once, and the producer's
        // own guard keeps every later path from trying.
        await expect(hooks?.done, order).resolves.toEqual(order === 'close-then-kill'
          ? { status: 'completed', detail: 'session closed' }
          : { status: 'killed', detail: 'killed first' })
        expect(harness.ctx.claudeCode.session(sessionId as never), order).toBeUndefined()
      } finally {
        await harness.dispose()
      }
    }
  })

  it('honors a cancel that lands before the open has finished', async () => {
    const harness = await mountTools({ jobs: true })
    try {
      const pending = startBackgroundSession(
        harness.ctx,
        { cwd: CWD, prompt: 'hi' },
        { signal: new AbortController().signal },
      )
      // `run()` is called synchronously inside `start()`, so the hooks exist
      // long before the session does.
      await waitFor(() => (harness.jobs?.hooks.length ?? 0) > 0, 'the job hooks')
      harness.jobs?.hooks[0]?.cancel('killed while starting')

      const handle = await pending
      expect(handle.jobId).toBe('claude-code-1')
      await expect(harness.jobs?.hooks[0]?.done)
        .resolves.toEqual({ status: 'killed', detail: 'killed while starting' })
      await settle()
      expect(harness.ctx.claudeCode.session(handle.ccSessionId as never)).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })
})
