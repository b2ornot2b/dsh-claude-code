/**
 * Stage 2 — the spec's §12 "failure injection" list, live (`DSH_CC_LIVE=1`).
 *
 * Everything in `tests/live/` so far exercises COOPERATIVE endings:
 * `interrupt()`, `close()`, a turn that finishes normally. This file is the
 * uncooperative ones — a subprocess that is SIGKILLed out from under a live
 * turn, and an ask whose answer arrives after the request that would have
 * consumed it is already gone — because those are exactly the paths that
 * used to leave `CcSession.status` stuck at `'running'` forever (api-contract
 * correction 42, fixed by Stage 1: pump completion/death now routes through
 * the SAME `close()` an explicit close uses, tagged with a `closeReason`).
 *
 * Scope split across packages, each testing its own seam's guarantee against
 * the SAME kind of subprocess death:
 *
 * - THIS file: the seam itself (`CcSession`/`ClaudeCodeService`) — status,
 *   `closeReason`, pending-ask settlement, `waitForResult` rejection, mirror
 *   finalization. Sub-item (a)'s "with the agent adapter mounted" half lives
 *   in `packages/claude-code-agent/tests/live/agent-kill.live.spec.ts` (a
 *   different package's composition, so it belongs in that package's own
 *   live suite rather than reached into from here).
 * - `packages/tool-claude-code/tests/live/tools-background-kill.live.spec.ts`:
 *   sub-item (b), a backgrounded job's settlement.
 *
 * Every test here asserts zero `unhandledRejection`s via
 * {@link captureUnhandledRejections} — a dead subprocess is exactly the kind
 * of event that used to leave a promise nobody would ever settle.
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { ClaudeCodeError } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

import { assertFramingInvariants, eventsOfType } from '../session-assertions.ts'
import {
  captureUnhandledRejections, disposeLiveWithAsk, killSessionProcess, LIVE, LIVE_TIMEOUT_MS, mountLiveWithAsk,
  registerLiveRootAgent, removeCwd, sleep, tmpCwd, waitForSessionProcessCount, waitUntil,
} from './helpers.ts'

/**
 * A `touch <target>` prompt — the exact shape `ask-timeout-fallback.live.spec.ts`
 * and `tools-background.live.spec.ts` use to reliably trigger a Bash approval
 * prompt. (`sleep N && echo done` was tried first and never triggered
 * `canUseTool` at all — the CLI's own safe-command classifier auto-approves it
 * below the callback, spike 4's documented gotcha; `touch` on an unseen path
 * does not.)
 * @param target - the file path the command touches.
 * @returns the prompt text.
 */
function bashPrompt(target: string): string {
  return `Use the Bash tool to run exactly: touch ${target}\nThen reply with one short sentence about what happened.`
}

describe.skipIf(!LIVE)('failure injection: SIGKILL mid-turn (§12, DSH_CC_LIVE=1)', () => {
  it(
    'a subprocess killed mid-turn with a pending ask reaches status closed/crashed, denies the ask, '
      + 'rejects waitForResult typed, and leaves the mirror finalized and appendable',
    async () => {
      const guard = captureUnhandledRejections()
      const cwd = tmpCwd('kill-mid-turn')
      const mounted = await mountLiveWithAsk()
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })
        // Scripted approval that NEVER resolves — exactly one pending ask,
        // held open until we kill the subprocess out from under it.
        const off = ctx.on('approval/request', async () => await new Promise<ApprovalOutcome>(() => {}))

        const snap = await service.open({
          cwd,
          ask: { agent: root.agent, delegated: false },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(bashPrompt(`${cwd}/kill-mid-turn.txt`))
        await waitUntil(() => session.pendingAsks, count => count > 0, 60_000, 100)
        expect(session.pendingAsks).toBeGreaterThan(0)
        expect(await waitForSessionProcessCount(snap.id, 1, 15_000)).toBe(1)
        expect(session.status).toBe('running')

        const waitPromise = session.waitForResult(LIVE_TIMEOUT_MS)
        // Swallow the eventual rejection into a settled value we assert on
        // below — an unawaited rejecting promise here would itself become an
        // unhandled rejection and defeat the very thing this test checks.
        const waitOutcome = waitPromise.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        )

        const killed = await killSessionProcess(snap.id)
        expect(killed).toBeGreaterThan(0)

        // The seam's own self-close: no one calls close() — the pump's death
        // routes through it. §12 / correction 42's fix, observed live.
        await waitUntil(() => session.status, status => status === 'closed', 30_000, 100)
        expect(session.status).toBe('closed')
        expect(['crashed', 'exited']).toContain(session.closeReason)

        // Pending ask settled as denied — no promise left holding open.
        expect(session.pendingAsks).toBe(0)
        off()

        // waitForResult rejects typed SESSION_CLOSED, not left hanging.
        const outcome = await waitOutcome
        expect(outcome.ok).toBe(false)
        expect(outcome.ok === false && outcome.error).toBeInstanceOf(ClaudeCodeError)
        expect(outcome.ok === false && (outcome.error as ClaudeCodeError).code).toBe('SESSION_CLOSED')

        // The tombstone answers for the closed session; the live table does not.
        expect(service.session(snap.id)).toBeUndefined()
        const tombstone = service.get(snap.id)
        expect(tombstone?.status).toBe('closed')
        expect(['crashed', 'exited']).toContain(tombstone?.closeReason)

        // The mirror is finalized: the dangling turn closed as aborted, and the
        // log accepts a fresh append (mirror-cancel.live.spec.ts's exact check,
        // repeated here for a SIGKILL rather than a cooperative close()).
        assertFramingInvariants(root.session)
        const [turnEnd] = eventsOfType(root.session, 'turn/end')
        expect(turnEnd?.data.reason.kind).toBe('aborted')
        root.session.append('turn/start', { turn: 2 })
        root.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
        assertFramingInvariants(root.session)

        expect(await waitForSessionProcessCount(snap.id, 0, 15_000)).toBe(0)
        await root.dispose()
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
        guard.stop()
      }
      expect(guard.reasons).toEqual([])
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'close() on a session with a never-answering interactive ask settles it denied, with no leaked promise',
    async () => {
      const guard = captureUnhandledRejections()
      const cwd = tmpCwd('close-settles-ask')
      const mounted = await mountLiveWithAsk()
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })
        // `delegated: false` (interactive) selects NO timeout at all (router.ts:
        // only a delegated target gets `ask.delegatedTimeoutMs`) — the only way
        // this ask ever settles is a human answering, or the session closing.
        const off = ctx.on('approval/request', async () => await new Promise<ApprovalOutcome>(() => {}))

        const snap = await service.open({
          cwd,
          ask: { agent: root.agent, delegated: false },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(bashPrompt(`${cwd}/close-settles-ask.txt`))
        await waitUntil(() => session.pendingAsks, count => count > 0, 60_000, 100)
        expect(session.pendingAsks).toBeGreaterThan(0)

        // close() must not hang waiting on an answer nobody will ever give.
        const closed = await service.close(snap.id)
        expect(closed).toBe(true)
        off()

        expect(session.pendingAsks).toBe(0)
        expect(session.status).toBe('closed')
        expect(session.closeReason).toBe('closed')
        expect(service.session(snap.id)).toBeUndefined()

        assertFramingInvariants(root.session)
        const [turnEnd] = eventsOfType(root.session, 'turn/end')
        expect(turnEnd?.data.reason.kind).toBe('aborted')

        await waitForSessionProcessCount(snap.id, 0, 15_000)
        await root.dispose()
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
        guard.stop()
      }
      expect(guard.reasons).toEqual([])
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'an approval answer that resolves AFTER an interrupt withdraws the request is discarded, not double-settled',
    async () => {
      const guard = captureUnhandledRejections()
      const cwd = tmpCwd('answer-after-cancel')
      const mounted = await mountLiveWithAsk()
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })

        let requestsSeen = 0
        // A scripted answerer that does not itself watch the abort signal —
        // it decides slowly, on its own clock, exactly like a slow human
        // would. If dsh's own approval channel does not discard a late
        // resolve once its signal aborted, this is what would double-settle.
        const off = ctx.on('approval/request', async () => {
          requestsSeen += 1
          await sleep(4_000)
          return 'allowed-once' as ApprovalOutcome
        })

        const target = `${cwd}/should-not-exist.txt`
        const snap = await service.open({
          cwd,
          ask: { agent: root.agent, delegated: false },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(
          `Use the Bash tool to run exactly: touch ${target}\nThen report what happened.`)
        // Wait on the ANSWERER, not on `pendingAsks`. The router books the
        // pending ask BEFORE it awaits `ctx.approval.request()`, and the
        // approval service appends its own audit events before dispatching
        // `approval/request` — so `pendingAsks > 0` is reachable a poll or two
        // before this listener has run, and Stage 3 caught exactly that as a
        // live flake (`expected 0 to be 1`). `requestsSeen` is the stronger
        // barrier in both directions: it cannot fire before the ask is booked,
        // and the answerer holds the ask for 4s after it does, so the
        // `pendingAsks` assertion below is then race-free.
        await waitUntil(() => requestsSeen, seen => seen > 0, 60_000, 100)
        expect(requestsSeen).toBe(1)
        expect(session.pendingAsks).toBeGreaterThan(0)

        // Withdraw the request out from under the slow answerer: interrupt()
        // cancels the SDK's own in-flight canUseTool call, which aborts the
        // signal `ctx.approval.request()` was given.
        await session.interrupt()

        // The withdrawal settles the ask well before the scripted answerer's
        // own 4s decision — proving close()/interrupt() do not wait on it.
        await waitUntil(() => session.pendingAsks, count => count === 0, 10_000, 100)
        expect(session.pendingAsks).toBe(0)
        expect(session.status).not.toBe('closed')

        // Let the late answer actually arrive. Nothing should throw, double
        // count, or produce an unhandled rejection when it does.
        await sleep(5_000)
        off()

        // The session is still perfectly usable — the late answer did not
        // corrupt the ask table or leave the session in a bad state.
        session.send('Say the word PING and nothing else.')
        const result = await session.waitForResult(LIVE_TIMEOUT_MS)
        expect(result.message.type).toBe('result')

        await service.close(snap.id)
        await root.dispose()
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
        guard.stop()
      }
      expect(guard.reasons).toEqual([])
    },
    LIVE_TIMEOUT_MS,
  )
})
