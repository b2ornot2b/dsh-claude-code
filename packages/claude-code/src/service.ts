/**
 * The `ctx.claudeCode` service: the seam every consumer talks to, and — from
 * Phase 2 — the owner of every live Claude Code session in a composition.
 *
 * It holds the validated configuration, the session registry, the warm pool and
 * the teardown effect that guarantees no subprocess outlives the plugin.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

import type { Session as DshSession } from '@deepseek-ai/dsh-session'

import { CcAskRouter } from './ask/router.ts'
import { CcAskRules } from './ask/rules.ts'
import type { CcAskServices, CcAskTarget } from './ask/types.ts'
import { realBackend } from './backend.ts'
import type { CcCanUseTool, QueryBackend } from './backend.ts'
import { Config as ConfigSchema, resolveClaudeCodeConfig } from './config.ts'
import type { ClaudeCodeConfig, ResolvedClaudeCodeConfig } from './config.ts'
import { attachMirror } from './mirror.ts'
import type { CcMirrorHandle, CcMirrorOptions } from './mirror.ts'
import { WarmPool } from './prewarm.ts'
import { CcSession, resolveQueryOptions } from './session.ts'
import type { CcSessionDeps } from './session.ts'
import { ClaudeCodeError, newCcSessionId } from './types.ts'
import type {
  CcAccountInfo, CcContextUsage, CcLogger, CcOpenOptions, CcSessionId, CcSessionSnapshot,
  CcSessionStatus, ClaudeCode,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Claude Code seam. Provided by `@deepseek-ai/dsh-claude-code`. */
    claudeCode: ClaudeCodeService
  }

  /**
   * Still empty, deliberately. Phase 3 landed the mirror WITHOUT a cordis
   * event: the mirror writes into a dsh session log (whose own vocabulary it
   * extends — see `SessionEventMap['claude-code/compact']` in `mirror.ts`) and
   * dispatches nothing on the context. An event declared before it is emitted
   * only invites listeners that can never fire.
   */
  interface Events {}
}

/**
 * One live session's mutable bookkeeping. Internal on purpose: consumers see
 * the {@link CcSessionSnapshot} value projection, never a live handle, because
 * cordis hands out a fresh traceable proxy per service access and identity
 * comparison of anything that crosses the seam is invalid.
 */
interface CcSessionRecord {
  readonly id: CcSessionId
  status: CcSessionStatus
  model?: string
  pendingAsks: number
  contextUsage?: CcContextUsage
  /** The live actor, when this record is backed by one (always, outside white-box tests). */
  session?: CcSession
  /** Settle pending asks as denied, then close the SDK query. Must be idempotent. */
  close(): Promise<void>
}

/**
 * Everything `open()` may be told to override per call, plus the injectable
 * seams a test replaces. Not part of the public surface: consumers open sessions
 * with {@link CcOpenOptions} and get the composition's configured behavior.
 */
export interface ClaudeCodeServiceDeps {
  /** The SDK boundary. Defaults to {@link realBackend}; unit tests inject a fake. */
  readonly backend?: QueryBackend
  /**
   * An explicit permission callback, overriding the per-session ask router
   * (tests script decisions with it). Omitted, every session gets its own
   * `CcAskRouter`.
   */
  readonly canUseTool?: CcCanUseTool
  /**
   * Resolve the API key referenced by `config.apiKeyRef` under `auth: 'api-key'`.
   * Phase 5 wires `ctx.credentials`.
   * @returns the key, or undefined when none can be resolved.
   */
  readonly resolveApiKey?: () => Promise<string | undefined>
  /** Drain-loop poll interval handed to each session (tests shrink it). */
  readonly drainPollMs?: number
}

/**
 * `ctx.claudeCode` — the Claude Code capability seam. Definition and provider
 * in one package: the Claude Agent SDK is the backend and nothing outside this
 * package may import it.
 */
export class ClaudeCodeService extends Service implements ClaudeCode {
  /** Runtime validation schema for the plugin's configuration. */
  static readonly Config: z<ClaudeCodeConfig> = ConfigSchema

  /** The validated configuration with every default resolved. */
  readonly config: ResolvedClaudeCodeConfig

  /** Live sessions by id, in open order (`Map` preserves insertion order). */
  private readonly sessions = new Map<CcSessionId, CcSessionRecord>()

  /** Injectable seams: the SDK boundary, the permission router, the credential hook. */
  private readonly deps: ClaudeCodeServiceDeps

  /** At most one pre-warmed subprocess for the next matching `open()`. */
  private readonly pool: WarmPool

  /** Diagnostics sink handed to every session (subprocess stderr lands here). */
  private readonly log: CcLogger

  /**
   * @param ctx - the context that owns the service; disposal closes every session.
   * @param config - surface configuration; defaults are resolved here so a
   *   hand-mounted service behaves exactly like a `cordis.yml` row.
   * @param deps - injectable seams. Production passes nothing; unit tests pass a
   *   fake backend so a full session lifecycle runs offline.
   */
  constructor(ctx: Context, config: ClaudeCodeConfig = {}, deps: ClaudeCodeServiceDeps = {}) {
    super(ctx, 'claudeCode')
    this.config = resolveClaudeCodeConfig(config)
    this.deps = deps
    // `ctx.logger` is read through the raw context ONCE, into a plain closure:
    // cordis hands out a fresh traceable proxy per access and a long-lived
    // session must not hold one.
    const logger = ctx.logger
    this.log = { debug: (message: string) => { logger.debug(message) } }
    this.pool = new WarmPool({
      backend: deps.backend ?? realBackend,
      enabled: this.config.prewarm,
      logger: this.log,
    })

    // Every session's lifetime is owned by this fiber: unloading the plugin
    // (HMR, teardown, a failed mount) must not leave a Claude Code subprocess
    // holding a permission callback nobody will ever answer.
    ctx.effect(() => async () => {
      await this.pool.close()
      await this.closeAll()
    }, 'claudeCode:sessions')
  }

  /**
   * Open (or resume, or fork) a Claude Code session.
   *
   * The id is minted HERE (or adopted from the warm pool, which pre-minted one)
   * and handed to both dsh and the SDK — there is no id map in either direction.
   *
   * @param options - working directory, first prompt, model, permission mode, resume/fork.
   * @returns the new session's snapshot, taken after the initialize handshake.
   * @throws {ClaudeCodeError} code `INVALID_CWD` when `cwd` is not an existing
   *   absolute directory (checked BEFORE anything spawns), `SESSION_LIMIT` when
   *   `limits.maxConcurrentSessions` is already reached, `SESSION_EXISTS` when a
   *   plain resume targets a session that is still open here, or `BACKEND_ERROR`
   *   when the SDK fails to start the session.
   */
  async open(options: CcOpenOptions): Promise<CcSessionSnapshot> {
    assertUsableCwd(options.cwd)
    const limit = this.config.limits.maxConcurrentSessions
    if (this.sessions.size >= limit) {
      throw new ClaudeCodeError(
        `claude-code: cannot open another session, limits.maxConcurrentSessions (${limit}) is reached`,
        'SESSION_LIMIT')
    }

    // A plain resume continues under the id it resumes (see below), so it would
    // otherwise overwrite that session's registry entry and strand its
    // subprocess — two live queries driving one CC transcript.
    if (options.resume !== undefined && options.fork !== true && this.sessions.has(options.resume)) {
      throw new ClaudeCodeError(
        `claude-code: session ${options.resume} is already open in this context; send to it or close it `
        + 'before resuming (a plain resume continues under the SAME id)',
        'SESSION_EXISTS')
    }

    // The pool template is deliberately resume-FREE. `warmFingerprint` excludes
    // `resume`/`forkSession` (so a pre-minted id can be adopted), which means a
    // subprocess warmed with either one baked in would be indistinguishable from
    // a plain one and could silently continue somebody else's transcript. A warm
    // handle is therefore always a PLAIN session of this shape: the equality key
    // for `acquire()` and the recipe for the next `prewarm()`, both.
    const poolShape = {
      cwd: options.cwd,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
    }
    const shape = {
      ...poolShape,
      ...(options.resume === undefined ? {} : { resume: options.resume }),
      ...(options.fork === undefined ? {} : { fork: options.fork }),
    }
    const mintedId = newCcSessionId()
    const template = await resolveQueryOptions(
      { id: mintedId, ...poolShape }, this.sessionDeps(), new AbortController())

    // A resumed or forked session can never be served warm: `resume`/`forkSession`
    // are fixed at startup and the pool never warms with them. On a hit the
    // pool's PRE-MINTED id wins — it is still a dsh-minted id, just minted early.
    const lease = options.resume === undefined ? this.pool.acquire(template) : undefined
    // A plain resume (no fork) continues under the SAME id it is resuming —
    // the SDK forbids sending a caller-supplied `sessionId` alongside `resume`
    // unless `forkSession` is also set (verified live), so `resolveQueryOptions`
    // sends `resume` alone and the CLI echoes back `options.resume` itself. A
    // fork always gets a fresh mint (spike 1: the SDK honors OUR id for the fork).
    const id = lease?.sessionId
      ?? (options.resume !== undefined && options.fork !== true ? options.resume : mintedId)

    // One ask channel per session: the SDK's `requestId` namespace is the
    // session's control channel, and `settleAll()` is the session's close path.
    const router = new CcAskRouter({
      services: this.askServices(),
      config: this.config,
      rules: CcAskRules.forSession(this.config, options.cwd, this.log),
      logger: this.log,
    })
    const session = new CcSession(
      { id, ...shape },
      { ...this.sessionDeps(), asks: router, ...(lease === undefined ? {} : { warm: lease }) })
    // Before `open()`, so the first tool call of the opening prompt already has
    // a human behind it.
    if (options.ask !== undefined) session.attachAskTarget(options.ask)

    const record: CcSessionRecord = {
      id,
      status: 'starting',
      pendingAsks: 0,
      session,
      close: async () => {
        await session.close()
      },
    }
    this.sessions.set(id, record)
    // A session that closes for ANY reason (an explicit close, teardown, a dead
    // subprocess) drops out of the registry: `list()` reports live sessions only.
    session.onClose(() => {
      if (this.sessions.get(id) === record) this.sessions.delete(id)
    })

    try {
      await session.open()
    } catch (error) {
      this.sessions.delete(id)
      throw error
    }

    // BEFORE the prompt: `send()` is synchronous, so a mirror attached after it
    // would miss the `turn/start` + `user/message` that opening prompt frames.
    if (options.mirror !== undefined) {
      const { session: dshSession, ...mirrorOptions } = options.mirror
      this.mirror(session, dshSession, mirrorOptions)
    }

    if (options.prompt !== undefined) session.send(options.prompt, { mode: 'followup' })

    // Prepare the NEXT session while this one runs, always as a PLAIN session of
    // this shape (see the template above). The first open of any given shape is
    // always cold: a subprocess cannot be warmed before its `cwd` is known.
    // Failures are swallowed inside the pool — a cold open is a latency
    // regression, never an error.
    void this.pool.prewarm(template)

    return session.snapshot()
  }

  /**
   * Look up one registered session.
   * @param id - the shared dsh/CC session id.
   * @returns its snapshot, or `undefined` when no such session is registered here.
   */
  get(id: CcSessionId): CcSessionSnapshot | undefined {
    const record = this.sessions.get(id)
    return record === undefined ? undefined : snapshot(record)
  }

  /**
   * Every session registered in this context, in open order.
   * @returns a fresh snapshot array (never a live view).
   */
  list(): readonly CcSessionSnapshot[] {
    return [...this.sessions.values()].map(snapshot)
  }

  /**
   * Close one session: settle its pending asks as denied, then close the SDK
   * query. Idempotent — closing an unknown or already-closed id is not an error.
   * @param id - the shared dsh/CC session id.
   * @returns true when a session was closed, false when the id was unknown.
   */
  async close(id: CcSessionId): Promise<boolean> {
    const record = this.sessions.get(id)
    if (record === undefined) return false
    // Deregister BEFORE awaiting: a concurrent close() or the teardown loop
    // must not enter the same record's close a second time.
    this.sessions.delete(id)
    await record.close()
    return true
  }

  /**
   * Which authentication is live for this composition.
   *
   * Answered from the FIRST live session's cached initialize response — the
   * account comes back with the handshake, so this costs nothing. It deliberately
   * opens nothing: spawning a subprocess to answer a status question would spend
   * a subscription slot (and ~2s) on a read-only call.
   *
   * @returns the account projection, with `auth` reporting the mode this service
   *   built the environment for (what we intended) alongside what the CLI reports
   *   (what actually happened) — a mismatch is the silent-billing smoking gun.
   * @throws {ClaudeCodeError} code `NO_LIVE_SESSION` when no session is open.
   *   Open one first; there is no cheaper way to ask the CLI who it is.
   */
  async accountInfo(): Promise<CcAccountInfo> {
    for (const record of this.sessions.values()) {
      const account = record.session?.account
      if (account === undefined) continue
      return await Promise.resolve({
        auth: this.config.auth,
        ...(account.email === undefined ? {} : { email: account.email }),
        ...(account.organization === undefined ? {} : { organization: account.organization }),
        ...(account.subscriptionType === undefined ? {} : { subscriptionType: account.subscriptionType }),
        ...(account.apiProvider === undefined ? {} : { apiProvider: account.apiProvider }),
      })
    }
    throw new ClaudeCodeError(
      'claude-code: accountInfo() needs at least one live session — the account arrives with a session\'s '
      + 'initialize handshake, and this call never spawns a subprocess of its own',
      'NO_LIVE_SESSION')
  }

  /**
   * Look up the live actor behind a registered session.
   *
   * This is the handle Phase 3 (mirror), Phase 5 (tools) and Phase 6 (the agent
   * adapter) drive: `send`, `interrupt`, `waitForResult`, `onMessage`. The
   * snapshot from {@link ClaudeCodeService.get} stays the value projection for
   * anything that crosses a tool boundary.
   *
   * @param id - the shared dsh/CC session id.
   * @returns the session actor, or undefined when the id is unknown.
   */
  session(id: CcSessionId): CcSession | undefined {
    return this.sessions.get(id)?.session
  }

  /**
   * Mirror an already-open session into a dsh session log (§5).
   *
   * @param id - the shared dsh/CC session id.
   * @param session - the dsh session to append to.
   * @param options - subagent policy, compaction policy, provider name, logger.
   * @returns the mirror and its unsubscribe function.
   * @throws {ClaudeCodeError} code `UNKNOWN_SESSION` when the id is not registered here.
   */
  attachMirror(id: CcSessionId, session: DshSession, options: CcMirrorOptions = {}): CcMirrorHandle {
    const actor = this.sessions.get(id)?.session
    if (actor === undefined) {
      throw new ClaudeCodeError(
        `claude-code: no session ${id} is registered in this context`, 'UNKNOWN_SESSION')
    }
    return this.mirror(actor, session, options)
  }

  /**
   * Attach (or replace) who answers one session's asks (§4.5).
   *
   * @param id - the shared dsh/CC session id.
   * @param target - the dsh agent and its optional seam overrides.
   * @returns a disposer detaching exactly this target.
   * @throws {ClaudeCodeError} code `UNKNOWN_SESSION` when the id is not registered here.
   */
  attachAskTarget(id: CcSessionId, target: CcAskTarget): () => void {
    const actor = this.sessions.get(id)?.session
    if (actor === undefined) {
      throw new ClaudeCodeError(
        `claude-code: no session ${id} is registered in this context`, 'UNKNOWN_SESSION')
    }
    return actor.attachAskTarget(target)
  }

  /**
   * The two optional dsh seams, resolved LAZILY on every ask.
   *
   * Read through `ctx.get(...)` at ask time rather than captured: a service may
   * mount or unload after this session opened, and cordis hands out a fresh
   * traceable proxy per access — a stored one outlives the fiber that made it.
   * @returns the resolvers the ask router consults.
   */
  private askServices(): CcAskServices {
    return {
      approval: () => this.ctx.get('approval'),
      userQuestions: () => this.ctx.get('userQuestions'),
    }
  }

  /**
   * Attach one mirror and bind its lifetime to the Claude Code session's.
   *
   * The mirror is handed the ACTOR, which it only ever reads through
   * `onMessage`/`onSend` — it is write-only into dsh and drives nothing.
   *
   * @param actor - the live Claude Code session.
   * @param session - the dsh session to append to.
   * @param options - mirror options (the logger defaults to this service's).
   * @returns the mirror handle.
   */
  private mirror(actor: CcSession, session: DshSession, options: CcMirrorOptions): CcMirrorHandle {
    const handle = attachMirror(actor, session, { logger: this.log, ...options })
    // §4.4: an approval prompt must reference a `tool/call` the UI has already
    // seen. The mirror is the only thing that knows whether it has.
    const detachCallSite = actor.attachAskCallSite(handle.mirror)
    // A mirror outliving its session would hold a listener on a dead actor and
    // keep appending nothing forever; disposal is owned here, not by the caller.
    // `finalize()` first: a session closed MID-TURN never emits the result that
    // would have closed the dsh turn, and a log with a dangling `turn/start`
    // can never be appended to again (dsh refuses a second open turn).
    actor.onClose(() => {
      detachCallSite()
      handle.mirror.finalize()
      handle.dispose()
    })
    return handle
  }

  /**
   * The dependency bundle every session is constructed with.
   * @returns the session deps derived from this service's config and injections.
   */
  private sessionDeps(): CcSessionDeps {
    return {
      backend: this.deps.backend ?? realBackend,
      config: this.config,
      logger: this.log,
      ...(this.deps.canUseTool === undefined ? {} : { canUseTool: this.deps.canUseTool }),
      ...(this.deps.resolveApiKey === undefined ? {} : { resolveApiKey: this.deps.resolveApiKey }),
      ...(this.deps.drainPollMs === undefined ? {} : { drainPollMs: this.deps.drainPollMs }),
    }
  }

  /**
   * Close every registered session. Runs on fiber disposal; one failing
   * session must not strand the others, so failures are collected and raised
   * together after the registry is empty.
   * @returns nothing; rejects with an `AggregateError` if any close failed.
   */
  private async closeAll(): Promise<void> {
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    for (const record of records) {
      try {
        await record.close()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `claude-code: ${failures.length} session(s) failed to close`)
    }
  }
}

/**
 * Project one bookkeeping record into the public value shape. Optional fields
 * are conditionally spread: `exactOptionalPropertyTypes` rejects assigning a
 * possibly-undefined value to an optional property.
 * @param record - the live bookkeeping record.
 * @returns the serializable snapshot.
 */
function snapshot(record: CcSessionRecord): CcSessionSnapshot {
  // A record backed by a live actor reports the actor's state: status, model and
  // context usage all move underneath the registry.
  const live = record.session?.snapshot()
  if (live !== undefined) return live
  return {
    id: record.id,
    status: record.status,
    ...(record.model === undefined ? {} : { model: record.model }),
    pendingAsks: record.pendingAsks,
    ...(record.contextUsage === undefined ? {} : { contextUsage: record.contextUsage }),
  }
}

/**
 * Refuse a working directory the SDK could only fail on, BEFORE anything spawns.
 *
 * A relative or missing `cwd` is the most common way a tool call goes wrong, and
 * paying a subprocess spawn to discover it costs ~2s and a subscription slot.
 * @param cwd - the requested working directory.
 * @throws {ClaudeCodeError} code `INVALID_CWD`.
 */
function assertUsableCwd(cwd: string): void {
  if (cwd.length === 0 || !isAbsolute(cwd)) {
    throw new ClaudeCodeError(
      `claude-code: cwd must be an absolute path, got ${JSON.stringify(cwd)}`, 'INVALID_CWD')
  }
  let directory = false
  try {
    directory = statSync(cwd).isDirectory()
  } catch (error) {
    throw new ClaudeCodeError(
      `claude-code: cwd ${JSON.stringify(cwd)} cannot be used: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_CWD',
      { cause: error })
  }
  if (!directory) {
    throw new ClaudeCodeError(
      `claude-code: cwd ${JSON.stringify(cwd)} is not a directory`, 'INVALID_CWD')
  }
}

/** Plugin name shown in Loader diagnostics and cordis fiber trees. */
export const name = 'claude-code'

/**
 * Services this plugin requires before it activates. Empty by design: the seam
 * must mount in a bare composition (a headless delegation run has no approval
 * or user-questions service), so the later phases read those seams
 * opportunistically with `ctx.get(...)` instead of injecting them.
 */
export const inject: string[] = []

/**
 * Mount the seam. Named export, never a default: the cordis Loader unwraps a
 * module's `.default` when one exists, which throws away the sibling
 * `name`/`inject`/`Config` exports and mounts the plugin with an empty inject
 * list (harness post-mortem 0001).
 * @param ctx - the context to provide `ctx.claudeCode` on.
 * @param config - surface configuration from the `cordis.yml` row.
 */
export function apply(ctx: Context, config: ClaudeCodeConfig = {}): void {
  void new ClaudeCodeService(ctx, config)
}
