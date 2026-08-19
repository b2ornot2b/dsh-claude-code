/**
 * Shared scaffolding for the LIVE ask-channel suite (`DSH_CC_LIVE=1`):
 * `ask-approval.live.spec.ts`, `ask-question.live.spec.ts`,
 * `ask-plan.live.spec.ts`, `ask-timeout-fallback.live.spec.ts`.
 *
 * Every spec in that group opens a REAL Claude Code subprocess through
 * `mountLiveWithAsk` + `registerLiveRootAgent` (see `./helpers.ts`) — a real
 * `SessionStore` + `AgentRegistry` + `UserQuestionService` + `ApprovalService`
 * composition, with the agent's own dsh session doubling as the mirrored
 * session per §7's Agent-adapter convention. What is deliberately NOT here:
 * anything that scripts `canUseTool` directly — the whole point of this group
 * is exercising the REAL `CcAskRouter` a session installs by default.
 *
 * Not a spec file: vitest only collects `*.spec.ts`, while `tsconfig.tests.json`
 * still type-checks this module.
 *
 * @module @deepseek-ai/dsh-claude-code (live tests)
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { expect } from 'vitest'

import { eventsOfType } from '../session-assertions.ts'

/** The `ToolResultBlock` wrapped by one `tool/result` event's message (its sole content entry). */
function toolResultBlock(
  event: Extract<SessionEvent, { type: 'tool/result' }>,
): Extract<SessionEvent, { type: 'tool/result' }>['data']['message']['content'][0] {
  return event.data.message.content[0]
}

/**
 * The model-facing text of one `tool/result` event — the deny/allow sentence
 * Claude Code's own permission machinery actually threaded back to the model,
 * independent of whatever the model went on to SAY about it. Assertions on
 * this are far less flaky against a real LLM than parsing the final assistant
 * turn.
 * @param event - a `tool/result` event off a real mirrored session.
 * @returns the concatenated text of every text block in the result.
 */
export function toolResultText(event: Extract<SessionEvent, { type: 'tool/result' }>): string {
  const outer = toolResultBlock(event)
  if (outer === undefined) return ''
  return outer.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Whether one `tool/result` event's block carries the SDK's own `is_error`
 * flag — set true whenever `canUseTool` denied the call.
 * @param event - a `tool/result` event off a real mirrored session.
 * @returns the flag (false when the block is missing entirely).
 */
export function toolResultIsError(event: Extract<SessionEvent, { type: 'tool/result' }>): boolean {
  return toolResultBlock(event)?.isError === true
}

/**
 * Find the one `tool/result` event answering a given `tool/call` (matched by
 * `name`), asserting exactly one such pair exists — the shape every scenario
 * in this suite drives (one Bash/AskUserQuestion/ExitPlanMode call per turn).
 * @param session - the mirrored session.
 * @param toolName - the tool whose call/result pair to find (e.g. `'Bash'`).
 * @returns the call and result events.
 */
export function callAndResult(
  session: Session,
  toolName: string,
): {
  call: Extract<SessionEvent, { type: 'tool/call' }>
  result: Extract<SessionEvent, { type: 'tool/result' }>
} {
  const calls = eventsOfType(session, 'tool/call').filter(event => event.data.name === toolName)
  expect(calls.length).toBeGreaterThanOrEqual(1)
  const call = calls[0]
  if (call === undefined) throw new Error(`callAndResult: no tool/call for ${toolName}`)
  const results = eventsOfType(session, 'tool/result')
    .filter(event => event.data.message.source.callId === call.data.callId)
  expect(results).toHaveLength(1)
  const result = results[0]
  if (result === undefined) throw new Error(`callAndResult: no tool/result for ${toolName}`)
  return { call, result }
}

/**
 * Register a scripted `approval/request` answerer on a {@link mountLiveWithAsk}
 * context, recording every request it saw.
 * @param ctx - the composition (must have `ApprovalService` mounted).
 * @param answer - the outcome (or a function of the request) to answer with.
 * @returns the seen requests, and a disposer.
 */
export function scriptApproval(
  ctx: Context,
  answer: ApprovalOutcome | ((request: ApprovalRequest) => Promise<ApprovalOutcome> | ApprovalOutcome),
): { requests: ApprovalRequest[], dispose: () => void } {
  const requests: ApprovalRequest[] = []
  const dispose = ctx.on('approval/request', async (request) => {
    requests.push(request)
    return await Promise.resolve(typeof answer === 'function' ? answer(request) : answer)
  })
  return { requests, dispose }
}
