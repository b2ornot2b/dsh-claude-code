/**
 * Why the concurrency ceiling was reached, in words and in data.
 *
 * `limits.maxConcurrentSessions` is a SERVICE-WIDE cap and the service outlives
 * any one dsh session. In the production trace that motivated this module, an
 * agent hit `SESSION_LIMIT` three times while believing it had opened exactly
 * two sessions: two of the four slots were held by sessions from EARLIER runs of
 * the same host service, one of them parked 1h32m on a permission prompt nobody
 * ever answered (an interactive ask has no timeout, by design). The refusal said
 * only "limits.maxConcurrentSessions (4) is reached", so the agent could not
 * name a single one of the sessions holding a slot — and closed its own
 * still-wanted plan session by guesswork.
 *
 * So a refusal here carries an INVENTORY: every live session, what it is doing,
 * how long it has been there, whether a human is mid-decision on it, and which
 * one is the safe thing to close. Both as prose (the model reads it) and as
 * {@link CcSessionLimitInfo} on `error.data` (a tool layer surfaces it without
 * parsing a sentence that may be reworded tomorrow).
 *
 * Everything here is PURE: the clock is read by the caller and passed in, so the
 * same inputs always produce the same message and the same payload.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { ClaudeCodeError } from './types.ts'
import type {
  CcSessionId, CcSessionInventoryEntry, CcSessionLimitInfo, CcSessionSnapshot,
} from './types.ts'

/**
 * How many pending asks are named individually in the prose before the rest are
 * summarized. One line per ask would let a session blocked on a dozen tool calls
 * push the actionable part of the message out of a model's attention.
 */
export const INVENTORY_ASK_DETAIL_LIMIT = 3

/**
 * Sort rank of one live session as a candidate for closure. Lower closes first.
 *
 * The ordering is the whole point of the inventory, and it encodes two refusals:
 *
 * - a session with a PENDING ASK is last, always. A human may be mid-decision on
 *   it, and closing it throws that decision away and denies the tool call.
 * - a session that is actively RUNNING (or still starting) ranks behind an idle
 *   one, because closing it kills a turn in flight.
 *
 * Within a rank, longest-idle first: the abandoned session is the one nothing
 * has happened on for the longest.
 */
const RANK_IDLE = 0
const RANK_ACTIVE = 1
const RANK_PENDING_ASK = 2

/**
 * Rank one entry as a close candidate.
 * @param entry - the inventory entry.
 * @returns {@link RANK_IDLE}, {@link RANK_ACTIVE} or {@link RANK_PENDING_ASK}.
 */
function closeRank(entry: CcSessionInventoryEntry): number {
  if (entry.pendingAsks > 0) return RANK_PENDING_ASK
  return entry.status === 'running' || entry.status === 'starting' ? RANK_ACTIVE : RANK_IDLE
}

/**
 * Project live snapshots into the inventory, best close candidate first.
 *
 * @param sessions - the live session snapshots (`ClaudeCode.list()`).
 * @param now - the clock reading the two durations are measured against,
 *   injected so this stays pure and a spec can pin it.
 * @returns a fresh sorted array; empty in, empty out.
 */
export function buildSessionInventory(
  sessions: readonly CcSessionSnapshot[],
  now: number,
): CcSessionInventoryEntry[] {
  const entries = sessions.map<CcSessionInventoryEntry>(session => ({
    id: session.id,
    cwd: session.cwd ?? '(unknown)',
    status: session.status,
    ...(session.model === undefined ? {} : { model: session.model }),
    ageMs: elapsed(now, session.openedAt),
    idleMs: elapsed(now, session.lastActivityAt),
    pendingAsks: Number.isFinite(session.pendingAsks) ? session.pendingAsks : 0,
    // Normalized, not trusted. `@deepseek-ai/dsh-claude-code` and
    // `@deepseek-ai/dsh-tool-claude-code` are published and RESOLVED separately,
    // so a deployment can legitimately run a tool package newer than the seam it
    // calls — and a snapshot from a seam built before this field existed would
    // make `renderEntry` throw on `.slice` of undefined while building the very
    // message that explains a refusal. An inventory that reports a session
    // imprecisely is a diagnostic; an inventory that throws is an outage.
    pendingAskDetails: session.pendingAskDetails ?? [],
  }))
  return entries.sort((left, right) => {
    const byRank = closeRank(left) - closeRank(right)
    if (byRank !== 0) return byRank
    const byIdle = right.idleMs - left.idleMs
    if (byIdle !== 0) return byIdle
    const byAge = right.ageMs - left.ageMs
    if (byAge !== 0) return byAge
    // Total order, so the same registry always renders the same message.
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/**
 * Assemble the structured payload a `SESSION_LIMIT` refusal carries.
 *
 * @param sessions - the live session snapshots at the moment of refusal.
 * @param limit - the configured `limits.maxConcurrentSessions`.
 * @param now - the clock reading.
 * @returns the inventory, with `closeCandidate` set to the first session that is
 *   NOT holding a human decision — absent when every live session has one.
 */
export function buildSessionLimitInfo(
  sessions: readonly CcSessionSnapshot[],
  limit: number,
  now: number,
): CcSessionLimitInfo {
  const inventory = buildSessionInventory(sessions, now)
  // Deliberately not "the first entry": when every session has a pending ask the
  // first entry is still the least-bad one, and recommending it would tell the
  // caller to discard a decision a person is in the middle of making.
  const candidate = inventory.find(entry => entry.pendingAsks === 0)
  return {
    limit,
    liveCount: sessions.length,
    sessions: inventory,
    ...(candidate === undefined ? {} : { closeCandidate: candidate.id }),
  }
}

/**
 * Milliseconds between a timestamp and now, floored at zero and total.
 *
 * Zero rather than a negative or a `NaN` for two reasons: a clock that stepped
 * backwards (NTP, a rewound fake timer) must not report a session as opened in
 * the future, and a snapshot missing the timestamp entirely (see
 * {@link buildSessionInventory}) must degrade to "just now" rather than poison
 * the sort comparator, which would leave the ordering unspecified.
 *
 * @param now - the clock reading.
 * @param since - the epoch timestamp being measured from.
 * @returns a finite, non-negative duration in milliseconds.
 */
function elapsed(now: number, since: number): number {
  const ms = Math.round(now - since)
  return Number.isFinite(ms) ? Math.max(0, ms) : 0
}

/**
 * Render a duration the way a person reads one.
 * @param ms - the elapsed milliseconds.
 * @returns `"9s"`, `"10m 03s"` or `"1h 32m"`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '0s'
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * One inventory line: what this session is, and whether it can be closed.
 * @param entry - the inventory entry.
 * @param index - its zero-based position in the sorted inventory.
 * @returns the line, with no trailing newline.
 */
function renderEntry(entry: CcSessionInventoryEntry, index: number): string {
  const head = `  ${index + 1}. ${entry.id} — ${entry.status}, cwd ${entry.cwd}, `
    + `open ${formatDuration(entry.ageMs)}, idle ${formatDuration(entry.idleMs)}`
    + (entry.model === undefined ? '' : `, model ${entry.model}`)
  if (entry.pendingAsks === 0) return head
  const named = entry.pendingAskDetails.slice(0, INVENTORY_ASK_DETAIL_LIMIT)
    .map(ask => `${ask.kind} ask for "${ask.toolName}"${ask.reason === undefined ? '' : ` — ${ask.reason}`}`)
    .join('; ')
  const more = entry.pendingAskDetails.length > INVENTORY_ASK_DETAIL_LIMIT
    ? ` (+${entry.pendingAskDetails.length - INVENTORY_ASK_DETAIL_LIMIT} more)`
    : ''
  return `${head}\n     BLOCKED on ${entry.pendingAsks} pending ask(s) a human must answer`
    + (named === '' ? '' : `: ${named}${more}`)
    + ' — do NOT close this one; somebody may be mid-decision.'
}

/**
 * The prose half of a `SESSION_LIMIT` refusal.
 *
 * It says, in this order and on purpose: what was refused; that the sessions
 * holding the slots MAY NOT BE YOURS (the single fact the production agent could
 * not deduce, and the reason it closed the wrong one); the inventory itself,
 * best close candidate first; and the one concrete next action.
 *
 * @param info - the structured inventory.
 * @returns the message, ready to be the error's `message`.
 */
export function renderSessionLimit(info: CcSessionLimitInfo): string {
  const header = `claude-code: cannot open another session — limits.maxConcurrentSessions (${info.limit}) is `
    + `reached, with ${info.liveCount} session(s) live right now. This limit is SERVICE-WIDE and the service `
    + 'outlives any one dsh session, so some of the sessions below may belong to OTHER dsh sessions (or to '
    + 'earlier runs) sharing this host — they are not necessarily ones you opened. Call claude_code_list to '
    + 'see this inventory at any time.'
  if (info.sessions.length === 0) {
    // Reachable only through a misconfiguration (a limit of zero); say so rather
    // than print an empty list under a header promising one.
    return `${header}\nNo sessions are registered, so the limit itself is the problem: raise `
      + 'limits.maxConcurrentSessions in this composition.'
  }
  const body = info.sessions.map(renderEntry).join('\n')
  const advice = info.closeCandidate === undefined
    ? 'EVERY live session is blocked on a pending human answer, so there is no safe one to close. Wait for a '
      + 'person to answer one of the prompts above (or close one deliberately, accepting that its pending ask '
      + 'is denied), then retry.'
    : `Best candidate to close: ${info.closeCandidate} (longest idle, nothing pending on a human). Call `
      + `claude_code_close with session_id ${info.closeCandidate} if you are sure it is not still wanted, then `
      + 'retry this open. Sessions are listed best-candidate-first.'
  return `${header}\nLive sessions, best close candidate first:\n${body}\n${advice}`
}

/**
 * Build the `SESSION_LIMIT` refusal: prose and structured payload from ONE
 * inventory, so the two can never disagree.
 *
 * @param sessions - the live session snapshots at the moment of refusal.
 * @param limit - the configured `limits.maxConcurrentSessions`.
 * @param now - the clock reading.
 * @returns the error, ready to throw.
 */
export function sessionLimitError(
  sessions: readonly CcSessionSnapshot[],
  limit: number,
  now: number,
): ClaudeCodeError {
  const info = buildSessionLimitInfo(sessions, limit, now)
  return new ClaudeCodeError(renderSessionLimit(info), 'SESSION_LIMIT', { data: { sessionLimit: info } })
}

/**
 * Whether ONE session may be reclaimed by the idle sweep, right now.
 *
 * Three conditions, all required, and the second one is the one that matters:
 * `idle` status, ZERO pending asks, and no activity for `idleTimeoutMs`. A
 * session with a pending ask is never eligible however long it has sat — that is
 * a human still deciding, and reaping it would deny their tool call for them.
 *
 * Exported as a single-session predicate, not just as the filter behind
 * {@link selectReapable}, because a sweep that closes several sessions AWAITS
 * between them: an ask raised by the SDK, or a `send()` from a tool call, lands
 * in exactly that gap and would otherwise be reaped on the strength of a
 * selection taken before it existed. The sweep re-asks this question about each
 * session immediately before closing it.
 *
 * @param session - the session snapshot, taken now.
 * @param idleTimeoutMs - the configured idle ceiling.
 * @param now - the clock reading.
 * @returns true when the session is idle, unblocked and past the ceiling.
 */
export function isReapable(
  session: CcSessionSnapshot,
  idleTimeoutMs: number,
  now: number,
): boolean {
  return session.status === 'idle'
    && session.pendingAsks === 0
    && now - session.lastActivityAt >= idleTimeoutMs
}

/**
 * Which sessions the idle sweep may reclaim.
 *
 * @param sessions - the live session snapshots.
 * @param idleTimeoutMs - the configured idle ceiling.
 * @param now - the clock reading.
 * @returns the ids to close, longest-idle first (a deterministic order, so a
 *   sweep that closes several logs them in a stable sequence).
 */
export function selectReapable(
  sessions: readonly CcSessionSnapshot[],
  idleTimeoutMs: number,
  now: number,
): CcSessionId[] {
  return sessions
    .filter(session => isReapable(session, idleTimeoutMs, now))
    .sort((left, right) => left.lastActivityAt - right.lastActivityAt)
    .map(session => session.id)
}
