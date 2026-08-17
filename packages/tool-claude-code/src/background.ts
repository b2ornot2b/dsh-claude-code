/**
 * `claude_code_open({ background: true })` — one Claude Code session registered
 * as a dsh job.
 *
 * The job IS the session, not just its first turn: `job_kill` closes it,
 * owner disposal closes it, `job_output` streams each turn's answer as it
 * lands, and the job settles when the session closes (which `claude_code_close`
 * also does). That is the shape §3.4 asks for — "the idiomatic dsh answer to
 * 'a tool started something that outlives the call'" — and it is why the
 * caller's `exec.signal` is never wired into the session: once `ctx.jobs.start()`
 * publishes the id, cancellation belongs to {@link JobHooks.cancel} alone
 * (delta D10). Cancelling the outer tool call must not kill a published session.
 *
 * The `JobHooks` contract this file implements to the letter:
 *
 * - **`cancel` is synchronous and idempotent.** It records the reason, requests
 *   the close, and returns; a second call (or one that lands before the session
 *   has finished opening) does nothing new. It never throws — a throwing cancel
 *   would leave the registry force-failing a record while the work ran on.
 * - **`done` never rejects.** Every path — a normal close, a cancel, a failed
 *   open — resolves it exactly once with a `JobOutcome`.
 * - **`readOutput` is a consuming delta.** Each completed turn's final text is
 *   buffered and handed over once. Delta bookkeeping is ~15 lines here because
 *   the seam already fans results out on `onMessage`, and a background session
 *   accepts follow-ups (`claude_code_send`), so final-output-only would hide
 *   every turn after the first.
 *
 * @module @deepseek-ai/dsh-tool-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CcSession, CcSessionId } from '@deepseek-ai/dsh-claude-code'
import type { JobHooks, JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'

import {
  abortedError, ClaudeCodeToolError, describeError, jobRejectedError, JOBS_REQUIRED_MESSAGE,
} from './errors.ts'
import { openSession } from './open.ts'
import type { CcOpenArgs } from './open.ts'
import { projectResult } from './result.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** One backgrounded Claude Code session, registered by `claude_code_open`. */
    'claude-code': 'claude-code'
  }
}

/** The job kind (and job-id prefix) a backgrounded Claude Code session registers under. */
export const CC_JOB_KIND = 'claude-code'

/** Longest label handed to the job registry; longer prompts are elided. */
export const MAX_JOB_LABEL_LENGTH = 120

/** What `claude_code_open` returns for a backgrounded session. */
export interface CcBackgroundHandle {
  /** The dsh job id tracking the session (`claude-code-<n>`). */
  readonly jobId: string
  /** The Claude Code session id the job opened. */
  readonly ccSessionId: string
}

/**
 * Derive the job's one-line model-facing label from the open.
 *
 * Prompt first (it is what the reader recognizes in `job_list`), the working
 * directory when the session was opened idle. Newlines collapse: the registry
 * renders a label into a single status line.
 * @param args - the validated open arguments.
 * @returns the label, at most {@link MAX_JOB_LABEL_LENGTH} characters.
 */
export function jobLabel(args: CcOpenArgs): string {
  const source = args.prompt === undefined || args.prompt.trim().length === 0
    ? `claude code session in ${args.cwd}`
    : args.prompt
  const line = source.replace(/\s+/g, ' ').trim()
  return line.length <= MAX_JOB_LABEL_LENGTH
    ? line
    : `${line.slice(0, MAX_JOB_LABEL_LENGTH - 1)}…`
}

/**
 * Open a Claude Code session detached from this tool call, as a dsh job.
 *
 * @param ctx - the plugin context.
 * @param args - the validated open arguments.
 * @param exec - the tool execution (owner and the pre-publication abort check).
 * @returns the job id and the session id it opened.
 * @throws {ClaudeCodeToolError} code `CC_NO_JOBS` when the composition has no
 *   jobs runtime, `CC_ABORTED` when the caller aborted the tool call before the
 *   job was published, or `CC_JOB_REJECTED` when the registry refused the
 *   registration (the per-owner cap). None of the three opened anything.
 * @throws whatever the open failed with — the job is registered and settles
 *   `failed`, and the failure is reported to the caller rather than swallowed.
 */
export async function startBackgroundSession(
  ctx: Context,
  args: CcOpenArgs,
  exec: Pick<ToolRunContext, 'agent' | 'signal'>,
): Promise<CcBackgroundHandle> {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) throw new ClaudeCodeToolError(JOBS_REQUIRED_MESSAGE, 'CC_NO_JOBS')

  // The caller owns cancellation until `start()` commits detached ownership;
  // this is the last instant at which that is still true (delta D10, and the
  // identical check at `@deepseek-ai/dsh-tool-bash`'s index.ts:358).
  if (exec.signal.aborted) throw abortedError('claude_code_open')

  const producer = new BackgroundSession(ctx, args, exec)
  let jobId: JobId
  try {
    jobId = jobs.start({
      kind: CC_JOB_KIND,
      label: jobLabel(args),
      // `owner` is optional and `exec.agent` may be undefined: spread it
      // conditionally or `exactOptionalPropertyTypes` fails the build (delta D10).
      ...(exec.agent ? { owner: exec.agent } : {}),
      run: () => producer.run(),
    })
  } catch (error) {
    // A REFUSED registration (the per-owner cap, a controller that does not
    // serve this owner) is raised before the registry ever calls `run()`, so
    // normally `producer` never opened anything. The two lines below cover the
    // other case anyway, because the cost of being wrong is an orphaned
    // subprocess plus a process-killing unhandled rejection: `cancel()` closes
    // whatever an already-invoked `run()` managed to open (it is idempotent and
    // a no-op when nothing started), and the `catch` marks `opened` handled,
    // since nothing awaits it once this throws.
    producer.cancel('the jobs runtime refused this registration')
    producer.opened.catch(() => {})
    throw jobRejectedError(error)
  }

  // The session id is minted inside `open()`, which `run()` started
  // asynchronously; awaiting it here is what lets the tool return the typed
  // handle instead of prose the caller would have to parse. It rejects only
  // when the open itself failed — by which time the job has already settled
  // `failed`, so nothing is left running.
  const ccSessionId = await producer.opened
  return { jobId, ccSessionId }
}

/**
 * The producer behind one backgrounded session: it owns the open, the output
 * buffer, the cancel request and the single settlement of `done`.
 */
class BackgroundSession {
  /** Resolves with the session id once the open succeeded; rejects when it failed. */
  readonly opened: Promise<CcSessionId>
  /** Resolves once — never rejects — with this job's terminal outcome. */
  readonly done: Promise<JobOutcome>

  readonly #ctx: Context
  readonly #args: CcOpenArgs
  readonly #exec: Pick<ToolRunContext, 'agent'>

  #settleOpened!: (id: CcSessionId) => void
  #failOpened!: (error: unknown) => void
  #settleDone!: (outcome: JobOutcome) => void

  /** Turn texts produced since the last {@link BackgroundSession.readOutput}. */
  #pending: string[] = []
  #session: CcSession | undefined
  #cancelled = false
  #cancelReason: string | undefined
  #settled = false

  /**
   * @param ctx - the plugin context.
   * @param args - the validated open arguments.
   * @param exec - the tool execution, for the ask target only.
   */
  constructor(ctx: Context, args: CcOpenArgs, exec: Pick<ToolRunContext, 'agent'>) {
    this.#ctx = ctx
    this.#args = args
    this.#exec = exec
    this.opened = new Promise<CcSessionId>((resolve, reject) => {
      this.#settleOpened = resolve
      this.#failOpened = reject
    })
    this.done = new Promise<JobOutcome>(resolve => {
      this.#settleDone = resolve
    })
  }

  /**
   * Start the work and hand the registry its hooks.
   *
   * Synchronous by contract — `JobStart.run()` must return hooks, not a promise
   * — so the open runs detached and everything that depends on it is arranged
   * through the two promises constructed above.
   * @returns the job hooks.
   */
  run(): JobHooks {
    void this.open()
    return {
      cancel: (reason?: string) => {
        this.cancel(reason)
      },
      done: this.done,
      readOutput: () => this.readOutput(),
    }
  }

  /**
   * Open the session, subscribe to its results, and arm settlement on close.
   * @returns nothing; failures settle the job rather than propagating.
   */
  private async open(): Promise<void> {
    try {
      const opened = await openSession(this.#ctx, this.#args, this.#exec)
      this.#session = opened.session
      const detach = opened.session.onMessage(envelope => {
        if (envelope.message.type !== 'result' || envelope.meta.interruptArtifact) return
        const text = projectResult(envelope).result
        if (text !== undefined) this.#pending.push(text)
      })
      opened.session.onClose(() => {
        detach()
        this.settle(this.#cancelled
          ? { status: 'killed', detail: this.#cancelReason ?? 'cancelled' }
          : { status: 'completed', detail: 'session closed' })
      })
      this.#settleOpened(opened.id)
      // A kill that landed while the open was still in flight: the hooks had no
      // session to close yet, so honor it now.
      if (this.#cancelled) this.requestClose()
    } catch (error) {
      this.settle({ status: 'failed', detail: describeError(error) })
      this.#failOpened(error)
    }
  }

  /**
   * Request termination: synchronous, idempotent, never throwing.
   *
   * Public because {@link startBackgroundSession} needs the same lever when the
   * registry throws out of `start()` after having already called `run()`.
   * @param reason - the registry's reason, forwarded verbatim into the outcome.
   * @returns nothing.
   */
  cancel(reason?: string): void {
    if (this.#cancelled) return
    this.#cancelled = true
    this.#cancelReason = reason
    this.requestClose()
  }

  /**
   * Ask the session to close, without waiting for it. Settlement rides the
   * session's own close listener, so a close that fails still settles the job
   * instead of leaving it `stopping` forever.
   * @returns nothing.
   */
  private requestClose(): void {
    const session = this.#session
    if (session === undefined) return
    void session.close().catch((error: unknown) => {
      this.settle({ status: 'killed', detail: `close failed: ${describeError(error)}` })
    })
  }

  /**
   * Hand over every turn text that arrived since the previous call.
   * @returns the delta (empty while a turn is still running).
   */
  private readOutput(): string {
    if (this.#pending.length === 0) return ''
    const delta = this.#pending.join('\n\n')
    this.#pending = []
    return delta
  }

  /**
   * Settle `done` exactly once.
   * @param outcome - the terminal outcome.
   * @returns nothing.
   */
  private settle(outcome: JobOutcome): void {
    if (this.#settled) return
    this.#settled = true
    this.#settleDone(outcome)
  }
}
