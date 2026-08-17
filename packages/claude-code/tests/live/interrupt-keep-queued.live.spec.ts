import { realBackend } from '@deepseek-ai/dsh-claude-code'
import type { CcMessageEnvelope } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

import {
  disposeLive, LIVE, LIVE_TIMEOUT_MS, mountLive, onceMessage, removeCwd, resultText, SEND_SETTLE_MS, sleep,
  tmpCwd, wrapBackendCounts, waitUntil,
} from './helpers.ts'

/**
 * Live coverage item 4: `interrupt({ keepQueued: true })` (spike 3). Two
 * uuid-stamped followups queued mid-turn survive the interrupt, are reported
 * in the receipt's `still_queued`, and then run as ONE coalesced next turn.
 */
describe.skipIf(!LIVE)('CcSession live: interrupt keepQueued:true (DSH_CC_LIVE=1)', () => {
  it(
    'receipt matches the two queued uuids; the coalesced turn then runs and commits both',
    async () => {
      const cwd = tmpCwd('interrupt-keep')
      const spy = wrapBackendCounts(realBackend)
      const mounted = await mountLive({}, { backend: spy.backend })
      const { service } = mounted
      try {
        const snap = await service.open({ cwd })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        const results: CcMessageEnvelope[] = []
        session.onMessage((envelope) => {
          if (envelope.message.type === 'result') results.push(envelope)
        })

        session.send('Count from 1 to 200, one number per line, then say DONE.')
        // Wait for a partial token, not a completed block: haiku on a small
        // counting task can finish an entire turn in a couple of seconds, so
        // waiting for a completed 'assistant' checkpoint risks missing the
        // running window entirely (spike 6: assistant messages are
        // block-completion checkpoints, not "output has started" signals).
        await onceMessage(session, envelope => envelope.message.type === 'stream_event', 60_000)

        const uuidApple = session.send('Say APPLE.')
        const uuidPear = session.send('Say PEAR.')
        await sleep(SEND_SETTLE_MS)

        const outcome = await session.interrupt({ keepQueued: true })
        expect(outcome.receiptSupported).toBe(true)
        expect([...outcome.stillQueued].sort()).toEqual([uuidApple, uuidPear].sort())
        expect(outcome.cancelled).toEqual([])

        // The interrupted turn's own error result, then the coalesced queued
        // turn's success result — status only settles back to idle once both
        // have been observed by the pump.
        await waitUntil(() => session.status, status => status === 'idle', LIVE_TIMEOUT_MS, 100)

        expect(results.length).toBeGreaterThanOrEqual(2)
        // Spike 3: the interrupted turn ends with its OWN error_during_execution
        // result. It is flagged as a turn we cancelled — never as a failed turn —
        // but it is not suppressed the way a steer's artifact is: with nothing
        // queued behind an interrupt it is the only signal the turn ended.
        for (const envelope of results) {
          if (envelope.message.subtype !== 'error_during_execution') continue
          expect(envelope.meta.interruptedTurn).toBe(true)
          expect(envelope.meta.interruptArtifact).toBe(false)
        }
        const last = results.at(-1)
        expect(last?.message.subtype).toBe('success')
        expect(resultText(last?.message ?? { type: 'result' }).toUpperCase()).toContain('APPLE')

        const states = new Map(session.outbox().map(entry => [entry.uuid, entry.state]))
        expect(states.get(uuidApple)).toBe('committed')
        expect(states.get(uuidPear)).toBe('committed')
        expect([...states.values()].every(state => state === 'committed')).toBe(true)
      } finally {
        await disposeLive(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
