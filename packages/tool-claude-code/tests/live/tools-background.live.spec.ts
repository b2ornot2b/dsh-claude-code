/**
 * Stage 2 — `claude_code_open({ background: true })` through the REAL jobs
 * stack (`dsh-jobs-local` + `dsh-tool-jobs`), against a REAL Claude Code
 * subprocess: the job IS the session (D10), driven and observed entirely
 * through model-facing tools (`job_list`, `job_output`, `job_kill`), never by
 * reaching into `BackgroundSession`'s private state.
 */

import { describe, expect, it } from 'vitest'

import {
  LIVE, LIVE_TIMEOUT_MS, mountLiveTools, removeCwd, tmpCwd, waitForAsync, waitForSessionProcessCount,
} from './helpers.ts'

describe.skipIf(!LIVE)('claude_code_open background mode, live jobs stack (DSH_CC_LIVE=1)', () => {
  it(
    'runs to completion: visible in job_list, output via job_output, done outcome success',
    async () => {
      const cwd = tmpCwd('tools-bg-complete')
      const harness = await mountLiveTools({ jobs: true })
      try {
        const openResult = await harness.call(
          'claude_code_open',
          {
            cwd,
            prompt: 'Count from 1 to 5, one number per line, nothing else.',
            background: true,
          },
          { agent: harness.root.agent },
        )
        expect(openResult.isError, JSON.stringify(openResult.error)).toBe(false)
        const handle = openResult.value as { kind: string, jobId: string, ccSessionId: string }
        expect(handle.kind).toBe('background')
        expect(typeof handle.jobId).toBe('string')
        expect(typeof handle.ccSessionId).toBe('string')

        // Immediately visible via the model-facing job_list tool (not the raw registry).
        const listResult = await harness.call('job_list', {}, { agent: harness.root.agent })
        expect(listResult.isError, JSON.stringify(listResult.error)).toBe(false)
        const jobs = listResult.value as Array<{ id: string, kind: string, status: string }>
        const job = jobs.find(entry => entry.id === handle.jobId)
        expect(job, 'the background job must be listed').toBeDefined()
        expect(job?.kind).toBe('claude-code')

        const readOutput = async (): Promise<{ text: string, job: { status: string } }> => {
          const result = await harness.call('job_output', { job_id: handle.jobId }, { agent: harness.root.agent })
          expect(result.isError, JSON.stringify(result.error)).toBe(false)
          return result.value as { text: string, job: { status: string } }
        }

        // Poll claude_code_status until the session is idle again (turn finished).
        await waitForAsync(
          async () => {
            const statusResult = await harness.call(
              'claude_code_status', { session_id: handle.ccSessionId }, { agent: harness.root.agent })
            return (statusResult.value as { status: string } | undefined)?.status
          },
          status => status === 'idle',
          LIVE_TIMEOUT_MS,
          500,
        )

        // job_output (readOutput consuming-delta path per Stage 1's decision).
        const output = await readOutput()
        expect(output.text.length).toBeGreaterThan(0)
        // Consuming: a second read before anything new happened yields nothing new.
        const secondRead = await readOutput()
        expect(secondRead.text).toBe('')

        // Close the session -> job settles `completed`.
        await harness.call('claude_code_close', { session_id: handle.ccSessionId }, { agent: harness.root.agent })
        const finalList = await waitForAsync(
          async () => {
            const result = await harness.call('job_list', {}, { agent: harness.root.agent })
            return (result.value as Array<{ id: string, status: string }>).find(entry => entry.id === handle.jobId)
          },
          entry => entry !== undefined && entry.status !== 'running',
          LIVE_TIMEOUT_MS,
          250,
        )
        expect(finalList?.status).toBe('completed')

        await waitForSessionProcessCount(handle.ccSessionId, 0, 15_000)
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS * 2,
  )

  it(
    'job_kill mid-run closes the session, kills the subprocess, and settles done as cancelled — no unhandled rejections',
    async () => {
      const cwd = tmpCwd('tools-bg-kill')
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
      process.on('unhandledRejection', onUnhandled)

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

        // Give the subprocess a moment to actually start the turn before killing it.
        await waitForSessionProcessCount(handle.ccSessionId, 1, 15_000)

        const killResult = await harness.call('job_kill', { job_id: handle.jobId }, { agent: harness.root.agent })
        expect(killResult.isError, JSON.stringify(killResult.error)).toBe(false)

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
        expect(finalStatus).toBe('killed')
        expect(harness.ctx.claudeCode.get(handle.ccSessionId as never)).toBeUndefined()

        await waitForSessionProcessCount(handle.ccSessionId, 0, 15_000)
      } finally {
        await harness.dispose()
        removeCwd(cwd)
        process.off('unhandledRejection', onUnhandled)
      }
      expect(unhandled).toEqual([])
    },
    LIVE_TIMEOUT_MS * 2,
  )
})
