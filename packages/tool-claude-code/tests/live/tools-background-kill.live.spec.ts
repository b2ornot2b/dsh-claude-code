/**
 * Stage 2, §12 failure injection, background-job half: SIGKILL the real
 * subprocess behind a `claude_code_open({ background: true })` job — as
 * opposed to `tools-background.live.spec.ts`'s `job_kill` (a COOPERATIVE
 * cancel through `JobHooks.cancel`) — and check `outcomeFor`'s dead-subprocess
 * row (`background.ts`'s settlement table): a subprocess that dies mid-turn
 * on its own settles the job `failed`, exactly once, with no orphan process
 * and no unhandled rejection.
 *
 * Companion to `packages/claude-code/tests/live/failures.live.spec.ts` (the
 * seam-level half) and
 * `packages/claude-code-agent/tests/live/agent-kill.live.spec.ts` (the agent
 * adapter half) — all three exercise the SAME underlying fix (api-contract
 * correction 44: pump death now routes through `close()`), each checking a
 * different consumer's projection of it.
 */

import { describe, expect, it } from 'vitest'

import { captureUnhandledRejections, killSessionProcess } from '../../../claude-code/tests/live/helpers.ts'
import {
  LIVE, LIVE_TIMEOUT_MS, mountLiveTools, removeCwd, tmpCwd, waitForAsync, waitForSessionProcessCount,
} from './helpers.ts'

describe.skipIf(!LIVE)('claude_code_open background mode: subprocess killed mid-turn (§12, DSH_CC_LIVE=1)', () => {
  it(
    'settles done exactly once with a failed outcome, job_list shows terminal state, no orphan process',
    async () => {
      const guard = captureUnhandledRejections()
      const cwd = tmpCwd('tools-bg-kill-sigkill')
      const harness = await mountLiveTools({ jobs: true })
      try {
        const openResult = await harness.call(
          'claude_code_open',
          {
            cwd,
            prompt: 'Write a very long, detailed, multi-paragraph essay (at least 20 paragraphs) about the '
              + 'history of the number zero. Keep writing until you are told to stop.',
            background: true,
          },
          { agent: harness.root.agent },
        )
        expect(openResult.isError, JSON.stringify(openResult.error)).toBe(false)
        const handle = openResult.value as { jobId: string, ccSessionId: string }

        // Give the subprocess a moment to actually start the turn.
        await waitForSessionProcessCount(handle.ccSessionId, 1, 15_000)

        // Kill the SUBPROCESS directly — no job_kill, no claude_code_close.
        // Nobody calls JobHooks.cancel(); the job only ever finds out its
        // session died on its own.
        const killed = await killSessionProcess(handle.ccSessionId)
        expect(killed).toBeGreaterThan(0)

        const finalStatus = await waitForAsync(
          async () => {
            const listResult = await harness.call('job_list', {}, { agent: harness.root.agent })
            return (listResult.value as Array<{ id: string, status: string }>)
              .find(entry => entry.id === handle.jobId)?.status
          },
          status => status !== undefined && status !== 'running' && status !== 'stopping',
          LIVE_TIMEOUT_MS,
          250,
        )
        // `outcomeFor`: cancelled=false (nobody called cancel), reason
        // 'crashed' (mid-turn death) -> JobOutcome.status === 'failed'.
        expect(finalStatus).toBe('failed')

        // The seam agrees: the session is gone from the live table, and its
        // tombstone (if the composition kept one) also reads closed/crashed.
        expect(harness.ctx.claudeCode.session(handle.ccSessionId as never)).toBeUndefined()

        // Exactly-once settlement: a second job_list read is stable, not a
        // second transition (which double settlement would produce as e.g.
        // an error from `done` resolving twice, or a status flapping back).
        const secondRead = await harness.call('job_list', {}, { agent: harness.root.agent })
        const secondStatus = (secondRead.value as Array<{ id: string, status: string }>)
          .find(entry => entry.id === handle.jobId)?.status
        expect(secondStatus).toBe('failed')

        expect(await waitForSessionProcessCount(handle.ccSessionId, 0, 15_000)).toBe(0)
      } finally {
        await harness.dispose()
        removeCwd(cwd)
        guard.stop()
      }
      expect(guard.reasons).toEqual([])
    },
    LIVE_TIMEOUT_MS * 2,
  )
})
