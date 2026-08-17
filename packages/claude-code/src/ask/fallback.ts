/**
 * The fallback policy (§4.5): what the ask channel answers when no human can
 * be reached.
 *
 * It covers exactly three situations, and they are NOT interchangeable:
 *
 * | situation | source |
 * |---|---|
 * | the question could not be routed | any {@link CC_ASK_ERROR_CODES} code — `DELEGATED_CALLER`, `CALLER_NOT_LIVE`, `NO_PROVIDER`, `ASK_ABORTED`, `ASK_CANCELLED`, `ASK_MISSING_AGENT`, `BAD_INTENT`, `EMPTY_QUESTIONS` |
 * | nobody answered the permission | `ApprovalOutcome === 'unavailable'` |
 * | nobody answered in time | `ask.timeoutMs` / `ask.delegatedTimeoutMs` elapsed |
 *
 * What it deliberately does NOT cover: a human who answered "no". A `rejected`
 * (including the deterministic `policy: 'never'` fold) or `cancelled` outcome is
 * a decision, and a decision is never overridden by a policy.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import type { CcPermissionDecision } from '../backend.ts'
import { ClaudeCodeError } from '../types.ts'
import type { AskFallback, CcLogger } from '../types.ts'

/** Which of the three ask paths hit the fallback. */
export type CcAskKind =
  /** `ctx.approval.request()` — a tool permission. */
  | 'approval'
  /** `ctx.userQuestions.ask()` — `AskUserQuestion`. */
  | 'questions'
  /** `ctx.userQuestions.ask()` with the `plan-review` intent — `ExitPlanMode`. */
  | 'plan'

/** Why the ask could not be answered. Stable tokens: log and route on these, never on the message. */
export type CcAskFallbackReason =
  /** A `UserQuestionError` code (the full D3 taxonomy). */
  | { readonly kind: 'question-error', readonly code: string, readonly detail: string }
  /** The approval seam answered `'unavailable'` (no answerer claimed it, or one threw). */
  | { readonly kind: 'approval-unavailable' }
  /** The configured wait elapsed with nobody answering. */
  | { readonly kind: 'timeout', readonly ms: number }
  /** No user-questions service is mounted in this composition at all. */
  | { readonly kind: 'no-service' }

/** One fallback decision, plus the error a `'error'` policy surfaces on the session. */
export interface CcAskFallbackResult {
  /** What the SDK is answered with. Always a decision — never `null`, never a throw. */
  readonly decision: CcPermissionDecision
  /** Set only under policy `'error'`: the typed failure the session republishes. */
  readonly error?: ClaudeCodeError
}

/** Everything {@link applyAskFallback} needs to answer one unanswerable ask. */
export interface CcAskFallbackInput {
  /** The configured policy (`config.ask.fallback`). */
  readonly policy: AskFallback
  /** Which path hit it. */
  readonly kind: CcAskKind
  /** The tool being decided (`'Bash'`, `'AskUserQuestion'`, `'ExitPlanMode'`, …). */
  readonly toolName: string
  /** Why no answer could be reached. */
  readonly reason: CcAskFallbackReason
  /** Diagnostics sink. `'first-option'` logs LOUDLY here — it is answering for a human. */
  readonly logger?: CcLogger
  /**
   * Build the `'first-option'` answer, when the path can produce one.
   *
   * Only the CLARIFYING-questions path supplies it. A permission prompt's
   * "first option" is a grant, and a plan review's first option is `Approve` —
   * auto-approving either would let an unattended run acquire exactly the
   * authority the prompt exists to withhold. Both therefore deny under
   * `'first-option'`, loudly (§4.5's table says "approvals denied").
   * @returns the allow decision, or undefined when nothing can be auto-answered.
   */
  readonly autoAnswer?: () => CcPermissionDecision | undefined
}

/** Advice appended to every deny, so Claude keeps working instead of retrying the prompt. */
const PROCEED_HINT
  = 'Nothing was executed. Continue on your best assumption and state the assumption you made, '
  + 'or put the unresolved question in your final message — asking again will fail the same way.'

/**
 * Answer one unanswerable ask according to the configured policy.
 *
 * Total by construction: every policy returns a decision, and the `'error'`
 * policy additionally hands back a typed error for the session to surface. The
 * callback may not throw — a rejected `canUseTool` promise hangs the Claude
 * Code session forever, with no park deadline (gotcha 9).
 *
 * @param input - policy, path, tool, reason, and the optional auto-answer.
 * @returns the decision, and the error to surface under policy `'error'`.
 */
export function applyAskFallback(input: CcAskFallbackInput): CcAskFallbackResult {
  const summary = describeReason(input.reason)
  const context = `${input.toolName} (${input.kind} ask): ${summary}`

  if (input.policy === 'first-option') {
    const auto = input.autoAnswer?.()
    if (auto !== undefined) {
      // LOUD by contract: an answer nobody gave has been put in a human's
      // mouth, and the audit log has no other record of it.
      input.logger?.debug(
        `claude-code ask: FIRST-OPTION FALLBACK answered ${context} — `
        + 'the first option of every question was selected automatically, with no human involved')
      return { decision: auto }
    }
    input.logger?.debug(
      `claude-code ask: first-option fallback cannot answer ${context} — `
      + 'a permission grant and a plan approval are never auto-answered; denying instead')
    return { decision: { behavior: 'deny', message: denyMessage(context) } }
  }

  if (input.policy === 'error') {
    const error = new ClaudeCodeError(
      `claude-code: no answer could be reached for ${context}`, 'ASK_UNANSWERABLE')
    input.logger?.debug(`claude-code ask: unanswerable, interrupting the session — ${context}`)
    // `interrupt: true` is deny-and-stop in one step (delta S13): the turn ends
    // rather than letting the model improvise around a decision it never got.
    return { decision: { behavior: 'deny', message: denyMessage(context), interrupt: true }, error }
  }

  input.logger?.debug(`claude-code ask: denying (fallback policy "deny") — ${context}`)
  return { decision: { behavior: 'deny', message: denyMessage(context) } }
}

/**
 * The model-facing sentence for a fallback deny.
 * @param context - the rendered "tool (kind ask): reason" summary.
 * @returns the deny message.
 */
function denyMessage(context: string): string {
  return `Denied — ${context}. ${PROCEED_HINT}`
}

/**
 * Render one reason as a short human sentence.
 * @param reason - the structured reason.
 * @returns the sentence.
 */
export function describeReason(reason: CcAskFallbackReason): string {
  switch (reason.kind) {
    case 'question-error':
      return `${reason.code} — ${reason.detail}`
    case 'approval-unavailable':
      return 'no approver is available in this composition (the approval seam answered "unavailable")'
    case 'timeout':
      return `nobody answered within ${reason.ms}ms`
    case 'no-service':
      return 'no user-questions service is mounted in this composition'
  }
}
