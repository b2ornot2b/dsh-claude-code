import type { CcMessageEnvelope } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

import {
  disposeLive, LIVE, LIVE_TIMEOUT_MS, mountLive, onceMessage, removeCwd, resultText, tmpCwd, waitUntil,
} from './helpers.ts'

/**
 * Live coverage item 3: steer mid-turn (spike 2's abort-and-refold). The
 * running turn dies with a flagged `error_during_execution` artifact, then ONE
 * fresh turn runs both instructions and its result carries BOTH — exactly one
 * UNflagged result reaches `waitForResult`/`lastResult`.
 */
describe.skipIf(!LIVE)('CcSession live: steer (DSH_CC_LIVE=1)', () => {
  it(
    'flags the abort artifact, folds BANANA into the merged result, exactly one unflagged result',
    async () => {
      const cwd = tmpCwd('steer')
      const mounted = await mountLive()
      const { service } = mounted
      try {
        const snap = await service.open({ cwd })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        const results: CcMessageEnvelope[] = []
        session.onMessage((envelope) => {
          if (envelope.message.type === 'result') results.push(envelope)
        })

        session.send('Count from 1 to 30, one number per line, then say DONE.')
        // Wait for partials to actually be flowing before steering, so the
        // steer really lands mid-turn (spike 2's scenario) rather than before
        // the turn has even started producing output.
        await onceMessage(session, envelope => envelope.message.type === 'stream_event', 60_000)

        session.send('Also say BANANA at the end.', { mode: 'steer' })

        await waitUntil(() => results.length, count => count >= 2, LIVE_TIMEOUT_MS, 50)

        expect(results).toHaveLength(2)
        const [aborted, final] = results

        expect(aborted?.message.subtype).toBe('error_during_execution')
        expect(aborted?.meta.interruptArtifact).toBe(true)

        expect(final?.meta.interruptArtifact).toBe(false)
        expect(final?.message.subtype).toBe('success')
        expect(resultText(final?.message ?? { type: 'result' }).toUpperCase()).toContain('BANANA')

        // Exactly one UNflagged result reaches the public surface.
        expect(results.filter(envelope => !envelope.meta.interruptArtifact)).toHaveLength(1)
        // The flagged artifact must never become lastResult/waitForResult's answer.
        expect(session.lastResult?.meta.interruptArtifact).toBe(false)
        await expect(session.waitForResult(1_000)).resolves.toMatchObject({ meta: { interruptArtifact: false } })

        expect(session.status).toBe('idle')
      } finally {
        await disposeLive(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
