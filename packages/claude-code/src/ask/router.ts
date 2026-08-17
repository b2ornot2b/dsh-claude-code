/**
 * The ask channel (§4) — Claude Code's ONE permission callback, routed to three
 * different dsh seams:
 *
 * ```
 * canUseTool(toolName, input, { signal, requestId, toolUseID, title, suggestions })
 *   ├─ 'AskUserQuestion' → ctx.userQuestions.ask()                     → §4.2
 *   ├─ 'ExitPlanMode'    → ctx.userQuestions.ask() w/ plan-review intent → §4.3
 *   └─ everything else   → ctx.approval.request()                      → §4.1
 * ```
 *
 * Invariants this file exists to hold:
 *
 * - **It always resolves.** Never `null` (the SDK reads that as "answered out of
 *   band" and the tool blocks forever), never a rejection (same outcome, via a
 *   different door). Every error path becomes a decision.
 * - **Allow always carries `updatedInput`.** The allow-without-input path is
 *   version-gated; we never rely on it.
 * - **A `callId` is never invented.** dsh's `ApprovalRequest` omits tool
 *   arguments because the answerer attaches the prompt to a tool call the UI
 *   already streamed. If the mirror has not appended that `tool/call` yet, the
 *   router waits briefly and then SYNTHESIZES it before asking (§4.4); with no
 *   mirror attached the request carries no `callId` at all.
 * - **Nothing is auto-approved silently.** Two paths skip the human, and both
 *   are loud: the integration-owned rule cache (an explicit stored grant) and
 *   the `first-option` fallback (questions only). Note also that the CLI's own
 *   safe-command classifier auto-approves things like `echo` BELOW this
 *   callback — the dsh audit log is a record of what dsh was asked, not of
 *   every tool Claude Code ran (§8.3).
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { readFileSync } from 'node:fs'

import { CallId } from '@deepseek-ai/dsh-llm/brand'
import type {
  AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionOption,
} from '@deepseek-ai/dsh-user-questions'

import type { CcCanUseTool, CcPermissionDecision, CcPermissionRequest } from '../backend.ts'
import type { ResolvedClaudeCodeConfig } from '../config.ts'
import type { CcLogger, ClaudeCodeError } from '../types.ts'
import { applyAskFallback } from './fallback.ts'
import type { CcAskFallbackReason, CcAskKind } from './fallback.ts'
import type { CcAskRules } from './rules.ts'
import { CcAskTable } from './table.ts'
import { askErrorCode, describeError } from './types.ts'
import type { ApprovalOutcome, CcAskCallSite, CcAskServices, CcAskTarget } from './types.ts'

/** CC's clarifying-question tool. */
export const CC_ASK_USER_QUESTION = 'AskUserQuestion'

/** CC's leave-plan-mode tool. */
export const CC_EXIT_PLAN_MODE = 'ExitPlanMode'

/** dsh's plan-review question id — copied verbatim from `@deepseek-ai/dsh-plan-mode`. */
export const CC_PLAN_REVIEW_ID = 'plan-review'

/** The option label that approves a plan. Named, never positional (dsh rejects an `approve` naming no option). */
export const CC_PLAN_APPROVE_LABEL = 'Approve'

/** The option label that declines it. */
export const CC_PLAN_DECLINE_LABEL = 'Keep planning'

/** Deny message for `ApprovalOutcome === 'rejected'` (§4.1's table). */
export const CC_REJECTED_MESSAGE = 'User rejected this action'

/** Deny message for `ApprovalOutcome === 'cancelled'` (§4.1's table). */
export const CC_CANCELLED_MESSAGE = 'Request withdrawn'

/** How long to wait for the mirror's `tool/call` before synthesizing one (§4.4). */
const DEFAULT_CALL_ID_WAIT_MS = 150

/** Poll interval inside that wait. */
const DEFAULT_CALL_ID_POLL_MS = 10

/** Longest `reason` this router derives from tool input. */
const MAX_REASON_LENGTH = 240

/** Longest `header` passed through to dsh (CC caps its own at ~12; this is belt and braces). */
const MAX_HEADER_LENGTH = 64

/** Everything the router needs. */
export interface CcAskRouterDeps {
  /** Lazy resolution of `ctx.approval` / `ctx.userQuestions`. */
  readonly services: CcAskServices
  /** The resolved plugin configuration (timeouts, fallback policy). */
  readonly config: ResolvedClaudeCodeConfig
  /** The integration-owned always-allow cache, consulted before any prompt. */
  readonly rules: CcAskRules
  /** The pending-ask table. One per session; constructed here when omitted. */
  readonly table?: CcAskTable
  /** Diagnostics sink. */
  readonly logger?: CcLogger
  /** How long to wait for the mirror's `tool/call` before synthesizing (default 150ms; tests shrink it). */
  readonly callIdWaitMs?: number
  /** Poll interval inside that wait (default 10ms). */
  readonly callIdPollMs?: number
  /**
   * Read a plan file (`ExitPlanMode.planFilePath`) when the inline `plan` is
   * absent. Injectable so unit tests need no fixture on disk.
   * @param path - the plan file path CC supplied.
   * @returns the plan markdown, or undefined when it cannot be read.
   */
  readonly readPlanFile?: (path: string) => string | undefined
}

/** One question after mapping CC's shape onto dsh's (§4.2). */
export interface CcMappedQuestion {
  /** The dsh question id: the question TEXT, suffixed on collision (§4.2.1). */
  readonly id: string
  /** The original question text — the key CC's `answers` object is keyed by. */
  readonly text: string
  /** Whether more than one option may be chosen. */
  readonly multiSelect: boolean
  /** The dsh question as it was asked. */
  readonly item: AskUserQuestionItem
}

/**
 * The ask channel for one Claude Code session.
 *
 * Constructed before the session opens (it supplies `canUseTool`), then told
 * WHO answers ({@link CcAskRouter.attachTarget}) and WHERE the tool calls are
 * logged ({@link CcAskRouter.attachCallSite}). Both are late-bound because both
 * are known later: the target at `open({ ask })`, the call site when a mirror
 * is attached.
 */
export class CcAskRouter {
  readonly #deps: CcAskRouterDeps
  readonly #table: CcAskTable
  readonly #errorListeners = new Set<(error: ClaudeCodeError) => void>()

  #target: CcAskTarget | undefined
  #callSite: CcAskCallSite | undefined
  /** Counter behind the synthetic key an id-less delivery gets (see {@link CcAskRouter.askKey}). */
  #anonymousAsks = 0

  /**
   * @param deps - services, config, rule cache, and the optional ask table.
   */
  constructor(deps: CcAskRouterDeps) {
    this.#deps = deps
    this.#table = deps.table ?? new CcAskTable(deps.logger === undefined ? {} : { logger: deps.logger })
  }

  /**
   * The permission callback to hand the SDK. A bound arrow so it can be passed
   * as a value without losing `this`.
   * @param toolName - the tool Claude Code wants to run.
   * @param input - its arguments.
   * @param request - the SDK's request context (signal, ids, title, suggestions).
   * @returns the decision. Always resolves; never `null`.
   */
  readonly canUseTool: CcCanUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    request: CcPermissionRequest,
  ): Promise<CcPermissionDecision> => {
    return await this.route(toolName, input, request)
  }

  /** The pending-ask table (snapshots read {@link CcAskTable.pendingCount} off it). */
  get table(): CcAskTable {
    return this.#table
  }

  /** How many asks are awaiting an answer. */
  get pendingAsks(): number {
    return this.#table.pendingCount
  }

  /** Who currently answers for this session, if anyone. */
  get target(): CcAskTarget | undefined {
    return this.#target
  }

  /**
   * Set who answers for this session.
   *
   * @param target - the dsh agent and its (optional) seam overrides.
   * @returns a disposer that detaches exactly this target; detaching a target
   *   that was already replaced is a no-op.
   */
  attachTarget(target: CcAskTarget): () => void {
    this.#target = target
    return () => {
      if (this.#target === target) this.#target = undefined
    }
  }

  /**
   * Point the router at the mirror that logs this session's tool calls (§4.4).
   * @param site - the mirror.
   * @returns a disposer that detaches exactly this call site.
   */
  attachCallSite(site: CcAskCallSite): () => void {
    this.#callSite = site
    return () => {
      if (this.#callSite === site) this.#callSite = undefined
    }
  }

  /**
   * Subscribe to unanswerable-ask failures (`askFallback: 'error'`).
   * @param listener - called with the typed `ASK_UNANSWERABLE` error.
   * @returns an unsubscribe function.
   */
  onError(listener: (error: ClaudeCodeError) => void): () => void {
    this.#errorListeners.add(listener)
    return () => {
      this.#errorListeners.delete(listener)
    }
  }

  /**
   * Settle every pending ask as denied — the session's close path.
   * @param message - the deny message; the table's session-closed sentence by default.
   * @returns how many asks were settled.
   */
  settleAll(message?: string): number {
    return message === undefined ? this.#table.settleAll() : this.#table.settleAll(message)
  }

  /**
   * Route one request through the ask table (idempotent per `requestId`).
   * @param toolName - the tool.
   * @param input - its arguments.
   * @param request - the SDK request context.
   * @returns the decision.
   */
  private async route(
    toolName: string,
    input: Record<string, unknown>,
    request: CcPermissionRequest,
  ): Promise<CcPermissionDecision> {
    const kind: CcAskKind = toolName === CC_ASK_USER_QUESTION
      ? 'questions'
      : toolName === CC_EXIT_PLAN_MODE ? 'plan' : 'approval'
    const timeoutMs = this.timeoutFor()

    return await this.#table.run({
      requestId: this.askKey(request),
      toolName,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      // A timeout on the questions path can still be auto-answered under
      // `first-option`; a permission or plan timeout never can.
      onTimeout: () => this.fallback(kind, toolName, { kind: 'timeout', ms: timeoutMs ?? 0 },
        kind === 'questions'
          ? () => firstOptionAnswer(input, mapQuestions(input, this.#deps.logger))
          : undefined),
    }, async (signal) => {
      switch (kind) {
        case 'questions':
          return await this.askQuestions(input, signal)
        case 'plan':
          return await this.reviewPlan(input, signal)
        case 'approval':
          return await this.requestApproval(toolName, input, request, signal)
      }
    })
  }

  /**
   * The ask table's key for one delivery.
   *
   * The SDK's `requestId` is that key (delta S2/S12) and its type says it is
   * always there. This method exists for the day it is not: an empty or missing
   * id would make EVERY ask collide on one table entry, and the second tool call
   * would silently inherit the first one's decision — a permission grant nobody
   * gave. Falling back to the `tool_use` id keeps redelivery idempotent for the
   * same call; falling back to a counter gives up idempotency rather than
   * correctness. Both are loud.
   *
   * @param request - the SDK request context.
   * @returns the table key.
   */
  private askKey(request: CcPermissionRequest): string {
    const requestId: unknown = request.requestId
    if (typeof requestId === 'string' && requestId !== '') return requestId

    const toolUseId: unknown = request.toolUseID
    const key = typeof toolUseId === 'string' && toolUseId !== ''
      ? `toolUse:${toolUseId}`
      : `anonymous:${++this.#anonymousAsks}`
    this.#deps.logger?.debug(
      `claude-code ask: this permission request carried no requestId; keying the ask table on ${key} instead `
      + '(redelivery idempotency is degraded, but two asks can never share one decision)')
    return key
  }

  /**
   * §4.1 — a tool permission.
   *
   * @param toolName - the tool.
   * @param input - its arguments.
   * @param request - the SDK request context.
   * @param signal - the table's derived signal (aborts on withdrawal, timeout or close).
   * @returns the decision, mapped EXACTLY per §4.1's outcome table.
   */
  private async requestApproval(
    toolName: string,
    input: Record<string, unknown>,
    request: CcPermissionRequest,
    signal: AbortSignal,
  ): Promise<CcPermissionDecision> {
    // 1. The integration-owned rule cache, BEFORE any prompt. A prompt forced by
    //    the user's own `permissions.ask` rule is never short-circuited: that
    //    rule is the user asking to be asked.
    if (request.matchedAskRule === undefined && this.#deps.rules.allows(toolName, request.suggestions)) {
      this.#deps.logger?.debug(
        `claude-code ask: ${toolName} allowed by the stored always-allow rule cache `
        + `(${this.#deps.rules.path}) — no dsh approval was requested`)
      return { behavior: 'allow', updatedInput: input }
    }

    const target = this.#target
    const approval = target?.approval ?? this.#deps.services.approval()
    // 2. Fail CLOSED when the seam is absent. This is NOT the fallback policy:
    //    `first-option` must never turn a missing approver into a grant.
    if (target === undefined || approval === undefined) {
      const why = target === undefined
        ? 'no dsh ask target is attached to this Claude Code session'
        : 'no approval service is mounted in this composition'
      this.#deps.logger?.debug(`claude-code ask: denying ${toolName} — ${why}`)
      return {
        behavior: 'deny',
        message: `Denied: ${why}, so this tool call could not be approved. Nothing was executed.`,
      }
    }

    const callId = await this.resolveCallId(request.toolUseID, toolName, input, signal)
    // The wait above is the one place this path yields, so it is the one place
    // the ask can go away underneath it (withdrawn, timed out, or the session
    // closed). Asking dsh anyway would append an approval/asked pair for a
    // decision nobody will ever read, on top of a tool call CC abandoned.
    if (signal.aborted) {
      this.#deps.logger?.debug(
        `claude-code ask: ${toolName} was withdrawn while its tool/call was being correlated; not asking dsh`)
      return { behavior: 'deny', message: CC_CANCELLED_MESSAGE }
    }
    // The CLI's pre-rendered sentence beats anything we could reconstruct
    // (delta S2); `describeCall` is the fallback for older CLIs.
    const reason = request.title ?? describeCall(toolName, input)

    let outcome: ApprovalOutcome
    try {
      outcome = await approval.request({
        agent: target.agent,
        toolName,
        ...(callId === undefined ? {} : { callId }),
        reason,
        signal,
      })
    } catch (error) {
      // The open-turn guard (gotcha 9): `request()` throws synchronously when
      // the agent's session has no open turn. Letting that reject the
      // `canUseTool` promise hangs the Claude Code session forever.
      const detail = describeError(error)
      this.#deps.logger?.debug(
        `claude-code ask: approval for ${toolName} could not be requested: ${detail}`)
      return {
        behavior: 'deny',
        message: `Denied: the dsh approval channel is not accepting requests right now (${detail}). `
          + 'This usually means the calling agent has no turn open, so nobody can be asked. '
          + 'Nothing was executed — report this instead of retrying.',
      }
    }

    switch (outcome) {
      case 'allowed-once':
        // ALWAYS with `updatedInput`.
        return { behavior: 'allow', updatedInput: input }
      case 'rejected':
        // Also the deterministic answer under session policy `'never'`, which is
        // a real decision and must never be second-guessed by the fallback.
        return { behavior: 'deny', message: CC_REJECTED_MESSAGE }
      case 'cancelled':
        return { behavior: 'deny', message: CC_CANCELLED_MESSAGE }
      default:
        // `'unavailable'` — and any rogue value, which the seam already
        // normalizes to it.
        return this.fallback('approval', toolName, { kind: 'approval-unavailable' })
    }
  }

  /**
   * §4.2 — clarifying questions.
   *
   * @param input - the `AskUserQuestion` input.
   * @param signal - the table's derived signal.
   * @returns an allow carrying `{ questions, answers }` (the S4-verified
   *   encoding), or the fallback decision.
   */
  private async askQuestions(
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CcPermissionDecision> {
    const questions = mapQuestions(input, this.#deps.logger)
    const autoAnswer = (): CcPermissionDecision | undefined => firstOptionAnswer(input, questions)

    if (questions.length === 0) {
      return this.fallback('questions', CC_ASK_USER_QUESTION, {
        kind: 'question-error',
        code: 'EMPTY_QUESTIONS',
        detail: 'the tool call carried no question this seam could map',
      }, autoAnswer)
    }

    const target = this.#target
    const seam = target?.userQuestions ?? this.#deps.services.userQuestions()
    if (target === undefined || seam === undefined) {
      return this.fallback('questions', CC_ASK_USER_QUESTION, { kind: 'no-service' }, autoAnswer)
    }

    let answer: AskUserQuestionAnswer
    try {
      answer = await seam.ask({
        questions: questions.map(question => question.item),
        agent: target.agent,
        signal,
      })
    } catch (error) {
      return this.questionFailure('questions', CC_ASK_USER_QUESTION, error, autoAnswer)
    }

    const answers = mapAnswers(questions, answer, this.#deps.logger)
    // `questions` goes back UNCHANGED: the tool needs it to process the answer
    // (probe 2), and `answers` is keyed by question TEXT.
    return { behavior: 'allow', updatedInput: { questions: input['questions'], answers } }
  }

  /**
   * §4.3 — plan approval, using dsh's own `plan-review` convention verbatim.
   *
   * `ctx.planMode` is deliberately NOT touched (delta D5): Claude Code owns its
   * own plan state, and dsh's queued-flip semantics assume the dsh agent loop.
   *
   * @param input - the `ExitPlanMode` input.
   * @param signal - the table's derived signal.
   * @returns allow (approved) or deny carrying the user's revision feedback.
   */
  private async reviewPlan(
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CcPermissionDecision> {
    const target = this.#target
    const seam = target?.userQuestions ?? this.#deps.services.userQuestions()
    if (target === undefined || seam === undefined) {
      // No auto-answer: `first-option` here would be `Approve`, i.e. an
      // unattended run granting itself the exit from plan mode.
      return this.fallback('plan', CC_EXIT_PLAN_MODE, { kind: 'no-service' })
    }

    const detail = this.readPlan(input)
    const question: AskUserQuestionItem = {
      id: CC_PLAN_REVIEW_ID,
      header: 'Plan review',
      question: 'Approve this plan?',
      // Omitted when the plan could not be read: `ask()` then rejects
      // BAD_INTENT (an intent needs the detail it reviews) and the fallback
      // policy answers — which is the honest outcome for a plan we cannot show.
      ...(detail === undefined ? {} : { detail }),
      options: [{ label: CC_PLAN_APPROVE_LABEL }, { label: CC_PLAN_DECLINE_LABEL }],
      intent: { kind: 'plan-review', approve: CC_PLAN_APPROVE_LABEL },
    }

    let answer: AskUserQuestionAnswer
    try {
      answer = await seam.ask({ questions: [question], agent: target.agent, signal })
    } catch (error) {
      if (askErrorCode(error) === 'ASK_CANCELLED') {
        // Dismissed is not declined: the user took the turn back to say
        // something the two options do not cover.
        return {
          behavior: 'deny',
          message: 'Plan review dismissed: the user closed the review to speak instead. '
            + 'Stay in plan mode, stop here, and wait for their message.',
        }
      }
      return this.questionFailure('plan', CC_EXIT_PLAN_MODE, error)
    }

    const items = answer.answers.filter(entry => entry.id === CC_PLAN_REVIEW_ID)
    const item = items.length === 1 ? items[0] : undefined
    const approved = item !== undefined
      && item.selected.length === 1
      && item.selected[0] === CC_PLAN_APPROVE_LABEL
      && item.custom === undefined
    if (approved) return { behavior: 'allow', updatedInput: input }

    const feedback = item?.custom?.trim() ?? ''
    return {
      behavior: 'deny',
      message: feedback === ''
        ? 'The user chose to keep planning; revise the plan and present it again.'
        : `The user chose to keep planning; their feedback: ${feedback}`,
    }
  }

  /**
   * Turn a `UserQuestionError` (any code in the D3 taxonomy) into a decision.
   * @param kind - which path failed.
   * @param toolName - the tool being decided.
   * @param error - the thrown value.
   * @param autoAnswer - the `first-option` builder, when the path has one.
   * @returns the fallback decision.
   */
  private questionFailure(
    kind: CcAskKind,
    toolName: string,
    error: unknown,
    autoAnswer?: () => CcPermissionDecision | undefined,
  ): CcPermissionDecision {
    const reason: CcAskFallbackReason = {
      kind: 'question-error',
      code: askErrorCode(error) ?? 'UNKNOWN',
      detail: describeError(error),
    }
    return this.fallback(kind, toolName, reason, autoAnswer)
  }

  /**
   * Apply the configured fallback policy and publish the typed error the
   * `'error'` policy produces.
   * @param kind - which path hit it.
   * @param toolName - the tool being decided.
   * @param reason - why no answer could be reached.
   * @param autoAnswer - the `first-option` builder, when the path has one.
   * @returns the decision.
   */
  private fallback(
    kind: CcAskKind,
    toolName: string,
    reason: CcAskFallbackReason,
    autoAnswer?: () => CcPermissionDecision | undefined,
  ): CcPermissionDecision {
    const result = applyAskFallback({
      policy: this.#deps.config.ask.fallback,
      kind,
      toolName,
      reason,
      ...(this.#deps.logger === undefined ? {} : { logger: this.#deps.logger }),
      ...(autoAnswer === undefined ? {} : { autoAnswer }),
    })
    if (result.error !== undefined) this.emitError(result.error)
    return result.decision
  }

  /**
   * Fan one unanswerable-ask error out, isolating listener failures — a
   * subscriber that throws must not turn a contained failure into an
   * uncontained one.
   * @param error - the typed error.
   * @returns nothing.
   */
  private emitError(error: ClaudeCodeError): void {
    for (const listener of [...this.#errorListeners]) {
      try {
        listener(error)
      } catch (failure) {
        this.#deps.logger?.debug(
          `claude-code ask: an ask-error listener threw: ${describeError(failure)}`)
      }
    }
  }

  /**
   * §4.4 — the `callId` the answerer can attach the prompt to.
   *
   * The mirror emits `tool/call` from the streamed `tool_use` block, and the
   * permission request usually follows it — but not always, and never for a
   * call CC did not surface as a block. So: wait briefly, then synthesize the
   * event ourselves. With no mirror attached, no `callId` is sent at all (dsh's
   * answerer back-scan then matches only callId-less asks, which is correct:
   * there is no UI record to attach to).
   *
   * @param toolUseId - CC's `tool_use` id.
   * @param toolName - the tool being decided.
   * @param input - its arguments, used if the event has to be synthesized.
   * @param signal - the ask's own signal; a withdrawal ends the wait and
   *   suppresses the synthesis, because a call nobody will run does not belong
   *   in the transcript.
   * @returns the dsh call id, or undefined when this session has no mirror (or
   *   lost it, or the ask went away) while waiting.
   */
  private async resolveCallId(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallId | undefined> {
    const site = this.#callSite
    if (site === undefined || toolUseId === '') return undefined

    const waitMs = this.#deps.callIdWaitMs ?? DEFAULT_CALL_ID_WAIT_MS
    const pollMs = this.#deps.callIdPollMs ?? DEFAULT_CALL_ID_POLL_MS
    const deadline = Date.now() + waitMs
    while (!site.hasEmittedCall(toolUseId) && Date.now() < deadline && !signal.aborted) {
      await sleep(pollMs)
    }
    if (signal.aborted) return undefined
    // The mirror can be detached (or replaced) while we wait — at session
    // close, or when a consumer re-points it. Synthesizing into the mirror this
    // ask started with would append a `tool/call` to a dsh session nobody is
    // mirroring into any more.
    if (this.#callSite !== site) {
      this.#deps.logger?.debug(
        `claude-code ask: the mirror detached while ${toolName} (${toolUseId}) was being correlated; `
        + 'the approval request will carry no callId')
      return undefined
    }
    if (!site.hasEmittedCall(toolUseId)) {
      // Loud: either the SDK's ordering changed or CC never surfaced this call
      // as a block. Both are worth seeing in a log.
      this.#deps.logger?.debug(
        `claude-code ask: no tool/call was mirrored for ${toolName} (${toolUseId}) within ${waitMs}ms; `
        + 'synthesizing one so the approval prompt has a call to attach to (§4.4)')
    }
    return CallId(site.ensureToolCall(toolUseId, toolName, input))
  }

  /**
   * The bounded wait for this session's asks: the delegated timeout when no
   * human is attached, otherwise `ask.timeoutMs` (unset = pend indefinitely,
   * the interactive posture).
   * @returns the timeout in ms, or undefined for an unbounded wait.
   */
  private timeoutFor(): number | undefined {
    const ask = this.#deps.config.ask
    if (this.#target?.delegated === true) return ask.delegatedTimeoutMs
    return ask.timeoutMs
  }

  /**
   * Read the plan under review. Probe order, and why:
   *
   * 1. `input.plan` — the live-probed runtime field (delta S3). Untyped in the
   *    SDK's `.d.ts`, present on CLI 2.1.233.
   * 2. `input.planFilePath` — the file the CLI wrote the plan to, read only
   *    when the inline field is missing or empty.
   *
   * @param input - the `ExitPlanMode` input.
   * @returns the plan markdown, or undefined when neither probe produced text.
   */
  private readPlan(input: Record<string, unknown>): string | undefined {
    // Strings only: `plan` is untyped in the SDK's `.d.ts`, and stringifying
    // whatever turns up would put "[object Object]" in front of a human as the
    // plan they are approving.
    const inline = asString(input['plan'])?.trim() ?? ''
    if (inline !== '') return inline
    const path = input['planFilePath']
    if (typeof path !== 'string' || path === '') return undefined
    const read = this.#deps.readPlanFile ?? defaultReadPlanFile
    const contents = read(path)?.trim() ?? ''
    if (contents === '') {
      this.#deps.logger?.debug(
        `claude-code ask: ExitPlanMode carried no inline plan and ${path} could not be read; `
        + 'the review will be answered by the fallback policy')
      return undefined
    }
    return contents
  }
}

/**
 * Map CC's `AskUserQuestion` input onto dsh question items (§4.2).
 *
 * Field mapping: `question` → `question` AND `id` (§4.2.1 — CC keys its answers
 * by question text, so the text IS the safest id); `header` → `header`, capped;
 * `options[].label`/`description` → the same; `multiSelect` → `multiSelect`.
 * `options[].preview` is dropped — it is TypeScript-only rich content with no
 * dsh counterpart.
 *
 * Malformed entries are skipped rather than thrown on: a question this seam
 * cannot express is better asked as the ones it can than not at all, and an
 * empty result routes to the fallback policy.
 *
 * @param input - the raw tool input.
 * @param logger - diagnostics sink.
 * @returns the mapped questions, in CC's order (which is answer order, D4).
 */
export function mapQuestions(
  input: Record<string, unknown>,
  logger?: CcLogger,
): readonly CcMappedQuestion[] {
  const raw = input['questions']
  if (!Array.isArray(raw)) return []
  const mapped: CcMappedQuestion[] = []
  const seen = new Map<string, number>()

  for (const entry of raw) {
    const record = asRecord(entry)
    const text = asString(record?.['question'])
    if (record === undefined || text === undefined || text.trim() === '') {
      logger?.debug('claude-code ask: skipping an AskUserQuestion entry with no question text')
      continue
    }
    // Ids must be unique: dsh does not enforce it, but every consumer requires
    // exactly one match by id (D4). Identical texts get ' #2', ' #3', …
    const count = (seen.get(text) ?? 0) + 1
    seen.set(text, count)
    const id = count === 1 ? text : `${text} #${count}`

    const header = asString(record['header'])
    const multiSelect = record['multiSelect'] === true
    const options = mapOptions(record['options'])

    mapped.push({
      id,
      text,
      multiSelect,
      item: {
        id,
        question: text,
        ...(header === undefined ? {} : { header: truncate(header, MAX_HEADER_LENGTH) }),
        ...(options.length === 0 ? {} : { options }),
        ...(multiSelect ? { multiSelect: true } : {}),
      },
    })
  }
  return mapped
}

/**
 * Map CC's option list. `preview` is dropped (§4.2's table).
 * @param raw - the raw `options` value.
 * @returns the dsh options, skipping entries with no label.
 */
function mapOptions(raw: unknown): AskUserQuestionOption[] {
  if (!Array.isArray(raw)) return []
  const options: AskUserQuestionOption[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    const label = asString(record?.['label'])
    if (label === undefined || label === '') continue
    const description = asString(record?.['description'])
    options.push({ label, ...(description === undefined ? {} : { description }) })
  }
  return options
}

/**
 * Map dsh's answer back onto CC's `answers` object (§4.2, delta D4/S4).
 *
 * The rules, each one load-bearing:
 *
 * - **Positional.** dsh's wire validator aligns `answers[i].id` with
 *   `questions[i].id`, so the answer array is read in question order. A
 *   mismatched id still resolves by id (with a loud log) rather than
 *   misattributing an answer.
 * - **`answers` is keyed by the question TEXT**, not by the id we sent and not
 *   by index — that is how the tool consumes it (probe 2).
 * - **`custom` overrides `selected` on single-select.** dsh's own rule; the
 *   free text is the answer, and the literal word "Other" never appears.
 * - **Multi-select yields an array**, with any free text appended as one more
 *   choice — dsh permits `custom` alongside selections there, and dropping the
 *   selections would silently discard what the human clicked.
 * - **A skipped question is OMITTED.** dsh allows an answer with no selection
 *   and no custom text; CC has no per-question skip, so the key is left out
 *   entirely rather than sent as an empty answer.
 *
 * @param questions - the mapped questions, in ask order.
 * @param answer - dsh's answer.
 * @param logger - diagnostics sink.
 * @returns CC's `answers` object.
 */
export function mapAnswers(
  questions: readonly CcMappedQuestion[],
  answer: AskUserQuestionAnswer,
  logger?: CcLogger,
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {}
  const byId = new Map(questions.map(question => [question.id, question]))

  answer.answers.forEach((item, index) => {
    let question = questions[index]
    if (question === undefined || question.id !== item.id) {
      const resolved = byId.get(item.id)
      if (resolved === undefined) {
        logger?.debug(
          `claude-code ask: dropping an answer for unknown question id ${JSON.stringify(item.id)}`)
        return
      }
      if (question !== undefined) {
        logger?.debug(
          'claude-code ask: answers arrived out of question order — resolving by id '
          + `(position ${index} carried ${JSON.stringify(item.id)})`)
      }
      question = resolved
    }
    const value = answerValue(question, item)
    if (value === undefined) return
    answers[question.text] = value
  })
  return answers
}

/**
 * The value one answered question contributes.
 * @param question - the question it answers.
 * @param item - the dsh answer item.
 * @returns the value, or undefined when the question was skipped (omit the key).
 */
function answerValue(
  question: CcMappedQuestion,
  item: AskUserQuestionAnswerItem,
): string | string[] | undefined {
  const custom = item.custom?.trim()
  const selected = item.selected.filter(label => label !== '')
  if (question.multiSelect) {
    const values = custom === undefined || custom === '' ? [...selected] : [...selected, custom]
    return values.length === 0 ? undefined : values
  }
  if (custom !== undefined && custom !== '') return custom
  if (selected.length === 0) return undefined
  return selected.join(', ')
}

/**
 * Build the `first-option` fallback answer for a clarifying-question call.
 * @param input - the raw tool input (its `questions` go back unchanged).
 * @param questions - the mapped questions.
 * @returns the allow decision, or undefined when no question offers an option.
 */
function firstOptionAnswer(
  input: Record<string, unknown>,
  questions: readonly CcMappedQuestion[],
): CcPermissionDecision | undefined {
  const answers: Record<string, string | string[]> = {}
  for (const question of questions) {
    const label = question.item.options?.[0]?.label
    if (label === undefined) continue
    answers[question.text] = question.multiSelect ? [label] : label
  }
  if (Object.keys(answers).length === 0) return undefined
  return { behavior: 'allow', updatedInput: { questions: input['questions'], answers } }
}

/**
 * Describe a tool call in one line, for `ApprovalRequest.reason` — used only
 * when the CLI supplied no pre-rendered `title` (delta S2).
 *
 * dsh's `ApprovalRequest` carries no arguments by design (the answerer attaches
 * the prompt to the tool call the UI already streamed), so this is a HINT, not
 * the record: it is bounded, single-line, and never the whole input.
 *
 * @param toolName - the tool.
 * @param input - its arguments.
 * @returns a bounded one-line description.
 */
export function describeCall(toolName: string, input: Record<string, unknown>): string {
  const detail = callDetail(input)
  const rendered = detail === undefined ? toolName : `${toolName}: ${detail}`
  return truncate(rendered.replace(/\s+/gu, ' ').trim(), MAX_REASON_LENGTH)
}

/**
 * The most informative single field of a tool input, if it has one.
 * @param input - the tool arguments.
 * @returns the detail string, or undefined when nothing stands out.
 */
function callDetail(input: Record<string, unknown>): string | undefined {
  for (const field of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt']) {
    const value = asString(input[field])
    if (value !== undefined && value !== '') return value
  }
  try {
    const rendered = JSON.stringify(input)
    return rendered === undefined || rendered === '{}' ? undefined : rendered
  } catch {
    return undefined
  }
}

/**
 * Read a plan file off disk. Failures are silent here and reported by the
 * caller, which knows what the read was for.
 * @param path - the plan file path.
 * @returns the contents, or undefined.
 */
function defaultReadPlanFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Cap a string, marking that it was cut.
 * @param value - the string.
 * @param max - the maximum length INCLUDING the ellipsis.
 * @returns the bounded string.
 */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * Narrow an unknown to a record.
 * @param value - the candidate.
 * @returns the record, or undefined.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Narrow an unknown to a string.
 * @param value - the candidate.
 * @returns the string, or undefined.
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Sleep, without holding the process open.
 * @param ms - how long.
 * @returns nothing.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
