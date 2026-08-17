/**
 * Stage 2 — `claude_code_cancel`, through the tool runtime, against a REAL
 * subprocess: opens synchronously with a short prompt, fires a long-running
 * followup WITHOUT waiting on it, cancels with the default `keep_queued: true`,
 * and asserts the tool's `still_queued` shape and that status recovers to
 * idle. Then closes cleanly.
 */

import { describe, expect, it } from 'vitest'

import {
  LIVE, LIVE_TIMEOUT_MS, mountLiveTools, removeCwd, tmpCwd, waitForAsync, waitForSessionProcessCount,
} from './helpers.ts'

describe.skipIf(!LIVE)('claude_code_cancel, live (DSH_CC_LIVE=1)', () => {
  it(
    'keep_queued defaults true; cancel returns a still_queued array shape and status recovers to idle',
    async () => {
      const cwd = tmpCwd('tools-cancel')
      const harness = await mountLiveTools()
      try {
        const openResult = await harness.call(
          'claude_code_open',
          { cwd, prompt: 'Reply with exactly one word: hi' },
          { agent: harness.root.agent },
        )
        expect(openResult.isError, JSON.stringify(openResult.error)).toBe(false)
        const opened = openResult.value as { session_id: string, status: string }
        expect(opened.status).toBe('idle')

        // A long-running followup, fired without waiting.
        const sendResult = await harness.call(
          'claude_code_send',
          {
            session_id: opened.session_id,
            message: 'Write a very long, detailed essay (at least 15 paragraphs) about the history of paper.',
            mode: 'followup',
          },
          { agent: harness.root.agent },
        )
        expect(sendResult.isError, JSON.stringify(sendResult.error)).toBe(false)

        // Give the subprocess a moment to actually start the turn.
        await waitForSessionProcessCount(opened.session_id, 1, 15_000)

        const cancelResult = await harness.call(
          'claude_code_cancel', { session_id: opened.session_id }, { agent: harness.root.agent })
        expect(cancelResult.isError, JSON.stringify(cancelResult.error)).toBe(false)
        const cancelled = cancelResult.value as { still_queued: string[] }
        expect(Array.isArray(cancelled.still_queued)).toBe(true)
        for (const uuid of cancelled.still_queued) expect(typeof uuid).toBe('string')

        // Status recovers to idle (the interrupted turn's abort result closes it,
        // and nothing was left un-settled).
        await waitForAsync(
          async () => {
            const statusResult = await harness.call(
              'claude_code_status', { session_id: opened.session_id }, { agent: harness.root.agent })
            return (statusResult.value as { status: string } | undefined)?.status
          },
          status => status === 'idle',
          LIVE_TIMEOUT_MS,
          500,
        )
        const statusResult = await harness.call(
          'claude_code_status', { session_id: opened.session_id }, { agent: harness.root.agent })
        expect((statusResult.value as { status: string }).status).toBe('idle')
        expect((statusResult.value as { pending_asks: number }).pending_asks).toBe(0)

        const closeResult = await harness.call(
          'claude_code_close', { session_id: opened.session_id }, { agent: harness.root.agent })
        expect(closeResult.isError, JSON.stringify(closeResult.error)).toBe(false)
        await waitForSessionProcessCount(opened.session_id, 0, 15_000)
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS * 2,
  )
})
