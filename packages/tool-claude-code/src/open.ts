/**
 * Opening a Claude Code session from a tool call: the seam call, the dsh
 * session mirror, the ask target, and the first prompt — in the one order that
 * loses nothing.
 *
 * The order matters and is the whole reason this lives in its own module:
 *
 * 1. `ctx.claudeCode.open()` WITHOUT `prompt`, carrying the ask target. The
 *    seam mints the id (D1: dsh mints every id, bare UUID, shared with the CLI)
 *    and attaches the ask target before the handshake, so the very first tool
 *    call of the session already has a human behind it.
 * 2. Create (or adopt) the dsh session under **that same id** and attach the
 *    mirror. It cannot happen earlier: the id does not exist until `open()`
 *    returns (a warm lease may supply a pre-minted one, a plain resume keeps
 *    the resumed id).
 * 3. Only now send the prompt. `send()` is synchronous and frames
 *    `turn/start` + `user/message` through the mirror, so a prompt sent before
 *    step 2 — which is exactly what `open({ prompt })` would do — would be
 *    invisible in the dsh log.
 *
 * @module @deepseek-ai/dsh-tool-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { CC_PERMISSION_MODES } from '@deepseek-ai/dsh-claude-code'
import type {
  CcAskTarget, CcOpenOptions, CcPermissionMode, CcSession, CcSessionId, CcSessionSnapshot,
} from '@deepseek-ai/dsh-claude-code'

import { ClaudeCodeToolError } from './errors.ts'

/** The `claude_code_open` arguments this module consumes, in the tool's own snake_case. */
export interface CcOpenArgs {
  /**
   * Absolute working directory the session runs in. Required unless `resume`
   * is set, in which case the seam resolves it from discovery.
   */
  readonly cwd?: string | undefined
  /** First user message; omitted opens an idle session. */
  readonly prompt?: string | undefined
  /** Model id override. */
  readonly model?: string | undefined
  /** Permission mode override; validated against {@link CC_PERMISSION_MODES}. */
  readonly permission_mode?: string | undefined
  /** An existing session id to resume. */
  readonly resume?: string | undefined
  /** Fork the resumed session instead of continuing it. */
  readonly fork?: boolean | undefined
}

/** A session this tool layer opened, plus what it did around the open. */
export interface CcOpenedSession {
  /** The shared dsh/Claude Code session id. */
  readonly id: CcSessionId
  /** The live actor to send to, wait on, interrupt and close. */
  readonly session: CcSession
  /** The snapshot `open()` returned (taken before the prompt was sent). */
  readonly snapshot: CcSessionSnapshot
  /** Whether a dsh session log is mirroring this session. */
  readonly mirrored: boolean
  /** Whether an opening prompt was sent (and therefore whether a result is coming). */
  readonly prompted: boolean
}

/**
 * Open a session for a tool call, mirror it, and send its opening prompt.
 *
 * @param ctx - the plugin context (the seam, and optionally `sessions`/`agents`).
 * @param args - the validated tool arguments.
 * @param exec - the tool execution, for the ask target.
 * @returns the opened session.
 * @throws {ClaudeCodeError} whatever the seam refuses the open with
 *   (`INVALID_CWD`, `SESSION_LIMIT`, `SESSION_EXISTS`, `BACKEND_ERROR`, …) —
 *   re-thrown untouched, because its `code` is what a caller routes on.
 */
export async function openSession(
  ctx: Context,
  args: CcOpenArgs,
  exec: Pick<ToolRunContext, 'agent'>,
): Promise<CcOpenedSession> {
  const ask = resolveAskTarget(ctx, exec)
  const permissionMode = readPermissionMode(args.permission_mode)
  const options: CcOpenOptions = {
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(args.resume === undefined ? {} : { resume: args.resume as CcSessionId }),
    ...(args.fork === undefined ? {} : { fork: args.fork }),
    ...(ask === undefined ? {} : { ask }),
  }

  const snapshot = await ctx.claudeCode.open(options)
  const id = snapshot.id
  const session = ctx.claudeCode.session(id)
  if (session === undefined) {
    // Only reachable if the session closed between `open()` resolving and this
    // lookup (a dead subprocess, a racing teardown). Report it as the same
    // thing every other lookup failure is rather than dereferencing undefined.
    throw noSuchSession(id)
  }

  // The RESOLVED cwd, not `args.cwd`: a resume without one gets it from
  // discovery inside `open()`, and the mirror header must record what the
  // session actually runs in, not what the caller omitted.
  let mirrored = false
  try {
    mirrored = attachSessionMirror(ctx, id, snapshot.cwd)
  } catch (error) {
    // A mirror that cannot be attached is a composition bug, not a reason to
    // strand a live subprocess holding a permission callback.
    await ctx.claudeCode.close(id)
    throw error
  }

  const prompted = args.prompt !== undefined
  if (args.prompt !== undefined) session.send(args.prompt, { mode: 'followup' })
  return { id, session, snapshot, mirrored, prompted }
}

/**
 * Look up the live actor behind a session id the model supplied.
 *
 * @param ctx - the plugin context.
 * @param sessionId - the id as the model wrote it.
 * @returns the live actor.
 * @throws {ClaudeCodeToolError} code `CC_NO_SESSION` when no such session is
 *   open here — an unknown id, a closed session and a malformed id are one
 *   failure from the model's point of view: there is nothing to send to.
 */
export function requireSession(ctx: Context, sessionId: string): CcSession {
  const session = ctx.claudeCode.session(sessionId as CcSessionId)
  if (session === undefined) throw noSuchSession(sessionId)
  return session
}

/**
 * The `CC_NO_SESSION` failure, worded for the model.
 * @param sessionId - the id that resolved to nothing.
 * @returns the typed error, ready to throw.
 */
export function noSuchSession(sessionId: string): ClaudeCodeToolError {
  return new ClaudeCodeToolError(
    `claude-code: no open session ${sessionId} in this composition — it was never opened here, it `
    + 'has already been closed, or the id is not one claude_code_open returned. Open a session '
    + 'first (claude_code_open) and use the session_id it returns.',
    'CC_NO_SESSION',
    { data: { session_id: sessionId } })
}

/**
 * Who answers this session's permission prompts, questions and plan reviews
 * (§4.5).
 *
 * - `exec.agent` present — that agent answers. Its turn is open by
 *   construction (it is mid tool call), which is exactly what makes
 *   `approval.request()` legal.
 * - `exec.agent` absent (a headless tool call: a script, a test, code mode
 *   without an agent) — NO target. The seam then fails closed and denies every
 *   ask with an explanation, which is the correct posture for a session nobody
 *   is watching.
 *
 * `delegated` is computed by comparing against `ctx.agents.roots()` — by `id`,
 * never by object identity, because everything reached through a cordis service
 * may be a fresh traceable proxy. With no agent registry in the composition the
 * honest answer is `true`: nothing can prove a human is attached, and
 * `delegated` only selects the shorter `ask.delegatedTimeoutMs`.
 *
 * @param ctx - the plugin context.
 * @param exec - the tool execution.
 * @returns the ask target, or undefined for a headless call.
 */
export function resolveAskTarget(
  ctx: Context,
  exec: Pick<ToolRunContext, 'agent'>,
): CcAskTarget | undefined {
  const agent = exec.agent
  if (agent === undefined) return undefined
  const roots = ctx.get('agents')?.roots() ?? []
  return { agent, delegated: !roots.some(root => root.id === agent.id) }
}

/**
 * Mirror a freshly opened session into a dsh session log sharing its id (D1).
 *
 * The store is OPTIONAL: a headless delegation composition mounts no
 * `ctx.sessions`, and then the session runs unmirrored — it still works, it
 * just leaves no dsh-side transcript, so no UI can replay it and no approval
 * prompt can reference a `tool/call` the user has seen.
 *
 * The mirror's disposal is owned by the seam (it detaches on session close), so
 * nothing is returned here.
 *
 * @param ctx - the plugin context.
 * @param id - the shared dsh/Claude Code session id.
 * @param cwd - the session's working directory, recorded in the session header.
 * @returns true when a mirror was attached, false when no session store exists.
 */
function attachSessionMirror(ctx: Context, id: CcSessionId, cwd: string): boolean {
  const store = ctx.get('sessions')
  if (store === undefined) return false
  // A plain resume continues under the id it resumed, so a live dsh session may
  // already carry that transcript — adopt it instead of failing on a duplicate.
  const dshSession = store.get(id) ?? store.create(id, { meta: { cwd } })
  ctx.claudeCode.attachMirror(id, dshSession)
  return true
}

/**
 * Narrow a model-supplied permission mode to the seam's union.
 *
 * The tool schema already declares the enum, so this is belt-and-braces for the
 * code-mode path (undeclared keys are allowed through) — and it is what keeps
 * the value assignable to `CcPermissionMode` without a cast.
 * @param mode - the raw argument.
 * @returns the mode, or undefined when absent or unrecognized.
 */
function readPermissionMode(mode: string | undefined): CcPermissionMode | undefined {
  if (mode === undefined) return undefined
  return CC_PERMISSION_MODES.find(candidate => candidate === mode)
}
