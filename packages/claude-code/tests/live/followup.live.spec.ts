import { describe, expect, it } from 'vitest'

import { disposeLive, LIVE, LIVE_TIMEOUT_MS, mountLive, removeCwd, tmpCwd } from './helpers.ts'

/**
 * Live coverage item 2: two sequential followups, each awaited to completion
 * before the next is sent, produce two DISTINCT results and commit the outbox
 * in send order.
 */
describe.skipIf(!LIVE)('CcSession live: followup (DSH_CC_LIVE=1)', () => {
  it(
    'two sequential sends produce two results, outbox committed in order',
    async () => {
      const cwd = tmpCwd('followup')
      const mounted = await mountLive()
      const { service } = mounted
      try {
        const snap = await service.open({ cwd })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        const uuid1 = session.send('Reply with only the word ONE.')
        const result1 = await session.waitForResult(LIVE_TIMEOUT_MS)
        expect(result1.message.type).toBe('result')
        expect(result1.message.subtype).toBe('success')

        const uuid2 = session.send('Reply with only the word TWO.')
        const result2 = await session.waitForResult(LIVE_TIMEOUT_MS)
        expect(result2.message.type).toBe('result')
        expect(result2.message.subtype).toBe('success')
        // Two distinct turns must produce two distinct result messages.
        expect(result2.message.uuid).not.toBe(result1.message.uuid)

        expect(session.outbox()).toEqual([
          { uuid: uuid1, mode: 'followup', sentAt: expect.any(Number) as unknown as number, state: 'committed' },
          { uuid: uuid2, mode: 'followup', sentAt: expect.any(Number) as unknown as number, state: 'committed' },
        ])
        expect(session.status).toBe('idle')
      } finally {
        await disposeLive(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
