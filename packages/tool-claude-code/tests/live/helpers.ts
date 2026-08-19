/**
 * Shared plumbing for the gated LIVE tool-runtime suite (`DSH_CC_LIVE=1`).
 *
 * This is Stage 2: validating the six `claude_code_*` tools THROUGH dsh's
 * `ToolRuntime` — the deepseek-harness-invokes-claude-code path, end to end —
 * as opposed to `packages/claude-code/tests/live/` (Phase 2's suite), which
 * drives the seam's `CcSession` actor directly. Every spec here calls
 * `ctx.tools.execute(...)`, exactly the way `dsh-agent-loop` would, against a
 * REAL Claude Code subprocess.
 *
 * The composition mounted here is the full stack Stage 2 asks for:
 * `SessionStore`, `AgentRegistry`, `ApprovalService`, `UserQuestionService`,
 * `ToolRuntime`, the jobs stack (`dsh-jobs-local` + `dsh-tool-jobs`, opt-in via
 * {@link MountLiveToolsOptions.jobs}), the real `ClaudeCodeService` (forced to
 * {@link LIVE_MODEL}), and `@deepseek-ai/dsh-tool-claude-code` itself — plus one
 * registered LIVE root agent standing in for "the delegating DeepSeek agent",
 * with an open turn on its own session (the precondition
 * `ctx.approval.request()` enforces).
 *
 * Reused from `packages/claude-code/tests/live/helpers.ts` rather than
 * duplicated: `LIVE`, `LIVE_MODEL`, `LIVE_TIMEOUT_MS`, `tmpCwd`/`removeCwd`,
 * `sleep`/`waitUntil`, and the per-session process-count assertions — the same
 * cross-package import shape `packages/tool-claude-code/tests/harness.ts`
 * already uses for the fake backend.
 *
 * Not a spec file: vitest only collects `*.spec.ts`, while `tsconfig.tests.json`
 * still type-checks this module.
 *
 * @module @deepseek-ai/dsh-tool-claude-code (live tests)
 */

import { randomUUID } from 'node:crypto'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ClaudeCodeService } from '@deepseek-ai/dsh-claude-code'
import type { ClaudeCodeConfig, ClaudeCodeServiceDeps } from '@deepseek-ai/dsh-claude-code'
import { CallId } from '@deepseek-ai/dsh-llm'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as ToolClaudeCode from '@deepseek-ai/dsh-tool-claude-code'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'

import {
  countClaudeProcesses, countSessionProcesses, LIVE, LIVE_MODEL, LIVE_TIMEOUT_MS, onceMessage, removeCwd, resultText,
  SEND_SETTLE_MS, sleep, tmpCwd, waitForSessionProcessCount, waitUntil,
} from '../../../claude-code/tests/live/helpers.ts'

export {
  countClaudeProcesses, countSessionProcesses, LIVE, LIVE_MODEL, LIVE_TIMEOUT_MS, onceMessage, removeCwd, resultText,
  SEND_SETTLE_MS, sleep, tmpCwd, waitForSessionProcessCount, waitUntil,
}

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

/** Which optional stacks to mount around the tools. */
export interface MountLiveToolsOptions {
  /** Mount `dsh-jobs-local` + `dsh-tool-jobs` so `background: true` works (default false). */
  readonly jobs?: boolean
  /** `ctx.approval`'s session-default policy (default `'ask'`). */
  readonly approvalPolicy?: 'ask' | 'never'
  /** Surface `ClaudeCodeConfig` overrides layered under the forced live model / isolation. */
  readonly claudeCode?: ClaudeCodeConfig
  /** Injectable seam overrides, exactly as `ClaudeCodeService`'s own `deps` (production tests pass none — real backend). */
  readonly claudeCodeDeps?: ClaudeCodeServiceDeps
}

/** One live root agent — the delegating "DeepSeek agent" stand-in — with an OPEN turn on its own session. */
export interface LiveDelegatingAgent {
  readonly agent: Agent
  readonly session: Session
  dispose(): Promise<void>
}

/** One fully mounted live composition, plus everything a spec needs to drive it through the tool runtime. */
export interface ToolLiveHarness {
  readonly ctx: Context
  readonly service: ClaudeCodeService
  /** The registered delegating agent every ask-routed spec calls tools as. */
  readonly root: LiveDelegatingAgent
  /**
   * Execute one tool through the REAL runtime — schema validation, policy
   * pipeline, presenters and output-schema enforcement included — exactly the
   * path `dsh-agent-loop` uses.
   * @param name - the tool name.
   * @param args - the raw (unvalidated) arguments.
   * @param options - the calling agent (default: none — a headless call) and/or a caller signal.
   * @returns the normalized execution result.
   */
  call(
    name: string,
    args: unknown,
    options?: { agent?: Agent, signal?: AbortSignal },
  ): Promise<ToolExecutionResult>
  /** Tear the whole composition down: every session, every subprocess, every fiber. */
  dispose(): Promise<void>
}

/**
 * Register a scripted `approval/request` answerer on a live tool composition.
 * Mirrors `packages/claude-code/tests/live/ask-live-helpers.ts`'s
 * `scriptApproval`, restated here so this suite does not reach into another
 * package's `tests/live/` for a one-line waterfall registration.
 * @param ctx - the composition (`ApprovalService` mounted — every {@link mountLiveTools} result qualifies).
 * @param answer - the outcome (or a function of the request) to answer with.
 * @returns every request seen, and a disposer.
 */
export function scriptApproval(
  ctx: Context,
  answer: ApprovalOutcome | ((request: ApprovalRequest) => Promise<ApprovalOutcome> | ApprovalOutcome),
): { requests: ApprovalRequest[], dispose: () => void } {
  const requests: ApprovalRequest[] = []
  const dispose = ctx.on('approval/request', async (request) => {
    requests.push(request)
    return await Promise.resolve(typeof answer === 'function' ? answer(request) : answer)
  })
  return { requests, dispose }
}

/**
 * Register a scripted `ctx.userQuestions` provider that answers every
 * question with one selected option (by label).
 * @param ctx - the composition (`UserQuestionService` mounted).
 * @param pickLabel - which option label to select for every question.
 * @returns a disposer.
 */
export function scriptQuestionAnswer(ctx: Context, pickLabel: string): () => void {
  return ctx.userQuestions.registerProvider({
    ask: async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => await Promise.resolve({
      answers: request.questions.map(question => ({
        id: question.id,
        selected: [question.options?.find(option => option.label === pickLabel)?.label ?? pickLabel],
      })),
    }),
  })
}

let callCounter = 0

/**
 * Mount the full live composition: the seams the tool layer reads
 * opportunistically (`sessions`, `agents`, `jobs`), the ask channel's two dsh
 * seams (`approval`, `userQuestions`), `ToolRuntime`, the REAL
 * `ClaudeCodeService` (real SDK backend, forced to {@link LIVE_MODEL}, full
 * setting isolation), `@deepseek-ai/dsh-tool-claude-code`, and one registered
 * root agent with an open turn standing in for the delegating DeepSeek agent.
 * @param options - which optional stacks to include, and config overrides.
 * @returns the harness.
 */
export async function mountLiveTools(options: MountLiveToolsOptions = {}): Promise<ToolLiveHarness> {
  const ctx = new Context()
  const fibers: Array<{ dispose(): Promise<unknown> }> = []

  // `SystemPrompt` is mounted FIRST and unconditionally: `ToolRuntime`'s own
  // `inject` list includes `systemPrompt`, so its fiber stays pending (and
  // `ctx.tools` stays undefined — with no thrown error to notice by) until
  // this is satisfied. Discovered live: only the `jobs: true` mounts (which
  // happened to also mount `SystemPrompt`, for `dsh-tool-jobs`' own inject
  // list) ever unparked it; the `jobs: false` path silently never did.
  const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(AgentRegistry))
  fibers.push(await ctx.plugin(UserQuestionService))
  fibers.push(await ctx.plugin(ApprovalService, { policy: options.approvalPolicy ?? 'ask' }))

  if (options.jobs === true) {
    fibers.push(await ctx.plugin(LocalJobRegistry))
    fibers.push(await ctx.plugin(ToolJobs))
  }

  let service: ClaudeCodeService | undefined
  function claudeCodeLiveToolMount(inner: Context): void {
    service = new ClaudeCodeService(
      inner,
      {
        ...options.claudeCode,
        defaults: {
          ...options.claudeCode?.defaults,
          settingSources: options.claudeCode?.defaults?.settingSources ?? [],
          model: LIVE_MODEL,
        },
      },
      options.claudeCodeDeps ?? {},
    )
  }
  fibers.push(await ctx.plugin(claudeCodeLiveToolMount))
  if (service === undefined) throw new Error('mountLiveTools: mount did not construct ClaudeCodeService')
  fibers.push(await ctx.plugin(ToolClaudeCode))

  const root = await registerRootAgent(ctx)

  return {
    ctx,
    service,
    root,
    call: async (name, args, callOptions = {}) => await ctx.tools.execute({
      signal: callOptions.signal ?? new AbortController().signal,
      callId: CallId(`call-${++callCounter}`),
      name,
      arguments: args,
      ...(callOptions.agent === undefined ? {} : { agent: callOptions.agent }),
    }),
    dispose: async () => {
      await root.dispose()
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/**
 * Poll an ASYNC read (a tool call, typically) until `predicate` is satisfied
 * or `timeoutMs` elapses. `waitUntil` (reused above from the seam's live
 * helpers) reads synchronously and cannot drive a `harness.call(...)` — every
 * poll loop in this suite goes through here instead.
 * @param read - performs one read (may itself await a tool call).
 * @param predicate - what we are waiting for.
 * @param timeoutMs - give up after this long (returns the last observed value; does not throw).
 * @param pollMs - interval between reads.
 * @returns the last observed value (may not satisfy `predicate` if it timed out).
 */
export async function waitForAsync<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  pollMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!predicate(value) && Date.now() < deadline) {
    await sleep(pollMs)
    value = await read()
  }
  return value
}

/**
 * Register one live root agent — a real dsh `Session` plus an `Agent`
 * wrapping it, registered through `ctx.agents.register()` (so it appears in
 * `ctx.agents.roots()`, matching `resolveAskTarget`'s `delegated: false`) —
 * with an OPEN turn already on its session, satisfying `ctx.approval.request()`'s
 * open-turn precondition before any tool call runs.
 *
 * This is deliberately independent of the CC session's own mirror (a SEPARATE
 * dsh session, keyed by the Claude Code session id — see `src/open.ts`): the
 * approval/question audit pairs land HERE, in the delegating agent's log,
 * exactly as production does.
 * @param ctx - a context with `AgentRegistry` and `SessionStore` already mounted.
 * @returns the agent, its session, and a disposer.
 */
export async function registerRootAgent(ctx: Context): Promise<LiveDelegatingAgent> {
  const id = SessionId(randomUUID())
  const session = ctx.sessions.create(id)
  const agent = { id, session, ctx } as unknown as Agent
  const fiber = await ctx.plugin(Object.assign((inner: Context) => {
    inner.agents.register(agent)
  }, { inject: ['agents'] }))
  session.append('turn/start', { turn: 1 })
  return { agent, session, dispose: async () => { await fiber.dispose() } }
}
