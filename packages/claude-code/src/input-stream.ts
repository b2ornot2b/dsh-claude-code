/**
 * The session's input side: a pushable `AsyncIterable<CcSdkUserMessage>` that
 * **never completes** while the session lives.
 *
 * This is not a style choice. Streaming input mode is the only mode in which
 * `canUseTool`, `interrupt()`, `setModel()` and `setPermissionMode()` exist, and
 * the moment the iterable completes the SDK closes the subprocess's stdin —
 * after a ~2s grace the process exits and every in-flight permission callback
 * becomes undeliverable. So {@link CcInputStream.end} is called from exactly one
 * place: {@link CcSession.close}.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { randomUUID } from 'node:crypto'

import type { CcSdkUserMessage, CcUuid } from './backend.ts'
import { ClaudeCodeError } from './types.ts'

/**
 * What a caller hands to {@link CcInputStream.push}: the message text plus the
 * few envelope fields this integration sets. Everything else (`type`,
 * `session_id`, the Anthropic message body) is built here so no caller can push
 * a malformed message, and `uuid` is stamped when omitted so interrupt-receipt
 * reconciliation always has a key (gotcha 3).
 */
export interface CcUserMessageInit {
  /** The message text. Content blocks (images, tool results) are deferred past Phase 2. */
  readonly content: string
  /** Reconciliation key. Minted when omitted — supply one only to replay a known id. */
  readonly uuid?: CcUuid
  /** Tool-use parent for subagent-addressed messages. Defaults to `null` (main thread). */
  readonly parentToolUseId?: string | null
  /** Session id stamped on the envelope. Defaults to `''`, which the CLI fills in. */
  readonly sessionId?: string
  /** `'now'` aborts and refolds the running turn (the steer path, spike 2). */
  readonly priority?: 'now' | 'next' | 'later'
  /** `false` appends to the transcript without starting a turn (the inject path, delta S7). */
  readonly shouldQuery?: boolean
}

/** The pushable, never-completing input stream handed to the SDK as `prompt`. */
export interface CcInputStream extends AsyncIterable<CcSdkUserMessage> {
  /**
   * Enqueue one user message.
   * @param init - message text plus envelope options.
   * @returns the uuid the message was stamped with (minted when not supplied).
   * @throws {ClaudeCodeError} code `SESSION_CLOSED` when the stream has ended.
   */
  push(init: CcUserMessageInit): CcUuid
  /**
   * Complete the iterable. Idempotent, and called ONLY from session disposal —
   * ending it early kills the permission-callback channel.
   */
  end(): void
  /** Whether {@link CcInputStream.end} has been called. */
  readonly ended: boolean
  /** Messages enqueued but not yet handed to the SDK. Diagnostics only. */
  readonly pending: number
}

/**
 * Build a fresh input stream.
 *
 * Backpressure-free by design (queue + single resolver, the shape every Phase 0
 * probe used): the SDK consumes as fast as it can and a send never blocks the
 * caller. A Claude Code session's inbound traffic is human/agent-paced, so an
 * unbounded queue is the right trade — and messages are individually
 * cancellable through the interrupt receipt anyway.
 *
 * @returns a stream that yields every pushed message exactly once and never
 *   completes until {@link CcInputStream.end} is called.
 */
export function createInputStream(): CcInputStream {
  const queue: CcSdkUserMessage[] = []
  let ended = false
  /** Resolved whenever the queue gains an item or the stream ends. */
  let wake: (() => void) | undefined
  let waiting: Promise<void> = new Promise<void>(resolve => { wake = resolve })

  /** Release the consumer and arm the next wait. */
  function signal(): void {
    const resolve = wake
    waiting = new Promise<void>(next => { wake = next })
    resolve?.()
  }

  return {
    get ended(): boolean {
      return ended
    },
    get pending(): number {
      return queue.length
    },
    push(init: CcUserMessageInit): CcUuid {
      if (ended) {
        throw new ClaudeCodeError(
          'claude-code: cannot send on a closed session (the input stream has ended)',
          'SESSION_CLOSED')
      }
      const uuid = init.uuid ?? randomUUID()
      queue.push({
        type: 'user',
        message: { role: 'user', content: init.content },
        parent_tool_use_id: init.parentToolUseId ?? null,
        session_id: init.sessionId ?? '',
        uuid,
        ...(init.priority === undefined ? {} : { priority: init.priority }),
        ...(init.shouldQuery === undefined ? {} : { shouldQuery: init.shouldQuery }),
      })
      signal()
      return uuid
    },
    end(): void {
      if (ended) return
      ended = true
      signal()
    },
    async *[Symbol.asyncIterator](): AsyncIterator<CcSdkUserMessage> {
      for (;;) {
        // Drain everything already queued before parking. `shift()` under
        // `noUncheckedIndexedAccess` returns `T | undefined`; the length check
        // is what makes the non-null assertion unnecessary.
        while (queue.length > 0) {
          const next = queue.shift()
          if (next !== undefined) yield next
        }
        if (ended) return
        await waiting
      }
    },
  }
}
