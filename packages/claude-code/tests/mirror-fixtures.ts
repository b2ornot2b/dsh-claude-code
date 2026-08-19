/**
 * Ground-truth Claude Code message shapes for the mirror's unit tests.
 *
 * Every shape here is transcribed from a RECORDED session, not invented:
 * `spikes/partial-messages/run1.log` (spike 6) for the partial-message envelope
 * and its `content_block_*` / `message_*` events, and the SDK's own type
 * declarations for the tool-use, tool-result and compaction variants.
 *
 * Not a spec file: `vitest` collects `*.spec.ts` only, while
 * `tsconfig.tests.json` still type-checks this module.
 */

import type { CcMessageEnvelope, CcSdkMessage, CcSessionId, CcUuid } from '@deepseek-ai/dsh-claude-code'
import { SessionId } from '@deepseek-ai/dsh-session'

/** The session id every fixture claims to come from. */
export const FIXTURE_SESSION: CcSessionId = SessionId('11111111-2222-4333-8444-555555555555')

/** A uuid in the shape the SDK's `uuid` fields demand. */
export const FIXTURE_UUID = '99999999-8888-4777-8666-555555555555' as CcUuid

/**
 * Wrap one raw SDK message in the seam's fan-out envelope.
 * @param message - the raw message.
 * @param meta - metadata overrides (`interruptArtifact`, `interruptedTurn`, `reinit`).
 * @returns the envelope the mirror consumes.
 */
export function envelope(
  message: CcSdkMessage,
  meta: Partial<CcMessageEnvelope['meta']> = {},
): CcMessageEnvelope {
  return {
    message,
    meta: {
      sessionId: FIXTURE_SESSION,
      receivedAt: 1_700_000_000_000,
      interruptArtifact: false,
      interruptedTurn: false,
      reinit: false,
      ...meta,
    },
  }
}

/**
 * A `stream_event` message.
 * @param event - the raw Anthropic stream event.
 * @param parentToolUseId - subagent parent, or null for main-thread traffic.
 * @returns the SDK message.
 */
export function streamEvent(event: Record<string, unknown>, parentToolUseId: string | null = null): CcSdkMessage {
  return { type: 'stream_event', event, parent_tool_use_id: parentToolUseId, session_id: FIXTURE_SESSION }
}

/**
 * The `message_start` event that opens one model call.
 * @param overrides - `id`, `model` and `usage` overrides.
 * @returns the SDK message.
 */
export function messageStart(overrides: { id?: string, model?: string } = {}): CcSdkMessage {
  return streamEvent({
    type: 'message_start',
    message: {
      id: overrides.id ?? 'msg_011Ce8gmjWZRoiEDtCGReRAp',
      model: overrides.model ?? 'claude-haiku-4-5-20251001',
      type: 'message',
      role: 'assistant',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, cache_creation_input_tokens: 2780, cache_read_input_tokens: 15830, output_tokens: 1 },
    },
  })
}

/**
 * A `content_block_start` event.
 * @param index - the provider block index.
 * @param block - the block descriptor (`{ type: 'text' | 'thinking' | 'tool_use', … }`).
 * @param parentToolUseId - subagent parent, when nested.
 * @returns the SDK message.
 */
export function blockStart(
  index: number,
  block: Record<string, unknown>,
  parentToolUseId: string | null = null,
): CcSdkMessage {
  return streamEvent({ type: 'content_block_start', index, content_block: block }, parentToolUseId)
}

/**
 * A `content_block_delta` event.
 * @param index - the provider block index.
 * @param delta - the delta payload.
 * @param parentToolUseId - subagent parent, when nested.
 * @returns the SDK message.
 */
export function blockDelta(
  index: number,
  delta: Record<string, unknown>,
  parentToolUseId: string | null = null,
): CcSdkMessage {
  return streamEvent({ type: 'content_block_delta', index, delta }, parentToolUseId)
}

/**
 * A `content_block_stop` event.
 * @param index - the provider block index.
 * @param parentToolUseId - subagent parent, when nested.
 * @returns the SDK message.
 */
export function blockStop(index: number, parentToolUseId: string | null = null): CcSdkMessage {
  return streamEvent({ type: 'content_block_stop', index }, parentToolUseId)
}

/**
 * The `message_delta` + `message_stop` pair that ends one model call.
 * @param stopReason - the provider stop reason.
 * @returns the two SDK messages, in order.
 */
export function messageEnd(stopReason = 'end_turn'): CcSdkMessage[] {
  return [
    streamEvent({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2780,
        cache_read_input_tokens: 15830,
        output_tokens: 100,
        output_tokens_details: { thinking_tokens: 59 },
      },
    }),
    streamEvent({ type: 'message_stop' }),
  ]
}

/**
 * An `SDKAssistantMessage` checkpoint — one per COMPLETED block, all sharing
 * the same `message.id` (spike 6, surprise 1).
 * @param content - the completed blocks this checkpoint reports.
 * @param parentToolUseId - subagent parent, when nested.
 * @returns the SDK message.
 */
export function assistantCheckpoint(
  content: Record<string, unknown>[],
  parentToolUseId: string | null = null,
): CcSdkMessage {
  return {
    type: 'assistant',
    message: { id: 'msg_011Ce8gmjWZRoiEDtCGReRAp', role: 'assistant', content },
    parent_tool_use_id: parentToolUseId,
    session_id: FIXTURE_SESSION,
  }
}

/**
 * A user-role SDK message carrying tool results.
 * @param content - the `tool_result` blocks.
 * @param parentToolUseId - subagent parent, when nested.
 * @returns the SDK message.
 */
export function toolResultMessage(
  content: Record<string, unknown>[],
  parentToolUseId: string | null = null,
): CcSdkMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: parentToolUseId,
    session_id: FIXTURE_SESSION,
  }
}

/**
 * An `SDKResultMessage`.
 * @param subtype - `'success'`, `'error_during_execution'`, …
 * @param extra - extra fields (`result`, `is_error`, …).
 * @returns the SDK message.
 */
export function result(subtype = 'success', extra: Record<string, unknown> = {}): CcSdkMessage {
  return { type: 'result', subtype, result: 'done', session_id: FIXTURE_SESSION, ...extra }
}

/**
 * A `system/init` message.
 * @param extra - extra fields (`model`, `capabilities`, …).
 * @returns the SDK message.
 */
export function systemInit(extra: Record<string, unknown> = {}): CcSdkMessage {
  return {
    type: 'system',
    subtype: 'init',
    model: 'claude-haiku-4-5-20251001',
    capabilities: ['interrupt_receipt_v1'],
    session_id: FIXTURE_SESSION,
    ...extra,
  }
}

/**
 * An `SDKCompactBoundaryMessage`.
 * @param trigger - `'manual'` or `'auto'`.
 * @param preTokens - context tokens before compaction.
 * @returns the SDK message.
 */
export function compactBoundary(trigger = 'auto', preTokens = 154_000): CcSdkMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: FIXTURE_UUID,
    session_id: FIXTURE_SESSION,
    compact_metadata: { trigger, pre_tokens: preTokens },
  }
}

/**
 * The complete haiku transcript recorded in spike 6: a thinking block, then a
 * text block, then the turn result.
 * @returns the SDK messages in recorded order.
 */
export function haikuTranscript(): CcSdkMessage[] {
  return [
    systemInit(),
    messageStart(),
    blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
    blockDelta(0, { type: 'thinking_delta', thinking: 'The user is asking' }),
    blockDelta(0, { type: 'thinking_delta', thinking: ' me to write two sentences.' }),
    blockDelta(0, { type: 'signature_delta', signature: 'Eu4DCpMBCBAYAipATKML' }),
    assistantCheckpoint([{ type: 'thinking', thinking: 'The user is asking me to write two sentences.', signature: 'Eu4D' }]),
    blockStop(0),
    blockStart(1, { type: 'text', text: '' }),
    blockDelta(1, { type: 'text_delta', text: 'The sky stretched endlessly above,' }),
    blockDelta(1, { type: 'text_delta', text: ' painted in shades of blue.' }),
    assistantCheckpoint([{ type: 'text', text: 'The sky stretched endlessly above, painted in shades of blue.' }]),
    blockStop(1),
    ...messageEnd(),
    result('success', { result: 'The sky stretched endlessly above, painted in shades of blue.' }),
  ]
}
