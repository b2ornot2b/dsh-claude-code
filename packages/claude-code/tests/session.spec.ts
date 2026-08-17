import { CcSession, newCcSessionId, resolveClaudeCodeConfig } from '@deepseek-ai/dsh-claude-code'
import type {
  CcMessageEnvelope, CcSessionDeps, CcSessionOptions, ClaudeCodeConfig,
} from '@deepseek-ai/dsh-claude-code'
import { afterEach, describe, expect, it } from 'vitest'

import { createFakeBackend, settle } from './fake-backend.ts'
import type { FakeQuery } from './fake-backend.ts'

/**
 * The session actor, driven entirely through a fake backend: no subprocess, no
 * network, no credentials. Everything asserted here is a protocol decision the
 * seam makes about messages it receives — which is exactly the part a live test
 * cannot pin down deterministically.
 */

/** Sessions opened by {@link open}, closed after every test. */
const opened: CcSession[] = []

afterEach(async () => {
  while (opened.length > 0) {
    const session = opened.pop()
    await session?.close()
  }
})

/**
 * Open a session against a fake backend.
 * @param config - surface configuration for the seam.
 * @param options - per-session overrides (`cwd` defaults to a fixed absolute path).
 * @param extraDeps - extra session dependencies (a permission router, a credential hook).
 * @returns the session, its fake query, and the fake backend.
 */
async function open(
  config: ClaudeCodeConfig = {},
  options: Partial<CcSessionOptions> = {},
  extraDeps: Partial<CcSessionDeps> = {},
): Promise<{ session: CcSession, query: FakeQuery, fake: ReturnType<typeof createFakeBackend> }> {
  const fake = createFakeBackend()
  const session = new CcSession(
    { id: newCcSessionId(), cwd: '/tmp/cc-session-spec', ...options },
    { backend: fake.backend, config: resolveClaudeCodeConfig(config), drainPollMs: 1, ...extraDeps })
  opened.push(session)
  await session.open()
  const query = fake.queries[0]
  if (query === undefined) throw new Error('fake backend built no query')
  return { session, query, fake }
}

describe('CcSession: construction options (§3.2)', () => {
  it('passes OUR session id, an explicit settingSources list and partial messages', async () => {
    const { session, query } = await open()

    expect(query.options.sessionId).toBe(session.id)
    // Omitting settingSources loads the user's real settings and CLAUDE.md into
    // an embedded agent (delta S1) — it must always be sent, empty by default.
    expect(query.options.settingSources).toEqual([])
    expect(query.options.includePartialMessages).toBe(true)
    expect(query.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(query.options.permissionMode).toBe('default')
    expect(typeof query.options.canUseTool).toBe('function')
    expect(query.options.abortController).toBeInstanceOf(AbortController)
  })

  it('carries config defaults (model, permission mode, appended prompt, executable path)', async () => {
    const { query } = await open({
      executablePath: '/usr/local/bin/claude',
      defaults: {
        model: 'claude-haiku-4-5-20251001',
        permissionMode: 'plan',
        settingSources: ['project'],
        appendSystemPrompt: 'Be terse.',
      },
    })

    expect(query.options.model).toBe('claude-haiku-4-5-20251001')
    expect(query.options.permissionMode).toBe('plan')
    expect(query.options.settingSources).toEqual(['project'])
    expect(query.options.systemPrompt?.append).toBe('Be terse.')
    expect(query.options.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
  })

  it('sends forkSession only with resume, and always under our own fresh id (spike 1)', async () => {
    const source = newCcSessionId()
    const { session, query } = await open({}, { resume: source, fork: true })

    expect(query.options.resume).toBe(source)
    expect(query.options.forkSession).toBe(true)
    expect(query.options.sessionId).toBe(session.id)
    expect(query.options.sessionId).not.toBe(source)
  })

  it('drops forkSession when there is nothing to resume', async () => {
    const { query } = await open({}, { fork: true })
    expect('forkSession' in query.options).toBe(false)
  })

  it('sends a plain resume WITHOUT a sessionId (the SDK rejects that combination)', async () => {
    // Verified live against SDK 0.3.233: `sessionId` + `resume` without
    // `forkSession` makes the subprocess exit 1 before `system/init`
    // ("--session-id can only be used with --continue or --resume if
    // --fork-session is also specified"), so a plain resume sends `resume`
    // alone and dsh tracks the session under the id it resumed.
    const source = newCcSessionId()
    const { query } = await open({}, { id: source, resume: source })

    expect(query.options.resume).toBe(source)
    expect('sessionId' in query.options).toBe(false)
    expect('forkSession' in query.options).toBe(false)
  })

  it('denies every tool call when no permission router is wired (fail closed)', async () => {
    const { query } = await open()
    const decision = await query.options.canUseTool?.(
      'Bash',
      { command: 'rm -rf /' },
      { signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'req-1' })

    expect(decision?.behavior).toBe('deny')
    expect(decision).toMatchObject({ message: expect.stringContaining('Phase 4') as unknown as string })
  })
})

describe('CcSession: environment construction (§9, delta S9)', () => {
  it('spreads process.env so PATH survives and strips ANTHROPIC_API_KEY under subscription auth', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-should-not-reach-the-subprocess'
    try {
      const { query } = await open({ auth: 'subscription' })
      // options.env REPLACES the environment: losing PATH loses the login.
      expect(query.options.env?.['PATH']).toBe(process.env['PATH'])
      expect('ANTHROPIC_API_KEY' in (query.options.env ?? {})).toBe(false)
    } finally {
      delete process.env['ANTHROPIC_API_KEY']
    }
  })

  it('overlays config.env on top of process.env', async () => {
    const { query } = await open({ env: { CLAUDE_CODE_MAX_RETRIES: '2', PATH: '/overridden' } })
    expect(query.options.env?.['CLAUDE_CODE_MAX_RETRIES']).toBe('2')
    expect(query.options.env?.['PATH']).toBe('/overridden')
  })

  it('keeps a resolved API key under api-key auth, under the configured reference name', async () => {
    const { query } = await open(
      { auth: 'api-key', apiKeyRef: 'MY_KEY_REF' },
      {},
      { resolveApiKey: async () => await Promise.resolve('sk-live-key') })

    expect(query.options.env?.['MY_KEY_REF']).toBe('sk-live-key')
  })
})

describe('CcSession: initialize handshake', () => {
  it('caches commands, models and the account, and reaches idle', async () => {
    const { session } = await open()

    expect(session.status).toBe('idle')
    expect(session.initializeResult?.commands.map(command => command.name)).toEqual(['usage'])
    expect(session.account?.email).toBe('tester@example.com')
    expect(session.snapshot()).toMatchObject({ id: session.id, status: 'idle', pendingAsks: 0 })
  })

  it('re-caches capabilities on every later init without re-running open logic (spike 3)', async () => {
    const { session, query } = await open()
    const seen: CcMessageEnvelope[] = []
    session.onMessage(envelope => { seen.push(envelope) })

    await query.emitInit({ model: 'claude-haiku-4-5-20251001', capabilities: ['interrupt_receipt_v1'] })
    expect(session.capabilities).toEqual(['interrupt_receipt_v1'])
    expect(seen[0]?.meta.reinit).toBe(false)

    await query.emitInit({ model: 'claude-sonnet-4-5', capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'] })
    expect(session.capabilities).toEqual(['interrupt_receipt_v1', 'msg_lifecycle_v1'])
    // The second init is flagged so the mirror can tell "session started" from
    // "the CLI re-initialized after an interrupt".
    expect(seen[1]?.meta.reinit).toBe(true)
    expect(session.snapshot().model).toBe('claude-sonnet-4-5')
    expect(session.status).toBe('idle')
  })
})

describe('CcSession: send modes', () => {
  it('followup sends a plain uuid-stamped message and starts a turn', async () => {
    const { session, query } = await open()
    const uuid = session.send('hello')
    await settle()

    expect(session.status).toBe('running')
    const sent = query.sent.at(-1)
    expect(sent?.uuid).toBe(uuid)
    expect('priority' in (sent ?? {})).toBe(false)
    expect(session.outbox()).toEqual([{ uuid, mode: 'followup', sentAt: expect.any(Number) as unknown as number, state: 'queued' }])
  })

  it('steer sends priority "now" and flags the abort artifact result (spike 2)', async () => {
    const { session, query } = await open()
    session.send('long task')
    await settle()
    session.send('actually, stop and do this instead', { mode: 'steer' })
    await settle()

    expect(query.sent.at(-1)?.priority).toBe('now')

    const seen: CcMessageEnvelope[] = []
    session.onMessage(envelope => { seen.push(envelope) })

    // The aborted turn's result is an internal artifact of steering: it must be
    // flagged (so the mirror suppresses it) and must NOT end the turn.
    await query.emitResult('error_during_execution')
    expect(seen.at(-1)?.meta.interruptArtifact).toBe(true)
    expect(session.status).toBe('running')
    // It is fanned out (the mirror decides what to do with it) but it is not a
    // turn result: it never becomes `lastResult`.
    expect(session.lastResult).toBeUndefined()

    // The refolded turn's real result ends it.
    await query.emitResult('success')
    expect(seen.at(-1)?.meta.interruptArtifact).toBe(false)
    expect(session.status).toBe('idle')
    expect(session.outbox().every(entry => entry.state === 'committed')).toBe(true)
  })

  it('flags a steering artifact as an interrupted turn too', async () => {
    const { session, query } = await open()
    session.send('long task')
    await settle()
    session.send('stop, do this instead', { mode: 'steer' })
    await settle()

    const seen: CcMessageEnvelope[] = []
    session.onMessage(envelope => { seen.push(envelope) })
    await query.emitResult('error_during_execution')

    // Every artifact is an interrupted turn; only an artifact is suppressed.
    expect(seen.at(-1)?.meta).toMatchObject({ interruptArtifact: true, interruptedTurn: true })
  })

  it('does not flag an unexpected error result as a steering artifact', async () => {
    const { session, query } = await open()
    const seen: CcMessageEnvelope[] = []
    session.onMessage(envelope => { seen.push(envelope) })
    session.send('go')
    await settle()

    await query.emitResult('error_during_execution')
    expect(seen.at(-1)?.meta).toMatchObject({ interruptArtifact: false, interruptedTurn: false })
    expect(session.status).toBe('idle')
  })

  it('inject sets shouldQuery:false, starts no turn and commits immediately', async () => {
    const { session, query } = await open()
    const uuid = session.send('FYI: the build is red', { mode: 'inject' })
    await settle()

    expect(query.sent.at(-1)?.shouldQuery).toBe(false)
    expect(session.status).toBe('idle')
    expect(session.outbox()).toEqual([
      { uuid, mode: 'inject', sentAt: expect.any(Number) as unknown as number, state: 'committed' },
    ])
  })

  it('refuses to send on a closed session', async () => {
    const { session } = await open()
    await session.close()
    expect(() => session.send('too late'))
      .toThrowError(expect.objectContaining({ name: 'ClaudeCodeError', code: 'SESSION_CLOSED' }))
  })
})

describe('CcSession: status machine and turn batching', () => {
  it('stays running while a followup queued behind the turn is still pending', async () => {
    const { session, query } = await open()
    session.send('first')
    await settle()
    session.send('second')
    await settle()
    expect(session.status).toBe('running')

    // First turn's result commits only the first batch; the queued message
    // becomes the next turn.
    await query.emitResult()
    expect(session.status).toBe('running')
    expect(session.outbox().map(entry => entry.state)).toEqual(['committed', 'queued'])

    await query.emitResult()
    expect(session.status).toBe('idle')
    expect(session.outbox().map(entry => entry.state)).toEqual(['committed', 'committed'])
  })

  it('coalesces messages queued behind one turn into a single next turn (spike 3)', async () => {
    const { session, query } = await open()
    session.send('first')
    await settle()
    session.send('second')
    session.send('third')
    await settle()

    await query.emitResult()
    expect(session.status).toBe('running')
    // Two queued messages, ONE coalesced turn, ONE result.
    await query.emitResult()
    expect(session.status).toBe('idle')
    expect(session.outbox().map(entry => entry.state)).toEqual(['committed', 'committed', 'committed'])
  })
})

describe('CcSession: waitForResult', () => {
  it('resolves with the turn result and then answers immediately from cache', async () => {
    const { session, query } = await open()
    session.send('go')
    await settle()

    const waiting = session.waitForResult()
    await query.emitResult('success', { total_cost_usd: 0.01 })
    const envelope = await waiting
    expect(envelope.message.subtype).toBe('success')
    expect(envelope.meta.sessionId).toBe(session.id)

    await expect(session.waitForResult()).resolves.toBe(envelope)
  })

  it('is not settled by a steering artifact', async () => {
    const { session, query } = await open()
    session.send('long task')
    await settle()
    session.send('steer', { mode: 'steer' })
    await settle()

    let settledWith: string | undefined
    const waiting = session.waitForResult().then(envelope => {
      settledWith = envelope.message.subtype
      return envelope
    })

    await query.emitResult('error_during_execution')
    expect(settledWith).toBeUndefined()

    await query.emitResult('success')
    await waiting
    expect(settledWith).toBe('success')
  })

  it('rejects with TIMEOUT without disturbing the session', async () => {
    const { session } = await open()
    session.send('slow')
    await settle()

    await expect(session.waitForResult(5))
      .rejects.toMatchObject({ name: 'ClaudeCodeError', code: 'TIMEOUT' })
    expect(session.status).toBe('running')
  })

  it('rejects every waiter when the session closes', async () => {
    const { session } = await open()
    session.send('go')
    await settle()

    const waiting = session.waitForResult()
    await session.close()
    await expect(waiting).rejects.toMatchObject({ name: 'ClaudeCodeError', code: 'SESSION_CLOSED' })
    await expect(session.waitForResult()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
})

describe('CcSession: interrupt receipt reconciliation (§5.4)', () => {
  it('commits uuids absent from still_queued and leaves survivors queued', async () => {
    const { session, query } = await open()
    const first = session.send('one')
    await settle()
    const second = session.send('two')
    const third = session.send('three')
    await settle()

    query.receipts.push({ still_queued: [second, third] })
    const outcome = await session.interrupt()

    expect(outcome.receiptSupported).toBe(true)
    expect(outcome.stillQueued).toEqual([second, third])
    const states = new Map(session.outbox().map(entry => [entry.uuid, entry.state]))
    expect(states.get(first)).toBe('committed')
    expect(states.get(second)).toBe('queued')
    expect(states.get(third)).toBe('queued')
  })

  it('ignores uuids it never sent (cron triggers, auto-resume continuations)', async () => {
    const { session, query } = await open()
    const mine = session.send('mine')
    await settle()

    query.receipts.push({ still_queued: [mine, 'a-uuid-we-never-sent'] })
    const outcome = await session.interrupt()

    expect(outcome.stillQueued).toEqual([mine])
    expect(session.outbox()).toHaveLength(1)
  })

  it('reconciles nothing when the CLI predates interrupt_receipt_v1', async () => {
    const { session, query } = await open()
    const uuid = session.send('one')
    await settle()

    query.receipts.push(undefined)
    const outcome = await session.interrupt()

    expect(outcome.receiptSupported).toBe(false)
    expect(outcome.stillQueued).toEqual([])
    expect(session.outbox()[0]?.state).toBe('queued')
  })

  it('keepQueued:false drains survivors and marks them cancelled', async () => {
    const { session, query } = await open()
    session.send('one')
    await settle()
    const second = session.send('two')
    const third = session.send('three')
    await settle()

    query.receipts.push({ still_queued: [second, third] }, { still_queued: [third] }, { still_queued: [] })
    const outcome = await session.interrupt({ keepQueued: false })

    expect([...outcome.cancelled].sort()).toEqual([second, third].sort())
    expect(outcome.stillQueued).toEqual([])
    const states = new Map(session.outbox().map(entry => [entry.uuid, entry.state]))
    expect(states.get(second)).toBe('cancelled')
    expect(states.get(third)).toBe('cancelled')
    expect(query.interruptCount).toBe(3)
  })

  it('caps the emulated drain at still_queued.length + 2 attempts', async () => {
    const { session, query } = await open()
    session.send('one')
    await settle()
    const second = session.send('two')
    await settle()

    // A CLI that never lets go: the loop must stop rather than spin forever.
    for (let index = 0; index < 20; index += 1) query.receipts.push({ still_queued: [second] })
    const outcome = await session.interrupt({ keepQueued: false })

    // 1 initial interrupt + cap (still_queued.length + 2 === 3) drain attempts.
    expect(query.interruptCount).toBe(4)
    expect(outcome.cancelled).toEqual([second])
  })

  it('flags the aborted turn of an explicit interrupt WITHOUT suppressing it', async () => {
    const { session, query } = await open()
    const seen: CcMessageEnvelope[] = []
    session.onMessage(envelope => { seen.push(envelope) })
    session.send('long task')
    await settle()

    query.receipts.push({ still_queued: [] })
    await session.interrupt()
    await query.emitResult('error_during_execution')

    // Spike 3: an interrupt aborts the turn with the same result shape a steer
    // produces. It is flagged so a mirror renders "cancelled" rather than
    // "failed" — but with nothing queued behind it, it is the ONLY signal the
    // turn ended, so it still settles waiters and becomes lastResult.
    expect(seen.at(-1)?.meta).toMatchObject({ interruptArtifact: false, interruptedTurn: true })
    expect(session.lastResult?.meta.interruptedTurn).toBe(true)
    expect(session.status).toBe('idle')
    await expect(session.waitForResult(5)).resolves.toMatchObject({ meta: { interruptedTurn: true } })
  })

  it('drops the interrupt expectation at a turn boundary of any other kind', async () => {
    const { session, query } = await open()
    const seen: CcMessageEnvelope[] = []
    session.onMessage(envelope => { seen.push(envelope) })
    session.send('one')
    await settle()

    // The interrupt lands after the turn already finished: no abort result is
    // produced, and a stale expectation must not mislabel a LATER real failure.
    query.receipts.push({ still_queued: [] })
    await session.interrupt()
    await query.emitResult('success')
    expect(seen.at(-1)?.meta.interruptedTurn).toBe(false)

    session.send('two')
    await settle()
    await query.emitResult('error_during_execution')
    expect(seen.at(-1)?.meta.interruptedTurn).toBe(false)
  })

  it('refuses to interrupt a closed session', async () => {
    const { session } = await open()
    await session.close()
    await expect(session.interrupt()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
})

describe('CcSession: fan-out', () => {
  it('delivers every message to every subscriber and honors unsubscribe', async () => {
    const { session, query } = await open()
    const first: string[] = []
    const second: string[] = []
    const stop = session.onMessage(envelope => { first.push(envelope.message.type) })
    session.onMessage(envelope => { second.push(envelope.message.type) })

    await query.emit({ type: 'assistant' })
    stop()
    await query.emit({ type: 'stream_event' })

    expect(first).toEqual(['assistant'])
    expect(second).toEqual(['assistant', 'stream_event'])
  })

  it('isolates a throwing listener so the pump keeps running', async () => {
    const logged: string[] = []
    const { session, query } = await open({}, {}, { logger: { debug: (line: string) => { logged.push(line) } } })
    session.onMessage(() => { throw new Error('subscriber exploded') })
    const healthy: string[] = []
    session.onMessage(envelope => { healthy.push(envelope.message.type) })

    await query.emit({ type: 'assistant' })
    await query.emit({ type: 'result', subtype: 'success' })

    expect(healthy).toEqual(['assistant', 'result'])
    expect(logged.some(line => line.includes('listener threw'))).toBe(true)
  })
})

describe('CcSession: close', () => {
  it('closes the query, ends the input stream and is idempotent', async () => {
    const { session, query } = await open()
    await session.close()
    await session.close()

    expect(query.closed).toBe(true)
    expect(session.status).toBe('closed')
    expect(query.options.abortController?.signal.aborted).toBe(true)
  })

  it('notifies close subscribers exactly once, and immediately when already closed', async () => {
    const { session } = await open()
    let closes = 0
    session.onClose(() => { closes += 1 })
    await session.close()
    expect(closes).toBe(1)

    let late = 0
    session.onClose(() => { late += 1 })
    expect(late).toBe(1)
  })

  it('reports a backend failure as BACKEND_ERROR and leaves nothing running', async () => {
    const fake = createFakeBackend()
    const failing: CcSessionDeps = {
      backend: {
        query() { throw new Error('spawn failed: ENOENT') },
        startup: fake.backend.startup.bind(fake.backend),
      },
      config: resolveClaudeCodeConfig(),
    }
    const session = new CcSession({ id: newCcSessionId(), cwd: '/tmp/cc-session-spec' }, failing)

    await expect(session.open()).rejects.toMatchObject({ name: 'ClaudeCodeError', code: 'BACKEND_ERROR' })
    expect(session.status).toBe('closed')
  })
})
