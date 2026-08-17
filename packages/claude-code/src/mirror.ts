/**
 * The mirror: Claude Code's message stream, projected into a dsh session log.
 *
 * **THE MIRROR IS NOT A SOURCE OF TRUTH** (spec §5.1). Claude Code owns its own
 * history and compacts it independently, so dsh's usual invariant — everything
 * the model saw is rebuildable from the log — does NOT hold for a CC-backed
 * session. Never drive a CC request from `deriveMessages()`.
 *
 * The mirror is therefore strictly **write-only into dsh**. Its view of the
 * session is {@link CcMirrorSource}: two subscribe functions and nothing else —
 * no `send`, no `interrupt`, no `close`, no cordis context and no waterfall
 * listeners. That is a structural proof, not a promise: the mirror could not
 * drive Claude Code if it wanted to.
 *
 * Facts this file is built on (Phase 0 spikes, delta D9, review §3 gotcha 13):
 *
 * - **`SDKAssistantMessage` is a per-block CHECKPOINT** (spike 6): it arrives
 *   several times per turn with the same `message.id`, once per completed
 *   block. Content is accumulated from `stream_event`s; the checkpoint is used
 *   only as a checksum (and as the fallback source for a subagent's tool calls).
 * - **The SDK message union is ~38 variants and grows** (delta S5): every
 *   unknown kind is counted and ignored. This file NEVER throws on a message it
 *   does not know, and never `assertNever`s a dsh session event either.
 * - **Reasoning is a chunk DISCRIMINANT, not a flag** (D9): thinking maps to
 *   `block-start { blockType: 'reasoning' }` + `reasoning-delta`.
 * - **Every payload is lossless JSON** — `Session.append` runtime-validates
 *   with `isJsonValue` and rejects anything else at the append site.
 * - **A steer's abort result is an internal artifact** (spike 2): suppressed
 *   entirely, because the refolded turn is still coming, and **the partial model
 *   call it interrupted is discarded, not flushed** (Stage 2's recorded `steer`
 *   fixture): the refold starts a brand new `message_start` rather than
 *   continuing the aborted stream, so the interrupted call's step is closed with
 *   no `assistant/message` of its own — its content is about to be re-streamed.
 * - **An explicit `interrupt()` is the opposite case**: nothing is re-streamed,
 *   so its abort result closes the turn as `aborted` and the killed call keeps
 *   the text it had already produced ({@link CcMirror.salvageOpenBlocks}).
 *
 * ### Turn framing (§5.2), and how it approximates dsh
 *
 * CC's notion of a turn is coarser than dsh's step loop. One CC turn is one dsh
 * turn; each MODEL CALL inside it is one dsh step, framed exactly where dsh
 * frames its own: `step/start` … `assistant/message` … `tool/call`* …
 * `tool/result`* … `step/end`. A new model call (`message_start`) closes the
 * previous step and opens the next, which is what keeps every `tool/result`
 * inside the step that requested it — dsh's session invariants reject a result
 * whose call is not pending in the open step.
 *
 * Three framing rules are not in the spec's table because they only show up
 * once real orderings are replayed through it:
 *
 * - A `followup` sent while a turn is open is QUEUED by CC and runs as its own
 *   later turn, so its `user/message` is deferred to that turn's `turn/start`
 *   ({@link CcMirror.recordSend}). A `steer` is not: it refolds into the open
 *   turn, which is where it is recorded.
 * - A model call killed mid-block still owes the assembled message its
 *   already-streamed text ({@link CcMirror.salvageOpenBlocks}); a call that
 *   produced nothing at all gets NO `assistant/message`, because an
 *   empty-content assistant message is not a valid provider message.
 * - A session that dies mid-turn leaves a turn nothing will ever close;
 *   {@link CcMirror.finalize} closes it as `aborted`/`disposed`, and the
 *   service calls it when the Claude Code session closes.
 *
 * ### What is deliberately NOT mirrored
 *
 * - `request/header` — the CC subprocess never discloses the request config it
 *   actually used. A synthesized header would poison `foldRequestHeader()` for
 *   every later reader, so the mirror writes none.
 * - Text of user-role SDK messages — user prompts are recorded from the send
 *   side ({@link CcMirrorSource.onSend}), so mirroring an echo would duplicate
 *   them. User-role messages contribute their `tool_result` blocks only.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { CallId } from '@deepseek-ai/dsh-llm/brand'
import {
  boundContextSummary, createAssistantMessage, createToolResultMessage, createUserMessage,
} from '@deepseek-ai/dsh-llm/message'
import type { UserMessage } from '@deepseek-ai/dsh-llm/message'
import type {
  ContentBlock, ContentBlockType, StreamChunk, TokenUsage, ToolCallBlock,
} from '@deepseek-ai/dsh-llm/types'
import type { Session as DshSession } from '@deepseek-ai/dsh-session'
import type {
  JsonValue, SessionEvent, SessionEventMap, SessionEventType, SurfaceEventType, SurfaceIntent,
  TodoItem, TurnEndReason,
} from '@deepseek-ai/dsh-session/types'

import type { CcMessageEnvelope, CcSendRecord } from './session.ts'
import type { CcLogger } from './types.ts'

/**
 * The Claude Code compaction boundary, as a dsh session event.
 *
 * Declaration-merged into dsh's `SessionEventMap` (D9: a custom event must be
 * merged, must carry a lossless-JSON payload, and SHOULD be marked `ignorable`
 * on the envelope). See {@link CC_COMPACT_EVENT} for the marker caveat that
 * rc.7's `Session.append()` forces on every out-of-tree writer.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Claude Code compacted its own transcript. Log-only and purely
     * informational: the dsh mirror's surface is NOT rewritten, because the
     * mirror never was the source of truth for CC's context (spec §5.1/§8.1).
     */
    'claude-code/compact': CcCompactEventData
  }
}

/**
 * The `claude-code/compact` event type name — the single source of the string.
 *
 * **What an out-of-tree custom event owes a reader** (D9). A session log may
 * travel to a runtime that never heard of this package, so a custom event must:
 *
 * 1. be declaration-merged into `SessionEventMap` (done above) so every writer
 *    in THIS build is type-checked against its payload;
 * 2. carry a strictly lossless-JSON payload — `Session.append` validates with
 *    `isJsonValue` and rejects anything else at the append site;
 * 3. carry `ignorable: true` on its ENVELOPE, because a persistence read path
 *    refuses to reconstruct a log containing a type outside its own
 *    `KNOWN_SESSION_EVENT_TYPES` unless the writer marked the event skippable
 *    (`packages/core/session/src/known-event-types.ts:8-18`). Refusing is the
 *    correct default: an unrecognized REQUIRED event may change how the rest of
 *    the log is read.
 *
 * **Point 3 cannot be satisfied through rc.7's public API.** `Session.append()`
 * builds the envelope itself (`{ type, seq, time, data, …surface }`) and
 * deep-freezes it; it accepts no `ignorable` flag and exposes no other channel.
 * So a live-appended `claude-code/compact` is a *required* event in every log it
 * lands in, and a stock harness build reading that log will refuse it.
 *
 * Two mitigations, both shipped:
 *
 * - {@link CcMirrorOptions.compaction} `'skip'` — never write the event, for a
 *   log that must stay portable to a stock build.
 * - {@link markEventIgnorable} — stamp the marker on the seed/restore boundary,
 *   the one place envelopes ARE caller-supplied (`SessionStore.prepare` with
 *   `seedSource: 'persistence'`).
 *
 * The real fix is upstream: `append(type, data, { ignorable: true })`. Tracked
 * in the README's deferred-work list.
 */
export const CC_COMPACT_EVENT = 'claude-code/compact'

/**
 * Payload of {@link CC_COMPACT_EVENT}. Every field is a JSON scalar so the
 * event round-trips losslessly through any persistence backend.
 */
export interface CcCompactEventData {
  /** Why CC compacted (`'manual'`, `'auto'`, …), or `null` when it did not say. */
  trigger: string | null
  /** Context tokens occupied before compaction, or `null` when not reported. */
  preTokens: number | null
  /** The CC message uuid of the boundary, for correlation with the CLI transcript. */
  uuid: string | null
  /** The dsh turn that was open when the boundary arrived, or `null` between turns. */
  turn: number | null
}

/** How the mirror treats Claude Code's compaction boundaries. */
export type CcCompactionMode =
  /** Append {@link CC_COMPACT_EVENT} (the default). */
  | 'append'
  /** Skip it — for a log that must stay readable by a stock harness build (see {@link CC_COMPACT_EVENT}). */
  | 'skip'

/** Options for {@link CcMirror} / {@link attachMirror}. */
export interface CcMirrorOptions {
  /**
   * Also mirror the TEXT of subagent (`parent_tool_use_id !== null`) traffic.
   * Off by default: only a subagent's `tool_use`/`tool_result` pairs are
   * mirrored, which is what the ask channel (Phase 4) and the transcript need.
   *
   * Known loss when on: dsh's `assistant/chunk` payload is the closed
   * `StreamChunk` union and `tool/call` has no free field, so
   * `parent_tool_use_id` CANNOT be carried on either — nested text appears
   * inline in the parent's step. Only `tool/result` can carry it (in the
   * event's tool-private `meta`).
   */
  readonly forwardSubagentText?: boolean
  /** What to do with CC compaction boundaries. Defaults to `'append'`. */
  readonly compaction?: CcCompactionMode
  /** Provider name stamped on every mirrored assistant message. Defaults to `'claude-code'`. */
  readonly provider?: string
  /** Diagnostics sink for ignored messages and checksum mismatches. */
  readonly logger?: CcLogger
}

/** What the mirror ignored, and how often. Keys are stable diagnostic slugs. */
export type CcMirrorIgnoreCounts = Readonly<Record<string, number>>

/** The mirror's own accounting — the debug counter D9 asks for, made public. */
export interface CcMirrorStats {
  /** Events appended to the dsh session. */
  readonly appended: number
  /** Ignored inputs by reason. A growing `message:*` count is normal, not a defect. */
  readonly ignored: CcMirrorIgnoreCounts
  /**
   * How often an `SDKAssistantMessage` checkpoint disagreed with the text
   * accumulated from stream events. Non-zero means the SDK changed its
   * partial-message contract — investigate, do not paper over.
   */
  readonly checksumMismatches: number
}

/**
 * The mirror's ENTIRE view of a Claude Code session: two subscriptions.
 *
 * `CcSession` satisfies it structurally. Nothing here can drive CC, which is
 * how "the mirror is write-only" is enforced rather than merely documented.
 */
export interface CcMirrorSource {
  /**
   * Subscribe to every message the session produces.
   * @param listener - called per message, in arrival order.
   * @returns an unsubscribe function.
   */
  onMessage(listener: (envelope: CcMessageEnvelope) => void): () => void
  /**
   * Subscribe to every message the session SENDS (user prompts never come back
   * over `onMessage`, so this is where `user/message` framing comes from).
   * @param listener - called per send, in send order.
   * @returns an unsubscribe function.
   */
  onSend(listener: (send: CcSendRecord) => void): () => void
}

/** A live mirror attachment. */
export interface CcMirrorHandle {
  /** The mirror itself — Phase 4 reads {@link CcMirror.callIdFor} off it. */
  readonly mirror: CcMirror
  /**
   * Unsubscribe from the session. Idempotent; appends nothing.
   *
   * Detaching does NOT close a turn that is still open — call
   * {@link CcMirror.finalize} for that, which is what
   * `ClaudeCodeService` does when the mirrored session closes.
   */
  dispose(): void
}

/** One content block being accumulated from stream events. */
interface BlockState {
  /** The provider block index (stable within one model call). */
  readonly index: number
  /** The dsh block type this maps to. */
  readonly blockType: ContentBlockType
  /** Accumulated `text_delta` / `thinking_delta` text. */
  text: string
  /** Accumulated `input_json_delta` fragments for a tool call. */
  argumentsJson: string
  /** CC's `tool_use` id, when this is a tool call. */
  toolUseId?: string
  /** Tool name, when this is a tool call. */
  toolName?: string
  /** Whether the tool-call name has been announced on a delta already. */
  nameAnnounced: boolean
}

/** One model call inside a CC turn — the unit that becomes one dsh step. */
interface ModelCall {
  /** Provider message id (`msg_…`), used to merge checkpoints. */
  messageId?: string
  /** Model that produced it, as the provider reported it. */
  model?: string
  /** Seqs of every `assistant/chunk` appended for this call. */
  readonly chunkSeqs: number[]
  /** Blocks still streaming, by provider index. */
  readonly open: Map<number, BlockState>
  /** Completed blocks with their provider index, flushed in index order. */
  readonly done: { index: number, block: ContentBlock }[]
  /** Latest usage the provider reported for this call. */
  usage?: TokenUsage
  /** Provider stop reason from `message_delta`, when the call reached one. */
  stopReason?: string
  /** Whether anything was appended for this call yet. */
  touched: boolean
}

/** A tool call awaiting its result inside the open step. */
interface PendingCall {
  /** The dsh call id. */
  readonly callId: CallId
  /** The step the call was appended in — a result outside it is dropped. */
  readonly step: number
}

/** Default provider name stamped on mirrored assistant messages. */
const DEFAULT_PROVIDER = 'claude-code'

/** Model name used when the SDK never disclosed one. */
const UNKNOWN_MODEL = 'unknown'

/**
 * Projects one Claude Code session onto one dsh {@link DshSession}.
 *
 * Construct it with the target dsh session, then feed it: {@link CcMirror.observe}
 * for SDK messages and {@link CcMirror.recordSend} for outgoing prompts.
 * {@link attachMirror} wires both to a live `CcSession` in one call.
 *
 * The mirror is resilient by construction: an input it does not understand is
 * counted in {@link CcMirror.stats} and dropped. It never throws at the pump.
 */
export class CcMirror {
  readonly #session: DshSession
  readonly #options: CcMirrorOptions
  readonly #provider: string
  readonly #logger: CcLogger | undefined

  /** cc `tool_use` id → dsh {@link CallId}. Phase 4's ask router reads this. */
  readonly #callIds = new Map<string, CallId>()
  /** The reverse index, so a decision carrying a dsh call id can name the cc tool. */
  readonly #toolUseIds = new Map<string, string>()
  /** Calls appended in the current step and not yet resulted. */
  readonly #pending = new Map<string, PendingCall>()
  /**
   * `followup` prompts sent while a turn was already open. Claude Code queues
   * them; they become the NEXT turn, so their `user/message` waits for its
   * `turn/start` (see {@link CcMirror.recordSend}).
   */
  readonly #deferred: CcSendRecord[] = []

  #openTurn: number | undefined
  #openStep: number | undefined
  #nextTurn = 1
  #nextStep = 1
  #call: ModelCall | undefined
  /** Model reported by the latest `system/init`, used when a stream event omits it. */
  #sessionModel: string | undefined
  #appended = 0
  #checksumMismatches = 0
  readonly #ignored = new Map<string, number>()

  /**
   * @param session - the dsh session to append to. It may already hold events
   *   (a resumed or forked log): turn and step numbering continues from them.
   * @param options - subagent policy, compaction policy, provider name, logger.
   */
  constructor(session: DshSession, options: CcMirrorOptions = {}) {
    this.#session = session
    this.#options = options
    this.#provider = options.provider ?? DEFAULT_PROVIDER
    this.#logger = options.logger
    this.foldExistingFraming()
  }

  /** Whether a dsh turn is currently open. False after every result. */
  get hasOpenTurn(): boolean {
    return this.#openTurn !== undefined
  }

  /** The open turn number, or undefined between turns. */
  get openTurn(): number | undefined {
    return this.#openTurn
  }

  /** The open step number, or undefined outside a step. */
  get openStep(): number | undefined {
    return this.#openStep
  }

  /**
   * The `tool_use` id → {@link CallId} table, exposed for Phase 4: the ask
   * router receives CC's `toolUseID` and needs the dsh call id to correlate an
   * `approval/asked` event with the `tool/call` already in the log.
   */
  get callIds(): ReadonlyMap<string, CallId> {
    return this.#callIds
  }

  /**
   * Look up (or mint) the dsh call id for one CC `tool_use` id. Minting here is
   * deliberate: the ask channel may see a permission request BEFORE the
   * `tool_use` block finishes streaming, and both paths must agree on the id.
   * @param toolUseId - CC's `tool_use` block id.
   * @returns the stable dsh call id for it.
   */
  callIdFor(toolUseId: string): CallId {
    const existing = this.#callIds.get(toolUseId)
    if (existing !== undefined) return existing
    // Identity mapping: CC's tool_use ids are already unique per session, so
    // branding the same string keeps the mapping stable, reversible, and
    // readable in a transcript. The map still exists because the correlation is
    // a contract, not an implementation detail.
    const callId = CallId(toolUseId)
    this.#callIds.set(toolUseId, callId)
    this.#toolUseIds.set(callId, toolUseId)
    return callId
  }

  /**
   * The reverse correlation.
   * @param callId - a dsh call id previously minted here.
   * @returns the CC `tool_use` id, or undefined when this mirror never saw it.
   */
  toolUseIdFor(callId: CallId): string | undefined {
    return this.#toolUseIds.get(callId)
  }

  /** What was appended, and what was ignored. */
  get stats(): CcMirrorStats {
    return {
      appended: this.#appended,
      ignored: Object.fromEntries(this.#ignored),
      checksumMismatches: this.#checksumMismatches,
    }
  }

  /**
   * Record one outgoing user message (§5.2: a send opens the turn).
   *
   * Three modes, three framings, each matching what Claude Code actually does
   * with the message:
   *
   * - `inject` (`shouldQuery: false`) appends transcript context and starts no
   *   turn, so it opens none here either — matching dsh's `inject()` semantics.
   * - `steer` (`priority: 'now'`) aborts the running turn and REFOLDS both
   *   instructions into it, so it belongs to the turn that is already open.
   * - `followup` sent while a turn is open QUEUES: it runs as its own later turn
   *   (spike 2), so its `user/message` is DEFERRED to that turn's `turn/start`.
   *   Appending it immediately would put the prompt before the answer to the
   *   PREVIOUS prompt in `deriveMessages()` — a transcript that reads as though
   *   the model answered a question it had not been asked yet.
   *
   * @param send - what the session sent.
   * @returns nothing.
   */
  recordSend(send: CcSendRecord): void {
    this.guard('recordSend', () => {
      if (send.mode === 'inject') {
        this.append('user/message', this.userMessage(send), { surfaceOp: 'append' })
        return
      }
      if (send.mode === 'followup' && this.#openTurn !== undefined) {
        this.#deferred.push(send)
        return
      }
      if (this.#openTurn === undefined) this.startTurn()
      this.append('user/message', this.userMessage(send), { surfaceOp: 'append' })
    })
  }

  /**
   * Close a turn that will never get its result, because the Claude Code
   * session it mirrors has gone away (an explicit close, a dead subprocess, a
   * disposed fiber).
   *
   * Left dangling, an open `turn/start` makes the log permanently unappendable:
   * dsh refuses a second open turn, so nothing — not a re-attached mirror, not a
   * Phase 6 agent — could ever write to that session again. dsh's own crash
   * repair (`interruptedTurnClosers`) closes such a tail on RELOAD, but a live
   * in-memory session never reaches a reload, and this seam knows something the
   * repair path has to guess: the turn was cut short by disposal.
   *
   * Idempotent, and appends nothing when no turn is open. Any `followup` still
   * deferred is flushed afterwards (outside a turn, which the log permits) so
   * that a prompt the session accepted is never silently absent.
   *
   * @returns nothing.
   */
  finalize(): void {
    this.guard('finalize', () => {
      this.flushModelCall()
      const turn = this.#openTurn
      if (turn !== undefined) {
        this.closeStep()
        this.append('turn/end', { turn, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
        this.#openTurn = undefined
        this.#nextTurn = turn + 1
        this.#pending.clear()
      }
      this.flushDeferredSends()
    })
  }

  /**
   * Build the dsh `user/message` payload for one send.
   * @param send - what the session sent.
   * @returns the user message.
   */
  private userMessage(send: CcSendRecord): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text: send.content }],
      source: send.mode === 'inject'
        // An inject is a one-off account of something that just happened —
        // `notice` is exactly that form, and it REQUIRES a bounded summary.
        ? { kind: 'plugin', plugin: 'dsh-claude-code', form: 'notice', summary: boundContextSummary(send.content) }
        : { kind: 'plugin', plugin: 'dsh-claude-code' },
    })
  }

  /**
   * Append every deferred `followup` prompt, oldest first — at the `turn/start`
   * of the turn those prompts are what CC is running, or at
   * {@link CcMirror.finalize} for prompts no turn ever ran.
   * @returns nothing.
   */
  private flushDeferredSends(): void {
    if (this.#deferred.length === 0) return
    const pending = this.#deferred.splice(0, this.#deferred.length)
    for (const send of pending) {
      this.append('user/message', this.userMessage(send), { surfaceOp: 'append' })
    }
  }

  /**
   * Project one SDK message into the dsh log.
   *
   * Total by construction: an unknown message kind, a malformed payload, or an
   * event arriving outside any turn is counted and dropped. The pump must never
   * be stalled by the mirror.
   *
   * @param envelope - the message plus the seam's interpretation of it.
   * @returns nothing.
   */
  observe(envelope: CcMessageEnvelope): void {
    this.guard('observe', () => { this.dispatch(envelope) })
  }

  /**
   * Route one envelope to its handler.
   * @param envelope - the message plus its metadata.
   * @returns nothing.
   */
  private dispatch(envelope: CcMessageEnvelope): void {
    const { message, meta } = envelope
    // A steer's abort result is an internal artifact of the refold (spike 2):
    // the turn is NOT over, so the result itself writes nothing. But the
    // partial model call it aborted must not survive either: live traffic
    // (Stage 2's recorded `steer` fixture) shows the refold does NOT continue
    // streaming into the interrupted call — the CLI issues a BRAND NEW
    // `system/init` and `message_start` for the merged turn. Left in place,
    // the stale call would be flushed as a spurious near-empty
    // `assistant/message` (whatever blocks happened to fully close before the
    // abort — often none) the moment that next `message_start` arrives, one
    // dsh step earlier than the real, refolded content.
    if (meta.interruptArtifact) {
      this.discardInterruptedCall()
      this.ignore('result:interrupt-artifact')
      return
    }
    switch (message['type']) {
      case 'stream_event':
        this.onStreamEvent(message)
        return
      case 'assistant':
        this.onAssistantCheckpoint(message)
        return
      case 'user':
        this.onUserMessage(message)
        return
      case 'result':
        this.onResult(message, meta.interruptedTurn)
        return
      case 'system':
        this.onSystem(message)
        return
      default:
        // The SDK union is ~38 variants and grows every release (delta S5).
        this.ignore(`message:${String(message['type'])}`)
    }
  }

  // ---------------------------------------------------------------- content

  /**
   * Map one `stream_event` onto dsh `assistant/chunk` events (§5.3).
   * @param message - the `stream_event` SDK message.
   * @returns nothing.
   */
  private onStreamEvent(message: CcMessageEnvelope['message']): void {
    const raw = asRecord(message['event'])
    if (raw === undefined) {
      this.ignore('stream:malformed')
      return
    }
    const parent = asString(message['parent_tool_use_id'])
    if (parent !== undefined && this.#options.forwardSubagentText !== true) {
      // Subagent text is off by default; its tool calls still land, from the
      // subagent's own assistant checkpoints.
      this.ignore('stream:subagent-text')
      return
    }

    switch (raw['type']) {
      case 'message_start':
        this.beginModelCall(raw)
        return
      case 'content_block_start':
        this.onBlockStart(raw)
        return
      case 'content_block_delta':
        this.onBlockDelta(raw)
        return
      case 'content_block_stop':
        this.onBlockStop(raw)
        return
      case 'message_delta':
        this.onMessageDelta(raw)
        return
      case 'message_stop':
        this.flushModelCall()
        return
      default:
        this.ignore(`stream:${String(raw['type'])}`)
    }
  }

  /**
   * Start one model call: close the previous step and open the next.
   * @param raw - the `message_start` provider event.
   * @returns nothing.
   */
  private beginModelCall(raw: Record<string, unknown>): void {
    // A model call that never reached `message_stop` (a killed turn) still owes
    // its assembled message; flushing here keeps the step well-formed. Then the
    // step CLOSES: one dsh step is one model call, which is what keeps every
    // `tool/result` inside the step whose `tool/call` requested it.
    this.flushModelCall()
    this.closeStep()
    const envelope = asRecord(raw['message'])
    const call: ModelCall = { chunkSeqs: [], open: new Map(), done: [], touched: false }
    const messageId = asString(envelope?.['id'])
    if (messageId !== undefined) call.messageId = messageId
    const model = asString(envelope?.['model']) ?? this.#sessionModel
    if (model !== undefined) call.model = model
    const usage = readUsage(asRecord(envelope?.['usage']))
    if (usage !== undefined) call.usage = usage
    this.#call = call
    // The step opens lazily on the first chunk: a `message_start` that is
    // immediately aborted must not leave an empty step in the log.
  }

  /**
   * Open one content block and emit its `block-start` chunk.
   * @param raw - the `content_block_start` provider event.
   * @returns nothing.
   */
  private onBlockStart(raw: Record<string, unknown>): void {
    const index = asIndex(raw['index'])
    const block = asRecord(raw['content_block'])
    if (index === undefined || block === undefined) {
      this.ignore('stream:malformed')
      return
    }
    const blockType = mapBlockType(asString(block['type']))
    if (blockType === undefined) {
      this.ignore(`stream:block-type:${String(block['type'])}`)
      return
    }
    const call = this.currentCall()
    const state: BlockState = { index, blockType, text: '', argumentsJson: '', nameAnnounced: false }
    const toolUseId = asString(block['id'])
    const toolName = asString(block['name'])
    if (toolUseId !== undefined) state.toolUseId = toolUseId
    if (toolName !== undefined) state.toolName = toolName
    call.open.set(index, state)
    this.appendChunk({ type: 'block-start', index, blockType })
  }

  /**
   * Fold one delta into its block and emit the matching dsh chunk.
   * @param raw - the `content_block_delta` provider event.
   * @returns nothing.
   */
  private onBlockDelta(raw: Record<string, unknown>): void {
    const index = asIndex(raw['index'])
    const delta = asRecord(raw['delta'])
    if (index === undefined || delta === undefined) {
      this.ignore('stream:malformed')
      return
    }
    const state = this.currentCall().open.get(index)
    if (state === undefined) {
      this.ignore('stream:delta-without-block')
      return
    }
    switch (delta['type']) {
      case 'text_delta': {
        const text = asString(delta['text']) ?? ''
        state.text += text
        this.appendChunk({ type: 'text-delta', index, text })
        return
      }
      case 'thinking_delta': {
        const text = asString(delta['thinking']) ?? ''
        state.text += text
        this.appendChunk({ type: 'reasoning-delta', index, text })
        return
      }
      case 'input_json_delta': {
        const fragment = asString(delta['partial_json']) ?? ''
        state.argumentsJson += fragment
        const toolUseId = state.toolUseId
        if (toolUseId === undefined) {
          this.ignore('stream:tool-delta-without-id')
          return
        }
        const callId = this.callIdFor(toolUseId)
        const announce = !state.nameAnnounced && state.toolName !== undefined
        state.nameAnnounced ||= announce
        this.appendChunk({
          type: 'tool-call-delta',
          index,
          id: callId,
          ...(announce && state.toolName !== undefined ? { name: state.toolName } : {}),
          argumentsDelta: fragment,
        })
        return
      }
      case 'signature_delta': {
        // dsh's reasoning block carries text only; the signature is provider
        // replay metadata with nowhere to live (documented loss, D9).
        this.ignore('stream:signature-delta')
        return
      }
      default:
        this.ignore(`stream:delta:${String(delta['type'])}`)
    }
  }

  /**
   * Close one content block and emit its `block-end` chunk with the assembled block.
   * @param raw - the `content_block_stop` provider event.
   * @returns nothing.
   */
  private onBlockStop(raw: Record<string, unknown>): void {
    const index = asIndex(raw['index'])
    if (index === undefined) {
      this.ignore('stream:malformed')
      return
    }
    const call = this.currentCall()
    const state = call.open.get(index)
    if (state === undefined) {
      this.ignore('stream:stop-without-block')
      return
    }
    call.open.delete(index)
    const block = this.assembleBlock(state)
    if (block === undefined) return
    call.done.push({ index, block })
    this.appendChunk({ type: 'block-end', index, block })
  }

  /**
   * Fold the blocks of a killed model call that never reached
   * `content_block_stop` into its assembled message.
   *
   * A turn this seam interrupted (`meta.interruptedTurn` on a result, or a
   * `message_start` arriving before the previous call finished) leaves blocks
   * mid-stream. Their deltas are ALREADY in the log as `assistant/chunk`s, so
   * dropping them from the assembled message would put text on the surface that
   * the message contradicts. Text and reasoning are therefore salvaged.
   *
   * A tool call is NOT: its `arguments` never finished streaming, so the JSON is
   * truncated, and emitting `tool/call` for it would claim the seam issued a
   * call that Claude Code never ran (and leave it pending for a `tool/result`
   * that can never arrive).
   *
   * @param call - the model call being closed.
   * @returns nothing.
   */
  private salvageOpenBlocks(call: ModelCall): void {
    for (const state of [...call.open.values()].sort((left, right) => left.index - right.index)) {
      if (state.blockType === 'tool-call') {
        this.ignore('stream:incomplete-tool-call')
        continue
      }
      // An opened-but-empty block carries nothing; an empty text block in an
      // assistant message is rejected by real providers.
      if (state.text === '') {
        this.ignore('stream:empty-open-block')
        continue
      }
      const block = this.assembleBlock(state)
      if (block !== undefined) call.done.push({ index: state.index, block })
    }
    call.open.clear()
  }

  /**
   * Materialize one accumulated block as a dsh {@link ContentBlock}.
   * @param state - the accumulated block.
   * @returns the block, or undefined when it cannot be represented.
   */
  private assembleBlock(state: BlockState): ContentBlock | undefined {
    if (state.blockType === 'text') return { type: 'text', text: state.text }
    if (state.blockType === 'reasoning') return { type: 'reasoning', text: state.text }
    const toolUseId = state.toolUseId
    if (state.blockType === 'tool-call' && toolUseId !== undefined) {
      return {
        type: 'tool-call',
        id: this.callIdFor(toolUseId),
        name: state.toolName ?? 'unknown',
        // Raw JSON string exactly as the model produced it; an empty stream is
        // a no-argument call, which every provider spells `{}`.
        arguments: state.argumentsJson === '' ? '{}' : state.argumentsJson,
      }
    }
    this.ignore(`stream:unrepresentable-block:${state.blockType}`)
    return undefined
  }

  /**
   * Record end-of-call usage and emit dsh's `usage` chunk.
   * @param raw - the `message_delta` provider event.
   * @returns nothing.
   */
  private onMessageDelta(raw: Record<string, unknown>): void {
    const call = this.currentCall()
    const stopReason = asString(asRecord(raw['delta'])?.['stop_reason'])
    if (stopReason !== undefined) call.stopReason = stopReason
    const usage = readUsage(asRecord(raw['usage']))
    if (usage === undefined) {
      this.ignore('stream:message-delta-without-usage')
      return
    }
    call.usage = usage
    // dsh's contract: adapters emit usage BEFORE the terminal finish chunk.
    this.appendChunk({ type: 'usage', usage })
  }

  /**
   * Close the model call: emit `assistant/message` from the ACCUMULATED blocks,
   * then one `tool/call` per tool-call block (§5.3).
   * @returns nothing.
   */
  private flushModelCall(): void {
    const call = this.#call
    if (call !== undefined && call.touched && call.stopReason !== undefined) {
      // The terminal chunk of the call, mirroring dsh's own stream contract
      // (usage, then exactly one `finish`). A call this seam killed never
      // reached a stop reason, and gets no synthetic finish.
      this.appendChunk({ type: 'finish', reason: finishReason(call.stopReason) })
    }
    this.#call = undefined
    if (call === undefined || !call.touched) return
    this.salvageOpenBlocks(call)
    const blocks = [...call.done].sort((left, right) => left.index - right.index).map(entry => entry.block)
    if (blocks.length === 0) {
      // Nothing survived: an interrupt that killed the call before its first
      // block closed, or a call whose only block was an unfinished tool use. An
      // assistant message with EMPTY content is not a faithful record of that —
      // it is an invalid provider message that every later reader of
      // `deriveMessages()` would have to special-case. The chunks already in the
      // log say exactly what was streamed before the kill.
      this.ignore('assistant:empty-call')
      return
    }
    const framing = this.ensureStep()
    const message = createAssistantMessage({
      content: blocks,
      source: { provider: this.#provider, model: call.model ?? this.#sessionModel ?? UNKNOWN_MODEL },
    })
    this.append(
      'assistant/message',
      {
        turn: framing.turn,
        step: framing.step,
        message,
        ...(call.usage === undefined ? {} : { usage: call.usage }),
      },
      // A present empty array is legal on assistant/message alone, and states
      // exactly which chunks built this message.
      { surfaceOp: 'append', sourceEventSeqs: [...call.chunkSeqs] },
    )
    for (const block of blocks) {
      if (block.type === 'tool-call') this.emitToolCall(block, framing)
    }
  }

  /**
   * Append one `tool/call` (and, for `TodoWrite`, the matching `todo/write`).
   * @param block - the assembled tool-call block.
   * @param framing - the open turn and step.
   * @returns nothing.
   */
  private emitToolCall(block: ToolCallBlock, framing: { turn: number, step: number }): void {
    const toolUseId = this.#toolUseIds.get(block.id) ?? block.id
    if (this.#pending.has(toolUseId)) {
      this.ignore('tool-call:duplicate')
      return
    }
    this.append('tool/call', {
      turn: framing.turn,
      step: framing.step,
      callId: block.id,
      name: block.name,
      arguments: block.arguments,
    })
    this.#pending.set(toolUseId, { callId: block.id, step: framing.step })
    this.emitTodoWrite(block)
  }

  /**
   * Mirror a `TodoWrite` call as dsh's own `todo/write` snapshot — the shape
   * maps trivially (`content` + a three-state `status`); CC's `activeForm` has
   * no dsh counterpart and is dropped. Anything else is skipped (§5.3).
   * @param block - the assembled tool-call block.
   * @returns nothing.
   */
  private emitTodoWrite(block: ToolCallBlock): void {
    if (block.name !== 'TodoWrite') return
    let parsed: unknown
    try {
      parsed = JSON.parse(block.arguments)
    } catch {
      this.ignore('todo:unparsable')
      return
    }
    const raw = asRecord(parsed)?.['todos']
    if (!Array.isArray(raw)) {
      this.ignore('todo:unmapped')
      return
    }
    const todos: TodoItem[] = []
    for (const entry of raw) {
      const item = asRecord(entry)
      const content = asString(item?.['content'])
      const status = asString(item?.['status'])
      if (content === undefined || !isTodoStatus(status)) {
        this.ignore('todo:unmapped')
        return
      }
      todos.push({ content, status })
    }
    this.append('todo/write', { todos })
  }

  /**
   * Use one `SDKAssistantMessage` as what it is: a per-block CHECKPOINT
   * (spike 6), never the source of content.
   *
   * Two jobs only — checksum the accumulated text, and harvest the tool calls of
   * a SUBAGENT message, whose stream events are not mirrored by default.
   *
   * @param message - the checkpoint message.
   * @returns nothing.
   */
  private onAssistantCheckpoint(message: CcMessageEnvelope['message']): void {
    const parent = asString(message['parent_tool_use_id'])
    const body = asRecord(message['message'])
    const content = body?.['content']
    if (!Array.isArray(content)) {
      this.ignore('assistant:malformed')
      return
    }
    if (parent !== undefined) {
      this.harvestSubagentCalls(content)
      this.ignore('assistant:subagent-checkpoint')
      return
    }
    const checkpointText = content
      .map(entry => asString(asRecord(entry)?.['text']) ?? '')
      .join('')
    if (checkpointText === '') {
      this.ignore('assistant:checkpoint')
      return
    }
    const accumulated = this.accumulatedText()
    if (accumulated !== '' && !accumulated.includes(checkpointText)) {
      this.#checksumMismatches += 1
      this.#logger?.debug(
        'claude-code mirror: assistant checkpoint disagrees with the accumulated stream text '
        + '(the SDK partial-message contract may have changed)')
    }
    this.ignore('assistant:checkpoint')
  }

  /**
   * Mint call ids and append `tool/call` for a subagent's tool uses — the only
   * part of nested traffic mirrored by default (§5.3).
   * @param content - the checkpoint's content blocks.
   * @returns nothing.
   */
  private harvestSubagentCalls(content: readonly unknown[]): void {
    for (const entry of content) {
      const block = asRecord(entry)
      if (asString(block?.['type']) !== 'tool_use') continue
      const toolUseId = asString(block?.['id'])
      if (toolUseId === undefined || this.#pending.has(toolUseId)) continue
      const framing = this.ensureStep()
      this.emitToolCall({
        type: 'tool-call',
        id: this.callIdFor(toolUseId),
        name: asString(block?.['name']) ?? 'unknown',
        arguments: stringifyArguments(block?.['input']),
      }, framing)
    }
  }

  /**
   * Project the `tool_result` blocks of one user-role SDK message.
   *
   * User TEXT is deliberately not mirrored here: prompts are recorded from the
   * send side, so an echo would duplicate them.
   *
   * @param message - the user-role SDK message.
   * @returns nothing.
   */
  private onUserMessage(message: CcMessageEnvelope['message']): void {
    const body = asRecord(message['message'])
    const content = body?.['content']
    if (!Array.isArray(content)) {
      this.ignore('user:no-blocks')
      return
    }
    const parent = asString(message['parent_tool_use_id'])
    let mirrored = 0
    for (const entry of content) {
      const block = asRecord(entry)
      if (block === undefined || asString(block['type']) !== 'tool_result') continue
      if (this.emitToolResult(block, parent)) mirrored += 1
    }
    if (mirrored === 0) this.ignore('user:no-tool-results')
  }

  /**
   * Append one `tool/result` for a call pending in the OPEN step.
   * @param block - the `tool_result` block.
   * @param parent - the subagent tool-use id this arrived under, when nested.
   * @returns whether an event was appended.
   */
  private emitToolResult(block: Record<string, unknown>, parent: string | undefined): boolean {
    const toolUseId = asString(block['tool_use_id'])
    if (toolUseId === undefined) {
      this.ignore('tool-result:no-id')
      return false
    }
    const pending = this.#pending.get(toolUseId)
    if (pending === undefined) {
      // A result whose call this mirror never saw (or already resulted). dsh's
      // session invariants reject it outright, so it is dropped, not forced.
      this.ignore('tool-result:orphan')
      return false
    }
    const framing = { turn: this.#openTurn, step: this.#openStep }
    if (framing.turn === undefined || framing.step === undefined || framing.step !== pending.step) {
      this.ignore('tool-result:outside-step')
      return false
    }
    this.#pending.delete(toolUseId)
    const message = createToolResultMessage({
      callId: pending.callId,
      content: toolResultContent(block['content']),
      isError: block['is_error'] === true,
    })
    this.append(
      'tool/result',
      {
        turn: framing.turn,
        step: framing.step,
        message,
        // `meta` is the ONE place a nested result can carry its parent: neither
        // `assistant/chunk` (a closed union) nor `tool/call` has a free field.
        ...(parent === undefined ? {} : { meta: { parentToolUseId: parent } satisfies JsonValue }),
      },
      { surfaceOp: 'append' },
    )
    return true
  }

  // ---------------------------------------------------------------- framing

  /**
   * Close the turn on a result (§5.2), or record CC's compaction boundary.
   * @param message - the `result` SDK message.
   * @param interruptedTurn - whether this seam aborted the turn itself.
   * @returns nothing.
   */
  private onResult(message: CcMessageEnvelope['message'], interruptedTurn: boolean): void {
    this.flushModelCall()
    if (this.#openTurn === undefined) {
      // A result with no open turn: an auto-resume continuation, or a mirror
      // attached mid-flight. Nothing to close.
      this.ignore('result:no-open-turn')
      return
    }
    const turn = this.#openTurn
    this.closeStep()
    this.append('turn/end', { turn, reason: turnEndReason(message, interruptedTurn) })
    this.#openTurn = undefined
    this.#nextTurn = turn + 1
    this.#pending.clear()
  }

  /**
   * Handle the `system` family: the compaction boundary is the only member with
   * a dsh projection; `init` re-caches the model and everything else is ignored.
   * @param message - the `system` SDK message.
   * @returns nothing.
   */
  private onSystem(message: CcMessageEnvelope['message']): void {
    const subtype = asString(message['subtype'])
    if (subtype === 'init') {
      // Multi-init is normal after an interrupt (spike 3) and must produce NO
      // framing events: re-caching the model is the whole job.
      const model = asString(message['model'])
      if (model !== undefined) this.#sessionModel = model
      this.ignore('system:init')
      return
    }
    if (subtype === 'compact_boundary') {
      this.onCompactBoundary(message)
      return
    }
    this.ignore(`system:${String(subtype)}`)
  }

  /**
   * Append the {@link CC_COMPACT_EVENT} marker for one CC compaction (D9).
   * @param message - the compaction-boundary message.
   * @returns nothing.
   */
  private onCompactBoundary(message: CcMessageEnvelope['message']): void {
    if ((this.#options.compaction ?? 'append') === 'skip') {
      this.ignore('system:compact_boundary:skipped')
      return
    }
    const metadata = asRecord(message['compact_metadata'])
    this.append(CC_COMPACT_EVENT, {
      trigger: asString(metadata?.['trigger']) ?? null,
      preTokens: asNumber(metadata?.['pre_tokens']) ?? null,
      uuid: asString(message['uuid']) ?? null,
      turn: this.#openTurn ?? null,
    })
  }

  /**
   * Open a turn.
   * @returns the opened turn number.
   */
  private startTurn(): number {
    const turn = this.#nextTurn
    this.append('turn/start', { turn })
    this.#openTurn = turn
    this.#nextStep = 1
    // The prompts queued behind the previous turn are what this turn RUNS
    // (spike 3: several queued messages coalesce into one turn), so they are
    // recorded here, inside it, in send order.
    this.flushDeferredSends()
    return turn
  }

  /**
   * Guarantee an open turn AND an open step, opening either as needed — this is
   * "first assistant activity after a turn opens → `step/start`" (§5.2), plus
   * the defensive case of CC starting a turn nobody sent (auto-resume, a
   * scheduled trigger).
   * @returns the open turn and step.
   */
  private ensureStep(): { turn: number, step: number } {
    const turn = this.#openTurn ?? this.startTurn()
    if (this.#openStep === undefined) {
      const step = this.#nextStep
      this.append('step/start', { turn, step })
      this.#openStep = step
    }
    // The step is open by construction above.
    return { turn, step: this.#openStep }
  }

  /**
   * Drop the model call an `interruptArtifact` result aborted, WITHOUT
   * flushing it: unlike a normal call boundary (`beginModelCall`,
   * `onResult`), nothing this call streamed is real output — it is exactly
   * the content the refold discarded. The step it opened (if any) is still
   * closed here, so the log's step framing stays well-formed for the step
   * that follows (one dsh step per model call, §5.2), but with no
   * `assistant/message` and no `tool/call` for content that never happened.
   * @returns nothing.
   */
  private discardInterruptedCall(): void {
    this.#call = undefined
    this.closeStep()
  }

  /**
   * Close the open step, if any. Pending calls do not survive it — dsh clears
   * them at `step/end` and so do we.
   * @returns nothing.
   */
  private closeStep(): void {
    const turn = this.#openTurn
    const step = this.#openStep
    if (turn === undefined || step === undefined) return
    this.append('step/end', { turn, step })
    this.#openStep = undefined
    this.#nextStep = step + 1
    this.#pending.clear()
  }

  /**
   * Continue turn/step numbering from a log that already holds events (a
   * resumed or forked session, or a second mirror over the same log).
   * @returns nothing.
   */
  private foldExistingFraming(): void {
    for (const event of this.#session.events) {
      switch (event.type) {
        case 'turn/start':
          this.#openTurn = event.data.turn
          this.#nextTurn = event.data.turn + 1
          this.#nextStep = 1
          break
        case 'turn/end':
          this.#openTurn = undefined
          this.#nextTurn = event.data.turn + 1
          break
        case 'step/start':
          this.#openStep = event.data.step
          this.#nextStep = event.data.step + 1
          break
        case 'step/end':
          this.#openStep = undefined
          this.#nextStep = event.data.step + 1
          break
        default:
          // Merge-extensible union: no assertNever, ever (D9).
          break
      }
    }
  }

  // ------------------------------------------------------------------ plumbing

  /**
   * The model call currently accumulating, opened on demand for a provider that
   * streams blocks without a `message_start`.
   * @returns the live model call.
   */
  private currentCall(): ModelCall {
    this.#call ??= { chunkSeqs: [], open: new Map(), done: [], touched: false }
    return this.#call
  }

  /**
   * The text accumulated for the live model call, for the checkpoint checksum.
   * @returns the concatenated text of every text block seen so far.
   */
  private accumulatedText(): string {
    const call = this.#call
    if (call === undefined) return ''
    const done = call.done
      .map(entry => entry.block.type === 'text' ? entry.block.text : '')
      .join('')
    const open = [...call.open.values()]
      .map(state => state.blockType === 'text' ? state.text : '')
      .join('')
    return done + open
  }

  /**
   * Append one `assistant/chunk`, opening the turn and step it needs, and record
   * its seq as provenance for the message being assembled.
   * @param chunk - the dsh stream chunk. Typed as dsh's own union, so a payload
   *   that does not match it fails to COMPILE rather than at the append site.
   * @returns nothing.
   */
  private appendChunk(chunk: StreamChunk): void {
    const framing = this.ensureStep()
    const call = this.currentCall()
    const event = this.append('assistant/chunk', { turn: framing.turn, step: framing.step, chunk })
    call.touched = true
    if (event !== undefined) call.chunkSeqs.push(event.seq)
  }

  /**
   * Append one event to the dsh session.
   *
   * Failures are contained: a rejected append (a payload dsh refuses, a framing
   * race with another writer) is logged and counted, never thrown at the pump.
   * The mirror is not a source of truth, so a hole in it must not take the
   * session down with it.
   *
   * @param type - the session event type.
   * @param data - its payload.
   * @param opts - surface metadata, required for the three surface event types.
   * @returns the appended event, or undefined when the append was refused.
   */
  private append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T> | undefined {
    try {
      // The public signature above is `Session.append`'s, verbatim, so a wrong
      // payload for a given type is a compile error at the CALL site. The cast
      // exists only because a conditional rest tuple cannot be spread through a
      // generic call; nothing about the contract is weakened by it.
      const append = this.#session.append.bind(this.#session) as
        (type: T, data: SessionEventMap[T], ...rest: unknown[]) => SessionEvent<T>
      const event = append(type, data, ...opts)
      this.#appended += 1
      return event
    } catch (error) {
      this.ignore(`append-failed:${String(type)}`)
      this.#logger?.debug(
        `claude-code mirror: dsh refused "${String(type)}": ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * Count one ignored input, logging the first occurrence of each reason.
   * @param reason - a stable diagnostic slug.
   * @returns nothing.
   */
  private ignore(reason: string): void {
    const seen = this.#ignored.get(reason) ?? 0
    this.#ignored.set(reason, seen + 1)
    if (seen === 0) this.#logger?.debug(`claude-code mirror: ignoring ${reason}`)
  }

  /**
   * Run one projection step with a total failure boundary.
   * @param what - the entry point, for diagnostics.
   * @param body - the projection to run.
   * @returns nothing.
   */
  private guard(what: string, body: () => void): void {
    try {
      body()
    } catch (error) {
      this.ignore(`mirror-failed:${what}`)
      this.#logger?.debug(
        `claude-code mirror: ${what} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Attach a mirror to a live Claude Code session.
 *
 * The mirror sees the session through {@link CcMirrorSource} — two subscribe
 * functions — so it cannot drive CC even by accident, and it registers no cordis
 * waterfall listeners at all.
 *
 * @param source - the session to observe (a `CcSession` satisfies this).
 * @param session - the dsh session to append to.
 * @param options - subagent policy, compaction policy, provider name, logger.
 * @returns the mirror and its unsubscribe function.
 */
export function attachMirror(
  source: CcMirrorSource,
  session: DshSession,
  options: CcMirrorOptions = {},
): CcMirrorHandle {
  const mirror = new CcMirror(session, options)
  const offMessage = source.onMessage(envelope => { mirror.observe(envelope) })
  const offSend = source.onSend(send => { mirror.recordSend(send) })
  let disposed = false
  return {
    mirror,
    dispose: () => {
      if (disposed) return
      disposed = true
      offMessage()
      offSend()
    },
  }
}

/**
 * Detach one logged event and stamp the envelope's `ignorable` marker on it.
 *
 * The marker says "a reader that does not recognize this `type` may skip it";
 * without it a reader MUST refuse the whole log (see {@link CC_COMPACT_EVENT}).
 * `Session.append()` cannot set it, so the marker is applied where envelopes are
 * caller-supplied instead: the seed/restore boundary
 * (`SessionStore.prepare(id, { seed, meta, seedSource: 'persistence' })`) and
 * any persistence backend writing our log out.
 *
 * @param event - a logged event (frozen; it is cloned, never mutated).
 * @returns a detached copy carrying `ignorable: true`.
 */
export function markEventIgnorable<T extends SessionEvent>(event: T): T {
  // Detached because the restore path takes OWNERSHIP of the graph it is given
  // and freezes it in place; sharing children with the live log would freeze
  // events under their owner.
  return { ...structuredClone(event), ignorable: true }
}

/**
 * Decide why a CC turn ended.
 *
 * A turn this seam aborted is `aborted`, never `error`: the `error_during_execution`
 * result of an interrupt is a cancellation we asked for (spikes 2 and 3), and a
 * consumer must render it as cancelled.
 *
 * @param message - the result message.
 * @param interruptedTurn - whether this seam aborted the turn.
 * @returns the dsh turn-end reason.
 */
function turnEndReason(message: CcMessageEnvelope['message'], interruptedTurn: boolean): TurnEndReason {
  if (interruptedTurn) return { kind: 'aborted', reason: { kind: 'user' } }
  const subtype = asString(message['subtype']) ?? 'unknown'
  if (subtype === 'success') return { kind: 'completed' }
  if (subtype === 'error_max_turns') return { kind: 'max-tokens' }
  if (message['is_error'] === true || subtype.startsWith('error')) {
    return {
      kind: 'error',
      error: {
        message: asString(message['result']) ?? `claude-code result: ${subtype}`,
        // A stable machine-routing code: the CC result subtype, namespaced.
        code: `CLAUDE_CODE_${subtype.toUpperCase()}`,
      },
    }
  }
  return { kind: 'completed' }
}

/**
 * Map a provider stop reason onto dsh's finish vocabulary.
 *
 * A provider reason dsh has no word for is `stop`: the alternatives
 * (`aborted`/`error`) each require a structured `LlmFailure` and would
 * report a failure that did not happen.
 *
 * @param stopReason - the provider's `message_delta.delta.stop_reason`.
 * @returns the dsh finish reason.
 */
function finishReason(stopReason: string): Extract<StreamChunk, { type: 'finish' }>['reason'] {
  switch (stopReason) {
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'stop' }
  }
}

/**
 * Map a provider block type onto dsh's content-block vocabulary.
 * @param type - the provider's block type.
 * @returns the dsh block type, or undefined when it has no dsh counterpart.
 */
function mapBlockType(type: string | undefined): ContentBlockType | undefined {
  switch (type) {
    case 'text':
      return 'text'
    case 'thinking':
    case 'redacted_thinking':
      return 'reasoning'
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      return 'tool-call'
    default:
      return undefined
  }
}

/**
 * Project a `tool_result` block's content onto dsh content blocks.
 * @param content - the provider's result content (a string or a block array).
 * @returns the dsh content blocks; never empty, so the model always sees something.
 */
function toolResultContent(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }]
  const blocks: ContentBlock[] = []
  for (const entry of content) {
    const block = asRecord(entry)
    const text = asString(block?.['text'])
    if (asString(block?.['type']) === 'text' && text !== undefined) {
      blocks.push({ type: 'text', text })
      continue
    }
    // Images and provider-private result blocks have no faithful dsh
    // representation here (an ImageBlock needs an attachment service); they are
    // recorded as a placeholder rather than dropped silently.
    blocks.push({ type: 'text', text: `[${asString(block?.['type']) ?? 'unknown'} block]` })
  }
  return blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks
}

/**
 * Render a checkpoint's already-parsed tool input back to the raw JSON string
 * dsh's `tool-call` block carries.
 * @param input - the parsed tool input.
 * @returns a JSON string, `'{}'` when it cannot be rendered.
 */
function stringifyArguments(input: unknown): string {
  try {
    const rendered = JSON.stringify(input)
    return rendered === undefined ? '{}' : rendered
  } catch {
    return '{}'
  }
}

/**
 * Read Anthropic's usage object as dsh {@link TokenUsage}. Counts are DISJOINT
 * in dsh: cached input is reported separately, which is already how Anthropic
 * reports it.
 * @param usage - the provider usage record.
 * @returns the dsh usage, or undefined when nothing usable was reported.
 */
function readUsage(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined
  const inputTokens = asNumber(usage['input_tokens'])
  const outputTokens = asNumber(usage['output_tokens'])
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  const cacheRead = asNumber(usage['cache_read_input_tokens'])
  const cacheWrite = asNumber(usage['cache_creation_input_tokens'])
  const reasoning = asNumber(asRecord(usage['output_tokens_details'])?.['thinking_tokens'])
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/**
 * Whether a value is one of dsh's three todo states.
 * @param status - the candidate status.
 * @returns true when it maps directly.
 */
function isTodoStatus(status: string | undefined): status is TodoItem['status'] {
  return status === 'pending' || status === 'in_progress' || status === 'completed'
}

/**
 * Narrow an unknown to a plain record.
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
 * Narrow an unknown to a lossless-JSON number (finite, never negative zero —
 * `Session.append` rejects both).
 * @param value - the candidate.
 * @returns the number, or undefined.
 */
function asNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) return undefined
  return value
}

/**
 * Narrow an unknown to a provider block index.
 * @param value - the candidate.
 * @returns the index, or undefined.
 */
function asIndex(value: unknown): number | undefined {
  const index = asNumber(value)
  return index !== undefined && Number.isSafeInteger(index) && index >= 0 ? index : undefined
}
