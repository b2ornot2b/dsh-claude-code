/**
 * Shared scaffolding for the ask-channel specs.
 *
 * The doubles here are deliberately dumb: they record what the router asked and
 * answer with a script. Everything about ROUTING, mapping and policy is then a
 * pure assertion on those recordings, and the specs that need the real dsh
 * seams (`ask-dsh-seams.spec.ts`) mount them for real instead of faking harder.
 *
 * Not a spec file: `vitest` collects `*.spec.ts` only, while
 * `tsconfig.tests.json` still type-checks this module.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@deepseek-ai/dsh-agent'
import { CcAskRouter, CcAskRules, resolveClaudeCodeConfig } from '@deepseek-ai/dsh-claude-code'
import type {
  CcApprovalSeam, CcAskCallSite, CcAskRouterDeps, CcAskTarget, CcLogger, CcPermissionRequest,
  CcUserQuestionsSeam, ClaudeCodeConfig,
} from '@deepseek-ai/dsh-claude-code'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer, AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'

/** Let pending microtasks and one macrotask turn drain. */
export async function settle(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

/** A logger that keeps every line, so "log loudly" is an assertion and not a hope. */
export class RecordingLogger implements CcLogger {
  /** Every line written. */
  readonly lines: string[] = []

  /**
   * Record a line.
   * @param message - the line.
   */
  debug(message: string): void {
    this.lines.push(message)
  }

  /**
   * Whether any recorded line contains `text`.
   * @param text - the substring to look for.
   * @returns true when some line contains it.
   */
  saw(text: string): boolean {
    return this.lines.some(line => line.includes(text))
  }
}

/** A scripted `ctx.approval`. */
export class FakeApproval implements CcApprovalSeam {
  /** Every request it received, in order. */
  readonly requests: ApprovalRequest[] = []
  /** Outcomes to answer with, in order; the last one repeats. */
  outcomes: ApprovalOutcome[] = ['allowed-once']
  /** When set, `request()` throws this instead of answering (the open-turn guard). */
  throws: Error | undefined
  /** When set, `request()` waits for this before answering. */
  gate: Promise<void> | undefined

  /**
   * Answer one approval request.
   * @param request - the request.
   * @returns the next scripted outcome.
   */
  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    this.requests.push(request)
    if (this.throws !== undefined) throw this.throws
    if (this.gate !== undefined) await this.gate
    return this.outcomes.length > 1 ? this.outcomes.shift() as ApprovalOutcome : this.outcomes[0] as ApprovalOutcome
  }
}

/** A scripted `ctx.userQuestions`. */
export class FakeQuestions implements CcUserQuestionsSeam {
  /** Every request it received, in order. */
  readonly requests: AskUserQuestionRequest[] = []
  /** Answer to return; ignored when {@link FakeQuestions.throws} is set. */
  answer: AskUserQuestionAnswer = { answers: [] }
  /** When set, `ask()` rejects with this. */
  throws: unknown
  /** When set, `ask()` waits for this before answering. */
  gate: Promise<void> | undefined

  /**
   * Answer one question request.
   * @param request - the request.
   * @returns the scripted answer.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    this.requests.push(request)
    if (this.throws !== undefined) throw this.throws
    if (this.gate !== undefined) await this.gate
    return this.answer
  }
}

/**
 * A `UserQuestionError` stand-in: the router reads `code` off the thrown value
 * and never `instanceof`-checks it (two copies of a package make that a lie).
 */
export class FakeUserQuestionError extends Error {
  /** The taxonomy code. */
  readonly code: string

  /**
   * @param code - the taxonomy code.
   * @param message - the message; defaults to the code.
   */
  constructor(code: string, message = `fake ${code}`) {
    super(message)
    this.name = 'UserQuestionError'
    this.code = code
  }
}

/** A call site (the mirror) that a test drives by hand (§4.4). */
export class FakeCallSite implements CcAskCallSite {
  /** `tool_use` ids a `tool/call` has been appended for. */
  readonly emitted = new Set<string>()
  /** Synthesis calls that actually appended something. */
  readonly synthesized: { toolUseId: string, toolName: string, input: Record<string, unknown> }[] = []

  /**
   * @param toolUseId - CC's `tool_use` id.
   * @returns whether the log already holds the call.
   */
  hasEmittedCall(toolUseId: string): boolean {
    return this.emitted.has(toolUseId)
  }

  /**
   * @param toolUseId - CC's `tool_use` id.
   * @param toolName - the tool.
   * @param input - its arguments.
   * @returns the (identity-mapped) dsh call id.
   */
  ensureToolCall(toolUseId: string, toolName: string, input: Record<string, unknown>): string {
    if (!this.emitted.has(toolUseId)) {
      this.synthesized.push({ toolUseId, toolName, input })
      this.emitted.add(toolUseId)
    }
    return toolUseId
  }
}

/** A minimal stand-in for a dsh Agent — the router only ever passes it through. */
export function fakeAgent(id = 'agent-1'): Agent {
  return { id } as unknown as Agent
}

/** One SDK permission request, with the fields Phase 4 reads. */
export function makeRequest(overrides: Partial<CcPermissionRequest> = {}): CcPermissionRequest {
  return {
    signal: new AbortController().signal,
    toolUseID: 'toolu_1',
    requestId: 'req_1',
    ...overrides,
  }
}

/** Everything {@link makeRouter} hands back. */
export interface AskHarness {
  /** The router under test. */
  readonly router: CcAskRouter
  /** Its scripted approval seam. */
  readonly approval: FakeApproval
  /** Its scripted user-questions seam. */
  readonly questions: FakeQuestions
  /** Its recording logger. */
  readonly logger: RecordingLogger
  /** The attached target (unless the test asked for none). */
  readonly target: CcAskTarget | undefined
  /** A temp directory used as the session cwd (the rule cache lives under it). */
  readonly cwd: string
  /** Remove the temp directory. */
  cleanup(): void
}

/** How to build one {@link AskHarness}. */
export interface AskHarnessOptions {
  /** Surface configuration for the seam. */
  readonly config?: ClaudeCodeConfig
  /** Attach no ask target (the fail-closed case). */
  readonly noTarget?: boolean
  /** Mark the target delegated (selects `ask.delegatedTimeoutMs`). */
  readonly delegated?: boolean
  /** Resolve the seams through the composition instead of the target. */
  readonly viaServices?: boolean
  /** Mount no approval seam at all. */
  readonly noApproval?: boolean
  /** Mount no user-questions seam at all. */
  readonly noQuestions?: boolean
  /** Extra router deps (call-id waits, plan-file reader, a shared table). */
  readonly deps?: Partial<CcAskRouterDeps>
}

/**
 * Build a router wired to scripted seams and a rule cache in a fresh temp
 * directory.
 * @param options - what to wire and how.
 * @returns the harness.
 */
export function makeRouter(options: AskHarnessOptions = {}): AskHarness {
  const cwd = mkdtempSync(join(tmpdir(), 'cc-ask-'))
  const config = resolveClaudeCodeConfig(options.config ?? {})
  const approval = new FakeApproval()
  const questions = new FakeQuestions()
  const logger = new RecordingLogger()

  const router = new CcAskRouter({
    services: {
      approval: () => (options.noApproval === true || options.viaServices !== true ? undefined : approval),
      userQuestions: () => (options.noQuestions === true || options.viaServices !== true ? undefined : questions),
    },
    config,
    rules: CcAskRules.forSession(config, cwd, logger),
    logger,
    callIdWaitMs: 30,
    callIdPollMs: 2,
    ...options.deps,
  })

  let target: CcAskTarget | undefined
  if (options.noTarget !== true) {
    target = {
      agent: fakeAgent(),
      delegated: options.delegated === true,
      ...(options.viaServices === true || options.noApproval === true ? {} : { approval }),
      ...(options.viaServices === true || options.noQuestions === true ? {} : { userQuestions: questions }),
    }
    router.attachTarget(target)
  }

  return {
    router,
    approval,
    questions,
    logger,
    target,
    cwd,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}
