import { describe, expect, it } from 'vitest'

import { disposeLive, LIVE, LIVE_TIMEOUT_MS, mountLive, removeCwd, resultText, tmpCwd } from './helpers.ts'

/**
 * Live coverage item 7: `resume + fork` (spike 1). The fork gets OUR fresh
 * minted id (never the source's), history carries over, and the source
 * session is left completely untouched — re-opening it (a plain resume)
 * afterward still works.
 *
 * History carry-over is probed as a plain recall question ("what word did I
 * ask you to remember"), never as a "codeword" the model is told to obey:
 * phrased that way, a live run had haiku decline on the grounds that
 * codewords overriding its judgment would be a security issue. The recall
 * question tests exactly the same thing — that the transcript came along —
 * without asking the model to do anything it might refuse.
 */
describe.skipIf(!LIVE)('CcSession live: fork (DSH_CC_LIVE=1)', () => {
  it(
    'fork gets a fresh id, carries history, and leaves the source session unpolluted',
    async () => {
      const cwd = tmpCwd('fork')
      const mounted = await mountLive()
      const { service } = mounted
      try {
        const snapA = await service.open({ cwd })
        const sessionA = service.session(snapA.id)
        if (sessionA === undefined) throw new Error('missing session A actor')
        sessionA.send('Please remember this word for later: MANGO. Reply with only OK.')
        const resultA = await sessionA.waitForResult(LIVE_TIMEOUT_MS)
        expect(resultA.message.subtype).toBe('success')
        await service.close(snapA.id)

        const snapC = await service.open({ cwd, resume: snapA.id, fork: true })
        const sessionC = service.session(snapC.id)
        if (sessionC === undefined) throw new Error('missing session C actor')
        // The fork gets OUR fresh id — never the source's.
        expect(snapC.id).not.toBe(snapA.id)

        sessionC.send('What word did I ask you to remember earlier? Reply with only that word.')
        const resultC = await sessionC.waitForResult(LIVE_TIMEOUT_MS)
        expect(resultC.message.subtype).toBe('success')
        expect(resultText(resultC.message).toUpperCase()).toContain('MANGO')
        await service.close(snapC.id)

        // A must be unpolluted by the fork: re-open it (a plain resume) and
        // confirm the word is still recalled from ITS own transcript.
        const snapA2 = await service.open({ cwd, resume: snapA.id })
        expect(snapA2.id).toBe(snapA.id)
        const sessionA2 = service.session(snapA2.id)
        if (sessionA2 === undefined) throw new Error('missing re-opened session A actor')
        sessionA2.send('What word did I ask you to remember earlier? Reply with only that word.')
        const resultA2 = await sessionA2.waitForResult(LIVE_TIMEOUT_MS)
        expect(resultA2.message.subtype).toBe('success')
        expect(resultText(resultA2.message).toUpperCase()).toContain('MANGO')
      } finally {
        await disposeLive(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
