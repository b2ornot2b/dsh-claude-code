/**
 * Public type vocabulary of the Claude Code seam: session identity, open
 * options, status/snapshot projections, and the error taxonomy. Everything a
 * consumer package (`dsh-tool-claude-code`, `dsh-claude-code-agent`) needs to
 * describe a Claude Code session without importing the Claude Agent SDK.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { randomUUID } from 'node:crypto'

import type { PermissionMode, SettingSource } from '@anthropic-ai/claude-agent-sdk'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session as DshSession } from '@deepseek-ai/dsh-session'

import type { CcAskReceipt, CcPendingAsk } from './ask/table.ts'
import type { CcAskTarget } from './ask/types.ts'
import type { CcMirrorHandle, CcMirrorOptions } from './mirror.ts'

/**
 * A Claude Code session id. It IS a dsh {@link SessionId} — the same value is
 * handed to the dsh session store/agent registry and to the SDK as
 * `options.sessionId`, so there is no id map in either direction.
 *
 * The SDK requires a valid UUID, and dsh session ids are unvalidated branded
 * strings whose default mints are NOT UUIDs (`session-<counter>`,
 * `<agentId>-session-<uuid>`). Therefore every CC-backed session id is minted
 * HERE with {@link newCcSessionId}; an externally supplied dsh id is never
 * accepted for the SDK side.
 */
export type CcSessionId = SessionId

/**
 * Mint a fresh session id shared by dsh and Claude Code: a bare UUID branded as
 * a dsh {@link SessionId}.
 *
 * Fork included — Phase 0 spike 1 proved `resume` + `forkSession: true` honors a
 * caller-supplied fresh uuid for the fork, so dsh mints fork ids too and the
 * source session is left untouched.
 * @returns a new bare-UUID session id.
 */
export function newCcSessionId(): CcSessionId {
  return SessionId(randomUUID())
}

/**
 * Whether a string is shaped like a session id this seam can hand to the SDK
 * (a bare RFC 4122 UUID). Consumers that receive an id from the model must
 * check it before calling {@link ClaudeCode.get} so a malformed id fails at the
 * tool boundary instead of inside the subprocess.
 * @param id - the candidate id.
 * @returns true when the id is a bare UUID.
 */
export function isCcSessionId(id: string): boolean {
  return UUID_PATTERN.test(id)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Claude Code's permission modes, verified against SDK 0.3.233. `dontAsk`
 * denies interactive tools without ever invoking the permission callback, and
 * `bypassPermissions`/`acceptEdits` skip the callback for the tools they
 * auto-approve — in those modes the dsh approval seam sees nothing.
 */
export type CcPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'

/** Every {@link CcPermissionMode}, for config validation and option advertisement. */
export const CC_PERMISSION_MODES: readonly CcPermissionMode[] = [
  'default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto',
]

// Compile-time proof that our union stays exactly the SDK's. If a future SDK
// bump adds or removes a mode, THIS breaks the build instead of a config value
// silently failing inside the subprocess.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _permissionModesMatchSdk: Same<CcPermissionMode, PermissionMode> = true
void _permissionModesMatchSdk

/**
 * Which on-disk setting layers the embedded agent may load. **Omitting
 * `settingSources` entirely makes the SDK load ALL of them** (user settings,
 * project settings, `CLAUDE.md`) — isolation is opt-in, so this seam always
 * passes an explicit list, empty by default.
 */
export type CcSettingSource = 'user' | 'project' | 'local'

/** Every {@link CcSettingSource}. */
export const CC_SETTING_SOURCES: readonly CcSettingSource[] = ['user', 'project', 'local']

const _settingSourcesMatchSdk: Same<CcSettingSource, SettingSource> = true
void _settingSourcesMatchSdk

/**
 * How Claude Code authenticates. `subscription` uses the machine's claude.ai
 * login and REQUIRES `ANTHROPIC_API_KEY` to be stripped from the subprocess
 * env (leaving it set silently bills the API instead, with no error).
 */
export type CcAuthMode = 'subscription' | 'api-key'

/** Every {@link CcAuthMode}. */
export const CC_AUTH_MODES: readonly CcAuthMode[] = ['subscription', 'api-key']

/**
 * What to do when an ask cannot reach a human: the delegated-agent case
 * (`DELEGATED_CALLER`), an absent answerer (`unavailable`, `NO_PROVIDER`), a
 * dismissed prompt, or a timeout.
 *
 * - `deny` — answer the SDK with a deny carrying an explanation (the default).
 * - `first-option` — pick the first offered option; only defensible for
 *   questions, never for permissions.
 * - `error` — deny AND interrupt the session, surfacing the failure upward.
 */
export type AskFallback = 'deny' | 'first-option' | 'error'

/** Every {@link AskFallback}. */
export const ASK_FALLBACKS: readonly AskFallback[] = ['deny', 'first-option', 'error']

/**
 * Session lifecycle as the seam reports it:
 * - `starting` — constructed, awaiting the SDK's initialize result.
 * - `running` — a turn is in flight (first send until `SDKResultMessage`).
 * - `idle` — initialized, no turn in flight; accepts sends.
 * - `closed` — the SDK query is closed; the record is retained only until the
 *   owning effect disposes it.
 */
export type CcSessionStatus = 'starting' | 'running' | 'idle' | 'closed'

/** Every {@link CcSessionStatus}. */
export const CC_SESSION_STATUSES: readonly CcSessionStatus[] = ['starting', 'running', 'idle', 'closed']

/**
 * WHY a session reached `closed`. A session reaches `closed` through exactly one
 * path — the close sequence in `CcSession.close()` — but it can be ENTERED for
 * three different reasons, and a consumer has to tell them apart:
 *
 * - `closed` — somebody asked: `claude_code_close`, `ClaudeCode.close()`, owner
 *   disposal, plugin teardown. The subprocess was alive and was shut down.
 * - `exited` — the subprocess ended on its own with no turn in flight. A clean
 *   exit: the CLI was done, or something outside dsh stopped it between turns.
 *   Any `waitForResult()` parked at that moment is answered with the last real
 *   result rather than failed, because the session did produce one.
 * - `crashed` — the subprocess ended MID-TURN, or its message iterator threw.
 *   The turn it was running will never produce a result: waiters fail with
 *   `SESSION_CLOSED`, the mirror's dangling turn is finalized as aborted, and a
 *   background job settles `failed` rather than `completed`.
 * - `reaped` — the service's idle sweep closed it because it had been idle,
 *   with NO pending ask, for longer than `limits.idleTimeoutMs`. Mechanically
 *   identical to `closed` (same close sequence, same mirror finalize, same
 *   tombstone); it is a separate reason because nobody asked, and a caller
 *   whose session vanished deserves to read "the composition reclaimed it after
 *   N ms idle" instead of "somebody closed it". Only ever produced when an
 *   operator opted in — the timeout is unset by default.
 *
 * The distinction is observable ONLY through {@link CcSessionSnapshot.closeReason}
 * and {@link CcSession.onClose}; `status` collapses all four to `closed`,
 * because for everything that merely asks "can I still send to this?" they are
 * the same answer.
 */
export type CcCloseReason = 'closed' | 'exited' | 'crashed' | 'reaped'

/** Every {@link CcCloseReason}. */
export const CC_CLOSE_REASONS: readonly CcCloseReason[] = ['closed', 'exited', 'crashed', 'reaped']

/**
 * The diagnostics sink a session writes subprocess stderr and lifecycle notes
 * to. Structural on purpose: cordis's `ctx.logger` satisfies it, and so does a
 * two-line test double — the seam never needs the rest of a logger's surface.
 */
export interface CcLogger {
  /**
   * Record a diagnostic line.
   * @param message - the line.
   */
  debug(message: string): void
}

/** Context-window occupancy of a live Claude Code session, when it reports one. */
export interface CcContextUsage {
  /** Tokens currently occupied by the session's live context. */
  readonly usedTokens: number
  /** The model's context window, when the SDK reports it. */
  readonly maxTokens?: number
}

/**
 * Mirror one session into a dsh session log from the moment it opens.
 *
 * Attaching at open time (rather than after {@link ClaudeCode.open} returns) is
 * what captures the FIRST prompt: `open({ prompt })` sends it synchronously, and
 * a mirror attached afterwards would have missed the `turn/start` +
 * `user/message` that prompt produces.
 *
 * `@deepseek-ai/dsh-session` stays OPTIONAL for pure-SDK consumers: it is a peer
 * dependency used for types here, and a consumer that never passes a session
 * never constructs one.
 */
export interface CcMirrorAttachment extends CcMirrorOptions {
  /** The dsh session to mirror into. It may already hold events (a resumed log). */
  readonly session: DshSession
}

/** How to open (or resume, or fork) a Claude Code session. */
export interface CcOpenOptions {
  /** Absolute working directory the session runs in. Required. */
  readonly cwd: string
  /** First user message. Omit to open an idle session and send later. */
  readonly prompt?: string
  /** Model id; omitted means the CLI default (or `defaults.model` from config). */
  readonly model?: string
  /** Permission mode; omitted means `defaults.permissionMode` from config. */
  readonly permissionMode?: CcPermissionMode
  /**
   * Resume this existing session's history. The SDK forbids combining a
   * caller-supplied `sessionId` with `resume` unless `fork` is set, so a plain
   * resume continues under the SAME id and a fork mints a new one.
   */
  readonly resume?: CcSessionId
  /**
   * Fork the resumed session instead of continuing it: history carries over,
   * the source session is untouched, and the fork gets a freshly minted dsh id.
   * Ignored without `resume`.
   */
  readonly fork?: boolean
  /**
   * Run detached from the caller's tool call (registered as a dsh job) instead
   * of synchronously. Consumers, not this seam, own the job registration.
   */
  readonly background?: boolean
  /**
   * Mirror this session into a dsh session log (§5). Attached BEFORE the first
   * prompt is sent, so the opening turn is framed. The attachment is disposed
   * automatically when the session closes.
   */
  readonly mirror?: CcMirrorAttachment
  /**
   * Who answers this session's permission prompts, clarifying questions and
   * plan reviews (§4). Attached BEFORE the first prompt, so the very first tool
   * call can be decided by a human instead of failing closed.
   *
   * Omitted, the session still runs — and denies every tool call it is asked
   * about, with an explanation. That is the correct posture for a session
   * nobody is watching.
   */
  readonly ask?: CcAskTarget
}

/**
 * Serializable projection of one session's state. Snapshots are values, never
 * live handles: cordis hands out a fresh traceable proxy per service access, so
 * consumers must never identity-compare anything obtained from the seam.
 */
export interface CcSessionSnapshot {
  /** The shared dsh/CC session id. */
  readonly id: CcSessionId
  /** Lifecycle state at snapshot time. */
  readonly status: CcSessionStatus
  /**
   * The absolute working directory the session runs in — the single most useful
   * thing for telling two sessions apart, and the reason it is carried on the
   * value rather than left inside the actor. A caller staring at four opaque
   * UUIDs at the concurrency ceiling cannot act on any of them; `/repo/api` vs
   * `/repo/web` it can.
   */
  readonly cwd: string
  /** Epoch ms the session was constructed (before the SDK handshake). */
  readonly openedAt: number
  /**
   * Epoch ms of the last thing that happened on this session: a send, a message
   * from the subprocess, or its close. `now - lastActivityAt` is the idle age
   * the inventory sorts on and the idle sweep (`limits.idleTimeoutMs`) reaps on.
   */
  readonly lastActivityAt: number
  /** The model in force, when known — absent while the CLI default applies and the SDK has not yet reported one. */
  readonly model?: string
  /** Number of permission/question asks currently awaiting an answer. */
  readonly pendingAsks: number
  /**
   * WHAT those asks are — one entry per pending ask, in arrival order, empty
   * when nothing is pending.
   *
   * Carried ALONGSIDE the count rather than replacing it: `pendingAsks` is
   * already in the `claude_code_status` tool schema, and a count is what most
   * callers branch on. This is what makes the pending state actionable — "a
   * human must approve `Write: /tmp/notes.txt`" instead of "1 pending ask(s)",
   * which is all the seam could say when a real session spent thirty minutes
   * blocked on an unanswered approval nobody upstream could name.
   */
  readonly pendingAskDetails: readonly CcPendingAsk[]
  /**
   * What has already been DECIDED, newest last: one {@link CcAskReceipt} per
   * settled ask, bounded to the last 20 of them (the ask table's receipt ring).
   *
   * `pendingAskDetails` made the WAITING visible; this makes the ANSWER visible.
   * Permission approvals, clarifying questions and plan reviews are all answered
   * by a person in the dsh UI, and once answered they left no trace at all — so
   * a delegating agent could not distinguish "a human chose hola" from "Claude
   * invented hola", nor "the human approved the plan" from "plan mode never
   * engaged", and graded a correct system as broken. Each receipt says how the
   * ask ended AND whether a human (`source: 'human'`) or a policy
   * (`source: 'policy'` — fallback, timeout, rule cache, session close) ended it.
   *
   * Always present, empty when nothing has settled: an absent array would make
   * "nothing was decided" and "this build cannot tell you" the same value.
   */
  readonly recentAsks: readonly CcAskReceipt[]
  /**
   * Epoch ms the current (or most recent) turn started; ABSENT until the
   * session's first send.
   *
   * Carried so a consumer can filter {@link CcSessionSnapshot.recentAsks} down
   * to the turn it actually waited on (`settledAt >= turnStartedAt`) instead of
   * reporting a previous turn's decisions as this one's.
   */
  readonly turnStartedAt?: number
  /** Context-window occupancy, when the session has reported usage. */
  readonly contextUsage?: CcContextUsage
  /**
   * Why the session closed. Present exactly when `status` is `closed`, absent
   * otherwise — an ADDITIVE optional field, so every consumer written before it
   * existed still reads a valid snapshot.
   *
   * This is the only place `exited`/`crashed` are distinguishable: a subprocess
   * that died on its own now closes its own session (the pump-completion close
   * path), which means a `closed` snapshot no longer implies anybody asked for
   * it. See {@link CcCloseReason}.
   */
  readonly closeReason?: CcCloseReason
}

/** How to read the session registry. */
export interface CcListOptions {
  /**
   * Also return the recently-closed sessions the service still holds tombstones
   * for (`CLOSED_SESSION_HISTORY`), newest-closed last. Defaults to false —
   * `list()` has always meant LIVE sessions, and a caller counting slots against
   * `limits.maxConcurrentSessions` must not accidentally count corpses.
   */
  readonly includeClosed?: boolean
}

/**
 * One live session as the concurrency inventory describes it: everything a
 * caller needs to decide whether THIS is the session it can afford to close.
 *
 * A projection of {@link CcSessionSnapshot} with the two clock readings already
 * subtracted, because the consumer that needs this most is a model, and a model
 * has no clock to subtract an epoch timestamp with.
 */
export interface CcSessionInventoryEntry {
  /** The shared dsh/CC session id — what you pass to `close()`. */
  readonly id: CcSessionId
  /** Its working directory: usually the only thing that identifies whose session this is. */
  readonly cwd: string
  /** Lifecycle state at inventory time. */
  readonly status: CcSessionStatus
  /** The model in force, when the CLI has reported one. */
  readonly model?: string
  /** How long the session has been open, in ms. */
  readonly ageMs: number
  /** How long since anything happened on it, in ms. The primary "is this abandoned?" signal. */
  readonly idleMs: number
  /** How many asks are awaiting a human answer. Non-zero means DO NOT close this one. */
  readonly pendingAsks: number
  /** What those asks are, so the prose can name the tool a person is looking at. */
  readonly pendingAskDetails: readonly CcPendingAsk[]
}

/** Where a discovered session came from, and therefore what is true of it. */
export type CcSessionOrigin = 'composed' | 'live-external' | 'resumable'

/** Runtime list of {@link CcSessionOrigin}, for schema enums. */
export const CC_SESSION_ORIGINS: readonly CcSessionOrigin[]
  = ['composed', 'live-external', 'resumable']

/** How wide a net {@link ClaudeCode.discover} casts. */
export type CcDiscoveryScope = 'composition' | 'host' | 'mesh'

/** Runtime list of {@link CcDiscoveryScope}, for schema enums. */
export const CC_DISCOVERY_SCOPES: readonly CcDiscoveryScope[] = ['composition', 'host', 'mesh']

/**
 * One session as discovery reports it, from any origin.
 *
 * `sendable` and `resumable` are carried explicitly rather than re-derived from
 * `origin` by every consumer: the rule belongs in one place, and a model that
 * cannot tell "I may send to this" from "I may only fork it" will try to send.
 */
export interface CcDiscoveredSession {
  readonly sessionId: CcSessionId
  readonly origin: CcSessionOrigin
  /** The host label that reported it; the local host names itself. */
  readonly host: string
  /** Which source reported it — for debugging a wrong answer. */
  readonly sourceId: string
  /** Working directory, translated to THIS host's paths where a map applies. */
  readonly cwd: string
  /** The untranslated path, present only when translation changed it. */
  readonly remoteCwd?: string
  readonly title?: string
  readonly gitBranch?: string
  /** Clock-normalized against the reporting source's own clock. */
  readonly lastActivityAt: number
  readonly createdAt?: number
  /** True only for `composed` sessions: nothing else has a control channel. */
  readonly sendable: boolean
  readonly resumable: boolean
  /** `sdk` metadata is authoritative; `probe` metadata is reconstructed. */
  readonly fidelity: 'sdk' | 'probe'
  readonly live?: {
    readonly pid?: number
    readonly kind?: string
    readonly entrypoint?: string
    readonly claudeVersion?: string
    readonly liveness: 'confirmed' | 'assumed'
  }
  /** Present exactly when `origin === 'composed'`. */
  readonly composed?: CcSessionSnapshot
  readonly sizeBytes?: number
}

/** What a source or the coordinator returns. Partial results plus warnings. */
export interface CcDiscoveryResult {
  readonly sessions: readonly CcDiscoveredSession[]
  /** Named degradations, e.g. `b2hx: unreachable (ssh connect timeout 6000ms)`. */
  readonly warnings: readonly string[]
  readonly generatedAt: number
  readonly cached: boolean
}

/** What the coordinator asks a source for. */
export interface CcDiscoverRequest {
  readonly now: number
  readonly includeResumable: boolean
  readonly recentWindowMs: number
  readonly maxResumable: number
  readonly includeTitles: boolean
  readonly signal?: AbortSignal
}

/** A contributor of sessions the composition did not open. */
export interface CcDiscoverySource {
  readonly id: string
  readonly host: string
  discover(request: CcDiscoverRequest): Promise<CcDiscoveryResult>
}

/** Caller-facing options for {@link ClaudeCode.discover}. */
export interface CcDiscoverOptions {
  readonly scope?: CcDiscoveryScope
  readonly includeResumable?: boolean
  /** Bypass the TTL cache. */
  readonly refresh?: boolean
}

/**
 * The structured payload carried by a `SESSION_LIMIT` refusal: who is holding
 * the slots, and which one is safe to close.
 *
 * This exists because of a real production trace. An agent hit
 * `limits.maxConcurrentSessions` three times while believing it had opened two
 * sessions — the other slots were held by sessions from EARLIER runs of the same
 * host service, one of them parked 1h32m on an approval nobody ever answered.
 * The refusal named only the limit, so the agent could not tell which sessions
 * existed, let alone which were abandoned, and closed its own still-wanted plan
 * session by guesswork.
 */
export interface CcSessionLimitInfo {
  /** The configured ceiling that was reached. */
  readonly limit: number
  /** How many sessions are live right now (equal to `limit` at the moment of refusal). */
  readonly liveCount: number
  /**
   * Every live session, sorted best-close-candidate first: sessions with no
   * pending human ask before sessions with one, idle before actively working,
   * longest-idle first within each group.
   */
  readonly sessions: readonly CcSessionInventoryEntry[]
  /**
   * The id the caller should close if it must free a slot, or ABSENT when every
   * live session has a pending ask — a human may still be deciding on each of
   * them, and recommending one for closure would throw that decision away.
   */
  readonly closeCandidate?: CcSessionId
}

/**
 * Machine-readable specifics attached to a {@link ClaudeCodeError}.
 *
 * `HarnessError` carries only a `code`, which is enough to ROUTE on and never
 * enough to ACT on. A consumer that wants the detail behind a refusal otherwise
 * has to parse the message — and a tool layer parsing prose is a defect waiting
 * for the first reworded sentence.
 */
export interface CcErrorData {
  /** Present on every `SESSION_LIMIT` refusal: the full live-session inventory. */
  readonly sessionLimit?: CcSessionLimitInfo
}

/** Options for {@link ClaudeCodeError}: the standard `cause`, plus structured `data`. */
export interface ClaudeCodeErrorOptions extends ErrorOptions {
  /** Machine-readable specifics for this failure; omitted when the code carries none. */
  readonly data?: CcErrorData
}

/**
 * Which authentication is actually live, projected from the SDK's
 * `accountInfo()` plus the mode this service constructed the env for. Surfaced
 * so a user can confirm a subscription session is not silently billing an API
 * key.
 */
export interface CcAccountInfo {
  /** The mode this service configured (what we intended). */
  readonly auth: CcAuthMode
  /** Account email, when the CLI reports one. */
  readonly email?: string
  /** Organization name, when the CLI reports one. */
  readonly organization?: string
  /** Subscription tier (e.g. a Max plan), when the CLI reports one. */
  readonly subscriptionType?: string
  /** Active API backend as the CLI names it (`firstParty`, `bedrock`, …). */
  readonly apiProvider?: string
}

/**
 * Stable machine-routable failure classes for this seam. Route on the code,
 * never by parsing a message.
 */
export type CcErrorCode =
  /** The requested capability lands in a later phase; the message names it. */
  | 'NOT_IMPLEMENTED'
  /** No session with that id is registered in this context. */
  | 'UNKNOWN_SESSION'
  /** `limits.maxConcurrentSessions` would be exceeded. */
  | 'SESSION_LIMIT'
  /**
   * A plain resume targets a session that is STILL OPEN in this context. It
   * would continue under the same id (the SDK forbids a fresh one without
   * `fork`), overwriting the live registry entry and leaving two queries on one
   * transcript. Close it first, or fork it.
   */
  | 'SESSION_EXISTS'
  /** The session id is not a bare UUID and cannot be handed to the SDK. */
  | 'INVALID_SESSION_ID'
  /** Configuration is internally inconsistent (e.g. api-key auth with no credential ref). */
  | 'INVALID_CONFIG'
  /** The session is closed (or closing): sends, interrupts and waiters are refused. */
  | 'SESSION_CLOSED'
  /** `cwd` is missing, relative, or not an existing directory — caught BEFORE any subprocess spawns. */
  | 'INVALID_CWD'
  /** A composition-level question was asked with no live session to answer it (e.g. `accountInfo()`). */
  | 'NO_LIVE_SESSION'
  /** A bounded wait elapsed (e.g. `waitForResult(timeoutMs)`); the session is untouched and still live. */
  | 'TIMEOUT'
  /** The Claude Agent SDK failed to start or drive the session; `cause` carries the original error. */
  | 'BACKEND_ERROR'
  /**
   * An ask could not reach a human and `ask.fallback` is `'error'`: the tool
   * call was denied with `interrupt: true` and this is the failure the owning
   * consumer reports. Never thrown into `canUseTool` — a rejected permission
   * promise hangs the Claude Code session forever.
   */
  | 'ASK_UNANSWERABLE'
  /**
   * The session was constructed without a dsh ask channel, so it has nothing to
   * attach an ask target (or a call site) to.
   */
  | 'ASK_UNAVAILABLE'
  /**
   * A plain resume was refused because the target session is running
   * elsewhere. Two writers on one transcript corrupts it; fork instead.
   */
  | 'SESSION_LIVE_ELSEWHERE'

/** Error taxonomy for the Claude Code seam. */
export class ClaudeCodeError extends HarnessError {
  /**
   * Machine-readable specifics, `undefined` when this code carries none.
   *
   * Declared explicitly nullable rather than optional: `exactOptionalPropertyTypes`
   * rejects assigning a possibly-undefined value to `data?: …`, and a field this
   * is read off in a `catch` must not depend on the constructor having spread it
   * conditionally.
   */
  readonly data: CcErrorData | undefined

  /**
   * @param message - human-readable explanation.
   * @param code - the stable {@link CcErrorCode} consumers route on.
   * @param options - standard error options (`cause`) plus optional structured `data`.
   */
  constructor(message: string, code: CcErrorCode, options: ClaudeCodeErrorOptions = {}) {
    super(message, code, options)
    this.name = 'ClaudeCodeError'
    this.data = options.data
  }
}

/**
 * The `ctx.claudeCode` surface consumers may rely on. Implemented by
 * `ClaudeCodeService`; stated as an interface so consumer packages can type
 * against the capability rather than the class.
 */
export interface ClaudeCode {
  /**
   * Open (or resume, or fork) a Claude Code session.
   * @param options - working directory, first prompt, model, permission mode, resume/fork.
   * @returns the new session's snapshot.
   * @throws {ClaudeCodeError} code `NOT_IMPLEMENTED` until Phase 2 lands the session actor.
   */
  open(options: CcOpenOptions): Promise<CcSessionSnapshot>
  /**
   * Look up one registered session.
   * @param id - the shared dsh/CC session id.
   * @returns its snapshot, or `undefined` when no such session is registered here.
   */
  get(id: CcSessionId): CcSessionSnapshot | undefined
  /**
   * Every session registered in this context, in open order.
   * @param options - `{ includeClosed: true }` appends the recently-closed
   *   tombstones; omitted means LIVE sessions only, as it always has.
   * @returns a snapshot array (a fresh array per call; never a live view).
   */
  list(options?: CcListOptions): readonly CcSessionSnapshot[]
  /**
   * Close one session: settle its pending asks as denied, then close the SDK
   * query. Idempotent.
   * @param id - the shared dsh/CC session id.
   * @returns true when a session was closed, false when the id was unknown.
   */
  close(id: CcSessionId): Promise<boolean>
  /**
   * Mirror an already-open session into a dsh session log (§5).
   *
   * Prefer `open({ mirror })` when the session is being opened with a prompt:
   * that prompt is sent synchronously inside `open()`, so a mirror attached
   * afterwards misses the turn it starts. This entry point exists for a session
   * opened idle, or for attaching a second log (a UI projection) later.
   *
   * @param id - the shared dsh/CC session id.
   * @param session - the dsh session to append to.
   * @param options - subagent policy, compaction policy, provider name, logger.
   * @returns the mirror and its unsubscribe function; disposed automatically
   *   when the Claude Code session closes.
   * @throws {ClaudeCodeError} code `UNKNOWN_SESSION` when the id is not registered.
   */
  attachMirror(id: CcSessionId, session: DshSession, options?: CcMirrorOptions): CcMirrorHandle
  /**
   * Attach (or replace) who answers one session's asks (§4.5).
   *
   * Prefer `open({ ask })` when the session is opened with a prompt: that
   * prompt is sent synchronously inside `open()`, so a target attached
   * afterwards can miss the first tool call and see it denied fail-closed.
   *
   * @param id - the shared dsh/CC session id.
   * @param target - the dsh agent and its optional seam overrides.
   * @returns a disposer detaching exactly this target.
   * @throws {ClaudeCodeError} code `UNKNOWN_SESSION` when the id is not registered.
   */
  attachAskTarget(id: CcSessionId, target: CcAskTarget): () => void
  /**
   * Which authentication is live for this composition.
   * @returns the account projection.
   * @throws {ClaudeCodeError} code `NOT_IMPLEMENTED` until Phase 2 owns a live query.
   */
  accountInfo(): Promise<CcAccountInfo>
  /**
   * Every session this composition can see, from every registered source.
   * Never rejects: source failures come back as `warnings` (spec §10).
   * @param options - scope and cache control.
   * @returns the merged, deduped, clock-normalized inventory.
   */
  discover(options?: CcDiscoverOptions): Promise<CcDiscoveryResult>
  /**
   * Contribute sessions from outside this composition.
   * @param source - the source to add.
   * @returns a disposer that removes it.
   */
  registerDiscoverySource(source: CcDiscoverySource): () => void
}
