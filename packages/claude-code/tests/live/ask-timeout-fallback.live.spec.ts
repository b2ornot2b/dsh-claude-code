/**
 * The ask channel's timeout + fallback path (§4.6), LIVE, plus the
 * `pendingAsks` snapshot contract that idempotency (§4.6's last bullet)
 * depends on — a REAL Claude Code subprocess whose answerer never resolves.
 *
 * Scenario one: a delegated target (`delegated: true`) selects
 * `ask.delegatedTimeoutMs`; a `ctx.approval` provider that never settles means
 * the ask can only be resolved by the table's own timeout, which applies the
 * configured fallback policy (`'deny'`, the default) — asserted to settle
 * within budget, deny the tool call (no file), and leave `pendingAsks` back at
 * zero with the session closing clean afterward.
 *
 * Scenario two covers the live half of item 5 in the Stage 2 brief (redelivery
 * itself is offline-only — triggering `reinitialize()` live is not cheap): a
 * provider that resolves after a 3s delay, polled DURING that delay to prove
 * `ClaudeCodeService.get(id)?.pendingAsks` genuinely tracks an in-flight ask
 * rather than reading a value that was already stale.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'

import {
  disposeLiveWithAsk, LIVE, LIVE_TIMEOUT_MS, mountLiveWithAsk, registerLiveRootAgent, removeCwd, sleep,
  tmpCwd, waitUntil,
} from './helpers.ts'

/** The configured delegated-ask timeout for scenario one (task-specified). */
const DELEGATED_TIMEOUT_MS = 15_000

describe.skipIf(!LIVE)('ask channel — timeout + fallback, live (§4.6, DSH_CC_LIVE=1)', () => {
  it(
    'settles via the fallback deny once ask.delegatedTimeoutMs elapses with no answer, and closes clean',
    async () => {
      const cwd = tmpCwd('ask-timeout-fallback')
      const mounted = await mountLiveWithAsk({ ask: { delegatedTimeoutMs: DELEGATED_TIMEOUT_MS } })
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })
        // Never resolves: the only thing that can settle this ask is the table's timeout.
        const off = ctx.on('approval/request', async () => await new Promise<ApprovalOutcome>(() => {}))

        const target = join(cwd, 'timed-out.txt')
        const snap = await service.open({
          cwd,
          ask: { agent: root.agent, delegated: true },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        const startedAt = Date.now()
        session.send(
          `Use the Bash tool to run exactly: touch ${target}\n`
          + 'Then reply with one short sentence about what happened.')
        await session.waitForResult(LIVE_TIMEOUT_MS)
        const elapsedMs = Date.now() - startedAt

        // Within budget: at least the configured wait, comfortably inside the
        // test's own hard timeout — not hung, not answered early by anything else.
        expect(elapsedMs).toBeGreaterThanOrEqual(DELEGATED_TIMEOUT_MS - 1_000)
        expect(elapsedMs).toBeLessThan(LIVE_TIMEOUT_MS)

        expect(existsSync(target)).toBe(false)
        expect(session.pendingAsks).toBe(0)
        expect(service.get(snap.id)?.pendingAsks).toBe(0)

        off()
        // Closing must not hang: no promise is left waiting on an answer that
        // will never come.
        const closed = await service.close(snap.id)
        expect(closed).toBe(true)
        expect(service.get(snap.id)).toBeUndefined()
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'pendingAsks in the service snapshot tracks a real in-flight ask while a scripted answerer is still deciding',
    async () => {
      const cwd = tmpCwd('ask-pending-snapshot')
      const mounted = await mountLiveWithAsk()
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })
        const off = ctx.on('approval/request', async () => {
          await sleep(3_000)
          return 'allowed-once'
        })

        const target = join(cwd, 'delayed.txt')
        const snap = await service.open({
          cwd,
          ask: { agent: root.agent, delegated: false },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        // Before the send, nothing is pending.
        expect(service.get(snap.id)?.pendingAsks).toBe(0)

        session.send(
          `Use the Bash tool to run exactly: touch ${target}\n`
          + 'Then reply with one short sentence about what happened.')

        // Poll for the ask to appear in flight. The 3s answerer delay is the
        // FLOOR of the pending window, not the ceiling: cold subprocess start
        // plus the first model round-trip (spike 5: ~2s dominated by the model,
        // more on a cold session) happens BEFORE Claude even calls Bash and
        // canUseTool fires, so the window this polls for must be generous —
        // the assertion is "it was seen pending at some point", not "it was
        // seen within 3s of send()".
        const observedPending = await waitUntil(
          () => service.get(snap.id)?.pendingAsks ?? 0,
          count => count > 0,
          30_000,
          50,
        )
        expect(observedPending).toBeGreaterThan(0)

        await session.waitForResult(LIVE_TIMEOUT_MS)

        expect(existsSync(target)).toBe(true)
        expect(service.get(snap.id)?.pendingAsks).toBe(0)
        off()
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
