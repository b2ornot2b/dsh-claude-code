/**
 * The ask channel's shared vocabulary: who answers, which seams are consulted,
 * and how this package refers to a dsh service without owning it.
 *
 * Two rules shape this file:
 *
 * 1. **Services are named structurally, never by class.** cordis 4 hands out a
 *    fresh traceable Proxy per service access (`ctx.get(k) !== ctx.get(k)`), so
 *    nothing here may identity-compare, `instanceof`-check or store a service
 *    across a turn. A one-method interface is all the router needs, it is what
 *    the real `ApprovalService` / `UserQuestionService` satisfy, and it is what
 *    a test double satisfies without mounting a composition.
 * 2. **Both seams are OPTIONAL.** A headless delegation composition mounts
 *    neither. Absent approval is fail-closed (deny, with an explanation);
 *    absent user-questions is the configured fallback policy (§4.5), because a
 *    clarifying question with nobody to answer it is a routing failure, not a
 *    security decision.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer, AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'

export type { Agent, ApprovalOutcome }

/**
 * `ctx.approval` as the ask channel uses it: one call, one closed outcome.
 *
 * `request()` THROWS (rather than resolving `'unavailable'`) when the agent's
 * session has no open turn — the audit pair must be turn-enclosed. The router
 * catches that and denies with an explanation; letting it reject the
 * `canUseTool` promise would hang the Claude Code session forever (gotcha 9).
 */
export interface CcApprovalSeam {
  /**
   * Ask the composed answerers for one decision.
   * @param request - agent, tool identity, call id, reason, signal.
   * @returns the closed outcome; `'allowed-once'` is the only grant.
   */
  request(request: ApprovalRequest): Promise<ApprovalOutcome>
}

/**
 * `ctx.userQuestions` as the ask channel uses it.
 *
 * Rejects with a `UserQuestionError` carrying one of the codes in
 * {@link CC_ASK_ERROR_CODES}; every one of them routes to the fallback policy
 * (§4.5 + delta D3), never upward.
 */
export interface CcUserQuestionsSeam {
  /**
   * Put questions to the human behind the calling agent.
   * @param request - questions, the exact live agent, and the abort signal.
   * @returns the human's answer.
   */
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

/**
 * The two optional seams, resolved LAZILY on every ask.
 *
 * Lazy on purpose: a service may mount (or unload) after the Claude Code
 * session opened, and a captured cordis proxy outlives the fiber that made it.
 * Each function is one `ctx.get(...)` call at the moment of asking.
 */
export interface CcAskServices {
  /**
   * Resolve the approval seam.
   * @returns `ctx.get('approval')`, or undefined when nothing provides it.
   */
  approval(): CcApprovalSeam | undefined
  /**
   * Resolve the user-questions seam.
   * @returns `ctx.get('userQuestions')`, or undefined when nothing provides it.
   */
  userQuestions(): CcUserQuestionsSeam | undefined
}

/**
 * Who answers for one Claude Code session — attached by the caller that owns
 * the dsh side of it:
 *
 * - **Phase 5 (tool delegation)** passes `exec.agent`, the DeepSeek agent whose
 *   tool call opened the session. Its turn is open by construction, which is
 *   what makes `approval.request()` legal. It may itself be a subagent, in
 *   which case `delegated` is true.
 * - **Phase 6 (Agent adapter)** passes the CC-backed agent it registered, and
 *   opens the turn from the mirror's own framing.
 *
 * The target may override either seam (a scoped answerer, a test double);
 * omitted, the session's context is consulted instead.
 */
export interface CcAskTarget {
  /** The dsh agent whose seams answer, and whose session log carries the audit pair. */
  readonly agent: Agent
  /** Override the user-questions seam for this session. Omitted means `ctx.get('userQuestions')`. */
  readonly userQuestions?: CcUserQuestionsSeam
  /** Override the approval seam for this session. Omitted means `ctx.get('approval')`. */
  readonly approval?: CcApprovalSeam
  /**
   * True when this agent is a delegate (a subagent, or any run with no human
   * attached). It selects `ask.delegatedTimeoutMs` over `ask.timeoutMs`, and it
   * is the honest name for the case `DELEGATED_CALLER` reports after the fact.
   */
  readonly delegated: boolean
}

/**
 * The mirror, as the ask channel reads it (§4.4). `CcMirror` satisfies it
 * structurally; a session with no mirror attached has none, and then approval
 * requests carry NO `callId` at all rather than an id the UI never saw.
 */
export interface CcAskCallSite {
  /**
   * Has a `tool/call` for this CC `tool_use` id been appended to the dsh log?
   * @param toolUseId - CC's `tool_use` block id.
   * @returns true when the UI has already seen the call.
   */
  hasEmittedCall(toolUseId: string): boolean
  /**
   * Append the `tool/call` if it is still missing, and return its dsh call id.
   * @param toolUseId - CC's `tool_use` block id.
   * @param toolName - the tool being decided.
   * @param input - the tool input as `canUseTool` received it.
   * @returns the dsh call id now present in the log.
   */
  ensureToolCall(toolUseId: string, toolName: string, input: Record<string, unknown>): string
}

/**
 * Every `UserQuestionError.code` the ask channel handles (delta D3 — the FULL
 * taxonomy, not just the two the spec named).
 *
 * `DELEGATED_CALLER` and `CALLER_NOT_LIVE` come from the service's liveness
 * gate; `NO_PROVIDER`, `ASK_ABORTED`, `EMPTY_QUESTIONS` and `BAD_INTENT` from
 * its own validation; `ASK_CANCELLED` (the user dismissed the prompt to speak
 * instead) and `ASK_MISSING_AGENT` from the UI provider.
 */
export const CC_ASK_ERROR_CODES: readonly string[] = [
  'DELEGATED_CALLER',
  'CALLER_NOT_LIVE',
  'NO_PROVIDER',
  'ASK_ABORTED',
  'ASK_CANCELLED',
  'ASK_MISSING_AGENT',
  'BAD_INTENT',
  'EMPTY_QUESTIONS',
]

/**
 * Read a `code` off a thrown value without importing anyone's error class:
 * `UserQuestionError` extends `HarnessError`, whose `code` is a plain string
 * property, and an `instanceof` check across two copies of a package is exactly
 * the identity comparison this repo forbids.
 * @param error - the thrown value.
 * @returns the code when the value carries a string one, else undefined.
 */
export function askErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Render any thrown value as one log/deny line.
 * @param error - the thrown value.
 * @returns a one-line description.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
