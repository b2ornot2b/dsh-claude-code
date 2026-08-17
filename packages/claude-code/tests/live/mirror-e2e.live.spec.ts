/**
 * The mirror's live end-to-end suite (Stage 2, item 3): boots the SAME
 * composition shape as `tests/composition/` (a real cordis `Context`, a REAL
 * `SessionStore`, a real `ClaudeCodeService` — see
 * `tests/live/helpers.ts`'s `mountLiveWithStore`), opens a live session with
 * the mirror attached to a store-created dsh session, runs scenario (b) — one
 * Bash tool call under a hardcoded `canUseTool` allow — LIVE, then asserts on
 * the REAL resulting dsh session:
 *
 * - `hasOpenTurn` is false once the session goes idle.
 * - `deriveMessages()` returns a coherent `Message[]` (user, assistant, tool
 *   call/result all present and in order).
 * - the event sequence passes the same relational invariants the golden suite
 *   checks (`assertFramingInvariants`).
 * - the mirrored log survives a JSON round trip (the lossless-JSON rule): a
 *   `JSON.parse(JSON.stringify(...))` clone of the events restores through
 *   `Session.fromRestore` into a session with an IDENTICAL derived history.
 */

import type { CcCanUseTool } from '@deepseek-ai/dsh-claude-code'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import { assertFramingInvariants, eventsOfType, types } from '../session-assertions.ts'
import {
  disposeLiveWithStore, LIVE, LIVE_TIMEOUT_MS, mountLiveWithStore, removeCwd, tmpCwd,
} from './helpers.ts'

/** Allows every tool call unconditionally, matching the fixture recorder's scenario (b). */
const allowAll: CcCanUseTool = async (_toolName, input) =>
  await Promise.resolve({ behavior: 'allow', updatedInput: input })

describe.skipIf(!LIVE)('mirror live end-to-end: real composition + real dsh session (DSH_CC_LIVE=1)', () => {
  it(
    'mirrors one live Bash tool call into a real dsh Session that round-trips losslessly',
    async () => {
      const cwd = tmpCwd('mirror-e2e')
      const mounted = await mountLiveWithStore({}, { canUseTool: allowAll })
      const { service, store } = mounted
      try {
        // A REAL dsh session, created through the store exactly as a
        // deployment would — this is the target `attachMirror`/
        // `open({ mirror })` write into, never a recording double.
        const log = store.create(SessionId('11111111-2222-4333-8444-555555555555'))

        const snap = await service.open({
          cwd,
          mirror: { session: log },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(
          'Use the Bash tool to run `echo e2e-fixture-hello` and then tell me exactly what it printed, '
          + 'in one short sentence.')
        await session.waitForResult(LIVE_TIMEOUT_MS)

        // --- assertions on the REAL dsh session -----------------------------

        expect(session.status).toBe('idle')
        assertFramingInvariants(log)

        // Turn framing: one completed turn, no dangling step.
        expect(eventsOfType(log, 'turn/start')).toHaveLength(1)
        const [turnEnd] = eventsOfType(log, 'turn/end')
        expect(turnEnd?.data.reason).toEqual({ kind: 'completed' })

        // Tool call/result pairing: the mirror actually saw the live Bash call.
        const [call] = eventsOfType(log, 'tool/call')
        const [result] = eventsOfType(log, 'tool/result')
        expect(call?.data.name).toBe('Bash')
        expect(result?.data.message.source.callId).toBe(call?.data.callId)

        // `deriveMessages()`: a coherent Message[] — user, assistant, tool
        // call/result all present and in order. dsh derives one message per
        // ASSEMBLED assistant/tool-result event (not per raw chunk), so this
        // is small even though the raw log carries dozens of `assistant/chunk`
        // entries.
        const messages = log.deriveMessages()
        expect(messages.length).toBeGreaterThanOrEqual(3)
        expect(messages[0]?.role).toBe('user')
        expect(messages[0]?.source).toEqual({ kind: 'plugin', plugin: 'dsh-claude-code' })
        expect(messages.some(message => message.role === 'assistant')).toBe(true)
        // A tool result is a user-role message carrying `source.kind === 'tool'`
        // (dsh represents tool results as a specialization of user-role, not a
        // separate `role`) — the mirror's own convention, verified structurally
        // by `assertFramingInvariants` above and semantically here.
        expect(messages.some(message => message.source.kind === 'tool')).toBe(true)
        // Ordering: the user prompt comes first, and the tool result never
        // precedes the assistant message whose tool-call it answers.
        const firstToolIndex = messages.findIndex(message => message.source.kind === 'tool')
        const firstAssistantIndex = messages.findIndex(message => message.role === 'assistant')
        expect(firstAssistantIndex).toBeGreaterThanOrEqual(0)
        expect(firstToolIndex).toBeGreaterThan(firstAssistantIndex)

        // --- the JSON round trip (lossless-JSON rule) -----------------------

        // No `claude-code/compact` event landed in a tiny two-step session, so
        // this real dsh log is exactly the kind of log a stock harness build
        // can restore without the `ignorable` marker gap (mirror.ts's own
        // documented caveat) ever coming into play.
        expect(log.events.some(event => event.type === 'claude-code/compact')).toBe(false)

        const clonedEvents = JSON.parse(JSON.stringify(log.events)) as typeof log.events
        const clonedHeader = JSON.parse(JSON.stringify(log.header)) as typeof log.header
        const restored = Session.fromRestore(log.id, clonedEvents, clonedHeader)

        // `fromRestore` treats its whole seed as history and appends exactly one
        // trailing `session/end-seed` marker (`Session`'s constructor is the
        // only legitimate writer of that event) — everything BEFORE it must be
        // byte-identical to what the live mirror actually wrote.
        expect(restored.events.at(-1)?.type).toBe('session/end-seed')
        expect(types(restored).slice(0, -1)).toEqual(types(log))
        expect(restored.events.slice(0, -1)).toEqual(log.events)
        expect(restored.deriveMessages()).toEqual(log.deriveMessages())
        assertFramingInvariants(restored)
      } finally {
        await disposeLiveWithStore(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
