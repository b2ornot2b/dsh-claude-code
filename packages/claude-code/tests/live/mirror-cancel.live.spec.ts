/**
 * The mirror's live cancellation coverage (Stage 3): the two framing paths that
 * only exist because a turn can END WITHOUT A NORMAL RESULT, and which no
 * recorded fixture contains because a fixture is a completed transcript.
 *
 * 1. `interrupt()` mid-turn — the model call is killed with its content block
 *    still open. The chunks it streamed are already on the surface, so the
 *    assembled `assistant/message` must carry that same text rather than
 *    contradicting it (or, worse, being empty), and the turn must close as
 *    `aborted`, never as an error.
 * 2. `close()` mid-turn — no result is ever emitted, so nothing would close the
 *    dsh turn. `ClaudeCodeService` calls `mirror.finalize()` on session close;
 *    without it the log keeps a dangling `turn/start` and can never be appended
 *    to again (dsh refuses a second open turn).
 *
 * Both assert against a REAL `SessionStore` session written by a REAL live
 * Claude Code subprocess.
 */

import type { CcMessageEnvelope } from '@deepseek-ai/dsh-claude-code'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import { assertFramingInvariants, eventsOfType } from '../session-assertions.ts'
import {
  disposeLiveWithStore, LIVE, LIVE_TIMEOUT_MS, mountLiveWithStore, onceMessage, removeCwd,
  tmpCwd, waitUntil,
} from './helpers.ts'

/** A prompt long enough that a haiku turn is reliably still running a second in. */
const LONG_PROMPT = 'Count from 1 to 200, one number per line, then say DONE.'

/**
 * Whether one envelope is a partial-message TEXT delta — the signal that the
 * model call has an open block with real content in it.
 * @param envelope - the fanned-out message.
 * @returns true for a `content_block_delta` carrying a `text_delta`.
 */
function isTextDelta(envelope: CcMessageEnvelope): boolean {
  if (envelope.message.type !== 'stream_event') return false
  const event = envelope.message['event'] as { type?: unknown, delta?: { type?: unknown } } | undefined
  return event?.type === 'content_block_delta' && event.delta?.type === 'text_delta'
}

describe.skipIf(!LIVE)('mirror live cancellation: a turn that never gets a normal result (DSH_CC_LIVE=1)', () => {
  it(
    'closes an interrupted turn as aborted and keeps the text it had already streamed',
    async () => {
      const cwd = tmpCwd('mirror-interrupt')
      const mounted = await mountLiveWithStore()
      const { service, store } = mounted
      try {
        const log = store.create(SessionId('33333333-4444-4555-8666-777777777777'))
        const snap = await service.open({ cwd, mirror: { session: log } })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(LONG_PROMPT)
        // Wait for a TEXT DELTA specifically, not just any stream event: the
        // point of this test is a block that is open AND has already streamed
        // real text when the interrupt lands, which is what makes the salvage
        // path observable rather than incidental.
        await onceMessage(session, isTextDelta, 60_000)
        await session.interrupt()
        await waitUntil(() => session.status, status => status === 'idle', LIVE_TIMEOUT_MS, 100)

        assertFramingInvariants(log)
        const [turnEnd] = eventsOfType(log, 'turn/end')
        expect(turnEnd?.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })

        // Every text delta that reached the surface is also in the assembled
        // message: the killed call's open block is salvaged, so the message
        // cannot contradict the chunk stream that precedes it.
        const streamed = eventsOfType(log, 'assistant/chunk')
          .map(event => event.data.chunk)
          .filter(chunk => chunk.type === 'text-delta')
          .map(chunk => chunk.type === 'text-delta' ? chunk.text : '')
          .join('')
        expect(streamed).not.toBe('')
        const messages = eventsOfType(log, 'assistant/message')
        const assembled = messages
          .flatMap(message => message.data.message.content)
          .filter(block => block.type === 'text')
          .map(block => block.type === 'text' ? block.text : '')
          .join('')
        expect(assembled).toContain(streamed)
        // No assistant message is ever empty — an empty-content assistant
        // message is not a valid provider message.
        for (const message of messages) expect(message.data.message.content.length).toBeGreaterThan(0)
      } finally {
        await disposeLiveWithStore(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'closes a turn the session died in, so the log stays appendable',
    async () => {
      const cwd = tmpCwd('mirror-finalize')
      const mounted = await mountLiveWithStore()
      const { service, store } = mounted
      try {
        const log = store.create(SessionId('44444444-5555-4666-8777-888888888888'))
        const snap = await service.open({ cwd, mirror: { session: log } })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(LONG_PROMPT)
        await onceMessage(session, envelope => envelope.message.type === 'stream_event', 60_000)
        // Close the session OUTRIGHT, mid-turn: no result will ever arrive.
        await service.close(snap.id)

        assertFramingInvariants(log)
        expect(eventsOfType(log, 'turn/start')).toHaveLength(1)
        const [turnEnd] = eventsOfType(log, 'turn/end')
        expect(turnEnd?.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'disposed' } })

        // The log is still usable: a fresh turn can open on it, which a dangling
        // `turn/start` would have made impossible forever.
        log.append('turn/start', { turn: 2 })
        log.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
        assertFramingInvariants(log)
      } finally {
        await disposeLiveWithStore(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
