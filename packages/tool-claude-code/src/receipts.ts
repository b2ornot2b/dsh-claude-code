/**
 * "A human decided this" — the settled-ask receipts, projected and rendered.
 *
 * This module is the counterpart to `pending.ts`, and it exists for the same
 * kind of production failure, one step later in the story. `pending.ts` fixed an
 * agent that could not see what a human was BEING asked. This fixes an agent
 * that cannot see what a human ANSWERED.
 *
 * The trace: an operator ran a 13-step acceptance test through the real dsh UI,
 * answering every prompt by hand. The delegating agent then reported 7 PASS / 5
 * PARTIAL / 1 FAIL, and its three worst calls were all wrong in the same
 * direction — it had no evidence that a person had acted, so it invented one:
 *
 * - a permission the human REJECTED was reported as "the denial was not
 *   propagated; the file was created anyway" (it was not created);
 * - a plan the human APPROVED was reported as "FAIL — session wrote the file
 *   without plan review" (plan mode engaged, the human approved, then the write
 *   happened);
 * - a question the human ANSWERED ("hola") was reported as "session auto-chose
 *   hola".
 *
 * Nothing in any tool result said a human had been involved, so "a human chose
 * hola" and "Claude invented hola" were the same observation. These projections
 * and this prose are the missing evidence, and the ONE property that matters
 * most is negative: a settle that was NOT a human's must never read as one. A
 * timeout, a fallback deny and a rule-cache allow each say so in words.
 *
 * Everything here is PURE — `execute` reads the seam once and bakes the values
 * in, so `output.render` stays a total function of `(args, value)`.
 *
 * @module @deepseek-ai/dsh-tool-claude-code
 */

import { CC_ASK_OUTCOMES, CC_ASK_SOURCES, CC_PENDING_ASK_KINDS } from '@deepseek-ai/dsh-claude-code'
import type { CcAskOutcome, CcAskReceipt, CcAskSource, CcPendingAskKind } from '@deepseek-ai/dsh-claude-code'

/**
 * One settled ask as the tool schemas report it: snake_case, lossless JSON, and
 * no timestamps — a model has no clock, and "who decided, and what did they
 * decide" is the whole payload.
 */
export interface CcHumanDecisionProjection {
  /** What the human was asked to do. */
  readonly kind: CcPendingAskKind
  /** The Claude Code tool that was decided, when the ask named one. */
  readonly tool_name?: string
  /** The same one-line description the human was shown in the dsh UI. */
  readonly reason?: string
  /** How it ended. */
  readonly outcome: CcAskOutcome
  /**
   * WHO ended it: `human` means a person answered in the dsh UI; `policy` means
   * nobody was asked or nobody answered (timeout, fallback, stored rule, the
   * session closing). Never report a `policy` entry as a person's decision.
   */
  readonly decided_by: CcAskSource
  /** The human's actual choice — selected option(s), custom text, plan feedback — or which policy answered. */
  readonly detail?: string
  /**
   * Present (and `true`) only when this ask was RAISED before the turn being
   * reported began, and settled during it.
   *
   * A turn-scoped list is filtered on when each ask SETTLED, because the settle
   * is the event with news in it. An ask can outlive the turn that raised it —
   * an interrupt ends a turn with a permission still on a human's screen, the
   * next turn starts, and the human clicks after that. Reporting such a decision
   * silently under the new turn would tell a delegating agent that a person
   * approved something the CURRENT turn asked for, which is a smaller version of
   * the same invention this whole module exists to stop. So it is reported here
   * — the turn it landed in — and labelled.
   */
  readonly asked_in_an_earlier_turn?: boolean
}

/**
 * The shared output-schema fragment for a `human_decisions` array.
 *
 * One definition, four tools (`claude_code_open`, `claude_code_wait`,
 * `claude_code_status`, `claude_code_list`): a model that learns to read it once
 * reads it everywhere, and the schemas cannot drift apart.
 */
export const HUMAN_DECISIONS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: {
        type: 'string',
        required: true,
        enum: CC_PENDING_ASK_KINDS,
        description: 'What the human was asked to do: approve a tool call ("permission"), answer a clarifying '
          + 'question ("question"), or review a plan ("plan").',
      },
      tool_name: { type: 'string', description: 'The Claude Code tool that was decided (e.g. "Write", "Bash").' },
      reason: {
        type: 'string',
        description: 'The same one-line description the human was shown in the dsh UI (e.g. "Bash: touch marker2.txt").',
      },
      outcome: {
        type: 'string',
        required: true,
        enum: CC_ASK_OUTCOMES,
        description: 'How it ended: "allowed" / "rejected" (a decision), "answered" (a question), "cancelled" '
          + '(dismissed or withdrawn), "timed-out", "fallback-denied" or "unavailable" (nobody could be asked).',
      },
      decided_by: {
        type: 'string',
        required: true,
        enum: CC_ASK_SOURCES,
        description: 'WHO settled it. "human": a person answered in the dsh web UI — report this as the human\'s '
          + 'decision. "policy": nobody answered (timeout, fallback policy, a stored always-allow rule, or the '
          + 'session closing) — NEVER report this as a human decision.',
      },
      detail: {
        type: 'string',
        description: 'The human\'s actual choice when there was one — the option label(s) they picked, the custom '
          + 'text they typed, or their plan feedback — otherwise which policy answered and why.',
      },
      asked_in_an_earlier_turn: {
        type: 'boolean',
        description: 'True when this ask was RAISED before the turn being reported started and only settled during '
          + 'it (e.g. an interrupt ended the turn while a human still had the prompt open). The decision is real, '
          + 'but it answers an EARLIER turn\'s tool call — do not report it as approval of this turn\'s work.',
      },
    },
  },
  description: 'Asks that were SETTLED (not pending), oldest first. Use this to report what a human actually '
    + 'decided instead of inferring it from whether a tool call happened.',
} as const

/**
 * Project the seam's receipts onto the tool wire shape, oldest first.
 *
 * @param receipts - the seam's settled-ask receipts, newest last.
 * @param turnStartedAt - when the turn being reported began, for a TURN-scoped
 *   list. Receipts for asks raised before it are flagged
 *   {@link CcHumanDecisionProjection.asked_in_an_earlier_turn}. Omitted for a
 *   whole-session list (`claude_code_status`), where there is no one turn to be
 *   earlier than.
 * @returns the projection, in the same order.
 */
export function projectHumanDecisions(
  receipts: readonly CcAskReceipt[],
  turnStartedAt?: number,
): CcHumanDecisionProjection[] {
  return receipts.map(receipt => ({
    kind: receipt.kind,
    ...(receipt.toolName === undefined || receipt.toolName === '' ? {} : { tool_name: receipt.toolName }),
    ...(receipt.reason === undefined || receipt.reason === '' ? {} : { reason: receipt.reason }),
    outcome: receipt.outcome,
    decided_by: receipt.source,
    ...(receipt.detail === undefined || receipt.detail === '' ? {} : { detail: receipt.detail }),
    ...(turnStartedAt === undefined || receipt.askedAt >= turnStartedAt
      ? {}
      : { asked_in_an_earlier_turn: true }),
  }))
}

/**
 * What was asked, in one phrase: `permission for Bash (touch marker2.txt)`.
 * @param decision - the projected decision.
 * @returns the subject phrase.
 */
function subject(decision: CcHumanDecisionProjection): string {
  const head = decision.kind === 'plan'
    ? 'plan review'
    : decision.kind === 'question'
      ? 'question'
      : `permission for ${decision.tool_name ?? 'an unnamed tool'}`
  // The CLI's own rendered title already starts with the tool name
  // ("Bash: touch marker2.txt"), and the subject just said it. Saying it twice
  // reads as a stutter in the one sentence a model is meant to repeat.
  const detail = stripToolPrefix(decision.reason, decision.tool_name)
  const asked = detail === undefined ? head : `${head} (${detail})`
  // A decision that answers an EARLIER turn's ask says so in the same sentence,
  // because the alternative is a model reporting "the human approved" about work
  // this turn never asked to do.
  return decision.asked_in_an_earlier_turn === true
    ? `${asked}, raised during an EARLIER turn`
    : asked
}

/**
 * Drop a leading `Tool: ` from a reason whose tool is already named.
 * @param reason - the one-line reason, when there is one.
 * @param toolName - the tool it belongs to, when the ask named one.
 * @returns the reason without the redundant prefix, or undefined.
 */
function stripToolPrefix(reason: string | undefined, toolName: string | undefined): string | undefined {
  if (reason === undefined || reason === '') return undefined
  if (toolName === undefined || toolName === '') return reason
  const prefix = `${toolName}: `
  const stripped = reason.startsWith(prefix) ? reason.slice(prefix.length).trim() : reason
  return stripped === '' ? undefined : stripped
}

/**
 * The verdict half of one line: what happened, and — always — whether a person
 * did it.
 *
 * The wording is deliberately asymmetric. A human's decision is stated in
 * CAPITALS with "by a human in the dsh UI" attached, because that is the fact an
 * agent must repeat and currently cannot. A policy settle is stated in lower
 * case and ends in "NOT a human decision", because the failure mode being
 * defended against is an agent reading a fail-closed deny and reporting that the
 * operator refused.
 *
 * @param decision - the projected decision.
 * @returns the verdict phrase.
 */
function verdict(decision: CcHumanDecisionProjection): string {
  const because = decision.detail === undefined ? '' : ` — ${decision.detail}`
  if (decision.decided_by === 'human') {
    switch (decision.outcome) {
      case 'allowed':
        return `ALLOWED by a human in the dsh UI${because}`
      case 'rejected':
        return `REJECTED by a human in the dsh UI${because}`
      case 'answered':
        return `answered by a human in the dsh UI: ${quote(decision.detail)}`
      case 'cancelled':
        return `dismissed by a human in the dsh UI${because}`
      default:
        return `settled as "${decision.outcome}" by a human in the dsh UI${because}`
    }
  }
  switch (decision.outcome) {
    case 'allowed':
      return `allowed WITHOUT asking anyone${because} — NOT a human decision`
    case 'answered':
      return `auto-answered with no human involved${because} — NOT a human decision`
    case 'timed-out':
      return `NOT answered: the ask timed out and was settled by policy${because} — NOT a human decision`
    case 'cancelled':
      return `cancelled before anyone decided${because} — NOT a human decision`
    default:
      return `denied by policy${because} — NOT a human decision, nobody was asked or nobody answered`
  }
}

/**
 * Quote a human's own words so a model repeats them verbatim.
 * @param detail - the choice, when there is one.
 * @returns the quoted text, or a stand-in when the seam recorded none.
 */
function quote(detail: string | undefined): string {
  return detail === undefined || detail === '' ? '(no choice was recorded)' : `'${detail}'`
}

/**
 * The numbered list of settled asks — one line each, no lead-in, so the wait,
 * status and list paths can all compose it.
 * @param decisions - the projected decisions, oldest first.
 * @returns the block, with no trailing newline. Empty string for none.
 */
export function renderHumanDecisions(decisions: readonly CcHumanDecisionProjection[]): string {
  return decisions
    .map((decision, index) => `  ${index + 1}. ${subject(decision)} — ${verdict(decision)}`)
    .join('\n')
}

/**
 * The whole settled-ask block, header included — the string a delegating model
 * reads to learn that a person was involved at all.
 *
 * The header counts the two sources separately on purpose: "2 settled asks (1
 * decided by a human, 1 settled by policy)" is what stops an agent from
 * summarising a mixed turn as "the human denied everything".
 *
 * @param decisions - the projected decisions, oldest first.
 * @param scope - what the list covers, e.g. `'this turn'` or `'on this session'`.
 * @returns the block, or the empty string when nothing settled.
 */
export function renderDecisionBlock(
  decisions: readonly CcHumanDecisionProjection[],
  scope: string,
): string {
  if (decisions.length === 0) return ''
  const human = decisions.filter(decision => decision.decided_by === 'human').length
  const policy = decisions.length - human
  const header = policy === 0
    ? `${human} human decision${human === 1 ? '' : 's'} ${scope}:`
    : human === 0
      ? `${policy} ask${policy === 1 ? '' : 's'} settled ${scope} WITHOUT any human decision:`
      : `${decisions.length} settled asks ${scope} (${human} decided by a human, `
        + `${policy} settled by policy with no human involved):`
  return `${header}\n${renderHumanDecisions(decisions)}`
}

/**
 * Put the settled-ask evidence in FRONT of a turn's own prose.
 *
 * Order is the whole trick. The failure being defended against is an agent that
 * narrates what Claude Code produced and never mentions that a person approved,
 * rejected or answered anything — so the human decisions lead, and the model
 * reads them before it has finished composing its summary of the result.
 *
 * @param body - the tool's existing prose (the turn's final text, or a status line).
 * @param decisions - the projected decisions, oldest first.
 * @param scope - what the list covers, e.g. `'this turn'`.
 * @returns the combined prose; `body` unchanged when nothing settled.
 */
export function renderWithDecisions(
  body: string,
  decisions: readonly CcHumanDecisionProjection[],
  scope: string,
): string {
  const block = renderDecisionBlock(decisions, scope)
  return block === '' ? body : `${block}\n\n${body}`
}

/**
 * The one-line summary `claude_code_list` carries per session — a count plus the
 * most recent decision, because a listing must stay scannable.
 * @param count - how many asks have settled on that session.
 * @param last - the most recent one, when there is one.
 * @returns the line, with no leading newline, or the empty string when nothing settled.
 */
export function renderLastDecision(
  count: number,
  last: CcHumanDecisionProjection | undefined,
): string {
  if (last === undefined || count === 0) return ''
  const trailer = count === 1 ? '' : ` (${count} settled asks on this session; newest shown)`
  return `     last decision: ${subject(last)} — ${verdict(last)}${trailer}`
}
