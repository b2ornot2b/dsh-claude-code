/**
 * Stage 2, spec 3: a followup that forces `AskUserQuestion`, driven through
 * the spawned `ClaudeCodeAgent`. The scripted `ctx.userQuestions` provider
 * receives the ask with the AGENT itself as `request.agent` — a registry
 * ROOT, so no `DELEGATED_CALLER` rejection is possible — and the chosen
 * answer round-trips into the agent's final assistant text.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

import { LIVE, LIVE_TIMEOUT_MS, mountLiveAgent, removeCwd, scriptQuestionAnswer, tmpCwd } from './helpers.ts'

const PROMPT
  = 'Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: '
  + '"Red" and "Blue". After you get my answer, reply with one short sentence that repeats the '
  + 'color I chose back to me.'

describe.skipIf(!LIVE)('ClaudeCodeAgent live: AskUserQuestion routes through the agent (DSH_CC_LIVE=1)', () => {
  it(
    'the scripted provider sees request.agent === the CC agent (a root, no DELEGATED_CALLER); the answer reaches the final text',
    async () => {
      const harness = await mountLiveAgent()
      const { ctx } = harness
      const cwd = tmpCwd('agent-question')
      try {
        const scripted = scriptQuestionAnswer(ctx, 'Blue')
        const handle = await harness.spawn({ cwd })
        const { agent } = handle

        agent.followup(createUserMessage({ content: [{ type: 'text', text: PROMPT }], source: { kind: 'user' } }))
        await agent.whenIdle()

        expect(scripted.requests.length).toBeGreaterThanOrEqual(1)
        // Root caller, exact live instance: routed through the agent itself,
        // not a delegate — `register()` recorded no owner for it.
        expect(scripted.requests[0]?.agent).toBe(agent)
        expect(ctx.agents.roots().map(root => root.id)).toContain(agent.id)

        const messages = agent.session.deriveMessages()
        const finalText = messages
          .filter(message => message.role === 'assistant')
          .flatMap(message => message.content)
          .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
          .map(block => block.text)
          .join('\n')
        expect(finalText.toLowerCase()).toContain('blue')

        expect(agent.status).toBe('idle')
        scripted.dispose()
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
