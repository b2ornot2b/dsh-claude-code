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
  /** The model in force, when known — absent while the CLI default applies and the SDK has not yet reported one. */
  readonly model?: string
  /** Number of permission/question asks currently awaiting an answer. */
  readonly pendingAsks: number
  /** Context-window occupancy, when the session has reported usage. */
  readonly contextUsage?: CcContextUsage
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

/** Error taxonomy for the Claude Code seam. */
export class ClaudeCodeError extends HarnessError {
  /**
   * @param message - human-readable explanation.
   * @param code - the stable {@link CcErrorCode} consumers route on.
   * @param options - standard error options (`cause`).
   */
  constructor(message: string, code: CcErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'ClaudeCodeError'
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
   * @returns a snapshot array (a fresh array per call; never a live view).
   */
  list(): readonly CcSessionSnapshot[]
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
   * Which authentication is live for this composition.
   * @returns the account projection.
   * @throws {ClaudeCodeError} code `NOT_IMPLEMENTED` until Phase 2 owns a live query.
   */
  accountInfo(): Promise<CcAccountInfo>
}
