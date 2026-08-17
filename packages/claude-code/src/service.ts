/**
 * The `ctx.claudeCode` service: the seam every consumer talks to, and (from
 * Phase 2) the owner of every live Claude Code session in a composition.
 *
 * Phase 1 holds the validated configuration and an empty session registry;
 * `open()` and `accountInfo()` reject with `NOT_IMPLEMENTED`.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

import { Config as ConfigSchema, resolveClaudeCodeConfig } from './config.ts'
import type { ClaudeCodeConfig, ResolvedClaudeCodeConfig } from './config.ts'
import { ClaudeCodeError } from './types.ts'
import type {
  CcAccountInfo, CcContextUsage, CcOpenOptions, CcSessionId, CcSessionSnapshot, CcSessionStatus,
  ClaudeCode,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Claude Code seam. Provided by `@deepseek-ai/dsh-claude-code`. */
    claudeCode: ClaudeCodeService
  }

  /**
   * Placeholder for the seam's event vocabulary. Phase 3 (the mirror) declares
   * the `claude-code/*` events here — and every one of them must also be
   * declaration-merged into `SessionEventMap` and marked `ignorable`, or an
   * older runtime refuses the log. Nothing is dispatched yet, so nothing is
   * declared yet: an event declared before it is emitted invites listeners
   * that can never fire.
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
  /** Settle pending asks as denied, then close the SDK query. Must be idempotent. */
  close(): Promise<void>
}

/** Message used by every Phase 1 stub, so the phase that lands the behavior is always named. */
const NOT_IMPLEMENTED_SUFFIX = 'lands in Phase 2 (the session actor); the Phase 1 scaffold owns configuration and the session registry only'

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
   * @param ctx - the context that owns the service; disposal closes every session.
   * @param config - surface configuration; defaults are resolved here so a
   *   hand-mounted service behaves exactly like a `cordis.yml` row.
   */
  constructor(ctx: Context, config: ClaudeCodeConfig = {}) {
    super(ctx, 'claudeCode')
    this.config = resolveClaudeCodeConfig(config)

    // Every session's lifetime is owned by this fiber: unloading the plugin
    // (HMR, teardown, a failed mount) must not leave a Claude Code subprocess
    // holding a permission callback nobody will ever answer.
    ctx.effect(() => async () => {
      await this.closeAll()
    }, 'claudeCode:sessions')
  }

  /**
   * Open (or resume, or fork) a Claude Code session.
   * @param options - working directory, first prompt, model, permission mode, resume/fork.
   * @returns the new session's snapshot.
   * @throws {ClaudeCodeError} code `NOT_IMPLEMENTED` in Phase 1.
   */
  open(options: CcOpenOptions): Promise<CcSessionSnapshot> {
    return Promise.reject(new ClaudeCodeError(
      `claude-code: open(${JSON.stringify(options.cwd)}) ${NOT_IMPLEMENTED_SUFFIX}`,
      'NOT_IMPLEMENTED'))
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
   * @returns the account projection.
   * @throws {ClaudeCodeError} code `NOT_IMPLEMENTED` in Phase 1.
   */
  accountInfo(): Promise<CcAccountInfo> {
    return Promise.reject(new ClaudeCodeError(
      `claude-code: accountInfo() ${NOT_IMPLEMENTED_SUFFIX}`,
      'NOT_IMPLEMENTED'))
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
  return {
    id: record.id,
    status: record.status,
    ...(record.model === undefined ? {} : { model: record.model }),
    pendingAsks: record.pendingAsks,
    ...(record.contextUsage === undefined ? {} : { contextUsage: record.contextUsage }),
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
