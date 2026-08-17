/**
 * The golden fixture suite (Stage 2, item 2): replays each fixture recorded by
 * `tests/live/record-fixtures.live.spec.ts` through a REAL `CcMirror` into a
 * REAL in-memory dsh `Session` (a `SessionStore`-backed one, not a recording
 * double), and asserts the exact resulting SKELETON (turn/step framing, message
 * assembly, tool call/result pairing, artifact suppression) plus key payloads.
 *
 * Fully offline: no subprocess, no network. This is the regression net every
 * later phase runs against — a real bug in the mirror's projection fails HERE,
 * against real recorded Claude Code traffic, not just against the hand-written
 * shapes in `mirror-fixtures.ts`.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import { CcMirror } from '@deepseek-ai/dsh-claude-code'
import type { CcMessageEnvelope, CcSendRecord } from '@deepseek-ai/dsh-claude-code'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import type { RecordedFixture } from './fixtures/types.ts'
import { assertChunkIndices, assertFramingInvariants, eventsOfType, skeleton } from './session-assertions.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The dsh session id every replay uses — fixtures carry no real session id (never scrubbed to one). */
const REPLAY_SESSION = SessionId('00000000-0000-4000-8000-000000000000')

/**
 * Load one committed fixture.
 * @param scenario - the fixture's slug (`<scenario>.json` under `tests/fixtures/`).
 * @returns the parsed fixture.
 */
function loadFixture(scenario: string): RecordedFixture {
  const raw = readFileSync(path.join(here, 'fixtures', `${scenario}.json`), 'utf8')
  return JSON.parse(raw) as RecordedFixture
}

/**
 * Mount a real in-memory `SessionStore` and create one session in it — the
 * same real-log pattern `tests/mirror.spec.ts` uses, so a payload dsh would
 * reject fails the replay exactly as it would in production.
 * @returns the session and a disposer for the owning fiber.
 */
async function mountSession(): Promise<{ session: Session, dispose(): Promise<void> }> {
  const ctx = new Context()
  const fiber = await ctx.plugin(SessionStore)
  const store = ctx.get('sessions')
  if (store === undefined) throw new Error('session store did not mount')
  const session = store.create(REPLAY_SESSION)
  return {
    session,
    dispose: async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/**
 * Replay one fixture's interleaved timeline through a fresh `CcMirror`.
 * @param fixture - the loaded fixture.
 * @returns the mirror and the dsh session it wrote into, plus a disposer.
 */
async function replay(fixture: RecordedFixture): Promise<{
  mirror: CcMirror
  session: Session
  dispose(): Promise<void>
}> {
  const { session, dispose } = await mountSession()
  const mirror = new CcMirror(session)
  for (const entry of fixture.entries) {
    if (entry.kind === 'send') {
      const send: CcSendRecord = {
        sessionId: REPLAY_SESSION,
        uuid: entry.send.uuid as CcSendRecord['uuid'],
        mode: entry.send.mode,
        content: entry.send.content,
        sentAt: entry.send.sentAt,
      }
      mirror.recordSend(send)
      continue
    }
    const envelope: CcMessageEnvelope = {
      message: entry.envelope.message,
      meta: {
        sessionId: REPLAY_SESSION,
        receivedAt: 0,
        interruptArtifact: entry.envelope.meta.interruptArtifact,
        interruptedTurn: entry.envelope.meta.interruptedTurn,
        reinit: entry.envelope.meta.reinit,
      },
    }
    mirror.observe(envelope)
  }
  return { mirror, session, dispose }
}

describe('mirror golden replay: plain-text.json', () => {
  it('projects a plain two-sentence answer with no tool traffic', async () => {
    const fixture = loadFixture('plain-text')
    const { mirror, session, dispose } = await replay(fixture)
    try {
      assertFramingInvariants(session)
      assertChunkIndices(session)
      expect(skeleton(session)).toEqual([
        'turn/start',
        'user/message',
        'step/start',
        'assistant/chunk*',
        'assistant/message',
        'step/end',
        'turn/end',
      ])

      // Turn framing (§5.2): exactly one turn, closed as completed.
      expect(eventsOfType(session, 'turn/start')).toHaveLength(1)
      const [turnEnd] = eventsOfType(session, 'turn/end')
      expect(turnEnd?.data.reason).toEqual({ kind: 'completed' })

      // The prompt came from the SEND side, never echoed from the SDK stream.
      const [user] = eventsOfType(session, 'user/message')
      expect(user?.data.content).toEqual([{ type: 'text', text: fixture.entries[0]?.kind === 'send' ? fixture.entries[0].send.content : undefined }])
      expect(user?.data.source).toEqual({ kind: 'plugin', plugin: 'dsh-claude-code' })

      // Exactly one assembled assistant message, built from >= 1 accumulated chunks.
      const [message] = eventsOfType(session, 'assistant/message')
      expect(message?.data.message.content.length).toBeGreaterThan(0)
      expect(message?.data.message.content.every(block => block.type === 'text' || block.type === 'reasoning')).toBe(true)
      expect(message?.data.message.source).toEqual({
        kind: 'model', provider: 'claude-code', model: fixture.model,
      })
      expect(message?.sourceEventSeqs).toEqual(eventsOfType(session, 'assistant/chunk').map(event => event.seq))

      // No tool traffic in this scenario.
      expect(eventsOfType(session, 'tool/call')).toHaveLength(0)
      expect(eventsOfType(session, 'tool/result')).toHaveLength(0)

      // No suppressed artifacts, no checksum drift against the checkpoint messages.
      expect(mirror.stats.ignored['result:interrupt-artifact']).toBeUndefined()
      expect(mirror.stats.checksumMismatches).toBe(0)
      expect(mirror.hasOpenTurn).toBe(false)
    } finally {
      await dispose()
    }
  })
})

describe('mirror golden replay: tool-call.json', () => {
  it('pairs one Bash tool_use with its tool_result, inside the step that requested it', async () => {
    const fixture = loadFixture('tool-call')
    const { mirror, session, dispose } = await replay(fixture)
    try {
      assertFramingInvariants(session)
      assertChunkIndices(session)
      expect(skeleton(session)).toEqual([
        'turn/start',
        'user/message',
        'step/start',
        'assistant/chunk*',
        'assistant/message',
        'tool/call',
        'tool/result',
        'step/end',
        'step/start',
        'assistant/chunk*',
        'assistant/message',
        'step/end',
        'turn/end',
      ])

      // Exactly one CC turn maps to one dsh turn with TWO steps (§5.2): one
      // model call requests the tool, the SECOND model call reports on it.
      expect(eventsOfType(session, 'turn/start')).toHaveLength(1)
      expect(eventsOfType(session, 'step/start')).toHaveLength(2)
      const [turnEnd] = eventsOfType(session, 'turn/end')
      expect(turnEnd?.data.reason).toEqual({ kind: 'completed' })

      // Tool call/result pairing: key payloads.
      const [call] = eventsOfType(session, 'tool/call')
      const [result] = eventsOfType(session, 'tool/result')
      expect(call?.data.name).toBe('Bash')
      expect(JSON.parse(call?.data.arguments ?? '{}')).toMatchObject({ command: expect.stringContaining('echo') })
      expect(result?.data.message.source.callId).toBe(call?.data.callId)
      expect(result?.data.message.content).toEqual([{
        type: 'tool-result',
        toolCallId: call?.data.callId,
        isError: false,
        content: [{ type: 'text', text: 'fixture-hello' }],
      }])
      expect(result?.data.turn).toBe(call?.data.turn)
      expect(result?.data.step).toBe(call?.data.step)

      // The mirror's cc-tool_use-id <-> dsh-CallId correlation (Phase 4's ask router needs this).
      expect(call?.data.callId).toBeDefined()
      if (call?.data.callId !== undefined) {
        expect(mirror.toolUseIdFor(call.data.callId)).toBeDefined()
        expect(mirror.callIdFor(mirror.toolUseIdFor(call.data.callId) ?? '')).toBe(call.data.callId)
      }

      // The FINAL assistant message reports the tool's output back to the user.
      const messages = eventsOfType(session, 'assistant/message')
      expect(messages).toHaveLength(2)
      const final = messages[1]
      expect(final?.data.message.content.some(
        block => block.type === 'text' && block.text.toLowerCase().includes('fixture-hello'))).toBe(true)

      expect(mirror.stats.checksumMismatches).toBe(0)
      expect(mirror.hasOpenTurn).toBe(false)
    } finally {
      await dispose()
    }
  })
})

describe('mirror golden replay: steer.json', () => {
  it('suppresses the interrupt artifact entirely and closes ONE completed turn', async () => {
    const fixture = loadFixture('steer')
    const { mirror, session, dispose } = await replay(fixture)
    try {
      assertFramingInvariants(session)
      // The interrupted call's own block-start (opened before the abort) is
      // discarded by the mirror WITH its matching close — no dangling index.
      assertChunkIndices(session)

      // Exactly ONE turn/start and ONE turn/end reach the log: the aborted
      // turn's `error_during_execution` result is an internal artifact of the
      // refold (spike 2) and must produce NO framing events at all.
      expect(eventsOfType(session, 'turn/start')).toHaveLength(1)
      expect(eventsOfType(session, 'turn/end')).toHaveLength(1)
      const [turnEnd] = eventsOfType(session, 'turn/end')
      expect(turnEnd?.data.reason).toEqual({ kind: 'completed' })

      // BOTH the original send and the steer send are recorded as user/message,
      // inside the SAME (only) turn.
      const users = eventsOfType(session, 'user/message')
      expect(users).toHaveLength(2)
      expect(users[1]?.data.content).toEqual([{ type: 'text', text: 'Also say BANANA at the end.' }])

      // Artifact suppression: the mirror counted exactly one suppressed result,
      // and it appended NOTHING for it (no stray turn/step/message from the
      // aborted attempt).
      expect(mirror.stats.ignored['result:interrupt-artifact']).toBe(1)

      // The fresh `system/init` the SDK sends after every interrupted turn
      // (spike 3) produced NO framing events either — it only re-caches state.
      expect(mirror.stats.ignored['system:init']).toBe(2)

      // The refolded turn's final message carries BOTH original instructions.
      const [message] = eventsOfType(session, 'assistant/message')
      const text = message?.data.message.content
        .filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('')
      expect(text ?? '').toContain('BANANA')

      expect(mirror.hasOpenTurn).toBe(false)
      expect(mirror.openStep).toBeUndefined()
    } finally {
      await dispose()
    }
  })
})

describe('mirror golden replay: fixture hygiene', () => {
  it.each(['plain-text', 'tool-call', 'steer'])('%s.json is secrets-free after scrubbing', (scenario) => {
    const raw = readFileSync(path.join(here, 'fixtures', `${scenario}.json`), 'utf8')
    // No real uuid survives scrubbing (the scrubber's own placeholders use a
    // `-scrubbed-` infix that this pattern deliberately excludes), no absolute
    // home-directory path, and no live API key shape.
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(raw).not.toMatch(/\/Users\/[a-zA-Z0-9_.-]+/)
    expect(raw).not.toMatch(/sk-ant-[A-Za-z0-9_-]+/)
  })
})
