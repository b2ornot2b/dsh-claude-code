/**
 * Shared plumbing for the gated LIVE integration suite (`DSH_CC_LIVE=1`).
 *
 * Every spec under `tests/live/` opens a REAL Claude Code subprocess through
 * the REAL SDK backend (`realBackend`), authenticated via the machine's
 * claude.ai subscription login. Rules every file in this directory follows:
 *
 * - Model is ALWAYS {@link LIVE_MODEL} (tiny, fast, cheap).
 * - `ANTHROPIC_API_KEY` is never set by a test; `auth: 'subscription'`
 *   (the config default) strips it from the subprocess env regardless.
 * - Every test owns an isolated tmp cwd ({@link tmpCwd}) removed on teardown.
 * - Every test disposes its own mount (and any session it opened) before
 *   returning, so no subprocess outlives the test.
 *
 * Not a spec file: vitest only collects `*.spec.ts`, while `tsconfig.tests.json`
 * still type-checks this module.
 *
 * @module @deepseek-ai/dsh-claude-code (live tests)
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { Context } from '@deepseek-ai/cordis'
import { ClaudeCodeService } from '@deepseek-ai/dsh-claude-code'
import type {
  CcBackendQuery, CcMessageEnvelope, CcSdkMessage, CcSdkUserMessage, CcSession, ClaudeCodeConfig,
  ClaudeCodeServiceDeps, QueryBackend,
} from '@deepseek-ai/dsh-claude-code'

const execFileP = promisify(execFile)

/** The only model any live test may use. */
export const LIVE_MODEL = 'claude-haiku-4-5-20251001'

/** The hard per-test timeout (ms) every `it(...)` in this directory is given. */
export const LIVE_TIMEOUT_MS = 240_000

/**
 * pgrep pattern for the SDK's own bundled per-platform executable
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`) — the exact
 * scoping spike 5's `probe-orphan.mjs` used. Matching the vendored binary path
 * (not the bare word `claude`) keeps this from tripping over an unrelated
 * `claude` process on the developer's machine.
 *
 * Note what this pattern CANNOT do: distinguish one live spec's subprocess from
 * another's. Vitest runs these nine files in parallel, so a whole-machine count
 * is not a property any single test can assert on — a before/after delta around
 * one test's teardown reads its neighbours' subprocesses as its own orphans
 * (observed: a teardown run measuring `before = 0` and `after = 2`, both of them
 * other specs' healthy sessions). Per-session scoping below is what teardown
 * assertions actually use.
 */
const CLAUDE_PROC_PATTERN = 'claude-agent-sdk-[a-z0-9-]*/claude'

/**
 * pgrep pattern for ONE session's subprocess. SDK 0.3.233 spawns the CLI with
 * `--session-id=<uuid>` in its argv whenever `options.sessionId` is set (true
 * for every fresh session and every fork, and for every pre-warmed handle,
 * which is warmed with a pre-minted id) — so this matches exactly one process
 * and is immune both to a parallel neighbour and to anything else on the
 * developer's machine.
 *
 * The leading `--` is dropped from the pattern deliberately: a pgrep pattern
 * that starts with a dash is parsed as an option.
 * @param sessionId - the session whose subprocess to look for.
 * @returns the pgrep pattern.
 */
function sessionProcPattern(sessionId: string): string {
  return `session-id=${sessionId}`
}

/** One mounted live service: the root context, its plugin fiber, and the raw service. */
export interface LiveMount {
  readonly ctx: Context
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
  readonly service: ClaudeCodeService
}

/**
 * Mount a REAL `ClaudeCodeService` (default deps resolve to `realBackend`
 * unless overridden) in a bare cordis Context — the pattern
 * `tests/service.spec.ts` uses for the offline suite.
 *
 * The model is ALWAYS forced to {@link LIVE_MODEL} regardless of what a test
 * passes in `config.defaults`, and setting isolation stays full (`[]`) unless
 * a test overrides it.
 *
 * @param config - surface config overrides (`prewarm`, `drainPollMs` is on `deps`, etc.).
 * @param deps - injectable seams; production tests only ever override `backend` (a counting spy).
 * @returns the mounted context, fiber and raw service instance.
 */
export async function mountLive(
  config: ClaudeCodeConfig = {},
  deps: ClaudeCodeServiceDeps = {},
): Promise<LiveMount> {
  const ctx = new Context()
  let service: ClaudeCodeService | undefined
  // A named function declaration (not `Object.assign(fn, { name })`): a
  // function's own `name` is not writable.
  function claudeCodeLiveMount(inner: Context): void {
    service = new ClaudeCodeService(
      inner,
      { ...config, defaults: { ...config.defaults, settingSources: config.defaults?.settingSources ?? [], model: LIVE_MODEL } },
      deps)
  }
  const fiber = await ctx.plugin(claudeCodeLiveMount)
  if (service === undefined) throw new Error('mountLive: mount did not construct the service')
  return { ctx, fiber, service }
}

/** Dispose a live mount all the way down: closes every session, kills every subprocess it owned. */
export async function disposeLive(mounted: LiveMount): Promise<void> {
  await mounted.fiber.dispose()
  await mounted.ctx.fiber.dispose()
}

/** A fresh, empty, absolute tmp directory. The caller removes it with {@link removeCwd}. */
export function tmpCwd(label: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-cc-live-${label}-`))
}

/** Remove a directory made by {@link tmpCwd}. Never throws. */
export function removeCwd(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** Resolve after `ms` milliseconds. */
export async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

/**
 * Grace window after pushing a message before acting on it (e.g. calling
 * `interrupt()`) — the real subprocess needs a moment to actually drain the
 * message off stdin; acting immediately races ahead of the CLI's own
 * queueing. Matches the delay spike 3's `probe-interrupt-queued.mjs` used
 * before calling `interrupt()`.
 */
export const SEND_SETTLE_MS = 300


/**
 * Poll `read()` until `predicate` is satisfied or `timeoutMs` elapses.
 * @param read - reads the current value.
 * @param predicate - what we are waiting for.
 * @param timeoutMs - give up after this long (returns the last observed value; does not throw).
 * @param pollMs - interval between reads.
 * @returns the last observed value (may not satisfy `predicate` if it timed out).
 */
export async function waitUntil<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  pollMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = read()
  while (!predicate(value) && Date.now() < deadline) {
    await sleep(pollMs)
    value = read()
  }
  return value
}

/**
 * Resolve with the first message a session emits that matches `predicate`.
 * @param session - the live session actor.
 * @param predicate - what we are waiting for.
 * @param timeoutMs - reject if nothing matches within this long.
 * @returns the matching envelope.
 */
export async function onceMessage(
  session: CcSession,
  predicate: (envelope: CcMessageEnvelope) => boolean,
  timeoutMs: number,
): Promise<CcMessageEnvelope> {
  return await new Promise<CcMessageEnvelope>((resolve, reject) => {
    let stop: () => void = () => {}
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`onceMessage: timed out after ${timeoutMs}ms waiting for a matching message`))
    }, timeoutMs)
    stop = session.onMessage((envelope) => {
      if (!predicate(envelope)) return
      clearTimeout(timer)
      stop()
      resolve(envelope)
    })
  })
}

/** Read a `result` message's text payload. The SDK types it as `result`; `CcSdkMessage` leaves it open. */
export function resultText(message: CcSdkMessage): string {
  const value = message['result']
  return typeof value === 'string' ? value : ''
}

/**
 * Count live Claude Code subprocesses system-wide, scoped to the SDK's own
 * bundled binary path (spike 5's `probe-orphan.mjs` pattern), so an unrelated
 * `claude` process elsewhere on the machine cannot false-positive it.
 *
 * Diagnostics ONLY — never assert on this. It cannot tell one live spec's
 * subprocess from another's, and these specs run in parallel; use
 * {@link countSessionProcesses} for anything a test depends on.
 * @returns the number of matching processes right now.
 */
export async function countClaudeProcesses(): Promise<number> {
  return await pgrepCount(CLAUDE_PROC_PATTERN)
}

/**
 * Count the live subprocesses belonging to ONE session id — the only
 * process assertion a parallel-safe live test may make (see
 * {@link sessionProcPattern}).
 * @param sessionId - the session whose subprocess to count.
 * @returns 1 while that session's subprocess is alive, 0 once it is gone.
 */
export async function countSessionProcesses(sessionId: string): Promise<number> {
  return await pgrepCount(sessionProcPattern(sessionId))
}

/**
 * Poll {@link countSessionProcesses} until it reaches `target` or `timeoutMs`
 * elapses (subprocess exit has a documented ~2s stdin-EOF grace period).
 * @param sessionId - the session whose subprocess to watch.
 * @param target - the count being waited for.
 * @param timeoutMs - give up after this long.
 * @param pollMs - interval between checks.
 * @returns the last observed count.
 */
export async function waitForSessionProcessCount(
  sessionId: string,
  target: number,
  timeoutMs: number,
  pollMs = 250,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let count = await countSessionProcesses(sessionId)
  while (count !== target && Date.now() < deadline) {
    await sleep(pollMs)
    count = await countSessionProcesses(sessionId)
  }
  return count
}

/**
 * Count processes matching a pgrep pattern.
 * @param pattern - the `pgrep -f` pattern.
 * @returns the number of matching processes right now.
 */
async function pgrepCount(pattern: string): Promise<number> {
  try {
    const { stdout } = await execFileP('pgrep', ['-f', pattern])
    const trimmed = stdout.trim()
    return trimmed.length === 0 ? 0 : trimmed.split('\n').length
  } catch {
    // pgrep exits 1 (no matches) — that IS the zero-count answer, not a failure.
    return 0
  }
}

/** A backend wrapper that counts `query()`/`startup()` calls and remembers the last warmed sessionId. */
export interface BackendCountSpy {
  readonly backend: QueryBackend
  queryCount: number
  startupCount: number
  lastStartupSessionId: string | undefined
}

/**
 * Wrap a real backend with call counters, so a test can prove "this open used
 * the warm handle" (no extra `query()` call, and the session's id matches what
 * `startup()` was called with) without reaching into the pool's private state.
 * @param inner - the backend to wrap (always `realBackend` in this suite).
 * @returns the spy.
 */
export function wrapBackendCounts(inner: QueryBackend): BackendCountSpy {
  // Built as one literal (never reassigned): `backend`'s methods close over
  // `spy` lazily, so referencing it here is safe even though the literal
  // itself is still being constructed — nothing calls `query`/`startup`
  // until well after this function returns.
  const spy: BackendCountSpy = {
    backend: {
      query(params: Parameters<QueryBackend['query']>[0]) {
        spy.queryCount += 1
        return inner.query(params)
      },
      async startup(params: Parameters<QueryBackend['startup']>[0]) {
        spy.startupCount += 1
        spy.lastStartupSessionId = params.options.sessionId
        return await inner.startup(params)
      },
    },
    queryCount: 0,
    startupCount: 0,
    lastStartupSessionId: undefined,
  }
  return spy
}

/** A backend wrapper that counts every `interrupt()` call across every query it produces. */
export interface BackendInterruptSpy {
  readonly backend: QueryBackend
  interruptCalls: number
}

/**
 * Wrap a real backend so every `interrupt()` call, on every query it hands
 * out (cold or warmed), increments a shared counter — the only way to observe
 * the `keepQueued:false` drain loop's iteration count against a real
 * subprocess (the session itself keeps no public counter).
 * @param inner - the backend to wrap (always `realBackend` in this suite).
 * @returns the spy.
 */
export function wrapBackendInterruptSpy(inner: QueryBackend): BackendInterruptSpy {
  function wrapQuery(query: CcBackendQuery): CcBackendQuery {
    return {
      interrupt: async () => {
        spy.interruptCalls += 1
        return await query.interrupt()
      },
      initializationResult: async () => await query.initializationResult(),
      setModel: async model => await query.setModel(model),
      setPermissionMode: async mode => await query.setPermissionMode(mode),
      accountInfo: async () => await query.accountInfo(),
      close: () => {
        query.close()
      },
      [Symbol.asyncIterator]: () => query[Symbol.asyncIterator](),
    }
  }

  // Same lazy-closure shape as {@link wrapBackendCounts}: `backend` references
  // `spy` only inside callbacks that run long after construction finishes.
  const spy: BackendInterruptSpy = {
    backend: {
      query(params: Parameters<QueryBackend['query']>[0]) {
        return wrapQuery(inner.query(params))
      },
      async startup(params: Parameters<QueryBackend['startup']>[0]) {
        const warm = await inner.startup(params)
        return {
          query: (prompt: AsyncIterable<CcSdkUserMessage>) => wrapQuery(warm.query(prompt)),
          close: () => {
            warm.close()
          },
        }
      },
    },
    interruptCalls: 0,
  }
  return spy
}

/** Whether the gated live suite should run at all. Every live spec's top-level `describe` gates on this. */
export const LIVE = process.env['DSH_CC_LIVE'] === '1'
