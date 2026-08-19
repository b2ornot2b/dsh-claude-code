import { describe, expect, it } from 'vitest'

import {
  countSessionProcesses, LIVE, LIVE_TIMEOUT_MS, mountLive, removeCwd, tmpCwd, waitForSessionProcessCount,
} from './helpers.ts'

/**
 * Live coverage item 8: disposing the plugin fiber (HMR-safety, the pattern
 * `tests/service.spec.ts` proves offline) must actually kill the real
 * subprocess, not just flip in-memory bookkeeping.
 *
 * Scoped to THIS session's own subprocess (`--session-id=<uuid>` in its argv),
 * not to a whole-machine count: the nine live specs run in parallel, so a
 * before/after delta around this test reads a neighbour's healthy session as
 * this test's orphan — which is exactly how a run of this file failed with
 * `expected 2 to be less than or equal to 0`, both of those processes being
 * other specs' sessions.
 */
describe.skipIf(!LIVE)('CcSession live: teardown (DSH_CC_LIVE=1)', () => {
  it(
    'disposing the service fiber closes the session and leaves no orphan subprocess',
    async () => {
      const cwd = tmpCwd('teardown')
      const mounted = await mountLive({ prewarm: false })
      const { ctx, fiber, service } = mounted
      try {
        const snap = await service.open({ cwd })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        // Exactly one subprocess, and it is unambiguously this session's.
        expect(await countSessionProcesses(snap.id)).toBe(1)
        expect(session.status).not.toBe('closed')

        await fiber.dispose()
        await ctx.fiber.dispose()

        expect(session.status).toBe('closed')
        expect(service.session(snap.id)).toBeUndefined()

        // Subprocess exit has a documented ~2s stdin-EOF grace period.
        expect(await waitForSessionProcessCount(snap.id, 0, 15_000)).toBe(0)
      } finally {
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
