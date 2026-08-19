import { describe, expect, it } from 'vitest'

import { disposeLive, LIVE, LIVE_TIMEOUT_MS, mountLive, removeCwd, resultText, tmpCwd } from './helpers.ts'

/**
 * Live coverage item 6: resume (spike 1). Session A establishes a word to
 * recall, closes fully, and session B resumes A's id — continuing under the
 * SAME id and recalling what A established.
 *
 * Phrased as a recall question rather than a "codeword" instruction: a live
 * run had haiku decline the latter as a request to let codewords override its
 * judgment. Recall tests the same transcript continuity with nothing to refuse.
 */
describe.skipIf(!LIVE)('CcSession live: resume (DSH_CC_LIVE=1)', () => {
  it(
    'resume continues under the same session id and recalls state from before close',
    async () => {
      const cwd = tmpCwd('resume')
      const mounted = await mountLive()
      const { service } = mounted
      try {
        const snapA = await service.open({ cwd })
        const sessionA = service.session(snapA.id)
        if (sessionA === undefined) throw new Error('missing session A actor')
        sessionA.send('Please remember this word for later: PLUM. Reply with only OK.')
        const resultA = await sessionA.waitForResult(LIVE_TIMEOUT_MS)
        expect(resultA.message.subtype).toBe('success')

        await service.close(snapA.id)
        expect(service.session(snapA.id)).toBeUndefined()

        const snapB = await service.open({ cwd, resume: snapA.id })
        const sessionB = service.session(snapB.id)
        if (sessionB === undefined) throw new Error('missing session B actor')
        sessionB.send('What word did I ask you to remember earlier? Reply with only that word.')
        const resultB = await sessionB.waitForResult(LIVE_TIMEOUT_MS)
        expect(resultB.message.subtype).toBe('success')

        expect(snapB.id).toBe(snapA.id)
        expect(resultText(resultB.message).toUpperCase()).toContain('PLUM')
      } finally {
        await disposeLive(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
