/**
 * Model-facing tools over the Claude Code capability seam (`ctx.claudeCode`):
 * open, send, wait, status, cancel, and close a Claude Code session.
 *
 * NAMED EXPORTS ONLY. A `default` export here would make the cordis Loader
 * unwrap the module to that single value and silently discard the sibling
 * `name`/`inject`/`Config` exports, mounting the plugin with an empty inject
 * list (harness post-mortem 0001, "export default drops the plugin's
 * inject"). `tests/exports.spec.ts` asserts the absence of a default export.
 *
 * **Phase 5 wired every body to the real seam.** The schemas are the same
 * contract Phase 1 froze; `claude_code_open`'s session branch gained three
 * OPTIONAL fields (`result`, `usage`, `cost_usd`) because synchronous mode now
 * returns the turn it waited for, and nothing was removed or retyped.
 *
 * What this plugin does NOT do, on purpose:
 *
 * - **No permission policy** (delta D13). Policy over *these* tools belongs in
 *   `tools/pre-execute` (allow/deny/ask) or `ctx.tools.guard()`; policy INSIDE
 *   a Claude Code session is the seam's ask channel (§4). A tool that decided
 *   for itself would be a second, weaker policy engine.
 * - **No progress injection.** The spec's `exec.agent.inject(...)` note is
 *   redundant now that background sessions are dsh jobs:
 *   `@deepseek-ai/dsh-tool-jobs` already delivers a completion notice to the
 *   owning agent (injected into a busy owner, waking an idle one, bounded per
 *   owner). A second, unbounded notice path from this plugin would double every
 *   message and bypass those bounds. Documented as a deliberate deviation in
 *   the README.
 *
 * @module @deepseek-ai/dsh-tool-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import {
  CC_CLOSE_REASONS,
  CC_PERMISSION_MODES,
  CC_SESSION_STATUSES,
} from '@deepseek-ai/dsh-claude-code'
import type { CcMessageEnvelope, CcSession, CcSessionId } from '@deepseek-ai/dsh-claude-code'
// Side-effect type-only imports: they contribute the `Context` augmentations
// this plugin reads opportunistically (`ctx.jobs`), and they are erased at
// runtime, so a composition without a jobs runtime still mounts.
import type {} from '@deepseek-ai/dsh-jobs'

import { startBackgroundSession } from './background.ts'
import { abortedError, ClaudeCodeToolError, errorCode } from './errors.ts'
import { noSuchSession, openSession, requireSession } from './open.ts'
import { projectContextUsage, projectResult } from './result.ts'

export const name = 'tool-claude-code'
export const inject = ['tools', 'claudeCode']

/** Reserved for future tuning (e.g. gating background-mode advertisement); empty in Phase 5. */
export interface Config {}

/** Runtime configuration schema for the Claude Code tool plugin. */
export const Config: z<Config> = z.object({})

/**
 * How long synchronous `claude_code_open` waits for the opening turn before it
 * gives up on WAITING (never on the session).
 *
 * Ten minutes is the same ceiling `@deepseek-ai/dsh-tool-jobs` puts on a bounded
 * job wait. A cap has to exist: a tool call that never returns holds the
 * caller's turn open forever, and the honest failure — "still running, here is
 * the id" — is strictly more useful than a hang.
 */
export const SYNC_OPEN_TIMEOUT_MS = 600_000

/** Hard ceiling for `claude_code_wait`, applied to an absent AND to an oversized `timeout_ms`. */
export const MAX_WAIT_TIMEOUT_MS = 600_000

/** Pure pending-call card shared by every tool below: a titled, category-iconed generic card. */
function genericCall(title: string, rawInput?: unknown): GenericCallView {
  return {
    card: 'generic',
    title,
    kind: 'execute',
    ...rawInput !== undefined ? { rawInput } : {},
  }
}

/**
 * Wait for a turn under a tool-layer cap, translating the seam's `TIMEOUT` into
 * this layer's `CC_TIMEOUT` — which names the still-open session so the caller
 * can wait again, cancel the turn, or close it.
 *
 * The code is read off the thrown value rather than checked with `instanceof`:
 * two copies of a package on two resolution planes make identity checks
 * silently false.
 * @param session - the live actor.
 * @param timeoutMs - the cap in milliseconds.
 * @param sessionId - the session id, for the error payload.
 * @returns the result envelope.
 * @throws {ClaudeCodeToolError} code `CC_TIMEOUT` when the wait elapsed.
 */
async function waitCapped(
  session: CcSession,
  timeoutMs: number,
  sessionId: string,
): Promise<CcMessageEnvelope> {
  try {
    return await session.waitForResult(timeoutMs)
  } catch (error) {
    if (errorCode(error) !== 'TIMEOUT') throw error
    throw new ClaudeCodeToolError(
      `claude-code: session ${sessionId} produced no result within ${timeoutMs}ms. The session is `
      + 'STILL OPEN and still working: wait again with claude_code_wait, stop the current turn with '
      + 'claude_code_cancel, or end it with claude_code_close.',
      'CC_TIMEOUT',
      { data: { session_id: sessionId }, cause: error })
  }
}

/**
 * Clamp a model-supplied wait to something this layer will actually honor.
 * @param timeoutMs - the requested wait, if any.
 * @returns the effective wait in milliseconds.
 */
function effectiveWait(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return MAX_WAIT_TIMEOUT_MS
  }
  return Math.min(Math.round(timeoutMs), MAX_WAIT_TIMEOUT_MS)
}

export function apply(ctx: Context, _config: Config = {}): void {
  const defaults = ctx.claudeCode.config.defaults

  ctx.tools.register(defineTool({
    name: 'claude_code_open',
    description: 'Open a new Claude Code session, or resume (optionally fork) an existing one, rooted at a working '
      + 'directory. With `prompt`, waits for that first turn and returns its answer; omit `prompt` to open idle and '
      + 'send the first message with `claude_code_send`. The session STAYS OPEN either way — follow up with '
      + '`claude_code_send`, then `claude_code_close` when you are done with it. Set `background: true` to run '
      + 'detached as a dsh job instead of synchronously (requires a jobs runtime in this composition).',
    parameters: {
      cwd: { type: 'string', required: true, description: 'Absolute working directory the session runs in.' },
      prompt: { type: 'string', description: 'First user message. Omit to open an idle session and send later.' },
      model: { type: 'string', description: 'Model id override; omit for the deployment default.' },
      permission_mode: {
        type: 'string',
        enum: CC_PERMISSION_MODES,
        description: `Permission mode; omit to use the deployment default (currently "${defaults.permissionMode}").`,
      },
      resume: { type: 'string', description: 'An existing Claude Code session id (bare UUID) to resume.' },
      fork: {
        type: 'boolean',
        description: 'Fork the resumed session instead of continuing it (requires `resume`); the source session is left untouched and the fork gets a fresh id.',
      },
      background: {
        type: 'boolean',
        description: 'Run detached from this tool call as a dsh job instead of synchronously; requires a jobs '
          + 'runtime (`@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`) loaded in this composition.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'session' },
              session_id: { type: 'string', required: true, description: 'The shared dsh/Claude Code session id.' },
              status: { type: 'string', required: true, enum: CC_SESSION_STATUSES },
              result: { type: 'string', description: 'Final assistant text of the opening turn, when one was sent and completed.' },
              usage: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  input_tokens: { type: 'integer', required: true },
                  output_tokens: { type: 'integer', required: true },
                },
              },
              cost_usd: { type: 'number', description: 'Opening-turn cost in USD, when the SDK reported one.' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true, description: 'The dsh job id tracking this session open.' },
              ccSessionId: { type: 'string', required: true, description: 'The Claude Code session id the background job opens.' },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background job ${value.jobId} (session ${value.ccSessionId})`
          : `session ${value.session_id} (${value.status})`
            + (value.result === undefined ? '' : `\n\n${value.result}`),
      } satisfies ContentBlock],
    },
    async execute(args, exec) {
      if (args.background === true) {
        // Everything about the background branch — the jobs-absent error, the
        // pre-publication abort check, the JobHooks contract — lives in
        // `background.ts`, next to the D10 rules it implements.
        const handle = await startBackgroundSession(ctx, args, exec)
        return { kind: 'background' as const, jobId: handle.jobId, ccSessionId: handle.ccSessionId }
      }

      // Nothing has spawned yet: an already-aborted call must not pay for a
      // subprocess (and a subscription slot) it will never read.
      if (exec.signal.aborted) throw abortedError('claude_code_open')

      const opened = await openSession(ctx, args, exec)
      // An idle open has no turn to wait for; waiting would park until the cap
      // elapsed and then report a timeout for a session that is working fine.
      if (!opened.prompted) {
        return { kind: 'session' as const, session_id: opened.id, status: opened.session.status }
      }
      const envelope = await waitCapped(opened.session, SYNC_OPEN_TIMEOUT_MS, opened.id)
      return {
        kind: 'session' as const,
        session_id: opened.id,
        status: opened.session.status,
        ...projectResult(envelope),
      }
    },
    presentCall: args => genericCall(`Open Claude Code session in ${args.cwd}`, args.resume ?? args.cwd),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_send',
    description: 'Send a message to an open Claude Code session: `followup` queues it for after the current turn '
      + 'finishes; `steer` interrupts the in-flight turn with it. Use `claude_code_wait` to observe the result.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'The Claude Code session id to send to.' },
      message: { type: 'string', required: true, description: 'The message text.' },
      mode: {
        type: 'string',
        required: true,
        enum: ['followup', 'steer'],
        description: '`followup` queues after the current turn; `steer` interrupts it now.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: CC_SESSION_STATUSES },
        },
      },
      render: (args, value) => [{ type: 'text', text: `session ${args.session_id} is now ${value.status}` } satisfies ContentBlock],
    },
    async execute(args) {
      const session = requireSession(ctx, args.session_id)
      // `send()` is synchronous (it pushes onto the never-completing input
      // stream) and moves the status machine itself, so the snapshot taken
      // right after it is the post-send truth, not a stale read.
      session.send(args.message, { mode: args.mode === 'steer' ? 'steer' : 'followup' })
      return await Promise.resolve({ status: session.status })
    },
    presentCall: args => genericCall(`Send to Claude Code session ${args.session_id} (${args.mode})`, args.message),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_wait',
    description: 'Wait for an open Claude Code session to finish its current turn (or `timeout_ms` to elapse) and '
      + 'return its outcome: status, final text when the turn completed, and usage/cost when the SDK reported them. '
      + 'A timeout leaves the session running — wait again, or cancel it.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'The Claude Code session id to wait on.' },
      timeout_ms: {
        type: 'number',
        description: 'Maximum time to wait, in milliseconds. Omitted (or above the cap) means the 10-minute ceiling.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: CC_SESSION_STATUSES },
          result: { type: 'string', description: 'Final assistant text, present when the turn completed.' },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              input_tokens: { type: 'integer', required: true },
              output_tokens: { type: 'integer', required: true },
            },
          },
          cost_usd: { type: 'number', description: 'Turn cost in USD, when the SDK reported one.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.result ?? `status: ${value.status}`,
      } satisfies ContentBlock],
    },
    async execute(args) {
      const session = requireSession(ctx, args.session_id)
      const envelope = await waitCapped(session, effectiveWait(args.timeout_ms), args.session_id)
      return { status: session.status, ...projectResult(envelope) }
    },
    presentCall: args => genericCall(`Wait for Claude Code session ${args.session_id}`),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_status',
    description: 'Read the current status of an open Claude Code session without waiting: lifecycle state, how '
      + 'many permission/question asks are pending, and context-window occupancy when known.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'The Claude Code session id to inspect.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: CC_SESSION_STATUSES },
          close_reason: {
            type: 'string',
            enum: CC_CLOSE_REASONS,
            description: 'Why the session closed, present only when status is "closed": "closed" (something '
              + 'asked — claude_code_close, teardown), "exited" (the Claude Code subprocess ended on its own '
              + 'between turns) or "crashed" (it died mid-turn, so that turn produced no result).',
          },
          pending_asks: { type: 'integer', required: true, description: 'Number of permission/question asks currently awaiting an answer.' },
          context_usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              used_tokens: { type: 'integer', required: true },
              max_tokens: { type: 'integer' },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `session ${args.session_id}: ${value.status}`
          + (value.close_reason === undefined ? '' : ` (${value.close_reason})`)
          + `, ${value.pending_asks} pending ask(s)`
          + (value.context_usage !== undefined ? `, ${value.context_usage.used_tokens} tokens used` : ''),
      } satisfies ContentBlock],
    },
    async execute(args) {
      // The ONE tool that answers for a session that is no longer live. Every
      // other one needs something to drive and rightly fails `CC_NO_SESSION`;
      // this one is the question a caller asks precisely BECAUSE the session
      // stopped answering, and since a dead subprocess now closes its own
      // session, "no such session" would be a lie about a session the caller
      // was handed the id of moments earlier. The seam keeps a bounded
      // tombstone for exactly this call (`CLOSED_SESSION_HISTORY`).
      const session = ctx.claudeCode.session(args.session_id as CcSessionId)
      const snapshot = session?.snapshot() ?? ctx.claudeCode.get(args.session_id as CcSessionId)
      if (snapshot === undefined) throw noSuchSession(args.session_id)
      // Occupancy comes from the seam's own field when a future phase starts
      // reporting one, and otherwise from the last completed turn's usage —
      // the cheapest REAL source (see `projectContextUsage`). It stays ABSENT
      // rather than guessed when nothing has been reported yet. A tombstoned
      // session has no actor left to read a last result off, so it reports
      // whatever the final snapshot carried and nothing more.
      const contextUsage = snapshot.contextUsage === undefined
        ? projectContextUsage(session?.lastResult)
        : {
            used_tokens: snapshot.contextUsage.usedTokens,
            ...(snapshot.contextUsage.maxTokens === undefined
              ? {}
              : { max_tokens: snapshot.contextUsage.maxTokens }),
          }
      return await Promise.resolve({
        status: snapshot.status,
        ...(snapshot.closeReason === undefined ? {} : { close_reason: snapshot.closeReason }),
        pending_asks: snapshot.pendingAsks,
        ...(contextUsage === undefined ? {} : { context_usage: contextUsage }),
      })
    },
    presentCall: args => genericCall(`Claude Code session ${args.session_id} status`),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_cancel',
    description: 'Cancel an in-flight turn on an open Claude Code session. `keep_queued` defaults to true: messages '
      + 'already queued behind the cancelled turn still run. Pass `keep_queued: false` to suppress them too — a '
      + 'dsh-side rule this integration enforces on top of the cancel, not a Claude Code CLI feature; it is never '
      + "persisted to the session's own settings. Returns the ids of any sends that stayed queued.",
    parameters: {
      session_id: { type: 'string', required: true, description: 'The Claude Code session id to cancel.' },
      keep_queued: {
        type: 'boolean',
        description: 'Keep queued follow-up sends (default true); false additionally suppresses them.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          still_queued: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Ids of queued follow-up sends that remain queued after this cancel.',
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.still_queued.length > 0
          ? `cancelled session ${args.session_id}; still queued: ${value.still_queued.join(', ')}`
          : `cancelled session ${args.session_id}`,
      } satisfies ContentBlock],
    },
    async execute(args) {
      const session = requireSession(ctx, args.session_id)
      // The uuids come from the interrupt receipt, reconciled against the
      // session's own outbox: unknown uuids (cron triggers, auto-resume
      // continuations) are dropped rather than reported as ours.
      const outcome = await session.interrupt({ keepQueued: args.keep_queued ?? true })
      return { still_queued: [...outcome.stillQueued] }
    },
    presentCall: args => genericCall(`Cancel Claude Code session ${args.session_id}`),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_close',
    description: 'Close a Claude Code session: settle its pending asks as denied, then close the underlying SDK '
      + 'query. Idempotent — closing an already-closed or unknown session still returns `closed: true`.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'The Claude Code session id to close.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true, const: true },
        },
      },
      render: args => [{ type: 'text', text: `closed session ${args.session_id}` } satisfies ContentBlock],
    },
    async execute(args) {
      // Everything downstream of the close is already wired by the seam and the
      // jobs runtime: the mirror finalizes its open turn and detaches
      // (`ClaudeCodeService.mirror`), and a background session's job settles
      // through the same `onClose` its producer subscribed to. Closing an
      // unknown id is not an error — the model asked for a session to be gone,
      // and it is.
      await ctx.claudeCode.close(args.session_id as CcSessionId)
      return { closed: true as const }
    },
    presentCall: args => genericCall(`Close Claude Code session ${args.session_id}`),
  }))
}
