/**
 * The typed failures these six tools raise on their own behalf.
 *
 * Everything the SEAM refuses already arrives as a `ClaudeCodeError` with a
 * `CcErrorCode` (`INVALID_CWD`, `SESSION_LIMIT`, `SESSION_EXISTS`,
 * `BACKEND_ERROR`, …) and is re-thrown untouched: re-wrapping it would bury the
 * code a caller routes on. This module covers only the failures that belong to
 * the TOOL layer — a session id the model made up, a wait this layer capped, a
 * composition with no jobs runtime, a tool call aborted before it published
 * anything.
 *
 * Codes are prefixed `CC_` so they never collide with the seam's own taxonomy
 * (`TIMEOUT` from `waitForResult` is the seam's; `CC_TIMEOUT` is ours, and it
 * carries the still-open session's id) and are read by string comparison, never
 * by `instanceof`: two copies of a package on two resolution planes make an
 * identity check silently false (spec review §3, gotcha 15).
 *
 * @module @deepseek-ai/dsh-tool-claude-code
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable machine-routable failure classes owned by the tool layer. */
export type CcToolErrorCode =
  /**
   * No open Claude Code session with that id is registered in this
   * composition: it was never opened here, it has been closed, or the id is not
   * a bare UUID this seam could ever have minted.
   */
  | 'CC_NO_SESSION'
  /**
   * A bounded wait this layer imposed elapsed. The session is UNTOUCHED and
   * still open — `data.session_id` names it so the caller can wait again,
   * cancel it, or close it.
   */
  | 'CC_TIMEOUT'
  /**
   * `background: true` in a composition with no jobs runtime. The message names
   * the packages to load; nothing was opened.
   */
  | 'CC_NO_JOBS'
  /**
   * The caller's tool call was already aborted at the last moment this layer
   * still owned it (immediately before `ctx.jobs.start()` publishes the job).
   * Nothing was started.
   */
  | 'CC_ABORTED'
  /**
   * `ctx.jobs.start()` REFUSED the registration — most often the per-owner
   * concurrency cap (10 by default), otherwise a composition whose controller
   * does not serve this owner. Every such refusal is raised before the
   * registry calls `spec.run()`, so nothing was opened. The registry's own
   * words are quoted in the message and kept as `cause`.
   */
  | 'CC_JOB_REJECTED'

/** Options for {@link ClaudeCodeToolError}. */
export interface CcToolErrorOptions extends ErrorOptions {
  /**
   * Machine-readable specifics a caller can act on — currently only
   * `session_id`, on `CC_TIMEOUT`. String-valued so the whole error stays
   * losslessly JSON-serializable through the tool result envelope.
   */
  readonly data?: Readonly<Record<string, string>>
}

/**
 * A failure raised by the Claude Code tools themselves (as opposed to the seam
 * behind them). Extends `HarnessError` so `error.code` is the routable class and
 * the tool runtime reports it as a normal tool error rather than a crash.
 */
export class ClaudeCodeToolError extends HarnessError {
  /** Machine-readable specifics; `undefined` when the code carries none. */
  readonly data: Readonly<Record<string, string>> | undefined

  /**
   * @param message - human-readable explanation, written for the model.
   * @param code - the stable {@link CcToolErrorCode} callers route on.
   * @param options - standard error options plus optional structured `data`.
   */
  constructor(message: string, code: CcToolErrorCode, options: CcToolErrorOptions = {}) {
    super(message, code, options)
    this.name = 'ClaudeCodeToolError'
    // Assigned, never spread into an optional property: `exactOptionalPropertyTypes`
    // rejects `{ data: undefined }` for `data?: …`, so the field is declared
    // explicitly nullable instead.
    this.data = options.data
  }
}

/**
 * The message a jobs-less composition gets for `background: true`. Names BOTH
 * packages, because loading only `@deepseek-ai/dsh-jobs` (or only a provider)
 * still leaves `ctx.jobs.start()` throwing: it refuses to start work no
 * attached controller can stop, and `@deepseek-ai/dsh-tool-jobs` is what
 * attaches that controller (delta D10).
 */
export const JOBS_REQUIRED_MESSAGE
  = 'claude_code_open: background mode needs a jobs runtime in this composition. Load '
  + '@deepseek-ai/dsh-jobs (with a provider such as @deepseek-ai/dsh-jobs-local) AND '
  + '@deepseek-ai/dsh-tool-jobs, which attaches the job controller ctx.jobs.start() requires and '
  + 'provides job_list / job_output / job_kill. Nothing was opened; retry without background to '
  + 'run the session synchronously.'

/**
 * The abort this layer throws while it still owns the call — the re-check
 * `@deepseek-ai/dsh-tool-bash` performs immediately before `ctx.jobs.start()`
 * (delta D10: once the job id is published, cancellation belongs to
 * `JobHooks.cancel`, never to `exec.signal`).
 *
 * `name` is set to `AbortError` because that is the shape the tool runtime
 * recognizes as a cancellation rather than a failure; the routable `code` stays
 * `CC_ABORTED`.
 * @param toolName - the tool reporting the abort.
 * @returns the typed abort error, ready to throw.
 */
export function abortedError(toolName: string): ClaudeCodeToolError {
  const error = new ClaudeCodeToolError(
    `${toolName}: the tool call was aborted before anything was started`, 'CC_ABORTED')
  error.name = 'AbortError'
  return error
}

/**
 * Re-raise a `ctx.jobs.start()` refusal as a routable tool error.
 *
 * The registry refuses with a plain `Error` — good prose ("background job limit
 * reached for this owner (limit: 10); use job_kill…"), but no `code`, so it is
 * the ONLY failure on this tool's surface a caller could not route on. The
 * wording is preserved verbatim (it names the remedy) and the original stays as
 * `cause`; only the routable class is added.
 *
 * Every refusal `@deepseek-ai/dsh-jobs-local` raises happens before it calls
 * `spec.run()`, which is what lets this message promise that nothing was opened.
 * @param error - whatever `start()` threw.
 * @returns the typed error, ready to throw.
 */
export function jobRejectedError(error: unknown): ClaudeCodeToolError {
  return new ClaudeCodeToolError(
    `claude_code_open: the jobs runtime refused to register this background session: ${describeError(error)}. `
    + 'Nothing was opened — no session, no subprocess. Retry once a job has finished, or run the '
    + 'session synchronously by omitting background.',
    'CC_JOB_REJECTED',
    { cause: error })
}

/**
 * Read a `code` off a thrown value without importing anyone's error class.
 * @param error - the thrown value.
 * @returns the code when the value carries a string one, else undefined.
 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Render any thrown value as one line of prose.
 * @param error - the thrown value.
 * @returns a one-line description.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
