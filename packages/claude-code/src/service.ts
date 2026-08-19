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
import { listLocalStore, readLocalRegistry, realBackend } from './backend.ts'
import type { CcCanUseTool, QueryBackend } from './backend.ts'
import { Config as ConfigSchema, resolveClaudeCodeConfig } from './config.ts'
import type { ClaudeCodeConfig, ResolvedClaudeCodeConfig } from './config.ts'
import { createLocalSource } from './discovery-local.ts'
import { mergeDiscovered, normalizeSourceClock, projectComposed } from './discovery.ts'
import { formatDuration, isReapable, selectReapable, sessionLimitError } from './inventory.ts'
import { attachMirror } from './mirror.ts'
import type { CcMirrorHandle, CcMirrorOptions } from './mirror.ts'
import { WarmPool } from './prewarm.ts'
import { CcSession, resolveQueryOptions } from './session.ts'
import type { CcSessionDeps } from './session.ts'
import { ClaudeCodeError, newCcSessionId } from './types.ts'
import type {
  CcAccountInfo, CcCloseReason, CcContextUsage, CcDiscoveredSession, CcDiscoverOptions, CcDiscoverRequest,
  CcDiscoveryResult, CcDiscoveryScope, CcDiscoverySource, CcListOptions, CcLogger, CcOpenOptions, CcSessionId,
  CcSessionSnapshot, CcSessionStatus, ClaudeCode,
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
  /** The absolute working directory — carried on the record so the inventory can name it. */
  readonly cwd: string
  /** Epoch ms this session was registered. */
  readonly openedAt: number
  status: CcSessionStatus
  model?: string
  pendingAsks: number
  contextUsage?: CcContextUsage
  /** The live actor, when this record is backed by one (always, outside white-box tests). */
  session?: CcSession
  /**
   * Settle pending asks as denied, then close the SDK query. Must be idempotent.
   * @param reason - why it is closing; the record forwards it to the actor so a
   *   reaped session is distinguishable from one somebody asked to close.
   */
  close(reason?: CcCloseReason): Promise<void>
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
  /**
   * Skip wiring the real local discovery source (the SDK store + on-disk
   * registry). Defaults to wiring it whenever `config.discovery.local` is
   * true; unit tests pass `false` so nothing here ever touches `~/.claude`.
   */
  readonly wireLocalSource?: boolean
  /**
   * Replace the local discovery source outright, instead of the real one
   * `backend.ts` builds from `listLocalStore`/`readLocalRegistry`. Ignored
   * when `wireLocalSource` is `false`.
   */
  readonly localSource?: CcDiscoverySource
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

  /**
   * The last snapshot of the {@link CLOSED_SESSION_HISTORY} most recently closed
   * sessions, so {@link ClaudeCodeService.get} can still answer for one.
   *
   * A session used to vanish from every lookup the instant it closed, which was
   * fine while `closed` only ever meant "somebody asked". It no longer does: a
   * dead subprocess now closes its own session, so the next
   * `claude_code_status` would answer `CC_NO_SESSION` — "it was never opened
   * here" — about a session the caller had just been handed the id of. A
   * tombstone answers the question actually being asked ("what happened to it?")
   * with `status: 'closed'` and the {@link CcCloseReason}.
   *
   * Deliberately NOT visible to {@link ClaudeCodeService.list} (live sessions
   * only) or {@link ClaudeCodeService.session} (there is nothing to drive), and
   * bounded, because a tombstone is a courtesy and must not become a leak.
   */
  private readonly closed = new Map<CcSessionId, CcSessionSnapshot>()

  /** Injectable seams: the SDK boundary, the permission router, the credential hook. */
  private readonly deps: ClaudeCodeServiceDeps

  /** At most one pre-warmed subprocess for the next matching `open()`. */
  private readonly pool: WarmPool

  /** Diagnostics sink handed to every session (subprocess stderr lands here). */
  private readonly log: CcLogger

  /** Registered discovery sources, keyed by id (a duplicate id replaces its predecessor). */
  private readonly discoverySources = new Map<string, CcDiscoverySource>()

  /**
   * The last merged wide-scope result PER REQUEST SHAPE, for
   * `config.discovery.cacheTtlMs`.
   *
   * Keyed by {@link discoveryCacheKey} — everything that changes what a
   * source is actually asked for (`scope`, `includeResumable`). Without this,
   * a `scope: 'host'` result could be served back as a cache hit to a
   * subsequent `scope: 'mesh'` call inside the TTL: a caller asking about the
   * whole mesh would silently get only this host's sessions, marked
   * `cached: true` with no warning that the answer had been narrowed. The
   * same hazard applies to `includeResumable`.
   *
   * Each entry holds ONLY the external (`live-external`/`resumable`) sessions,
   * never the composed ones: composed sessions are re-projected fresh on
   * every {@link ClaudeCodeService.discover} call regardless of cache state,
   * because they are free (no source to query) and change fastest — a cached
   * one could name a session that has since closed.
   */
  private readonly discoveryCache = new Map<string, { at: number, result: CcDiscoveryResult }>()

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

    // OPT-IN. With `limits.idleTimeoutMs` unset there is no sweep and NO TIMER
    // AT ALL — not a disabled one, not a zero-length one — because an operator
    // who did not ask for reaping must get exactly the behaviour they had
    // before this option existed, down to the event loop.
    const idleTimeoutMs = this.config.limits.idleTimeoutMs
    if (idleTimeoutMs !== undefined) {
      ctx.effect(() => {
        // ONE timer for the whole service, not one per session: a per-session
        // timer would have to be created, cleared and re-armed on every send and
        // every received message (that is the activity clock), which is a
        // rearm-per-SDK-message on a streaming turn.
        const timer = setInterval(() => {
          void this.reapIdle(idleTimeoutMs)
        }, sweepIntervalMs(idleTimeoutMs))
        // A background sweep must never be the reason a process refuses to exit.
        timer.unref?.()
        return () => {
          clearInterval(timer)
        }
      }, 'claudeCode:idleSweep')
    }

    // The real local source reads the SDK store and the on-disk registry
    // (`backend.ts`, the only place in this package permitted to touch the
    // SDK). Unit tests pass `wireLocalSource: false` and register their own
    // fakes instead, so no unit test in this repo ever reads this machine's
    // real `~/.claude`.
    if (deps.wireLocalSource !== false && this.config.discovery.local) {
      const source = deps.localSource ?? createLocalSource({
        host: this.config.hostLabel,
        listSessions: async options => listLocalStore(options),
        readRegistry: async () => readLocalRegistry(),
      })
      ctx.effect(() => this.registerDiscoverySource(source), 'claudeCode:localDiscovery')
    }
  }

  /**
   * Open (or resume, or fork) a Claude Code session.
   *
   * The id is minted HERE (or adopted from the warm pool, which pre-minted one)
   * and handed to both dsh and the SDK — there is no id map in either direction.
   *
   * @param options - working directory, first prompt, model, permission mode, resume/fork.
   * @returns the new session's snapshot, taken after the initialize handshake.
   * @throws {ClaudeCodeError} code `INVALID_CWD` when `cwd` is omitted without
   *   `resume`, or when the given (or discovered) cwd is not an existing
   *   absolute directory (checked BEFORE anything spawns), `SESSION_LIMIT` when
   *   `limits.maxConcurrentSessions` is already reached, `SESSION_EXISTS` when a
   *   plain resume targets a session that is still open here,
   *   `SESSION_LIVE_ELSEWHERE` when a plain resume targets a session discovery
   *   reports running in another terminal or on another mesh host, or
   *   `BACKEND_ERROR` when the SDK fails to start the session.
   */
  async open(options: CcOpenOptions): Promise<CcSessionSnapshot> {
    // A resumed session already has a working directory; making the caller
    // restate it invites a wrong guess, and a wrong cwd is the failure mode
    // that wrote proof.txt into $HOME instead of the repo.
    const cwd = options.cwd ?? await this.resumeCwd(options.resume)
    assertUsableCwd(cwd)
    const limit = this.config.limits.maxConcurrentSessions
    if (this.sessions.size >= limit) {
      // The refusal INVENTORIES what is holding the slots — see `inventory.ts`
      // for the trace that made this mandatory. The prose and `error.data`
      // are built from one projection so they can never disagree.
      throw sessionLimitError(this.list(), limit, Date.now())
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

    // SESSION_EXISTS only knows about sessions THIS composition opened. A
    // session running in another terminal or on another host is invisible to
    // it, and appending to a transcript another live process is writing
    // corrupts it. Forking is always safe, so the refusal names that way out.
    // Cached, same as `resumeCwd` above — a resume must not force a fresh
    // probe of every mesh host on top of the one discovery already ran.
    if (options.resume !== undefined && options.fork !== true) {
      const elsewhere = (await this.discover({ scope: 'mesh' })).sessions
        .find(session => session.sessionId === options.resume && session.origin === 'live-external')
      if (elsewhere !== undefined) {
        throw new ClaudeCodeError(
          `claude-code: session ${options.resume} is running on ${elsewhere.host}`
          + `${elsewhere.live?.pid === undefined ? '' : ` (pid ${elsewhere.live.pid})`}`
          + `${elsewhere.title === undefined ? '' : ` — "${elsewhere.title}"`}. `
          + 'Continuing it would put two processes writing one transcript. '
          + 'Pass fork: true to branch from it instead; the original is left untouched.',
          'SESSION_LIVE_ELSEWHERE')
      }
    }

    // The pool template is deliberately resume-FREE. `warmFingerprint` excludes
    // `resume`/`forkSession` (so a pre-minted id can be adopted), which means a
    // subprocess warmed with either one baked in would be indistinguishable from
    // a plain one and could silently continue somebody else's transcript. A warm
    // handle is therefore always a PLAIN session of this shape: the equality key
    // for `acquire()` and the recipe for the next `prewarm()`, both.
    const poolShape = {
      cwd,
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
      rules: CcAskRules.forSession(this.config, cwd, this.log),
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
      cwd,
      openedAt: Date.now(),
      status: 'starting',
      pendingAsks: 0,
      session,
      close: async (reason) => {
        await session.close(reason)
      },
    }
    this.sessions.set(id, record)
    // A session that closes for ANY reason (an explicit close, teardown, a dead
    // subprocess that closed itself) drops out of the registry: `list()` reports
    // live sessions only. The snapshot is taken here rather than reconstructed
    // later because this is the last moment the actor still holds it.
    session.onClose((reason) => {
      if (this.sessions.get(id) === record) this.sessions.delete(id)
      this.entomb(id, session.snapshot(), reason)
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
   * Find the working directory of a session being resumed.
   *
   * Consults the cache the same as any other `scope: 'mesh'` discovery call —
   * never `refresh: true` — so a resume never forces a fresh probe of every
   * mesh host on top of the one discovery already ran to list this session.
   * @param resume - the session id to resume, if any.
   * @returns the discovered cwd.
   * @throws {ClaudeCodeError} code `INVALID_CWD` when there is no `resume` to
   *   resolve from, or when discovery does not know the resumed session's cwd.
   */
  private async resumeCwd(resume: CcSessionId | undefined): Promise<string> {
    if (resume === undefined) {
      throw new ClaudeCodeError('claude-code: open requires a cwd unless resume is set', 'INVALID_CWD')
    }
    const found = (await this.discover({ scope: 'mesh' })).sessions
      .find(session => session.sessionId === resume)
    if (found === undefined || found.cwd === '') {
      throw new ClaudeCodeError(
        `claude-code: cannot resume ${resume}: no cwd was given and discovery does not know this session. `
        + 'Pass cwd explicitly, or call claude_code_list with a wider scope first.',
        'INVALID_CWD')
    }
    return found.cwd
  }

  /**
   * Look up one session: live, or one of the most recently closed.
   *
   * A closed session answers from the tombstone table for a bounded while (see
   * {@link ClaudeCodeService.closed}) — `status: 'closed'` plus the
   * {@link CcCloseReason} that ended it. That is the difference between telling
   * a caller "your session crashed" and telling it "no such session", which is
   * what it used to hear the moment a subprocess died.
   *
   * @param id - the shared dsh/CC session id.
   * @returns its snapshot, or `undefined` when this context never opened it (or
   *   closed it long enough ago that the tombstone has been evicted).
   */
  get(id: CcSessionId): CcSessionSnapshot | undefined {
    const record = this.sessions.get(id)
    if (record !== undefined) return snapshot(record)
    return this.closed.get(id)
  }

  /**
   * Every session registered in this context, in open order.
   *
   * LIVE sessions only by default, unchanged since Phase 2 — anything counting
   * slots against `limits.maxConcurrentSessions` (this service's own `open()`
   * included) must not count tombstones. `{ includeClosed: true }` appends the
   * recently-closed ones, oldest tombstone first, for the caller that is trying
   * to work out where a session it was handed the id of went.
   *
   * @param options - `{ includeClosed }`; omitted means live only.
   * @returns a fresh snapshot array, at most one entry per id (never a live view).
   */
  list(options: CcListOptions = {}): readonly CcSessionSnapshot[] {
    const live = [...this.sessions.values()].map(snapshot)
    if (options.includeClosed !== true) return live
    // A tombstone for an id that is LIVE AGAIN is suppressed. A plain resume
    // continues under the SAME id it resumes, so a session closed here and then
    // resumed here holds both a registry record and a tombstone — and listing
    // both would report one session twice, once as `closed`, with the corpse's
    // `closeReason` attached to the row a caller is about to send to. `get()`
    // has always preferred the live record for exactly this reason; so does this.
    const tombstones = [...this.closed.values()].filter(entry => !this.sessions.has(entry.id))
    return [...live, ...tombstones]
  }

  /**
   * Close one session: settle its pending asks as denied, then close the SDK
   * query. Idempotent — closing an unknown or already-closed id is not an error.
   * @param id - the shared dsh/CC session id.
   * @returns true when a session was closed, false when the id was unknown.
   */
  async close(id: CcSessionId, reason: CcCloseReason = 'closed'): Promise<boolean> {
    const record = this.sessions.get(id)
    if (record === undefined) return false
    // Deregister BEFORE awaiting: a concurrent close() or the teardown loop
    // must not enter the same record's close a second time.
    this.sessions.delete(id)
    await record.close(reason)
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
   * Every session this composition can see, from every registered source.
   *
   * `scope: 'composition'` (the default) touches NO source at all — it only
   * projects this composition's own `list()` — so every caller that predates
   * discovery, and every caller that never asked for it, pays nothing beyond
   * the inventory projection it already paid for `SESSION_LIMIT` (spec §6.2).
   *
   * Wider scopes query the registered sources IN PARALLEL against a shared
   * clock reading and never reject: a source that throws or times out becomes
   * a `warnings` entry instead, because a list that fails whenever one laptop
   * is asleep is not a list anyone can use (design P6). The composed group is
   * re-projected fresh on every call, cached or not — it is free (no source to
   * query) and it is the group that goes stale fastest, so caching it would
   * risk naming a session that has since closed.
   *
   * @param options - scope and cache control.
   * @returns the merged, deduped, clock-normalized inventory.
   */
  async discover(options: CcDiscoverOptions = {}): Promise<CcDiscoveryResult> {
    const now = Date.now()
    const scope = options.scope ?? 'composition'
    const composed = projectComposed(this.list(), this.config.hostLabel, now)
    if (scope === 'composition') {
      return { sessions: composed, warnings: [], generatedAt: now, cached: false }
    }

    const includeResumable = options.includeResumable ?? true
    // Everything that changes what a source is actually asked for goes in the
    // key: a cache hit must only ever serve a result gathered under the SAME
    // request shape (see the field doc on `discoveryCache`).
    const cacheKey = discoveryCacheKey(scope, includeResumable)
    const cached = this.discoveryCache.get(cacheKey)
    if (options.refresh !== true && cached !== undefined
      && now - cached.at < this.config.discovery.cacheTtlMs) {
      // Routed through the SAME merge the uncached path uses (Amendment 2):
      // a session that is both composed and reported live by an external
      // source must dedupe here too, or it would appear twice on every cache
      // hit even though the uncached path never lets that happen.
      return {
        ...cached.result,
        sessions: mergeDiscovered(composed, [[...cached.result.sessions]], now),
        cached: true,
      }
    }

    const sources = [...this.discoverySources.values()]
      .filter(source => scope === 'mesh' || source.host === this.config.hostLabel)
    const request: Omit<CcDiscoverRequest, 'signal'> = {
      now,
      includeResumable,
      recentWindowMs: this.config.discovery.recentWindowMs,
      maxResumable: this.config.discovery.maxResumable,
      includeTitles: this.config.discovery.includeTitles,
    }
    const sourceTimeoutMs = this.config.discovery.sourceTimeoutMs
    const warnings: string[] = []
    // One deadline PER SOURCE, inside this parallel map — never around the
    // whole `Promise.all` — so one hung host cannot delay the others' results.
    const groups = await Promise.all(sources.map(async (source): Promise<CcDiscoveredSession[]> => {
      try {
        const result = await this.queryWithDeadline(source, request, sourceTimeoutMs)
        return normalizeSourceClock(result, now)
      } catch (error) {
        warnings.push(`${source.host}: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }))

    // The cache stores ONLY the external sessions (never `composed`): they are
    // what cost something to gather, and re-merging them against a freshly
    // projected `composed` on the next call is how a closed composed session
    // stops shadowing a cached external copy of itself.
    const external = mergeDiscovered([], groups, now)
    this.discoveryCache.set(cacheKey, {
      at: now,
      result: { sessions: external, warnings, generatedAt: now, cached: false },
    })
    return {
      sessions: mergeDiscovered(composed, [external], now),
      warnings,
      generatedAt: now,
      cached: false,
    }
  }

  /**
   * Contribute sessions from outside this composition (spec §6.1): a mesh
   * host's probe, a container's forwarded inventory, or a test double.
   *
   * @param source - the source to add; a duplicate id replaces its predecessor.
   * @returns a disposer that removes it and drops the cache, so the next
   *   {@link ClaudeCodeService.discover} call never consults it again.
   */
  registerDiscoverySource(source: CcDiscoverySource): () => void {
    this.discoverySources.set(source.id, source)
    // The source SET changed, which invalidates every cached request shape,
    // not just the one currently in flight — a `mesh` entry cached before
    // this source existed is just as stale as a `host` one.
    this.discoveryCache.clear()
    return () => {
      // Only remove THIS registration, identified by object, not by id: a
      // second `registerDiscoverySource` call with the same id replaces the
      // map entry, and the FIRST call's disposer must not be able to evict
      // the second registration out from under it.
      if (this.discoverySources.get(source.id) === source) {
        this.discoverySources.delete(source.id)
        this.discoveryCache.clear()
      }
    }
  }

  /**
   * Query one source, bounded by `sourceTimeoutMs`.
   *
   * A rejection is already handled by the caller's `try`/`catch` — this exists
   * for the failure mode a rejection does NOT cover: a source that never
   * settles at all (a wedged child process, a stuck SSH connect with no
   * transport timeout of its own). The source gets an `AbortController` so a
   * well-behaved implementation can react and fail fast; the race against the
   * deadline timer is what bounds it even if the source ignores the signal.
   *
   * @param source - the source to query.
   * @param request - the shared request fields (`now`, window, limits); the
   *   per-source `signal` is attached here, not by the caller.
   * @param timeoutMs - how long to wait before giving up on this source.
   * @returns the source's result.
   * @throws whatever the source rejects with, or a timeout error naming the
   *   elapsed limit once `timeoutMs` passes with nothing settled.
   */
  private async queryWithDeadline(
    source: CcDiscoverySource,
    request: Omit<CcDiscoverRequest, 'signal'>,
    timeoutMs: number,
  ): Promise<CcDiscoveryResult> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`discovery timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      // A pending per-source deadline must never be the reason a process
      // refuses to exit — same posture as the idle-sweep timer above.
      timer.unref?.()
    })
    try {
      return await Promise.race([
        source.discover({ ...request, signal: controller.signal }),
        deadline,
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * One sweep of the opt-in idle reaper: close every session that is idle, has
   * NO pending ask, and has seen no activity for `limits.idleTimeoutMs`.
   *
   * Closed through the same {@link ClaudeCodeService.close} an explicit
   * `claude_code_close` uses — mirror finalized, tombstone recorded, waiters
   * settled — with `reaped` as the only difference, so the two paths cannot
   * drift. Every reap is logged with the session, its idle age and the ceiling
   * it crossed: a session that vanishes on its own must leave a reason behind.
   *
   * @param idleTimeoutMs - the configured idle ceiling.
   * @returns the ids reaped, in the order they were closed.
   */
  private async reapIdle(idleTimeoutMs: number): Promise<readonly CcSessionId[]> {
    const now = Date.now()
    // Selection is a pure function of the snapshots, so the "never reap a
    // session with a pending ask" rule is stated once and tested without a timer.
    const doomed = selectReapable(this.list(), idleTimeoutMs, now)
    const reaped: CcSessionId[] = []
    for (const id of doomed) {
      // RE-ASKED, per session, immediately before closing it. The loop awaits
      // each close, so every id after the first is being acted on across at
      // least one turn of the event loop — and a permission ask raised by the
      // subprocess, or a `send()` from a tool call, lands in exactly that gap.
      // Reaping on the strength of the selection alone would close a session a
      // human had just been asked to decide on. This re-check and the
      // `close()` below run in one synchronous block (`close()` deregisters
      // before its first `await`), so nothing can slip between them.
      const record = this.sessions.get(id)
      if (record === undefined) continue
      const current = snapshot(record)
      if (!isReapable(current, idleTimeoutMs, Date.now())) {
        this.log.debug(
          `claude-code: idle sweep skipped session ${id} — it became ${current.status} with `
          + `${current.pendingAsks} pending ask(s) after the sweep selected it`)
        continue
      }
      const idleMs = now - current.lastActivityAt
      try {
        if (!await this.close(id, 'reaped')) continue
      } catch (error) {
        // A sweep is best-effort background work: one session that fails to
        // close must not stop the others being reclaimed, and must not reject
        // out of a timer callback where nobody can catch it.
        this.log.debug(`claude-code: idle sweep failed to reap session ${id}: `
          + `${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      reaped.push(id)
      this.log.debug(
        `claude-code: reaped session ${id} — idle ${formatDuration(idleMs)} with no pending asks, past the `
        + `limits.idleTimeoutMs ceiling of ${formatDuration(idleTimeoutMs)}; closed with reason "reaped"`)
    }
    return reaped
  }

  /**
   * Record one closed session's final snapshot, evicting the oldest tombstone
   * once the table is full.
   *
   * `Map` iteration is insertion order, so the first key IS the oldest entry;
   * a re-closed id is deleted first so it re-enters as the newest rather than
   * keeping a stale position (and a stale reason).
   *
   * @param id - the closed session's id.
   * @param final - the actor's snapshot, taken at close time.
   * @param reason - why it closed.
   * @returns nothing.
   */
  private entomb(id: CcSessionId, final: CcSessionSnapshot, reason: CcCloseReason): void {
    this.closed.delete(id)
    this.closed.set(id, { ...final, status: 'closed', closeReason: final.closeReason ?? reason })
    while (this.closed.size > CLOSED_SESSION_HISTORY) {
      const oldest = this.closed.keys().next()
      if (oldest.done === true) break
      this.closed.delete(oldest.value)
    }
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
 * How many closed sessions keep an answerable tombstone (see
 * {@link ClaudeCodeService.closed}). Small on purpose: it exists so the status
 * call that FOLLOWS a crash gets a real answer, not so a composition can browse
 * its history — that is the session log's job.
 */
export const CLOSED_SESSION_HISTORY = 32

/** Shortest interval the idle sweep will ever run at, however small the ceiling. */
export const MIN_IDLE_SWEEP_MS = 250

/** Longest interval the idle sweep will ever run at, however large the ceiling. */
export const MAX_IDLE_SWEEP_MS = 60_000

/**
 * How often the single idle sweep timer fires for a given ceiling.
 *
 * A quarter of the ceiling, clamped: a session is therefore reclaimed within
 * ~1.25x `idleTimeoutMs` rather than up to 2x it (which is what sweeping at
 * exactly the ceiling would give), while a one-minute floor keeps a very long
 * ceiling from waking the process every few seconds for nothing.
 *
 * @param idleTimeoutMs - the configured idle ceiling.
 * @returns the sweep interval in milliseconds.
 */
export function sweepIntervalMs(idleTimeoutMs: number): number {
  return Math.min(MAX_IDLE_SWEEP_MS, Math.max(MIN_IDLE_SWEEP_MS, Math.floor(idleTimeoutMs / 4)))
}

/**
 * The `discoveryCache` key for one request shape.
 *
 * MUST cover every parameter that changes what a source is actually asked
 * for — today that is `scope` (which sources get consulted at all: `host`
 * queries a strict subset of what `mesh` does) and `includeResumable` (which
 * changes the request each consulted source receives). Leaving either one out
 * of the key would let a narrower result silently answer a wider request: a
 * `scope: 'host'` result served back as a `scope: 'mesh'` cache hit would
 * report only this host's sessions as if the whole mesh had been asked, with
 * `cached: true` and no warning that the answer had been narrowed — the exact
 * bug this key exists to rule out. `recentWindowMs`/`maxResumable`/
 * `includeTitles` are deliberately NOT here: they come from `config.discovery`
 * and never vary between calls on one service instance, so they cannot make
 * two calls ask for different things.
 * @param scope - the requested discovery scope (`'host'` or `'mesh'`; `'composition'` never reaches the cache).
 * @param includeResumable - whether resumable sessions were requested.
 * @returns a stable string key for this request shape.
 */
function discoveryCacheKey(scope: CcDiscoveryScope, includeResumable: boolean): string {
  return `${scope}:${includeResumable}`
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
    cwd: record.cwd,
    openedAt: record.openedAt,
    // A record with no live actor has no activity clock of its own; its
    // registration is the only thing that ever happened to it.
    lastActivityAt: record.openedAt,
    ...(record.model === undefined ? {} : { model: record.model }),
    pendingAsks: record.pendingAsks,
    // A record with no live actor has no ask table to read: either it never got
    // one (a white-box test registration) or its session already drained the
    // table on close. Both are honestly empty, never "unknown".
    pendingAskDetails: [],
    // Likewise: a record with no actor never settled an ask here. A CLOSED
    // session keeps its real receipts — `entomb()` stores the actor's FINAL
    // snapshot, so `claude_code_status` on a session that has ended still
    // reports what the human decided while it was alive.
    recentAsks: [],
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
