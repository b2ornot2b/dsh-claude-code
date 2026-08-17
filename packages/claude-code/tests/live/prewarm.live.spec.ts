import { realBackend } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

import {
  disposeLive, LIVE, LIVE_TIMEOUT_MS, mountLive, removeCwd, sleep, tmpCwd,
  waitForSessionProcessCount, waitUntil, wrapBackendCounts,
} from './helpers.ts'

/**
 * Live coverage item 9: `config.prewarm` (spike 5). The pool holds at most
 * one warmed subprocess; an `open()` whose resolved options match it adopts
 * the pool's PRE-MINTED id instead of spawning cold (the id match is the
 * proof: `sessionId`/`canUseTool`/`stderr`/`abortController` are frozen at
 * `startup()`, so a session using a lease's id could only have come from
 * `warm.query()`, never a fresh `backend.query()` call). The pool re-warms
 * after every open, and teardown must close the spare with no orphan.
 */
describe.skipIf(!LIVE)('CcSession live: prewarm (DSH_CC_LIVE=1)', () => {
  it(
    'a matching open consumes the warm handle by id, and the pool re-warms',
    async () => {
      const cwd = tmpCwd('prewarm')
      const spy = wrapBackendCounts(realBackend)
      const mounted = await mountLive({ prewarm: true }, { backend: spy.backend })
      const { service } = mounted
      // Disposal happens INSIDE the test (the orphan assertions come after it)
      // and must not run twice from the safety net in `finally`.
      let disposed = false
      try {
        // Session A: unavoidably cold — a subprocess cannot be warmed before
        // its cwd is known (session.ts's own documented consequence). `open()`
        // fires `void this.pool.prewarm(template)` as its last step, and JS
        // runs an async call synchronously up to its first internal `await`,
        // so `startup()` may already have been INVOKED (not yet resolved) by
        // the time `service.open()`'s own promise settles — hence no
        // assertion on `startupCount` here, only that A's own open was cold.
        const snapA = await service.open({ cwd })
        expect(spy.queryCount).toBe(1)
        await service.close(snapA.id)

        // `spy.startupCount` increments the MOMENT `backend.startup()` is
        // invoked, not once the real subprocess finishes initializing and the
        // pool actually stores the lease (`this.#held`) — so wait for the
        // call, then give the real spawn+init handshake (spike 5: ~300ms)
        // room to complete before relying on the pool actually holding it.
        await waitUntil(() => spy.startupCount, count => count >= 1, 30_000, 200)
        expect(spy.startupCount).toBe(1)
        const warmedSessionId = spy.lastStartupSessionId
        expect(warmedSessionId).toBeDefined()
        await sleep(2_000)

        // Session B: the SAME shape (cwd, model, everything the fingerprint
        // covers) — should consume the warm handle. Proof: its id is the one
        // the pool pre-minted at startup() time, and no second cold query()
        // call was made for it.
        const snapB = await service.open({ cwd })
        expect(snapB.id).toBe(warmedSessionId)
        expect(spy.queryCount).toBe(1)
        await service.close(snapB.id)

        // The pool re-warms for the NEXT open.
        await waitUntil(() => spy.startupCount, count => count >= 2, 30_000, 200)
        expect(spy.startupCount).toBe(2)
        const spareSessionId = spy.lastStartupSessionId
        expect(spareSessionId).toBeDefined()
        expect(spareSessionId).not.toBe(warmedSessionId)

        await disposeLive(mounted)
        disposed = true
        // Teardown must close the SPARE warm subprocess too — the one nobody
        // ever leased. Scoped to its own pre-minted id (see helpers.ts): the
        // nine live specs run in parallel, so a whole-machine count would read
        // a neighbour's healthy session as this test's orphan.
        expect(await waitForSessionProcessCount(spareSessionId ?? '', 0, 15_000)).toBe(0)
        expect(await waitForSessionProcessCount(warmedSessionId ?? '', 0, 15_000)).toBe(0)
        expect(await waitForSessionProcessCount(snapA.id, 0, 15_000)).toBe(0)
      } finally {
        if (!disposed) await disposeLive(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
