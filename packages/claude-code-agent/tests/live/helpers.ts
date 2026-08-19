/**
 * Shared plumbing for the gated LIVE agent-adapter suite (`DSH_CC_LIVE=1`).
 *
 * This is Stage 2 for `@deepseek-ai/dsh-claude-code-agent`: driving the
 * CC-backed dsh `Agent` the way a HUMAN at the dsh UI would — spawn through
 * `ctx.claudeCodeAgents.spawn()` (never `createClaudeCodeAgent()` directly,
 * and never the seam's `CcSession` actor directly), then `followup`/`steer`/
 * `cancel`/dispose the returned `Agent`, observing approvals and questions
 * land under the AGENT's own identity — against a REAL Claude Code subprocess.
 *
 * The composition mounted here is the full stack the module doc under review
 * asks for: `SessionStore`, `AgentRegistry`, `ApprovalService`,
 * `UserQuestionService`, the real `ClaudeCodeService` (forced to
 * {@link LIVE_MODEL}), and the adapter plugin itself
 * (`@deepseek-ai/dsh-claude-code-agent`) — jobs are not required.
 *
 * Reused from `packages/claude-code/tests/live/helpers.ts` rather than
 * duplicated: `LIVE`, `LIVE_MODEL`, `LIVE_TIMEOUT_MS`, `tmpCwd`/`removeCwd`,
 * `sleep`/`waitUntil`, `onceMessage`, `resultText`, and the per-session
 * process-count assertions — the same cross-package import shape
 * `packages/tool-claude-code/tests/live/helpers.ts` already uses.
 *
 * Not a spec file: vitest only collects `*.spec.ts`, while `tsconfig.tests.json`
 * still type-checks this module.
 *
 * @module @deepseek-ai/dsh-claude-code-agent (live tests)
 */

import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ClaudeCodeService } from '@deepseek-ai/dsh-claude-code'
import type { ClaudeCodeConfig, ClaudeCodeServiceDeps } from '@deepseek-ai/dsh-claude-code'
import { SessionStore } from '@deepseek-ai/dsh-session'
import type { Session as DshSession } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'

import * as ClaudeCodeAgentPlugin from '@deepseek-ai/dsh-claude-code-agent'
import type { CcAgentHandle, CcAgentOptions, CcAgentSpawnDeps } from '@deepseek-ai/dsh-claude-code-agent'

import {
  countSessionProcesses, LIVE, LIVE_MODEL, LIVE_TIMEOUT_MS, onceMessage, removeCwd, resultText, SEND_SETTLE_MS,
  sleep, tmpCwd, waitForSessionProcessCount, waitUntil,
} from '../../../claude-code/tests/live/helpers.ts'

export {
  countSessionProcesses, LIVE, LIVE_MODEL, LIVE_TIMEOUT_MS, onceMessage, removeCwd, resultText, SEND_SETTLE_MS,
  sleep, tmpCwd, waitForSessionProcessCount, waitUntil,
}

/** Which optional bits to vary in a mount. */
export interface MountLiveAgentOptions {
  /** `ctx.approval`'s session-default policy (default `'ask'`). */
  readonly approvalPolicy?: 'ask' | 'never'
  /** Surface `ClaudeCodeConfig` overrides layered under the forced live model / isolation. */
  readonly claudeCode?: ClaudeCodeConfig
  /** Injectable seam overrides, exactly as `ClaudeCodeService`'s own `deps` (production tests pass none). */
  readonly claudeCodeDeps?: ClaudeCodeServiceDeps
}

/** One fully mounted live composition, plus the entry point a human-driven test uses to spawn agents. */
export interface LiveAgentHarness {
  readonly ctx: Context
  readonly service: ClaudeCodeService
  /**
   * The adapter plugin's OWN fiber (`@deepseek-ai/dsh-claude-code-agent`,
   * mounted last). Disposing THIS ALONE — never the whole harness — is the
   * HMR path: `ctx.agents`/`ctx.sessions`/`ctx.claudeCode` all stay live,
   * exactly as a plugin unload/reload in a running host would leave them.
   */
  readonly pluginFiber: Awaited<ReturnType<Context['plugin']>>
  /**
   * Spawn one CC-backed dsh agent through the REAL `ctx.claudeCodeAgents`
   * surface — schema-validated config defaults, registry publication and the
   * ordered teardown effect included. `cwd` always defaults to a fresh tmp
   * directory this harness owns and removes on {@link LiveAgentHarness.dispose}.
   * @param options - open options; `cwd` defaults to a fresh tmp dir.
   * @param deps - spawn-level test seams (e.g. `disposeDrainMs`).
   * @returns the published agent and its exact disposer.
   */
  spawn(options?: Partial<CcAgentOptions>, deps?: CcAgentSpawnDeps): Promise<CcAgentHandle>
  /** Tear the whole composition down: every agent, every session, every subprocess, every fiber. */
  dispose(): Promise<void>
}

/**
 * Mount the full live agent-adapter composition: `SessionStore`,
 * `AgentRegistry`, `UserQuestionService`, `ApprovalService`, the REAL
 * `ClaudeCodeService` (forced to {@link LIVE_MODEL}, full setting isolation),
 * and `@deepseek-ai/dsh-claude-code-agent` itself.
 * @param options - which optional stacks to include, and config overrides.
 * @returns the harness.
 */
export async function mountLiveAgent(options: MountLiveAgentOptions = {}): Promise<LiveAgentHarness> {
  const ctx = new Context()
  const fibers: Array<{ dispose(): Promise<unknown> }> = []
  const cwds: string[] = []

  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(AgentRegistry))
  fibers.push(await ctx.plugin(UserQuestionService))
  fibers.push(await ctx.plugin(ApprovalService, { policy: options.approvalPolicy ?? 'ask' }))

  let service: ClaudeCodeService | undefined
  function claudeCodeLiveAgentMount(inner: Context): void {
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
  fibers.push(await ctx.plugin(claudeCodeLiveAgentMount))
  if (service === undefined) throw new Error('mountLiveAgent: mount did not construct ClaudeCodeService')
  const pluginFiber = await ctx.plugin(ClaudeCodeAgentPlugin)
  fibers.push(pluginFiber)

  return {
    ctx,
    service,
    pluginFiber,
    spawn: async (spawnOptions = {}, deps = {}) => {
      let cwd = spawnOptions.cwd
      if (cwd === undefined) {
        cwd = tmpCwd('agent')
        cwds.push(cwd)
      }
      return await ctx.claudeCodeAgents.spawn({ ...spawnOptions, cwd }, deps)
    },
    dispose: async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      await ctx.fiber.dispose()
      for (const cwd of cwds) removeCwd(cwd)
    },
  }
}

/**
 * Register a scripted `approval/request` answerer, recording every request
 * it saw. Mirrors `packages/tool-claude-code/tests/live/helpers.ts`'s
 * `scriptApproval`, restated here so this suite stays self-contained.
 * @param ctx - the composition (`ApprovalService` mounted).
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
 * question with one selected option (by label), recording every request seen.
 * @param ctx - the composition (`UserQuestionService` mounted).
 * @param pickLabel - which option label to select for every question.
 * @returns every request seen, and a disposer.
 */
export function scriptQuestionAnswer(
  ctx: Context,
  pickLabel: string,
): { requests: AskUserQuestionRequest[], dispose: () => void } {
  const requests: AskUserQuestionRequest[] = []
  const dispose = ctx.userQuestions.registerProvider({
    ask: async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
      requests.push(request)
      return await Promise.resolve({
        answers: request.questions.map(question => ({
          id: question.id,
          selected: [question.options?.find(option => option.label === pickLabel)?.label ?? pickLabel],
        })),
      })
    },
  })
  return { requests, dispose }
}

/**
 * Poll an agent's `status` until it reaches `target` or `timeoutMs` elapses.
 * @param agent - the agent to observe.
 * @param target - the status being waited for.
 * @param timeoutMs - give up after this long.
 * @returns the last observed status.
 */
export async function waitForAgentStatus(
  agent: Agent,
  target: Agent['status'],
  timeoutMs: number,
): Promise<Agent['status']> {
  return await waitUntil(() => agent.status, status => status === target, timeoutMs, 50)
}

/**
 * Record every distinct `status` value an agent passes through, by polling.
 * Started immediately; stop it once the scenario under test is done driving
 * the agent.
 * @param agent - the agent to observe.
 * @param pollMs - polling interval.
 * @returns the observed sequence (deduplicated adjacent repeats) and a stop function.
 */
export function recordStatusSequence(
  agent: Agent,
  pollMs = 25,
): { readonly sequence: Agent['status'][], stop(): void } {
  const sequence: Agent['status'][] = [agent.status]
  const record = (): void => {
    const current = agent.status
    if (sequence[sequence.length - 1] !== current) sequence.push(current)
  }
  const timer = setInterval(record, pollMs)
  // `stop()` records one final sample before clearing the poll: the caller
  // typically stops right after an await (e.g. `whenIdle()`) that settled in
  // the gap between two ticks, and the last transition must not be lost to
  // that race.
  return { sequence, stop: () => { record(); clearInterval(timer) } }
}

/**
 * Whether a dsh session currently has an open turn, computed from its own
 * event log (the mirror's own `hasOpenTurn` getter is not reachable from the
 * agent adapter — `attachMirror`'s handle is not retained past `spawn.ts`).
 * Mirrors `CcMirror.hasOpenTurn`'s own definition: false after every `turn/end`.
 * @param session - the dsh session to inspect.
 * @returns true while the last turn boundary event is a `turn/start`.
 */
export function hasOpenTurn(session: DshSession): boolean {
  const last = session.events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  return last?.type === 'turn/start'
}
