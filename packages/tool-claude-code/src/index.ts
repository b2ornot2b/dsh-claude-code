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
 * Every tool body in this file is a typed stub: `execute()` always rejects
 * with {@link ClaudeCodeError} `code: 'NOT_IMPLEMENTED'` naming Phase 5, the
 * phase that wires a real Claude Code session actor behind these six calls.
 * The schemas below ARE the lasting contract — Phase 5 fills in bodies, it
 * does not change shapes.
 *
 * @module @deepseek-ai/dsh-tool-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import {
  CC_PERMISSION_MODES,
  CC_SESSION_STATUSES,
  ClaudeCodeError,
} from '@deepseek-ai/dsh-claude-code'

export const name = 'tool-claude-code'
export const inject = ['tools', 'claudeCode']

/** Reserved for future tuning (e.g. gating background-mode advertisement); empty in Phase 1. */
export interface Config {}

/** Runtime configuration schema for the Claude Code tool plugin. */
export const Config: z<Config> = z.object({})

/** Every tool body is a stub until Phase 5 wires a real session actor behind `ctx.claudeCode`. */
function notImplemented(toolName: string): never {
  throw new ClaudeCodeError(
    `${toolName} is not implemented until Phase 5 (the Claude Code session actor); `
    + 'this schema is the final contract, only the execution body is deferred.',
    'NOT_IMPLEMENTED',
  )
}

/** Pure pending-call card shared by every tool below: a titled, category-iconed generic card. */
function genericCall(title: string, rawInput?: unknown): GenericCallView {
  return {
    card: 'generic',
    title,
    kind: 'execute',
    ...rawInput !== undefined ? { rawInput } : {},
  }
}

export function apply(ctx: Context, _config: Config = {}): void {
  const defaults = ctx.claudeCode.config.defaults

  ctx.tools.register(defineTool({
    name: 'claude_code_open',
    description: 'Open a new Claude Code session, or resume (optionally fork) an existing one, rooted at a working '
      + 'directory. Returns the session id immediately; omit `prompt` to open idle and send the first message with '
      + '`claude_code_send`. Set `background: true` to run detached as a dsh job instead of synchronously (requires '
      + 'a jobs runtime in this composition).',
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
          : `session ${value.session_id} (${value.status})`,
      } satisfies ContentBlock],
    },
    async execute() {
      return notImplemented('claude_code_open')
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
    async execute() {
      return notImplemented('claude_code_send')
    },
    presentCall: args => genericCall(`Send to Claude Code session ${args.session_id} (${args.mode})`, args.message),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_wait',
    description: 'Wait for an open Claude Code session to finish its current turn (or `timeout_ms` to elapse) and '
      + 'return its outcome: status, final text when the turn completed, and usage/cost when the SDK reported them.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'The Claude Code session id to wait on.' },
      timeout_ms: { type: 'number', description: 'Maximum time to wait, in milliseconds. Omit to wait indefinitely.' },
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
    async execute() {
      return notImplemented('claude_code_wait')
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
        text: `session ${args.session_id}: ${value.status}, ${value.pending_asks} pending ask(s)`
          + (value.context_usage !== undefined ? `, ${value.context_usage.used_tokens} tokens used` : ''),
      } satisfies ContentBlock],
    },
    async execute() {
      return notImplemented('claude_code_status')
    },
    presentCall: args => genericCall(`Claude Code session ${args.session_id} status`),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_cancel',
    description: 'Cancel an in-flight turn on an open Claude Code session. `keep_queued: false` (the default) '
      + 'additionally suppresses queued follow-up sends made through `claude_code_send` — a dsh-side rule this '
      + 'integration enforces on top of the cancel, not a Claude Code CLI feature; it is never persisted to the '
      + "session's own settings. Returns the ids of any sends that stayed queued.",
    parameters: {
      session_id: { type: 'string', required: true, description: 'The Claude Code session id to cancel.' },
      keep_queued: {
        type: 'boolean',
        description: 'Keep queued follow-up sends instead of suppressing them (default false: suppress).',
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
    async execute() {
      return notImplemented('claude_code_cancel')
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
    async execute() {
      return notImplemented('claude_code_close')
    },
    presentCall: args => genericCall(`Close Claude Code session ${args.session_id}`),
  }))
}
