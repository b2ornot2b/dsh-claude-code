/**
 * Stage 2, spec 2: `agent.steer()` mid-turn, driven through the spawned
 * `ClaudeCodeAgent` rather than the seam's `CcSession` directly.
 *
 * Claude Code has no token-level steering (spike 2's abort-and-refold): the
 * running turn dies with a flagged `error_during_execution` artifact that the
 * mirror suppresses from the agent's own session log, and ONE fresh turn runs
 * both instructions together. This spec asserts the MERGED result at the
 * agent/session layer: exactly one visible (non-suppressed) turn/end in the
 * agent's session, the final assistant text contains BANANA, and the agent
 * settles back to `idle`.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

import { LIVE, LIVE_TIMEOUT_MS, mountLiveAgent, removeCwd, tmpCwd, waitUntil } from './helpers.ts'

describe.skipIf(!LIVE)('ClaudeCodeAgent live: steer merges into one visible turn (DSH_CC_LIVE=1)', () => {
  it(
    'exactly one non-cancelled turn/end in the agent session; final assistant text contains BANANA',
    async () => {
      const harness = await mountLiveAgent()
      const cwd = tmpCwd('agent-steer')
      try {
        const handle = await harness.spawn({ cwd })
        const { agent } = handle

        agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'Count from 1 to 300, one number per line, then say DONE.' }],
          source: { kind: 'user' },
        }))

        // Steer only once partials are ACTUALLY flowing — the seam-level live
        // spec's precondition, expressed at the layer this one is allowed to
        // read: the mirror appends one `assistant/chunk` per SDK stream event,
        // so the first chunk is the agent-side equivalent of the seam spec's
        // first `stream_event`. A fixed sleep raced the model here and merged
        // nothing (haiku finished counting to 30 in under two seconds); a
        // longer count plus an event-driven gate removes both halves of that
        // race instead of widening the sleep and hoping.
        await waitUntil(
          () => agent.session.events.some(event => event.type === 'assistant/chunk'),
          flowing => flowing,
          LIVE_TIMEOUT_MS,
          25)

        agent.steer(createUserMessage({
          content: [{ type: 'text', text: 'Also say BANANA at the end.' }],
          source: { kind: 'user' },
        }))

        await agent.whenIdle()

        const events = agent.session.events
        const turnEnds = events.filter(event => event.type === 'turn/end')
        // The aborted turn's artifact is suppressed by the mirror: only the
        // MERGED work's own turn/end reaches the agent's session log.
        expect(turnEnds).toHaveLength(1)
        expect(turnEnds[0]?.type === 'turn/end' ? turnEnds[0].data.reason.kind : undefined).toBe('completed')
        expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)

        const messages = agent.session.deriveMessages()
        const assistantMessages = messages.filter(message => message.role === 'assistant')
        expect(assistantMessages.length).toBeGreaterThan(0)
        const finalText = assistantMessages
          .flatMap(message => message.content)
          .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
          .map(block => block.text)
          .join('\n')
        expect(finalText.toUpperCase()).toContain('BANANA')

        expect(agent.status).toBe('idle')
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
