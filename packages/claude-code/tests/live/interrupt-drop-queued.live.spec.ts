import { realBackend } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

import {
  disposeLive, LIVE, LIVE_TIMEOUT_MS, mountLive, onceMessage, removeCwd, SEND_SETTLE_MS, sleep, tmpCwd,
  wrapBackendInterruptSpy,
} from './helpers.ts'

/**
 * Live coverage item 5: `interrupt({ keepQueued: false })` — the emulated
 * `cancel_queued` (spike 3: SDK 0.3.233 exposes no native way to drive it).
 * The seam marks the survivors cancelled immediately and re-interrupts as
 * each surviving turn starts, capped at `still_queued.length + 2` drain
 * attempts (`session.ts`'s documented cap).
 */
describe.skipIf(!LIVE)('CcSession live: interrupt keepQueued:false (DSH_CC_LIVE=1)', () => {
  it(
    'drains queued followups, marks them cancelled, and never exceeds the drain cap',
    async () => {
      const cwd = tmpCwd('interrupt-drop')
      const spy = wrapBackendInterruptSpy(realBackend)
      const mounted = await mountLive({}, { backend: spy.backend, drainPollMs: 200 })
      const { service } = mounted
      try {
        const snap = await service.open({ cwd })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send('Count from 1 to 200, one number per line, then say DONE.')
        await onceMessage(session, envelope => envelope.message.type === 'stream_event', 60_000)

        const uuidApple = session.send('Say APPLE.')
        const uuidPear = session.send('Say PEAR.')
        await sleep(SEND_SETTLE_MS)

        const outcome = await session.interrupt({ keepQueued: false })

        expect([...outcome.cancelled].sort()).toEqual([uuidApple, uuidPear].sort())
        expect(outcome.stillQueued).toEqual([])

        const states = new Map(session.outbox().map(entry => [entry.uuid, entry.state]))
        expect(states.get(uuidApple)).toBe('cancelled')
        expect(states.get(uuidPear)).toBe('cancelled')
        // Nothing that was cancelled may later flip to committed — a queued
        // turn "completing as success" after the final interrupt would mean
        // the drain emulation lied about what it cancelled.
        await sleep(2_000)
        const statesAfterGrace = new Map(session.outbox().map(entry => [entry.uuid, entry.state]))
        expect(statesAfterGrace.get(uuidApple)).toBe('cancelled')
        expect(statesAfterGrace.get(uuidPear)).toBe('cancelled')

        // 1 explicit interrupt() inside session.interrupt() itself, plus at
        // most `still_queued.length + 2` (= 2 + 2 = 4) drain-loop attempts —
        // the cap session.ts documents and unit-tests against a CLI that
        // never lets go.
        expect(spy.interruptCalls).toBeLessThanOrEqual(1 + 2 + 2)
        expect(spy.interruptCalls).toBeGreaterThanOrEqual(1)
      } finally {
        await disposeLive(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
