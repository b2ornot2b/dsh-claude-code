/**
 * The warm pool: one pre-spawned, pre-initialized Claude Code subprocess held
 * ready for the next `open()` that can actually use it.
 *
 * Spike 5 measured the win: `startup()` costs ~305–325ms once, after which a
 * warm `query()` reaches `system/init` in ~8ms instead of ~300ms. First *token*
 * latency is unchanged (the model round-trip dominates), `canUseTool` routes
 * identically on a warm query, and `close()` leaves no orphan process.
 *
 * Two hard constraints shape the design, and both are why this file stays dumb
 * on purpose:
 *
 * 1. **A `WarmQuery` is single-use and its options were fixed at `startup()`.**
 *    So the pool can only serve an `open()` whose resolved options are equal to
 *    the warmed ones — {@link warmFingerprint} is that equality, and a mismatch
 *    falls through to a cold query.
 * 2. **`sessionId` is one of those fixed options.** A pool that warmed without
 *    one would let the CLI mint an id and break this integration's central
 *    invariant (dsh mints every id, spike 1 / D1). So the pool PRE-MINTS the id
 *    and the accepting `open()` adopts it. The id is still ours.
 *
 * Because the warmed options also fix `canUseTool`, `stderr` and the
 * `AbortController`, the pool warms with indirection hooks and hands them to the
 * session at lease time.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { createHash } from 'node:crypto'

import type {
  CcBackendQuery, CcCanUseTool, CcPermissionDecision, CcPermissionRequest, CcQueryOptions,
  CcSdkUserMessage, CcWarmQuery, QueryBackend,
} from './backend.ts'
import { newCcSessionId } from './types.ts'
import type { CcLogger, CcSessionId } from './types.ts'

/**
 * A warm subprocess handed to one session. The session adopts `sessionId` and
 * `abortController` (both were fixed when the subprocess started) and calls
 * {@link CcWarmLease.bind} before the first message so permission requests reach
 * ITS router rather than the pool's fail-closed default.
 */
export interface CcWarmLease {
  /** The id the subprocess was started with. The accepting session MUST adopt it. */
  readonly sessionId: CcSessionId
  /** The controller the warm query was started with — the session's cancellation channel. */
  readonly abortController: AbortController
  /**
   * Point the warmed indirection hooks at the session that took this lease.
   * @param handlers - the session's permission router and stderr sink.
   */
  bind(handlers: { canUseTool: CcCanUseTool, stderr: (data: string) => void }): void
  /**
   * Attach the session's input stream and start the conversation.
   * @param prompt - the never-completing input stream.
   * @returns the live query handle.
   */
  query(prompt: AsyncIterable<CcSdkUserMessage>): CcBackendQuery
  /** Discard the warm subprocess without ever using it. */
  close(): void
}

/** What a {@link WarmPool} needs from its surroundings. */
export interface WarmPoolDeps {
  /** The SDK boundary. Tests pass a fake. */
  readonly backend: QueryBackend
  /** Whether pre-warming is enabled at all (`config.prewarm`). */
  readonly enabled: boolean
  /** Diagnostics sink. */
  readonly logger?: CcLogger
}

/** Fields that are per-session and therefore excluded from the warm fingerprint. */
const SESSION_SPECIFIC_KEYS = new Set([
  'sessionId', 'resume', 'forkSession', 'canUseTool', 'stderr', 'abortController',
])

/**
 * The equality a warm handle can serve: a stable string over every option that
 * `startup()` freezes, minus the ones that are per-session (the id, resume/fork,
 * and the three indirection hooks the lease re-points).
 *
 * `env`'s AUTH DECISION is included — whether `ANTHROPIC_API_KEY` is present,
 * and (when it is) a digest of its VALUE so a rotated key cannot be served from
 * a subprocess frozen with the old one — because serving a subscription session
 * from a subprocess warmed with an API key is exactly the silent-billing bug the
 * auth switch exists to prevent. The digest, never the key, is what this
 * fingerprint carries. The REST of `env` is deliberately excluded: it is a
 * spread of `process.env` overlaid with the (per-composition constant)
 * `config.env`, and
 * fingerprinting it verbatim was verified live to make prewarm brittle against
 * ambient noise outside this seam's control — the Claude Agent SDK itself sets
 * `CLAUDE_AGENT_SDK_VERSION` on `process.env` as a one-time side effect of its
 * first real `query()`/`startup()` call in a process, which silently
 * invalidated every warm handle fingerprinted before that call. Two subprocess
 * environments differing only in ambient noise like that ARE interchangeable.
 *
 * @param options - the resolved query options for a hypothetical session.
 * @returns a fingerprint string; equal fingerprints mean interchangeable subprocesses.
 */
export function warmFingerprint(options: CcQueryOptions): string {
  const { env, ...rest } = options
  const apiKey = env?.['ANTHROPIC_API_KEY']
  return JSON.stringify({
    ...stable(rest as unknown as Record<string, unknown>, true) as Record<string, unknown>,
    authKey: apiKey === undefined ? 'absent' : createHash('sha256').update(apiKey).digest('hex').slice(0, 16),
  })
}

/**
 * Recursively sort object keys so fingerprints do not depend on literal order.
 * @param value - the value to normalize.
 * @param top - true at the top level, where per-session keys are dropped.
 * @returns a normalized, JSON-stable structure.
 */
function stable(value: unknown, top = false): unknown {
  if (Array.isArray(value)) return value.map(entry => stable(entry))
  if (typeof value === 'function') return '[function]'
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (top && SESSION_SPECIFIC_KEYS.has(key)) continue
    const entry = source[key]
    if (entry === undefined) continue
    out[key] = stable(entry)
  }
  return out
}

/**
 * Holds at most ONE warm subprocess.
 *
 * Deliberately not a pool of many: a warm handle is single-use, a spare
 * subprocess is real memory, and the win is a one-shot ~300ms — one is the whole
 * benefit for an interactive composition and one is what teardown can always
 * account for.
 *
 * Note the ordering consequence: the first `open()` in a composition is always
 * cold, because a subprocess cannot be warmed before its `cwd` is known. The
 * service warms AFTER each open, for the next one.
 */
export class WarmPool {
  readonly #deps: WarmPoolDeps
  #held: { fingerprint: string, lease: CcWarmLease } | undefined
  #warming: Promise<void> | undefined
  #closed = false

  /**
   * @param deps - backend, enable switch and logger.
   */
  constructor(deps: WarmPoolDeps) {
    this.#deps = deps
  }

  /** Whether a warm handle is currently held. */
  get warm(): boolean {
    return this.#held !== undefined
  }

  /**
   * Spawn and initialize a subprocess for the NEXT open that matches
   * `template`. No-op when pre-warming is disabled, when one is already held,
   * when one is already being prepared, or after {@link WarmPool.close}.
   *
   * Never rejects: a failed pre-warm is a latency regression, not an error the
   * caller should have to handle, so it is logged and swallowed.
   *
   * @param template - the resolved options a future session would use.
   * @returns nothing.
   */
  async prewarm(template: CcQueryOptions): Promise<void> {
    if (!this.#deps.enabled || this.#closed) return
    if (this.#held !== undefined || this.#warming !== undefined) return
    this.#warming = this.startWarm(template)
    try {
      await this.#warming
    } finally {
      this.#warming = undefined
    }
  }

  /**
   * Take the warm handle when it matches, and clear the slot either way.
   *
   * A mismatch DISCARDS the stale handle (closing its subprocess) rather than
   * holding it for an open that may never come: a composition that changed
   * `cwd` or model has told us the old fingerprint is dead.
   *
   * @param template - the resolved options of the session about to open.
   * @returns the lease when the fingerprints match, else undefined.
   */
  acquire(template: CcQueryOptions): CcWarmLease | undefined {
    const held = this.#held
    if (held === undefined) return undefined
    this.#held = undefined
    if (held.fingerprint === warmFingerprint(template)) return held.lease

    this.#deps.logger?.debug('claude-code: warm subprocess discarded (options changed since it was warmed)')
    held.lease.close()
    return undefined
  }

  /**
   * Discard any warm handle and refuse further pre-warming. Idempotent; runs on
   * plugin teardown, where an orphan subprocess would outlive the composition.
   * @returns nothing.
   */
  async close(): Promise<void> {
    this.#closed = true
    // A pre-warm in flight must finish before we can close what it produced.
    if (this.#warming !== undefined) {
      try {
        await this.#warming
      } catch {
        // startWarm never throws; this is belt-and-braces for a fake backend.
      }
    }
    const held = this.#held
    this.#held = undefined
    held?.lease.close()
  }

  /**
   * Do the actual `startup()` and store the lease.
   * @param template - the options to freeze into the subprocess.
   * @returns nothing.
   */
  private async startWarm(template: CcQueryOptions): Promise<void> {
    const fingerprint = warmFingerprint(template)
    const sessionId = newCcSessionId()
    const abortController = new AbortController()
    // Indirection: the warmed subprocess routes through these slots, which the
    // accepting session re-points at itself. Until then they fail closed.
    const holder: { canUseTool: CcCanUseTool, stderr: (data: string) => void } = {
      canUseTool: warmDeny,
      stderr: (data: string) => {
        this.#deps.logger?.debug(`claude-code[warm] ${data}`)
      },
    }

    try {
      const handle: CcWarmQuery = await this.#deps.backend.startup({
        options: {
          ...template,
          sessionId,
          canUseTool: (toolName, input, request) => holder.canUseTool(toolName, input, request),
          stderr: (data: string) => {
            holder.stderr(data)
          },
          abortController,
        },
      })
      if (this.#closed) {
        handle.close()
        return
      }
      this.#held = { fingerprint, lease: makeLease(sessionId, abortController, holder, handle) }
    } catch (error) {
      this.#deps.logger?.debug(
        `claude-code: pre-warm failed (sessions will open cold): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Wrap a warm handle as a lease.
 * @param sessionId - the pre-minted id the subprocess was started with.
 * @param abortController - the controller the subprocess was started with.
 * @param holder - the mutable indirection slots.
 * @param handle - the SDK warm handle.
 * @returns the lease.
 */
function makeLease(
  sessionId: CcSessionId,
  abortController: AbortController,
  holder: { canUseTool: CcCanUseTool, stderr: (data: string) => void },
  handle: CcWarmQuery,
): CcWarmLease {
  return {
    sessionId,
    abortController,
    bind(handlers) {
      holder.canUseTool = handlers.canUseTool
      holder.stderr = handlers.stderr
    },
    query(prompt) {
      return handle.query(prompt)
    },
    close() {
      handle.close()
    },
  }
}

/**
 * Fail-closed permission answer for a warm subprocess nobody has leased yet.
 * @param _toolName - the tool (unused).
 * @param _input - the tool input (unused).
 * @param _request - the request context (unused).
 * @returns a deny decision.
 */
const warmDeny: CcCanUseTool = async (
  _toolName: string,
  _input: Record<string, unknown>,
  _request: CcPermissionRequest,
): Promise<CcPermissionDecision> => {
  return await Promise.resolve({
    behavior: 'deny',
    message: 'Denied: this Claude Code subprocess is pre-warmed and not attached to a session yet.',
  })
}
