/**
 * `claude_code_list` — the session inventory, projected and rendered.
 *
 * The seam has had `ClaudeCode.list()` since Phase 2 and the model has never had
 * a way to reach it. Every other tool here takes a `session_id`, which means the
 * only sessions a model could ask about were the ones it had personally opened
 * and still remembered. `limits.maxConcurrentSessions` is SERVICE-WIDE and the
 * service outlives any one dsh session, so the sessions that actually matter —
 * the ones holding the slots — were precisely the ones nothing could name. In
 * the production trace a fresh agent hit `SESSION_LIMIT` three times while
 * believing it had opened two sessions, and closed its own still-wanted plan
 * session by guesswork.
 *
 * The ORDER is load-bearing and comes from the seam (`buildSessionInventory`):
 * best close candidate first — nothing pending on a human before anything a
 * human is mid-decision on, idle before running, longest-idle first. A model
 * that reads only the first row still reads the right one.
 *
 * Everything here is PURE: `execute` reads the clock once and bakes the ages
 * into the canonical value, so `output.render` is a total function of
 * `(args, value)` and a logged result re-renders to the prose the model saw.
 *
 * @module @deepseek-ai/dsh-tool-claude-code
 */

import { CC_CLOSE_REASONS, CC_SESSION_STATUSES, buildSessionInventory } from '@deepseek-ai/dsh-claude-code'
import type { CcCloseReason, CcSessionSnapshot, CcSessionStatus } from '@deepseek-ai/dsh-claude-code'

import { formatWaiting, PENDING_ASK_DETAILS_SCHEMA, projectPendingAsks, renderPendingAsks } from './pending.ts'
import type { CcPendingAskProjection } from './pending.ts'
import { HUMAN_DECISIONS_SCHEMA, projectHumanDecisions, renderLastDecision } from './receipts.ts'
import type { CcHumanDecisionProjection } from './receipts.ts'

/** One session as `claude_code_list` reports it. */
export interface CcSessionListEntry {
  /** The shared dsh/Claude Code session id — what every other tool here takes. */
  readonly session_id: string
  /** Lifecycle state at list time. */
  readonly status: CcSessionStatus
  /** The working directory it runs in: usually the only thing that says whose session this is. */
  readonly cwd: string
  /** The model in force, when the CLI has reported one. */
  readonly model?: string
  /** How long it has been open, in milliseconds. */
  readonly age_ms: number
  /** How many asks are awaiting a human answer. */
  readonly pending_asks: number
  /** What those asks are. */
  readonly pending_ask_details: CcPendingAskProjection[]
  /**
   * How many asks have SETTLED on this session (bounded by the seam's receipt
   * ring). A count, not the list: a listing has to stay scannable, and the one
   * question it answers is "has anybody been deciding things here?".
   */
  readonly human_decisions_count: number
  /** The most recent settled ask, when there is one — who decided, and what. */
  readonly last_human_decision?: CcHumanDecisionProjection
  /** Why it closed — present only for a closed session, and only with `include_closed`. */
  readonly close_reason?: CcCloseReason
}

/** The output schema for the entries array, shared by the tool declaration and its docs. */
export const SESSION_LIST_SCHEMA = {
  type: 'array',
  required: true,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      session_id: {
        type: 'string',
        required: true,
        description: 'Pass this to claude_code_send / _wait / _status / _cancel / _close.',
      },
      status: { type: 'string', required: true, enum: CC_SESSION_STATUSES },
      cwd: { type: 'string', required: true, description: 'The absolute working directory the session runs in.' },
      model: { type: 'string', description: 'The model in force, when the CLI has reported one.' },
      age_ms: {
        type: 'integer',
        required: true,
        description: 'How long this session has been open, in milliseconds.',
      },
      pending_asks: {
        type: 'integer',
        required: true,
        description: 'How many permission/question asks are awaiting a human answer. Non-zero means a person '
          + 'is mid-decision: do not close this session.',
      },
      pending_ask_details: { ...PENDING_ASK_DETAILS_SCHEMA, required: true },
      human_decisions_count: {
        type: 'integer',
        required: true,
        description: 'How many asks have been SETTLED on this session (permission approvals, question answers, '
          + 'plan reviews), bounded by the seam\'s receipt ring. Zero means nobody has decided anything here.',
      },
      last_human_decision: {
        ...HUMAN_DECISIONS_SCHEMA.items,
        description: 'The most recent settled ask on this session: what it was, how it ended, and whether a '
          + 'human ("decided_by": "human") or a policy settled it. Call claude_code_status for the full list.',
      },
      close_reason: {
        type: 'string',
        enum: CC_CLOSE_REASONS,
        description: 'Why a closed session closed; present only for entries returned by include_closed.',
      },
    },
  },
  description: 'Every session, best close candidate first: sessions with nothing pending on a human come '
    + 'before ones a person is mid-decision on, idle before running, longest-idle first.',
} as const

/**
 * Project the seam's snapshots onto the tool wire shape, in inventory order.
 *
 * @param sessions - the snapshots from `ClaudeCode.list()`.
 * @param now - the clock reading the ages are measured against (injected so this
 *   stays pure and specs can pin it).
 * @returns the entries, best close candidate first.
 */
export function projectSessions(
  sessions: readonly CcSessionSnapshot[],
  now: number,
): CcSessionListEntry[] {
  // Closed sessions are ordered by the same rank as live ones (they are idle
  // with nothing pending, so they sort to the front by idle age) — which is
  // harmless, because a closed entry carries `close_reason` and nothing can be
  // sent to it. The ONE ordering promise this tool makes is the one that
  // matters: no session a human is mid-decision on is ever listed first.
  const inventory = buildSessionInventory(sessions, now)
  const closeReasons = new Map(sessions.map(session => [session.id, session.closeReason]))
  // The inventory entry deliberately carries only what the ORDERING needs; the
  // receipts come from the snapshots the inventory was built from, keyed by the
  // same id, so a row can never show one session's decisions against another's.
  const receipts = new Map(sessions.map(session => [session.id, session.recentAsks]))
  return inventory.map((entry) => {
    const closeReason = closeReasons.get(entry.id)
    const settled = projectHumanDecisions(receipts.get(entry.id) ?? [])
    const last = settled[settled.length - 1]
    return {
      session_id: entry.id,
      status: entry.status,
      cwd: entry.cwd,
      ...(entry.model === undefined ? {} : { model: entry.model }),
      age_ms: entry.ageMs,
      pending_asks: entry.pendingAsks,
      pending_ask_details: projectPendingAsks(entry.pendingAskDetails, now),
      human_decisions_count: settled.length,
      ...(last === undefined ? {} : { last_human_decision: last }),
      ...(closeReason === undefined ? {} : { close_reason: closeReason }),
    }
  })
}

/**
 * What the model reads when nothing is open.
 *
 * Stated explicitly rather than rendered as an empty table: "no sessions" and
 * "this tool returned something I failed to parse" must never look alike, and
 * the empty case is the one where the next action is least obvious.
 */
export const EMPTY_SESSION_LIST
  = 'No Claude Code sessions are open in this composition. Nothing is holding a '
  + 'limits.maxConcurrentSessions slot; open one with claude_code_open.'

/**
 * Render the inventory as a compact listing a model can act on.
 *
 * One row per session, fixed field order, and — because the field that decides
 * whether a session may be closed is the one a table cell would truncate — the
 * pending asks are named on their own indented lines under the row they belong
 * to.
 *
 * @param entries - the projected entries, in inventory order.
 * @param includedClosed - whether closed sessions were requested, so the summary
 *   line can say what the list covers.
 * @returns the model-facing prose.
 */
export function renderSessionList(
  entries: readonly CcSessionListEntry[],
  includedClosed: boolean,
): string {
  if (entries.length === 0) return EMPTY_SESSION_LIST
  const live = entries.filter(entry => entry.close_reason === undefined)
  const blocked = live.filter(entry => entry.pending_asks > 0).length
  const header = `${entries.length} Claude Code session(s)`
    + (includedClosed ? ` (${live.length} live, ${entries.length - live.length} recently closed)` : '')
    + ', best close candidate first:'
  const rows = entries.map((entry, index) => {
    const head = `  ${index + 1}. ${entry.session_id}  ${entry.status}`
      + (entry.close_reason === undefined ? '' : ` (${entry.close_reason})`)
      + `  open ${formatWaiting(entry.age_ms)}`
      + (entry.model === undefined ? '' : `  ${entry.model}`)
      + `  ${entry.cwd}`
    const lines = [head]
    if (entry.pending_ask_details.length > 0) lines.push(renderPendingAsks(entry.pending_ask_details))
    // One line, newest decision only: enough for a reader to see that a person
    // has been answering on this session (or that a policy has been), without
    // turning the inventory into a transcript.
    const decided = renderLastDecision(entry.human_decisions_count, entry.last_human_decision)
    if (decided !== '') lines.push(decided)
    return lines.join('\n')
  })
  const footer = blocked === 0
    ? 'Sessions holding a slot may belong to OTHER dsh sessions sharing this host service — check the cwd '
      + 'before closing one.'
    : `${blocked} session(s) are BLOCKED on a human answering in the dsh UI: do not close those — a person `
      + 'may be mid-decision. Sessions holding a slot may belong to OTHER dsh sessions sharing this host '
      + 'service — check the cwd before closing one.'
  return `${header}\n${rows.join('\n')}\n${footer}`
}
