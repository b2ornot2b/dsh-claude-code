/**
 * The mirror (Phase 3, spec §5): Claude Code's message stream projected into a
 * REAL dsh session log.
 *
 * Every assertion here runs against a live `SessionStore` session — not a
 * recording double — so a payload dsh would reject, a surface marker it would
 * refuse, or a chunk shape outside its `StreamChunk` union fails the test at the
 * append site exactly as it would in production.
 *
 * The SDK message shapes come from `./mirror-fixtures.ts`, transcribed from
 * spike 6's recorded transcript (`spikes/partial-messages/run1.log`).
 */

import { Context } from '@deepseek-ai/cordis'
import { attachMirror, CC_COMPACT_EVENT, CcMirror, markEventIgnorable } from '@deepseek-ai/dsh-claude-code'
import type { CcMessageEnvelope, CcSendRecord } from '@deepseek-ai/dsh-claude-code'
import { isJsonValue, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import {
  assistantCheckpoint, blockDelta, blockStart, blockStop, compactBoundary, envelope, FIXTURE_SESSION,
  haikuTranscript, messageEnd, messageStart, result, systemInit, toolResultMessage,
} from './mirror-fixtures.ts'

/**
 * Mount a real in-memory `SessionStore` and create one session in it.
 * @param id - the session id; defaults to the fixture id.
 * @returns the session and a disposer for the owning fiber.
 */
async function mountSession(id = FIXTURE_SESSION): Promise<{
  ctx: Context
  session: Session
  store: SessionStore
  dispose(): Promise<void>
}> {
  const ctx = new Context()
  const fiber = await ctx.plugin(SessionStore)
  const store = ctx.get('sessions')
  if (store === undefined) throw new Error('session store did not mount')
  const session = store.create(id)
  return {
    ctx,
    session,
    store,
    dispose: async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/**
 * One send record, as `CcSession.onSend` would produce it.
 * @param content - the message text.
 * @param mode - the inbox verb.
 * @returns the send record.
 */
function send(content: string, mode: CcSendRecord['mode'] = 'followup'): CcSendRecord {
  return {
    sessionId: FIXTURE_SESSION,
    uuid: '99999999-8888-4777-8666-555555555555',
    mode,
    content,
    sentAt: 1_700_000_000_000,
  }
}

/**
 * Feed a list of SDK messages through the mirror.
 * @param mirror - the mirror under test.
 * @param messages - the messages, in arrival order.
 * @param meta - metadata applied to every envelope.
 * @returns nothing.
 */
function feed(
  mirror: CcMirror,
  messages: readonly Parameters<typeof envelope>[0][],
  meta: Partial<CcMessageEnvelope['meta']> = {},
): void {
  for (const message of messages) mirror.observe(envelope(message, meta))
}

/**
 * The event types of a session log, in order — the shape most assertions read.
 * @param session - the dsh session.
 * @returns the ordered type names.
 */
function types(session: Session): string[] {
  return session.events.map(event => event.type)
}

/**
 * Narrow one logged event by type.
 * @param session - the dsh session.
 * @param type - the event type to find.
 * @returns every matching event.
 */
function eventsOfType<T extends SessionEvent['type']>(session: Session, type: T): Extract<SessionEvent, { type: T }>[] {
  return session.events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type)
}

/**
 * Re-check dsh's own relational log invariants over a produced log.
 *
 * A local restatement of `@deepseek-ai/dsh-session/invariant` (which needs the
 * invariants service, not part of this offline suite): seq contiguity, one open
 * turn at a time with `nextTurn` numbering, no step outside a turn, and no
 * `tool/result` whose `tool/call` is not pending in the open step.
 *
 * @param session - the session whose log to validate.
 * @returns nothing.
 * @throws when the log violates a framing invariant.
 */
function assertFramingInvariants(session: Session): void {
  let openTurn: number | undefined
  let openStep: number | undefined
  let nextTurn = 1
  let nextStep = 1
  const pending = new Set<string>()
  for (const [index, event] of session.events.entries()) {
    expect(event.seq).toBe(index)
    switch (event.type) {
      case 'turn/start':
        expect(openTurn).toBeUndefined()
        expect(event.data.turn).toBe(nextTurn)
        openTurn = event.data.turn
        nextStep = 1
        break
      case 'turn/end':
        expect(openTurn).toBe(event.data.turn)
        expect(openStep).toBeUndefined()
        openTurn = undefined
        nextTurn = event.data.turn + 1
        break
      case 'step/start':
        expect(openTurn).toBe(event.data.turn)
        expect(openStep).toBeUndefined()
        expect(event.data.step).toBe(nextStep)
        openStep = event.data.step
        break
      case 'step/end':
        expect(openTurn).toBe(event.data.turn)
        expect(openStep).toBe(event.data.step)
        openStep = undefined
        nextStep = event.data.step + 1
        pending.clear()
        break
      case 'assistant/chunk':
      case 'assistant/message':
        expect(openTurn).toBe(event.data.turn)
        expect(openStep).toBe(event.data.step)
        break
      case 'tool/call':
        expect(openTurn).toBe(event.data.turn)
        expect(openStep).toBe(event.data.step)
        pending.add(event.data.callId)
        break
      case 'tool/result':
        expect(openTurn).toBe(event.data.turn)
        expect(openStep).toBe(event.data.step)
        expect(pending.has(event.data.message.source.callId)).toBe(true)
        pending.delete(event.data.message.source.callId)
        break
      case 'todo/write':
        expect(openTurn).not.toBeUndefined()
        break
      default:
        // Merge-extensible: a plugin event (ours included) constrains nothing.
        break
    }
    expect(isJsonValue(event.data)).toBe(true)
  }
}

describe('CcMirror content projection', () => {
  it('projects a recorded turn into the exact dsh event sequence', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('two short sentences about the sky'))
      feed(mirror, haikuTranscript())

      expect(types(session)).toEqual([
        'turn/start',
        'user/message',
        'step/start',
        'assistant/chunk', // block-start reasoning
        'assistant/chunk', // reasoning-delta
        'assistant/chunk', // reasoning-delta
        'assistant/chunk', // block-end reasoning
        'assistant/chunk', // block-start text
        'assistant/chunk', // text-delta
        'assistant/chunk', // text-delta
        'assistant/chunk', // block-end text
        'assistant/chunk', // usage
        'assistant/chunk', // finish
        'assistant/message',
        'step/end',
        'turn/end',
      ])
      assertFramingInvariants(session)
      expect(mirror.hasOpenTurn).toBe(false)
      expect(mirror.openStep).toBeUndefined()
      expect(mirror.stats.checksumMismatches).toBe(0)
    } finally {
      await dispose()
    }
  })

  it('emits chunk payloads that match dsh StreamChunk exactly, reasoning included', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('hi'))
      feed(mirror, haikuTranscript())

      const chunks = eventsOfType(session, 'assistant/chunk').map(event => event.data.chunk)
      expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
      expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: 'The user is asking' })
      expect(chunks[3]).toEqual({
        type: 'block-end',
        index: 0,
        block: { type: 'reasoning', text: 'The user is asking me to write two sentences.' },
      })
      expect(chunks[4]).toEqual({ type: 'block-start', index: 1, blockType: 'text' })
      expect(chunks[5]).toEqual({ type: 'text-delta', index: 1, text: 'The sky stretched endlessly above,' })
      expect(chunks[8]).toEqual({
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 100,
          cacheReadTokens: 15830,
          cacheWriteTokens: 2780,
          reasoningTokens: 59,
        },
      })
      expect(chunks[9]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      for (const chunk of chunks) expect(isJsonValue(chunk)).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('assembles assistant/message from the stream, never from the per-block checkpoints', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('hi'))
      feed(mirror, haikuTranscript())

      const messages = eventsOfType(session, 'assistant/message')
      // ONE message, although three `SDKAssistantMessage` checkpoints arrived.
      expect(messages).toHaveLength(1)
      const [message] = messages
      expect(message?.data.message.content).toEqual([
        { type: 'reasoning', text: 'The user is asking me to write two sentences.' },
        { type: 'text', text: 'The sky stretched endlessly above, painted in shades of blue.' },
      ])
      expect(message?.data.message.source).toEqual({
        kind: 'model',
        provider: 'claude-code',
        model: 'claude-haiku-4-5-20251001',
      })
      expect(message?.data.usage?.outputTokens).toBe(100)
      // Provenance: every chunk that built it, in order.
      expect(message?.sourceEventSeqs).toEqual(
        eventsOfType(session, 'assistant/chunk').map(event => event.seq))
      expect(message?.surfaceOp).toBe('append')
    } finally {
      await dispose()
    }
  })

  it('records the user prompt from the send side, with a plugin source', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('two short sentences about the sky'))

      const [user] = eventsOfType(session, 'user/message')
      expect(user?.data.role).toBe('user')
      expect(user?.data.content).toEqual([{ type: 'text', text: 'two short sentences about the sky' }])
      expect(user?.data.source).toEqual({ kind: 'plugin', plugin: 'dsh-claude-code' })
      expect(user?.surfaceOp).toBe('append')
      expect(session.deriveMessages()).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it('does not open a turn for an inject send, and declares it as a notice', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('a file changed under you', 'inject'))

      expect(types(session)).toEqual(['user/message'])
      expect(mirror.hasOpenTurn).toBe(false)
      const [user] = eventsOfType(session, 'user/message')
      expect(user?.data.source).toEqual({
        kind: 'plugin',
        plugin: 'dsh-claude-code',
        form: 'notice',
        summary: 'a file changed under you',
      })
    } finally {
      await dispose()
    }
  })
})

describe('CcMirror turn framing', () => {
  it('suppresses a steer artifact entirely and keeps the turn open', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('first'))
      feed(mirror, [messageStart(), blockStart(0, { type: 'text', text: '' })])
      const beforeArtifact = session.events.length

      // The abort result of a `steer`: an internal artifact of the refold. It
      // writes nothing itself, but it DOES close the step it interrupted —
      // real live traffic (the `steer` golden fixture) shows the refold never
      // continues streaming the aborted call; it starts an entirely fresh
      // `message_start`. Leaving the interrupted step dangling open would let
      // the fresh call's chunks land inside it instead of a step of their own.
      feed(mirror, [result('error_during_execution', { is_error: true })], {
        interruptArtifact: true,
        interruptedTurn: true,
      })

      expect(session.events.length).toBe(beforeArtifact + 1)
      expect(types(session).at(-1)).toBe('step/end')
      expect(mirror.hasOpenTurn).toBe(true)
      expect(mirror.openStep).toBeUndefined()
      expect(mirror.stats.ignored['result:interrupt-artifact']).toBe(1)
      // The interrupted call's partial content never became an assistant
      // message: it was aborted mid-stream, not real output.
      expect(eventsOfType(session, 'assistant/message')).toHaveLength(0)

      // The refolded turn opens a BRAND NEW model call, inside the SAME dsh
      // turn but its OWN step (spike 3: a fresh `message_start` follows every
      // interrupted turn).
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'both instructions' }),
        blockStop(0),
        ...messageEnd(),
        result('success'),
      ])
      expect(eventsOfType(session, 'turn/start')).toHaveLength(1)
      expect(eventsOfType(session, 'step/start')).toHaveLength(2)
      expect(eventsOfType(session, 'assistant/message')).toHaveLength(1)
      expect(eventsOfType(session, 'assistant/message')[0]?.data.message.content).toEqual([
        { type: 'text', text: 'both instructions' },
      ])
      expect(eventsOfType(session, 'turn/end')[0]?.data.reason).toEqual({ kind: 'completed' })
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('closes an interrupted turn as aborted, never as failed', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('long job'))
      feed(mirror, [messageStart(), blockStart(0, { type: 'text', text: '' })])
      feed(mirror, [result('error_during_execution', { is_error: true })], { interruptedTurn: true })

      expect(eventsOfType(session, 'turn/end')[0]?.data.reason).toEqual({
        kind: 'aborted',
        reason: { kind: 'user' },
      })
      expect(mirror.hasOpenTurn).toBe(false)
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('closes a genuinely failed turn as an error with a stable code', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('boom'))
      feed(mirror, [result('error_during_execution', { is_error: true, result: 'subprocess died' })])

      expect(eventsOfType(session, 'turn/end')[0]?.data.reason).toEqual({
        kind: 'error',
        error: { message: 'subprocess died', code: 'CLAUDE_CODE_ERROR_DURING_EXECUTION' },
      })
    } finally {
      await dispose()
    }
  })

  it('never emits a step without a turn, and frames one step per model call', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('use a tool then answer'))
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }),
        blockDelta(0, { type: 'input_json_delta', partial_json: '{"command"' }),
        blockDelta(0, { type: 'input_json_delta', partial_json: ':"ls"}' }),
        blockStop(0),
        ...messageEnd('tool_use'),
        toolResultMessage([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file.txt' }]),
        messageStart({ id: 'msg_second' }),
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'there is one file.' }),
        blockStop(0),
        ...messageEnd(),
        result('success'),
      ])

      expect(eventsOfType(session, 'step/start').map(event => event.data.step)).toEqual([1, 2])
      expect(eventsOfType(session, 'step/end').map(event => event.data.step)).toEqual([1, 2])
      expect(eventsOfType(session, 'turn/start')).toHaveLength(1)
      // The result of step 1's call lands INSIDE step 1 — dsh rejects it anywhere else.
      expect(eventsOfType(session, 'tool/result')[0]?.data.step).toBe(1)
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('continues turn numbering from a log that already holds events', async () => {
    const { session, dispose } = await mountSession()
    try {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      const mirror = new CcMirror(session)
      expect(mirror.hasOpenTurn).toBe(false)
      mirror.recordSend(send('second turn'))

      expect(eventsOfType(session, 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('produces no duplicate framing across re-inits (spike 3)', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      feed(mirror, [systemInit()])
      mirror.recordSend(send('go'))
      feed(mirror, [messageStart(), blockStart(0, { type: 'text', text: '' })])
      feed(mirror, [result('error_during_execution')], { interruptedTurn: true })
      // A fresh init follows every interrupted turn — it must frame nothing.
      feed(mirror, [systemInit()], { reinit: true })

      expect(eventsOfType(session, 'turn/start')).toHaveLength(1)
      expect(eventsOfType(session, 'turn/end')).toHaveLength(1)
      expect(mirror.stats.ignored['system:init']).toBe(2)
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })
})

describe('CcMirror tool correlation', () => {
  it('mints one stable CallId per cc tool_use id and exposes the map', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('list files'))
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'tool_use', id: 'toolu_abc', name: 'Bash', input: {} }),
        blockDelta(0, { type: 'input_json_delta', partial_json: '{"command":"ls"}' }),
        blockStop(0),
        ...messageEnd('tool_use'),
      ])

      const callId = mirror.callIdFor('toolu_abc')
      // Stability: the ask channel (Phase 4) may ask before OR after the block
      // finishes streaming, and both must agree.
      expect(mirror.callIdFor('toolu_abc')).toBe(callId)
      expect(mirror.callIds.get('toolu_abc')).toBe(callId)
      expect(mirror.toolUseIdFor(callId)).toBe('toolu_abc')

      const [call] = eventsOfType(session, 'tool/call')
      expect(call?.data).toMatchObject({ callId, name: 'Bash', arguments: '{"command":"ls"}' })
      const chunk = eventsOfType(session, 'assistant/chunk')
        .map(event => event.data.chunk)
        .find(entry => entry.type === 'tool-call-delta')
      expect(chunk).toEqual({
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        name: 'Bash',
        argumentsDelta: '{"command":"ls"}',
      })
    } finally {
      await dispose()
    }
  })

  it('pairs a tool_result arriving as a user-role message with its call', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('list files'))
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'tool_use', id: 'toolu_abc', name: 'Bash', input: {} }),
        blockDelta(0, { type: 'input_json_delta', partial_json: '{}' }),
        blockStop(0),
        ...messageEnd('tool_use'),
        toolResultMessage([{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'file.txt', is_error: false }]),
      ])

      const [toolResult] = eventsOfType(session, 'tool/result')
      expect(toolResult?.data.message.source.callId).toBe(mirror.callIdFor('toolu_abc'))
      expect(toolResult?.data.message.content).toEqual([{
        type: 'tool-result',
        toolCallId: mirror.callIdFor('toolu_abc'),
        content: [{ type: 'text', text: 'file.txt' }],
        isError: false,
      }])
      expect(toolResult?.surfaceOp).toBe('append')
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('drops a tool_result whose call it never saw instead of forcing it into the log', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('hi'))
      feed(mirror, [toolResultMessage([{ type: 'tool_result', tool_use_id: 'toolu_ghost', content: 'x' }])])

      expect(eventsOfType(session, 'tool/result')).toHaveLength(0)
      expect(mirror.stats.ignored['tool-result:orphan']).toBe(1)
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('mirrors a TodoWrite call as dsh todo/write when the shape maps trivially', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('plan it'))
      const todos = JSON.stringify({
        todos: [
          { content: 'read the spec', status: 'completed', activeForm: 'Reading the spec' },
          { content: 'write the mirror', status: 'in_progress', activeForm: 'Writing the mirror' },
        ],
      })
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: {} }),
        blockDelta(0, { type: 'input_json_delta', partial_json: todos }),
        blockStop(0),
        ...messageEnd('tool_use'),
      ])

      expect(eventsOfType(session, 'todo/write')[0]?.data.todos).toEqual([
        { content: 'read the spec', status: 'completed' },
        { content: 'write the mirror', status: 'in_progress' },
      ])
    } finally {
      await dispose()
    }
  })

  it('skips a TodoWrite whose shape does not map', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('plan it'))
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: {} }),
        blockDelta(0, { type: 'input_json_delta', partial_json: '{"todos":[{"content":1,"status":"nope"}]}' }),
        blockStop(0),
        ...messageEnd('tool_use'),
      ])

      expect(eventsOfType(session, 'todo/write')).toHaveLength(0)
      expect(mirror.stats.ignored['todo:unmapped']).toBe(1)
      expect(eventsOfType(session, 'tool/call')).toHaveLength(1)
    } finally {
      await dispose()
    }
  })
})

describe('CcMirror subagent traffic', () => {
  it('mirrors only tool_use/tool_result from a subagent by default', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('delegate it'))
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'delegating' }),
        blockStop(0),
        // Nested traffic: text is dropped, the tool call is not.
        blockDelta(0, { type: 'text_delta', text: 'nested thought' }, 'toolu_parent'),
        assistantCheckpoint([{ type: 'tool_use', id: 'toolu_nested', name: 'Read', input: { file_path: '/x' } }], 'toolu_parent'),
        toolResultMessage([{ type: 'tool_result', tool_use_id: 'toolu_nested', content: 'contents' }], 'toolu_parent'),
      ])

      expect(mirror.stats.ignored['stream:subagent-text']).toBe(1)
      const [call] = eventsOfType(session, 'tool/call')
      expect(call?.data).toMatchObject({ name: 'Read', arguments: '{"file_path":"/x"}' })
      const [toolResult] = eventsOfType(session, 'tool/result')
      // `meta` is the only field in dsh's schemas that can carry the parent.
      expect(toolResult?.data.meta).toEqual({ parentToolUseId: 'toolu_parent' })
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('forwards nested text when asked to', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session, { forwardSubagentText: true })
      mirror.recordSend(send('delegate it'))
      feed(mirror, [
        blockStart(0, { type: 'text', text: '' }, 'toolu_parent'),
        blockDelta(0, { type: 'text_delta', text: 'nested thought' }, 'toolu_parent'),
      ])

      expect(eventsOfType(session, 'assistant/chunk').map(event => event.data.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'nested thought' },
      ])
      expect(mirror.stats.ignored['stream:subagent-text']).toBeUndefined()
    } finally {
      await dispose()
    }
  })
})

describe('CcMirror compaction', () => {
  it('appends a lossless-JSON claude-code/compact marker', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('keep going'))
      feed(mirror, [compactBoundary('auto', 154_000)])

      const [compact] = session.events.filter(event => event.type === CC_COMPACT_EVENT)
      expect(compact?.data).toEqual({
        trigger: 'auto',
        preTokens: 154_000,
        uuid: '99999999-8888-4777-8666-555555555555',
        turn: 1,
      })
      expect(isJsonValue(compact?.data)).toBe(true)
      // The surface is untouched: CC compacts ITS history, not the mirror's.
      expect(session.surface.nodes).toEqual([1])
    } finally {
      await dispose()
    }
  })

  it('documents the ignorable gap: append cannot mark it, the seed boundary can', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      feed(mirror, [compactBoundary()])
      const [compact] = session.events.filter(event => event.type === CC_COMPACT_EVENT)
      if (compact === undefined) throw new Error('no compact event was appended')

      // rc.7's `Session.append()` builds and freezes the envelope itself, so a
      // LIVE custom event cannot carry the marker (see CC_COMPACT_EVENT).
      expect(compact.ignorable).toBeUndefined()

      // The seed/restore boundary is where envelopes are caller-supplied, and
      // that is where the marker goes on.
      const marked = markEventIgnorable(compact)
      expect(marked.ignorable).toBe(true)
      expect(marked.data).toEqual(compact.data)
      expect(marked).not.toBe(compact)
    } finally {
      await dispose()
    }
  })

  it('accepts the marked envelope on a seeded session', async () => {
    const { session, store, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      feed(mirror, [compactBoundary()])
      const [compact] = session.events.filter(event => event.type === CC_COMPACT_EVENT)
      if (compact === undefined) throw new Error('no compact event was appended')

      const seeded = store.create(SessionId('22222222-3333-4444-8555-666666666666'), {
        seed: [markEventIgnorable({ ...compact, seq: 0 })],
      })
      expect(seeded.events[0]?.ignorable).toBe(true)
      expect(seeded.events[0]?.type).toBe(CC_COMPACT_EVENT)
    } finally {
      await dispose()
    }
  })

  it('skips the marker when the log must stay portable', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session, { compaction: 'skip' })
      feed(mirror, [compactBoundary()])

      expect(session.events).toHaveLength(0)
      expect(mirror.stats.ignored['system:compact_boundary:skipped']).toBe(1)
    } finally {
      await dispose()
    }
  })
})

describe('CcMirror robustness', () => {
  it('default-ignores unknown message kinds and counts them', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      feed(mirror, [
        { type: 'rate_limit_event', session_id: FIXTURE_SESSION },
        { type: 'system', subtype: 'status', session_id: FIXTURE_SESSION },
        { type: 'system', subtype: 'thinking_tokens', session_id: FIXTURE_SESSION },
        { type: 'task_progress_v2', session_id: FIXTURE_SESSION },
        { type: 'stream_event', event: 'not-an-object', parent_tool_use_id: null },
        { type: 'stream_event', event: { type: 'ping' }, parent_tool_use_id: null },
        { type: 'assistant', message: { content: 'not-an-array' }, parent_tool_use_id: null },
        { type: 'user', message: { role: 'user', content: 'plain text prompt echo' }, parent_tool_use_id: null },
      ])

      expect(session.events).toHaveLength(0)
      expect(mirror.stats.appended).toBe(0)
      expect(mirror.stats.ignored).toMatchObject({
        'message:rate_limit_event': 1,
        'message:task_progress_v2': 1,
        'system:status': 1,
        'system:thinking_tokens': 1,
        'stream:malformed': 1,
        'stream:ping': 1,
        'assistant:malformed': 1,
        'user:no-blocks': 1,
      })
    } finally {
      await dispose()
    }
  })

  it('never throws on a malformed or out-of-order stream', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      expect(() => {
        feed(mirror, [
          blockDelta(3, { type: 'text_delta', text: 'orphan' }),
          blockStop(9),
          blockStart(0, { type: 'video', data: 'x' }),
          // No block was opened for an unrepresentable type, so its deltas are
          // orphans too — counted, never guessed at.
          blockDelta(0, { type: 'weird_delta' }),
          result('success'),
        ])
      }).not.toThrow()

      expect(mirror.stats.ignored['stream:delta-without-block']).toBe(2)
      expect(mirror.stats.ignored['stream:stop-without-block']).toBe(1)
      expect(mirror.stats.ignored['stream:block-type:video']).toBe(1)
      expect(mirror.stats.ignored['result:no-open-turn']).toBe(1)
      expect(session.events).toHaveLength(0)
    } finally {
      await dispose()
    }
  })

  it('flags a checkpoint that disagrees with the accumulated stream text', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('hi'))
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'streamed text' }),
        assistantCheckpoint([{ type: 'text', text: 'something else entirely' }]),
      ])

      expect(mirror.stats.checksumMismatches).toBe(1)
    } finally {
      await dispose()
    }
  })
})

describe('CcMirror pump orderings', () => {
  // Every ordering below is one the Phase 2 pump can really emit but no
  // recorded fixture happened to contain: a followup queued behind a running
  // turn, a turn killed mid-block, a result with no stream events at all, and a
  // session that dies before its turn ever finishes.

  it('records a followup queued mid-turn in the turn that RUNS it, not the one that was open', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('first'))
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'one' }),
        blockStop(0),
      ])
      // A plain send while the turn is running QUEUES (spike 2): it runs as its
      // own later turn, so recording it here would put the prompt before the
      // answer to the PREVIOUS prompt.
      mirror.recordSend(send('second'))
      expect(eventsOfType(session, 'user/message')).toHaveLength(1)

      feed(mirror, [...messageEnd(), result('success')])
      feed(mirror, [
        messageStart({ id: 'msg_second' }),
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'two' }),
        blockStop(0),
        ...messageEnd(),
        result('success'),
      ])

      const users = eventsOfType(session, 'user/message')
      expect(users).toHaveLength(2)
      // Inside turn 2, immediately after its `turn/start`.
      const order = types(session)
      expect(order.indexOf('turn/start', order.indexOf('turn/end'))).toBe(order.lastIndexOf('user/message') - 1)
      // The derived conversation alternates properly: prompt, answer, prompt, answer.
      expect(session.deriveMessages().map(message => message.role)).toEqual([
        'user', 'assistant', 'user', 'assistant',
      ])
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('records a steer in the OPEN turn, because the refold merges both instructions into it', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('first'))
      feed(mirror, [messageStart(), blockStart(0, { type: 'text', text: '' })])
      mirror.recordSend(send('also do this', 'steer'))

      expect(eventsOfType(session, 'user/message')).toHaveLength(2)
      expect(eventsOfType(session, 'turn/start')).toHaveLength(1)
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('keeps the text an interrupted turn had already streamed', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('write a long essay'))
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'partial answer so far' }),
      ])
      // An explicit interrupt: the block never reached `content_block_stop`.
      feed(mirror, [result('error_during_execution', { is_error: true })], { interruptedTurn: true })

      // The message agrees with the chunks already on the surface — an
      // assistant/message that dropped them would contradict its own stream.
      expect(eventsOfType(session, 'assistant/message')[0]?.data.message.content).toEqual([
        { type: 'text', text: 'partial answer so far' },
      ])
      expect(eventsOfType(session, 'turn/end')[0]?.data.reason).toEqual({
        kind: 'aborted', reason: { kind: 'user' },
      })
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('never writes an empty assistant/message, and never a tool/call whose arguments were cut off', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('run something slow'))
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'tool_use', id: 'toolu_cut', name: 'Bash', input: {} }),
        blockDelta(0, { type: 'input_json_delta', partial_json: '{"comm' }),
      ])
      feed(mirror, [result('error_during_execution', { is_error: true })], { interruptedTurn: true })

      // A truncated tool call was never issued to anything: claiming it in the
      // log would leave a call that no result can ever answer.
      expect(eventsOfType(session, 'tool/call')).toHaveLength(0)
      expect(eventsOfType(session, 'assistant/message')).toHaveLength(0)
      expect(mirror.stats.ignored['stream:incomplete-tool-call']).toBe(1)
      expect(mirror.stats.ignored['assistant:empty-call']).toBe(1)
      expect(types(session)).toEqual([
        'turn/start', 'user/message', 'step/start', 'assistant/chunk', 'assistant/chunk',
        'step/end', 'turn/end',
      ])
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('leaves no empty step when a fresh model call is killed before it streams anything', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('go'))
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'a' }),
        blockStop(0),
        ...messageEnd(),
        // The next call opens and is interrupted before its first chunk.
        messageStart({ id: 'msg_second' }),
      ])
      feed(mirror, [result('error_during_execution')], { interruptedTurn: true })

      expect(eventsOfType(session, 'step/start')).toHaveLength(1)
      expect(eventsOfType(session, 'assistant/message')).toHaveLength(1)
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('closes a turn on a result that carried no stream events at all', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('hi'))
      feed(mirror, [result('success')])

      expect(types(session)).toEqual(['turn/start', 'user/message', 'turn/end'])
      expect(mirror.hasOpenTurn).toBe(false)
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('drops a tool_result that arrives after its turn already closed', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('list files'))
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'tool_use', id: 'toolu_late', name: 'Bash', input: {} }),
        blockDelta(0, { type: 'input_json_delta', partial_json: '{}' }),
        blockStop(0),
        ...messageEnd('tool_use'),
        result('success'),
        // dsh clears pending calls at `step/end`; a result arriving after it has
        // nowhere valid to live, so it is counted and dropped rather than forced.
        toolResultMessage([{ type: 'tool_result', tool_use_id: 'toolu_late', content: 'too late' }]),
      ])

      expect(eventsOfType(session, 'tool/result')).toHaveLength(0)
      expect(mirror.stats.ignored['tool-result:orphan']).toBe(1)
      expect(types(session).at(-1)).toBe('turn/end')
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('leaves an inject mid-turn outside the framing entirely', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('go'))
      feed(mirror, [messageStart(), blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'a' })])
      mirror.recordSend(send('a file changed under you', 'inject'))
      feed(mirror, [blockStop(0), ...messageEnd(), result('success')])

      expect(eventsOfType(session, 'turn/start')).toHaveLength(1)
      expect(eventsOfType(session, 'user/message')).toHaveLength(2)
      expect(eventsOfType(session, 'user/message')[1]?.data.source).toMatchObject({ form: 'notice' })
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })
})

describe('CcMirror.finalize', () => {
  it('closes a turn the dead session will never finish, as aborted/disposed', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('long job'))
      feed(mirror, [
        messageStart(),
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'half an answer' }),
      ])
      // The subprocess dies / the session is closed: no result will ever come.
      mirror.finalize()

      expect(mirror.hasOpenTurn).toBe(false)
      expect(mirror.openStep).toBeUndefined()
      expect(eventsOfType(session, 'turn/end')[0]?.data.reason).toEqual({
        kind: 'aborted', reason: { kind: 'disposed' },
      })
      // What it had streamed survives, exactly as on an interrupt.
      expect(eventsOfType(session, 'assistant/message')[0]?.data.message.content).toEqual([
        { type: 'text', text: 'half an answer' },
      ])
      assertFramingInvariants(session)

      // Idempotent, and the log stays appendable: a fresh turn can still open.
      const before = session.events.length
      mirror.finalize()
      expect(session.events.length).toBe(before)
      mirror.recordSend(send('next session, same log'))
      expect(eventsOfType(session, 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })

  it('appends nothing when the session closed between turns', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('hi'))
      feed(mirror, [result('success')])
      const before = session.events.length

      mirror.finalize()
      expect(session.events.length).toBe(before)
    } finally {
      await dispose()
    }
  })

  it('flushes a deferred followup so a prompt the session accepted is never lost', async () => {
    const { session, dispose } = await mountSession()
    try {
      const mirror = new CcMirror(session)
      mirror.recordSend(send('first'))
      feed(mirror, [messageStart(), blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'working' })])
      mirror.recordSend(send('queued behind it'))
      mirror.finalize()

      const users = eventsOfType(session, 'user/message')
      expect(users).toHaveLength(2)
      expect(users[1]?.data.content).toEqual([{ type: 'text', text: 'queued behind it' }])
      // It never ran, so it is recorded AFTER the aborted turn closed, not inside it.
      expect(types(session).at(-1)).toBe('user/message')
      expect(types(session).at(-2)).toBe('turn/end')
      assertFramingInvariants(session)
    } finally {
      await dispose()
    }
  })
})

describe('attachMirror', () => {
  it('is write-only: it drives nothing on the Claude Code session', async () => {
    const { session, dispose } = await mountSession()
    try {
      const listeners: { message?: (envelope: CcMessageEnvelope) => void, send?: (send: CcSendRecord) => void } = {}
      let unsubscribed = 0
      const forbidden: string[] = []
      // Everything a mirror could use to DRIVE Claude Code, made explosive.
      const source = {
        onMessage(listener: (envelope: CcMessageEnvelope) => void) {
          listeners.message = listener
          return () => { unsubscribed += 1 }
        },
        onSend(listener: (record: CcSendRecord) => void) {
          listeners.send = listener
          return () => { unsubscribed += 1 }
        },
        send: () => { forbidden.push('send'); throw new Error('the mirror must not send') },
        interrupt: () => { forbidden.push('interrupt'); throw new Error('the mirror must not interrupt') },
        close: () => { forbidden.push('close'); throw new Error('the mirror must not close') },
        onClose: () => { forbidden.push('onClose'); return () => {} },
      }

      const handle = attachMirror(source, session)
      listeners.send?.(send('hello'))
      listeners.message?.(envelope(result('success')))

      expect(forbidden).toEqual([])
      expect(types(session)).toEqual(['turn/start', 'user/message', 'turn/end'])
      expect(handle.mirror).toBeInstanceOf(CcMirror)

      handle.dispose()
      handle.dispose()
      expect(unsubscribed).toBe(2)
    } finally {
      await dispose()
    }
  })
})
