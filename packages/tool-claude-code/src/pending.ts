/**
 * "Still running, and here is what it is waiting for" — the projection and the
 * prose.
 *
 * This module exists because of one production trace. A dsh agent delegated to
 * Claude Code, the CLI raised a `Write` permission, and a human had not answered
 * it yet. `claude_code_open` blocked for ten minutes and then THREW; the
 * delegating model read the throw as a failure, cancelled the turn, and opened a
 * fresh session — three times, ~30 minutes, on step 2 of 13. Meanwhile the ask
 * table held both the tool name and the exact sentence the human was looking at
 * (`Write: /private/tmp/.../notes.txt`) and nothing upstream could see either:
 * the only signal was a COUNT, from `claude_code_status`.
 *
 * Two fixes, and this file is the second one:
 *
 * 1. A turn still running because nobody has answered yet is a NORMAL state, so
 *    the tools RESOLVE with it (see `index.ts`) rather than throwing.
 * 2. The value they resolve with has to say what a human must do, in words a
 *    model will act on rather than route around. That is
 *    {@link renderStillRunning}, and it is the highest-value string in this
 *    package — it is what stands between "wait again" and "cancel and respawn".
 *
 * Everything here is PURE: `execute` reads the clock once and puts the elapsed
 * milliseconds INTO the canonical value, so `output.render` is a total function
 * of `(args, value)` and the rendered prose is replayable from a logged result.
 *
 * @module @deepseek-ai/dsh-tool-claude-code
 */

import { CC_PENDING_ASK_KINDS } from '@deepseek-ai/dsh-claude-code'
import type { CcPendingAsk, CcPendingAskKind } from '@deepseek-ai/dsh-claude-code'

/**
 * One pending ask as the tool schemas report it: snake_case, lossless JSON, and
 * a DURATION rather than an epoch timestamp.
 *
 * The duration is the deliberate part. `CcPendingAsk.since` is epoch
 * milliseconds, which a model cannot subtract anything from — it has no clock —
 * whereas "pending 12m 04s" is immediately actionable ("this has been waiting a
 * while; the human may not be at their desk").
 */
export interface CcPendingAskProjection {
  /** What a human is being asked to do. */
  readonly kind: CcPendingAskKind
  /** The tool being decided, when the ask names one. */
  readonly tool_name?: string
  /** The same one-line reason the human is reading in the dsh UI, when there is one. */
  readonly reason?: string
  /** How long this ask has been awaiting an answer, in milliseconds, at projection time. */
  readonly waiting_ms: number
}

/**
 * The shared output-schema fragment for a `pending_ask_details` array.
 *
 * One definition, three tools (`claude_code_open`, `claude_code_wait`,
 * `claude_code_status`): a model that learns to read it once reads it
 * everywhere, and the three schemas cannot drift apart.
 */
export const PENDING_ASK_DETAILS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: {
        type: 'string',
        required: true,
        enum: CC_PENDING_ASK_KINDS,
        description: 'What the human is being asked to do: approve a tool call ("permission"), answer a '
          + 'clarifying question ("question"), or review a plan ("plan").',
      },
      tool_name: { type: 'string', description: 'The Claude Code tool being decided (e.g. "Write", "Bash").' },
      reason: {
        type: 'string',
        description: 'The same one-line description the human sees in the dsh UI — the CLI\'s own rendered '
          + 'title when it supplied one (e.g. "Write: /tmp/notes.txt").',
      },
      waiting_ms: {
        type: 'integer',
        required: true,
        description: 'How long this ask has been waiting for an answer, in milliseconds.',
      },
    },
  },
  description: 'What is pending, one entry per ask, in arrival order. Empty when nothing is pending.',
} as const

/**
 * Project the seam's pending asks onto the tool wire shape.
 *
 * @param details - the seam's pending asks, in arrival order.
 * @param now - the clock reading to measure `waiting_ms` against (injected so
 *   this stays pure and so tests can pin it).
 * @returns the projection, in the same order.
 */
export function projectPendingAsks(
  details: readonly CcPendingAsk[],
  now: number,
): CcPendingAskProjection[] {
  return details.map(detail => ({
    kind: detail.kind,
    ...(detail.toolName === '' ? {} : { tool_name: detail.toolName }),
    ...(detail.reason === undefined || detail.reason === '' ? {} : { reason: detail.reason }),
    // A clock that stepped backwards (NTP, a fake timer rewound between calls)
    // must not report a negative age as if the ask were from the future.
    waiting_ms: Math.max(0, Math.round(now - detail.since)),
  }))
}

/**
 * Render a duration the way a person reads one.
 * @param ms - the elapsed milliseconds.
 * @returns `"9s"`, `"10m 03s"` or `"1h 12m"`.
 */
export function formatWaiting(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * The numbered list of what is pending — one line per ask, no lead-in and no
 * guidance, so both the wait/open path and the status path can compose it.
 * @param details - the projected pending asks.
 * @returns the block, with no trailing newline. Empty string for no asks.
 */
export function renderPendingAsks(details: readonly CcPendingAskProjection[]): string {
  return details
    .map((detail, index) => `  ${index + 1}. ${detail.kind} ask for tool `
      + `"${detail.tool_name ?? 'unknown'}"`
      + (detail.reason === undefined ? '' : ` — reason: ${detail.reason}`)
      + ` — pending ${formatWaiting(detail.waiting_ms)}`)
    .join('\n')
}

/**
 * The instruction half of the message: what the model should actually do next.
 *
 * Written to defeat one specific failure mode — the delegating model in the
 * production trace treated "not finished yet" as "broken" and respawned. So it
 * says, in order: this is normal; a PERSON is the blocker; call wait again; and
 * the two things not to do, with the reason a retry cannot help (a new session
 * raises the same ask, and the old one is still unanswered).
 *
 * @param sessionId - the session to name in the next-step instruction.
 * @returns the guidance sentence.
 */
export function answerInDshUi(sessionId: string): string {
  return 'This is the normal human-in-the-loop state, not a failure: a person has to answer in the dsh '
    + 'web UI before this turn can continue, and no tool call here can answer for them. The correct next '
    + `step is to call claude_code_wait with session_id ${sessionId} again and keep waiting. Do NOT cancel `
    + 'this turn and do NOT open another Claude Code session — a new session raises the same ask, and this '
    + 'one would still be unanswered.'
}

/**
 * The single highest-value string in this package: what a delegating model
 * reads when it polls a session that is waiting on a human.
 *
 * It states, in this order and on purpose: the session id (so the model waits on
 * the RIGHT one), that the session is still running rather than failed, exactly
 * what is pending (kind, tool, the human's own reason, how long), and the exact
 * next action.
 *
 * @param sessionId - the still-open session.
 * @param status - its lifecycle state (`running` in practice; `starting` while
 *   the handshake is still in flight).
 * @param details - the projected pending asks; empty is a legitimate case (the
 *   turn is simply taking a while, with nothing blocked on a human).
 * @returns the model-facing prose.
 */
export function renderStillRunning(
  sessionId: string,
  status: string,
  details: readonly CcPendingAskProjection[],
): string {
  if (details.length === 0) {
    return `session ${sessionId} is still running (status: ${status}): the current turn has not produced a `
      + 'result yet, and nothing is waiting on a human. Nothing failed and the session is untouched — call '
      + `claude_code_wait with session_id ${sessionId} again to keep waiting (raise timeout_ms for a longer `
      + 'poll). Do NOT open another Claude Code session for this work.'
  }
  const count = details.length === 1 ? '1 ask' : `${details.length} asks`
  return `session ${sessionId} is still running (status: ${status}) and is BLOCKED on ${count} a human must `
    + `answer in the dsh UI:\n${renderPendingAsks(details)}\n${answerInDshUi(sessionId)}`
}
