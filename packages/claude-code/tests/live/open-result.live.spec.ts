import type { CcSessionStatus } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

import {
  disposeLive, LIVE, LIVE_MODEL, LIVE_TIMEOUT_MS, mountLive, removeCwd, tmpCwd, waitUntil,
} from './helpers.ts'

/**
 * Live coverage item 1: open a real session, send one turn, watch the whole
 * status machine, and confirm the initialize handshake cached real data.
 */
describe.skipIf(!LIVE)('CcSession live: open -> send -> result (DSH_CC_LIVE=1)', () => {
  it(
    'observes starting -> idle -> running -> idle and caches commands/models/account',
    async () => {
      const cwd = tmpCwd('open-result')
      const mounted = await mountLive()
      const { service } = mounted
      try {
        // Do not await yet: the registry entry appears (status 'starting')
        // before the real subprocess finishes its cold init, and that window
        // is the only place 'starting' is observable from outside the actor.
        const openPromise = service.open({ cwd })
        const duringOpen = await waitUntil<CcSessionStatus | undefined>(
          () => service.list()[0]?.status,
          status => status !== undefined,
          10_000, 10)
        expect(duringOpen).toBe('starting')

        const snap = await openPromise
        expect(snap.status).toBe('idle')
        expect(snap.model).toBe(LIVE_MODEL)

        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')
        expect(session.status).toBe('idle')

        session.send('Reply only OK.')
        // The status flips synchronously the moment send() returns.
        expect(session.status).toBe('running')

        const envelope = await session.waitForResult(LIVE_TIMEOUT_MS)
        expect(envelope.message.type).toBe('result')
        expect(envelope.message.subtype).toBe('success')
        expect(envelope.meta.sessionId).toBe(session.id)
        expect(session.status).toBe('idle')

        const init = session.initializeResult
        expect(init).toBeDefined()
        expect(Array.isArray(init?.commands)).toBe(true)
        expect(init?.commands.length ?? 0).toBeGreaterThan(0)
        expect(Array.isArray(init?.models)).toBe(true)
        expect(init?.models.length ?? 0).toBeGreaterThan(0)
        expect(init?.account).toBeTruthy()
        expect(session.account).toBeTruthy()
      } finally {
        await disposeLive(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
