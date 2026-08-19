/**
 * The offline composition every tool spec in this package runs against.
 *
 * There is no hand-written "fake seam" here on purpose. `ctx.claudeCode` is the
 * REAL `ClaudeCodeService`, mounted with the Phase 2 fake backend injected in
 * place of the Claude Agent SDK — so these specs exercise the actual seam
 * (session registry, status machine, outbox, mirror wiring, ask target) rather
 * than a double that can drift from it, and still spawn nothing. A structural
 * double is impossible anyway: `ClaudeCodeService` and `CcSession` both carry
 * private fields, so nothing else is assignable to them.
 *
 * The optional services are mounted a la carte, because their absence is a
 * supported composition:
 *
 * - no `ctx.sessions` — the session opens UNMIRRORED;
 * - no `ctx.jobs` — `background: true` fails with a typed `CC_NO_JOBS`;
 * - no `ctx.agents` — every ask target is `delegated: true`.
 *
 * Not a spec file: `vitest` collects `*.spec.ts` only.
 */

import { tmpdir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ClaudeCodeService } from '@deepseek-ai/dsh-claude-code'
import type { QueryBackend } from '@deepseek-ai/dsh-claude-code'
import { CallId } from '@deepseek-ai/dsh-llm'
import { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { JobHooks, JobRead, JobSnapshot, JobStart } from '@deepseek-ai/dsh-jobs'
import { SessionStore } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolClaudeCode from '@deepseek-ai/dsh-tool-claude-code'

import { createFakeBackend, settle } from '../../claude-code/tests/fake-backend.ts'
import type { FakeBackend } from '../../claude-code/tests/fake-backend.ts'

/** An absolute directory that certainly exists — the seam validates `cwd` before anything spawns. */
export const CWD = tmpdir()

/** Every tool this package registers. */
export const TOOL_NAMES = [
  'claude_code_open',
  'claude_code_send',
  'claude_code_wait',
  'claude_code_status',
  'claude_code_list',
  'claude_code_cancel',
  'claude_code_close',
] as const

/**
 * A job registry that records what producers ask of it and runs their starter
 * immediately, exactly as `@deepseek-ai/dsh-jobs-local` does — but with no
 * lifecycle of its own, so a spec can drive the returned {@link JobHooks} by
 * hand and assert the contract (sync idempotent `cancel`, never-rejecting
 * `done`, consuming `readOutput`).
 */
export class RecordingJobRegistry extends JobRegistry {
  /** Every spec passed to {@link RecordingJobRegistry.start}, in order. */
  readonly started: JobStart[] = []
  /** The hooks each starter returned, index-aligned with {@link RecordingJobRegistry.started}. */
  readonly hooks: JobHooks[] = []
  /**
   * When set, {@link RecordingJobRegistry.start} throws it INSTEAD of running
   * the producer — the shape `@deepseek-ai/dsh-jobs-local` has when it refuses a
   * registration (the per-owner concurrency cap, a missing controller, an
   * invalid kind/label). Every one of those refusals is raised before
   * `spec.run()` is called, which is what the tool layer relies on to promise
   * that a refused background open started nothing.
   */
  startError: Error | undefined
  /**
   * When the scripted {@link RecordingJobRegistry.startError} is raised.
   * `'before-run'` is what the real registry does; `'after-run'` is the
   * CONTRACT-VIOLATING provider the tool layer defends against, because a
   * producer whose `run()` already fired would otherwise be left holding a
   * session nothing can reach.
   */
  startErrorTiming: 'before-run' | 'after-run' = 'before-run'

  /**
   * Register one job and start it.
   * @param spec - the producer declaration.
   * @returns the minted job id.
   * @throws {@link RecordingJobRegistry.startError} when a refusal is scripted.
   */
  override start(spec: JobStart): JobId {
    if (this.startError !== undefined && this.startErrorTiming === 'before-run') throw this.startError
    this.started.push(spec)
    if (this.startError !== undefined) {
      this.hooks.push(spec.run())
      throw this.startError
    }
    this.hooks.push(spec.run())
    return JobId(`claude-code-${this.started.length}`)
  }

  /** @returns an empty list; these specs drive hooks directly. */
  override list(): JobSnapshot[] {
    return []
  }

  /** @throws always; unused by the tool layer. */
  override get(): JobSnapshot {
    throw new Error('RecordingJobRegistry.get is not used by these specs')
  }

  /** @throws always; unused by the tool layer. */
  override read(): JobRead {
    throw new Error('RecordingJobRegistry.read is not used by these specs')
  }

  /** @returns `already-finished`; unused by the tool layer. */
  override kill(): 'requested' | 'already-finished' {
    return 'already-finished'
  }

  /** @throws always; unused by the tool layer. */
  override async wait(): Promise<JobSnapshot> {
    return await Promise.reject(new Error('RecordingJobRegistry.wait is not used by these specs'))
  }

  /** @returns a no-op disposer. */
  override onJobDone(): () => void {
    return () => {}
  }

  /** @returns a no-op disposer. */
  override onJobsChanged(): () => void {
    return () => {}
  }

  /** @returns a no-op disposer. */
  override attachController(): () => void {
    return () => {}
  }
}

/** Which optional services a mount includes. */
export interface MountOptions {
  /** Mount a real `SessionStore` so opened sessions are mirrored (default true). */
  readonly sessions?: boolean
  /** Mount {@link RecordingJobRegistry} so `background: true` is available (default false). */
  readonly jobs?: boolean
  /**
   * Make every `query()` throw, so `open()` fails with `BACKEND_ERROR` — the
   * "the subprocess refused to start" case a background job must survive
   * without ever rejecting its `done` promise.
   */
  readonly breakBackend?: boolean
}

/** One mounted composition, plus everything a spec needs to drive it. */
export interface ToolHarness {
  /** The root context. */
  readonly ctx: Context
  /** The injected fake SDK backend: every query the seam opened. */
  readonly fake: FakeBackend
  /** The job registry, when one was mounted. */
  readonly jobs: RecordingJobRegistry | undefined
  /**
   * Execute one tool through the real runtime (schema validation, presenters
   * and output-schema enforcement included).
   * @param name - the tool name.
   * @param args - the raw arguments.
   * @param options - the calling agent and/or a caller signal.
   * @returns the normalized execution result.
   */
  call(
    name: string,
    args: unknown,
    options?: { agent?: Agent, signal?: AbortSignal },
  ): Promise<ToolExecutionResult>
  /** Tear the whole composition down. */
  dispose(): Promise<void>
}

let callCounter = 0

/**
 * Mount the tool plugin over the real seam (fake backend) and the services the
 * spec asked for.
 * @param options - which optional services to include.
 * @returns the harness.
 */
export async function mountTools(options: MountOptions = {}): Promise<ToolHarness> {
  const fake = createFakeBackend()
  const ctx = new Context()
  const fibers: Array<{ dispose(): Promise<unknown> }> = []

  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  if (options.sessions !== false) fibers.push(await ctx.plugin(SessionStore))

  let jobs: RecordingJobRegistry | undefined
  if (options.jobs === true) {
    // A named function declaration, not an arrow: cordis reads the plugin's own
    // `name`, and a function's `name` is not writable.
    function recordingJobsMount(inner: Context): void {
      jobs = new RecordingJobRegistry(inner)
    }
    fibers.push(await ctx.plugin(recordingJobsMount))
  }

  const backend: QueryBackend = options.breakBackend === true
    ? {
        query: () => {
          throw new Error('fake: the subprocess refused to start')
        },
        startup: fake.backend.startup.bind(fake.backend),
      }
    : fake.backend

  function claudeCodeToolMount(inner: Context): void {
    // `prewarm: false`: a warm subprocess would hand the next open a query that
    // never lands in `fake.queries`, making the specs' indexing racy for no gain.
    void new ClaudeCodeService(inner, { prewarm: false }, { backend, drainPollMs: 1 })
  }
  fibers.push(await ctx.plugin(claudeCodeToolMount))
  fibers.push(await ctx.plugin(ToolClaudeCode))

  return {
    ctx,
    fake,
    jobs,
    call: async (name, args, callOptions = {}) => await ctx.tools.execute({
      signal: callOptions.signal ?? new AbortController().signal,
      callId: CallId(`call-${++callCounter}`),
      name,
      arguments: args,
      ...(callOptions.agent === undefined ? {} : { agent: callOptions.agent }),
    }),
    dispose: async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/**
 * Let the event loop turn until `predicate` holds.
 * @param predicate - the condition to wait for.
 * @param label - what the spec was waiting for, for the failure message.
 * @param attempts - how many macrotask turns to allow.
 * @returns nothing.
 */
export async function waitFor(
  predicate: () => boolean,
  label: string,
  attempts = 50,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await settle()
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * The live query the seam opened for the first session, once it exists.
 * @param harness - the mounted harness.
 * @param index - which query (default the first).
 * @returns the fake query.
 */
export async function firstQuery(
  harness: ToolHarness,
  index = 0,
): Promise<FakeBackend['queries'][number]> {
  await waitFor(() => harness.fake.queries.length > index, `query #${index}`)
  const query = harness.fake.queries[index]
  if (query === undefined) throw new Error(`no query #${index}`)
  return query
}

/**
 * A minimal stand-in for the agent a tool call runs on behalf of.
 *
 * The tool layer reads exactly two things off it — `agent.id` (to decide
 * `delegated` against `ctx.agents.roots()`) and the object identity it forwards
 * as the job's `owner` — so a full `Agent` (loop, session, inbox) would be
 * ceremony with no coverage attached.
 * @param id - the agent id.
 * @returns the double, typed as an `Agent`.
 */
export function fakeAgent(id = 'agent-1'): Agent {
  return { id } as unknown as Agent
}

export { settle }
