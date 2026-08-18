/**
 * `ClaudeCodeAgent` — dsh's `Agent` interface implemented over a live Claude
 * Code session (spec §7, with review findings D6/D7 folded in).
 *
 * It is NOT a loop. Claude Code drives its own model requests inside its own
 * subprocess; this class is the adapter that makes that subprocess look like a
 * first-class dsh agent to everything that consumes `ctx.agents`. Which means
 * three things it does, and one large thing it deliberately does not:
 *
 * - **Identity.** `id === session.id`, by construction (D6:
 *   `AgentRegistry.enter()` throws otherwise). The value is the bare UUID the
 *   seam minted for the SDK, so dsh and Claude Code share one id with no map
 *   in either direction.
 * - **Projection.** `status`, `options.model` and `inbox` are projections of
 *   the seam's session state (`CcSessionStatus`, the snapshot's model, the
 *   outbox), never independent bookkeeping that could drift from it.
 * - **Routing.** dsh's three inbox verbs are routed onto the seam's three send
 *   modes: `followup` → a plain queued message, `steer` → `priority: 'now'`,
 *   `inject` → `shouldQuery: false` (delta S7).
 * - **It never dispatches `agent/pre-step`, `agent/request`,
 *   `agent/request-error` or anything under `tools/*`.** Those are the loop's
 *   own extension points (D8); synthesizing them here would make a plugin
 *   author believe a hook works when the thing it hooks never happens.
 *
 * @module @deepseek-ai/dsh-claude-code-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent, AgentEventDispatch, AgentOptions, AgentStatus, CancelOptions, InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents } from '@deepseek-ai/dsh-agent'
import type { CcLogger, CcSendMode, CcUuid } from '@deepseek-ai/dsh-claude-code'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { UserMessage } from '@deepseek-ai/dsh-llm/message'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { AgentCancelCause, Session as DshSession, SessionId } from '@deepseek-ai/dsh-session'

import { CC_AGENT_PROVIDER } from './types.ts'
import type { CcAgentSession } from './types.ts'

/** Everything one {@link ClaudeCodeAgent} needs from its surroundings. */
export interface ClaudeCodeAgentDeps {
  /**
   * The host context: what agent events are dispatched through, and what the
   * agent's own scope is minted under. Pass the context that will also own the
   * registration effect (`createClaudeCodeAgent` passes its `ctx`).
   */
  readonly ctx: Context
  /**
   * The dsh session this agent drives — the SAME session the seam's mirror
   * writes into. Its id must equal the Claude Code session's id.
   */
  readonly session: DshSession
  /** The live Claude Code session actor. */
  readonly cc: CcAgentSession
  /** Provider route reported on {@link ClaudeCodeAgent.options}. Defaults to `'claude-code'`. */
  readonly provider?: string
  /** Diagnostics sink. */
  readonly logger?: CcLogger
  /**
   * How long disposal waits for the interrupted session to reach quiescence
   * before closing the subprocess anyway. Defaults to
   * {@link DEFAULT_DISPOSE_DRAIN_MS}.
   */
  readonly disposeDrainMs?: number
}

/**
 * How long {@link ClaudeCodeAgent.drain} waits for quiescence during disposal.
 *
 * Bounded on purpose. A healthy session reaches idle as soon as the interrupt's
 * abort result arrives (milliseconds), but a subprocess that has already died
 * emits no result at all — and an unbounded wait there would wedge plugin
 * unload (HMR) on a process that is never going to answer.
 */
export const DEFAULT_DISPOSE_DRAIN_MS = 5_000

/** The text of one dsh message, plus what could not be carried to Claude Code. */
export interface CcAgentMessageText {
  /** Every `text` block, joined by a blank line. Empty when the message carried none. */
  readonly text: string
  /** `type` of every block that was NOT carried, in order, with duplicates kept. */
  readonly dropped: readonly string[]
}

/**
 * Reduce one dsh `UserMessage` to the plain string a Claude Code session can
 * receive.
 *
 * The seam's send channel is `{ content: string }` — the CLI's stdin protocol
 * has no place for dsh's richer blocks — so anything that is not a `text`
 * block cannot cross. This function makes that loss explicit and countable
 * rather than silent; {@link ClaudeCodeAgent.send} records it in the session
 * log as a `notice` and logs it.
 *
 * @param message - the dsh message to reduce.
 * @returns the joined text and the types of the blocks left behind.
 */
export function extractMessageText(message: UserMessage): CcAgentMessageText {
  const text: string[] = []
  const dropped: string[] = []
  for (const block of message.content as readonly ContentBlock[]) {
    if (block.type === 'text') {
      if (block.text.length > 0) text.push(block.text)
      continue
    }
    dropped.push(block.type)
  }
  return { text: text.join('\n\n'), dropped }
}

/** One message this adapter handed (or owes) to the seam. */
interface Delivery {
  /** The dsh message, held so a parked send can be delivered verbatim later. */
  readonly message: UserMessage
  /** Which inbox list it sits in. */
  readonly target: InboxTarget
  /** The text handed to the seam. */
  readonly text: string
  /** Whether delivery may wake the session. */
  readonly wakeup: boolean
}

/**
 * A dsh `Agent` backed by one Claude Code session.
 *
 * Construct it through `createClaudeCodeAgent()` — it wires the dsh session,
 * the mirror, the ask target and the registration effect in the one order that
 * survives teardown. Constructing it directly is supported (that is what the
 * unit tests do) but then the caller owns every one of those.
 */
export class ClaudeCodeAgent implements Agent {
  /** The single identity shared with {@link ClaudeCodeAgent.session} (D6). */
  readonly id: SessionId

  /** The live session this agent drives; the seam's mirror is what writes to it. */
  readonly session: DshSession

  /** The agent-owned projection of durable pending work. */
  readonly inbox: Inbox

  /**
   * The agent-scoped registration boundary. Yield {@link Scope.rawDispose} into
   * the composite teardown so agent-scoped contributions unwind IN ORDER (after
   * the subprocess is gone, before the registry drops the agent) — the same
   * position `dsh-agent-loop` gives it.
   */
  readonly scope: Scope

  /** Agent-scoped context; contributions are agent-local and unwind with {@link ClaudeCodeAgent.scope}. */
  readonly ctx: Context

  readonly #host: Context
  readonly #cc: CcAgentSession
  readonly #provider: string
  readonly #logger: CcLogger | undefined
  readonly #disposeDrainMs: number
  readonly #dispatch: AgentEventDispatch

  /** Message identity → the uuid the seam stamped on it. Only live for pending messages. */
  readonly #uuids = new Map<string, CcUuid>()
  /** Waking sends held back while a maintenance task owns the true-idle phase. */
  readonly #parked: Delivery[] = []
  /** Parked {@link ClaudeCodeAgent.whenIdle} resolvers. */
  readonly #quiescence = new Set<() => void>()

  #status: AgentStatus
  #maintenance: AbortController | undefined
  #options: AgentOptions
  #optionsModel: string | undefined
  #closed = false

  /**
   * @param deps - the host context, the dsh session, the seam actor, and the
   *   provider label.
   * @throws when the agent and session identities differ — `AgentRegistry.enter()`
   *   would refuse the registration later, and this failure names the real cause.
   */
  constructor(deps: ClaudeCodeAgentDeps) {
    if (deps.cc.id !== deps.session.id) {
      throw new Error(
        `claude-code-agent: Claude Code session "${deps.cc.id}" does not match dsh session `
        + `"${deps.session.id}" — an agent and its session must share ONE identity`)
    }
    this.id = deps.session.id
    this.session = deps.session
    this.#host = deps.ctx
    this.#cc = deps.cc
    this.#provider = deps.provider ?? CC_AGENT_PROVIDER
    this.#logger = deps.logger
    this.#disposeDrainMs = deps.disposeDrainMs ?? DEFAULT_DISPOSE_DRAIN_MS
    // Built once, exactly as the loop does: the dispatcher fuses the agent
    // subject to its scope carrier, so a scoped listener cannot be handed an
    // event whose payload names a different agent (D8).
    this.#dispatch = agentEvents(deps.ctx, this)
    this.inbox = new Inbox(deps.session, {
      inserted: (message) => { this.#dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.#dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.#dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    this.scope = createScope(deps.ctx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.#optionsModel = deps.cc.snapshot().model
    this.#options = freezeOptions(this.#provider, this.#optionsModel)
    // A session that has not been sent to yet is `starting`, which is idle as
    // far as dsh is concerned: no driver is active.
    this.#status = projectStatus(deps.cc.status)

    // Owned by the agent's own scope, so the subscriptions unwind exactly when
    // its contributions do — and, given the teardown order, they are still live
    // while the seam session closes, which is what carries the final status
    // transition and the last outbox reconciliation.
    this.scope.ctx.effect(() => {
      const offMessage = this.#cc.onMessage(() => { this.sync() })
      const offClose = this.#cc.onClose(() => {
        this.#closed = true
        this.sync()
      })
      return () => {
        offMessage()
        offClose()
      }
    }, 'claudeCodeAgent.observe()')
  }

  /**
   * The provider route and model this agent's turns use.
   *
   * A LIVE projection, not the startup snapshot the Phase 1 scaffold promised:
   * the seam updates its model on every `system/init` (the CLI emits one after
   * every interrupted turn) and on {@link ClaudeCodeAgent.setModel}, so reading
   * it here is always what Claude Code most recently reported. The object
   * identity only changes when the model does.
   */
  get options(): AgentOptions {
    const model = this.#cc.snapshot().model
    if (model !== this.#optionsModel) {
      this.#optionsModel = model
      this.#options = freezeOptions(this.#provider, model)
    }
    return this.#options
  }

  /**
   * The current lifecycle state.
   *
   * Two of the seam's four states project onto dsh's `idle`: `starting` (the
   * handshake is done but nothing has been sent, so no driver is active) and
   * `closed`. Disposal is deliberately NOT a third status — dsh's own
   * `AgentStatus` doc says so — so a disposed agent reads `idle` right up to
   * the moment the registry drops it.
   */
  get status(): AgentStatus {
    return this.#status
  }

  /**
   * Route identified input to an inbox boundary and optionally wake the session.
   *
   * The mapping is total and has no third case:
   *
   * | `target` / `wakeup` | seam mode | what Claude Code does |
   * |---|---|---|
   * | `next-turn`, wake | `followup` | queues; runs as its own next turn |
   * | `next-step`, wake | `steer` | aborts the running turn, refolds both instructions into one |
   * | either, no wake | `inject` | appends to the transcript, starts no turn |
   *
   * `wakeup: false` is the §7.1 inject-buffer substitute: `shouldQuery: false`
   * is a native SDK mechanism with exactly dsh `inject()`'s contract (delta
   * S7), so nothing is buffered here and prepended later.
   *
   * Non-text content cannot cross the seam's `{ content: string }` send channel.
   * When a message carries any, the loss is recorded in the session log as a
   * `notice`-form message (bounded summary, per dsh's `ContextFormed` rules)
   * and logged; a message with NO text at all is not delivered at all and never
   * enters the inbox, because there is nothing to send and a permanently
   * pending entry would hang {@link ClaudeCodeAgent.whenIdle}.
   *
   * @param message - identified content and the source that supplied it.
   * @param target - the preferred next-turn or next-step inbox boundary.
   * @param wakeup - whether delivery may wake the session.
   */
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    const { text, dropped } = extractMessageText(message)
    if (dropped.length > 0) this.recordDroppedBlocks(message, dropped, text.length > 0)
    if (text.length === 0) return
    this.inbox.append(target, message)
    const delivery: Delivery = { message, target, text, wakeup }
    // A maintenance task owns the true-idle phase: waking input waits in the
    // inbox until it settles (dsh's contract), rather than starting a Claude
    // Code turn underneath a task that believes it has the agent to itself.
    if (wakeup && this.#maintenance !== undefined) {
      this.#parked.push(delivery)
      return
    }
    this.deliver(delivery)
  }

  /**
   * Queue an ordinary follow-up turn and wake the session.
   * @param message - identified prompt content and the source that supplied it.
   */
  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  /**
   * Submit steering for the nearest step.
   *
   * Claude Code has no token-level steering. The closest mechanism is
   * `priority: 'now'`, which is **abort-and-refold** (Phase 0 spike 2): the
   * running turn is killed and ONE fresh turn runs both instructions together.
   * The aborted turn's `error_during_execution` result is an internal artifact
   * the seam flags and the mirror suppresses — but turn-1 tokens are re-paid,
   * so steering here is not the cheap operation it is in the dsh loop.
   *
   * @param message - identified steering content and the source that supplied it.
   */
  steer(message: UserMessage): void {
    this.send(message, 'next-step', true)
  }

  /**
   * Queue model-facing context for the next turn without waking the session.
   * @param message - identified injected context and the source that supplied it.
   */
  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }

  /**
   * Abort the running turn, and — unless `keepInbox` — ask for queued messages
   * to be discarded too.
   *
   * **The default differs from `ReactLoopAgent`'s, deliberately.** dsh's loop
   * owns its inbox outright, so `cancel(cause)` with no options clears it. Here
   * the queue lives inside the Claude Code subprocess and `keepQueued: false`
   * is EMULATED (SDK 0.3.233 exposes no way to drive
   * `interrupt_cancel_queued_v1`): the seam re-interrupts as each surviving
   * turn starts, capped, and marks what it managed to stop. That is lossy and
   * costs extra interrupts, so it is opt-in — `keepInbox` defaults to `true`
   * here, matching `claude_code_cancel`'s own default. Pass
   * `{ keepInbox: false }` to drive the drain.
   *
   * The inbox is reconciled from the seam's outbox afterwards, never cleared
   * optimistically: a message the emulated drain could not stop is still going
   * to run, and an inbox that claimed otherwise would be a lie the mirror would
   * immediately contradict.
   *
   * **The `cause` does not reach Claude Code.** `CcSession.interrupt()` takes no
   * cause parameter — the SDK's `interrupt()` takes no arguments at all — so the
   * cause is used ONLY as an active maintenance task's abort reason. Every
   * agent-driven interrupt the subprocess actually answers is therefore mirrored
   * as `turn/end { aborted, reason: { kind: 'user' } }`, whatever the real cause
   * was; `{ kind: 'disposed' }` appears only on `CcMirror.finalize()`'s fallback,
   * when the turn was still dangling at `close()` time. A human reading the
   * transcript cannot tell "the plugin disposed this agent mid-turn" from "the
   * user clicked cancel" unless the subprocess never answered at all.
   *
   * @param cause - the stable caller intent; it becomes an active maintenance
   *   task's abort reason, and nothing else (see above).
   * @param options - `keepInbox` preserves queued work (default `true`, see above).
   */
  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    const keepInbox = options.keepInbox ?? true
    this.#maintenance?.abort(cause)
    if (!keepInbox) this.discardParked()
    if (this.shouldInterrupt(keepInbox)) {
      void this.#cc.interrupt({ keepQueued: keepInbox }).then(
        () => { this.sync() },
        (error: unknown) => {
          this.#logger?.debug(`claude-code-agent: ${this.id} interrupt failed: ${describe(error)}`)
          this.sync()
        })
    }
    // Synchronously too: discarding parked work (or aborting a task that had
    // nothing to interrupt) can be the whole of what this cancel did, and a
    // parked `whenIdle()` has to hear about it either way.
    this.sync()
  }

  /**
   * Whether this cancel has anything for the seam to interrupt.
   *
   * With no active activity, cancellation is a no-op and does not arm later
   * work (dsh's own contract). "Active" here means a running turn, or queued
   * messages a `keepInbox: false` cancel is being asked to stop.
   *
   * @param keepInbox - whether queued work is being preserved.
   * @returns true when an interrupt should be issued.
   */
  private shouldInterrupt(keepInbox: boolean): boolean {
    if (this.#closed || this.#cc.status === 'closed') return false
    if (this.#cc.status === 'running') return true
    return !keepInbox && this.#cc.outbox().some(entry => entry.state === 'queued')
  }

  /**
   * Resolve after this agent reaches quiescence: no running Claude Code turn,
   * no maintenance task, and nothing left queued in the seam's outbox.
   *
   * The outbox is part of the condition because a Claude Code turn boundary is
   * not the end of the work: N messages queued behind a running turn coalesce
   * into ONE later turn (spike 3), so a session can be momentarily `idle` with
   * three prompts still owed. A CLOSED session is quiescent by definition —
   * whatever it still had queued is never going to run.
   *
   * @returns fulfillment once no turn, task or queued message remains.
   */
  async whenIdle(): Promise<void> {
    while (!this.isQuiescent()) {
      await new Promise<void>(resolve => { this.#quiescence.add(resolve) })
    }
  }

  /**
   * Run one non-turn maintenance task from the true idle phase.
   *
   * Exclusivity is the whole contract (D7 note 8): the task starts
   * synchronously after claiming the phase, and a second claim — or a claim
   * while a turn is running — throws SYNCHRONOUSLY rather than returning a
   * rejected promise, so a caller cannot accidentally `await` its way past the
   * conflict. Public status stays `idle` throughout, and waking input sent
   * meanwhile waits in the inbox until the task settles.
   *
   * @param task - the operation; its signal is aborted by {@link ClaudeCodeAgent.cancel}.
   * @returns the task's promise, fulfillment and rejection preserved.
   * @throws synchronously when a turn or another maintenance task already owns the agent.
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#maintenance !== undefined) {
      throw new Error(`agent "${this.id}" already has an active maintenance task`)
    }
    if (this.#status === 'running') {
      throw new Error(`agent "${this.id}" is driving a turn and cannot start a maintenance task`)
    }
    const abort = new AbortController()
    this.#maintenance = abort
    return (async () => {
      try {
        return await task(abort.signal)
      } finally {
        this.#maintenance = undefined
        this.flushParked()
        this.sync()
      }
    })()
  }

  /**
   * Switch the model this agent's next turns use.
   *
   * **Not part of dsh's `Agent` interface, on purpose.** `AgentOptions` is a
   * readonly `{ provider?, model?, maxTokens? }` with no `setModel()` (D7), and
   * dsh's own model selection rides the `agent/request` waterfall, which never
   * fires for a CC-backed agent (D8). This is the §7.1 substitute: it reaches
   * through to the seam's `query.setModel()`, and {@link ClaudeCodeAgent.options}
   * reflects the change on its next read.
   *
   * @param model - the model id, or omitted for the CLI's own default.
   * @returns nothing.
   * @throws {ClaudeCodeError} code `SESSION_CLOSED` when the session is gone.
   */
  async setModel(model?: string): Promise<void> {
    await this.#cc.setModel(model)
  }

  /**
   * Cancel and wait for quiescence, bounded, on the disposal path.
   *
   * Disposal IS a `disposed`-cause cancel followed by quiescence — the same
   * shape `dsh-agent-loop` uses — except that the wait is bounded here: a
   * subprocess that died mid-turn will never emit the result that would settle
   * it, and plugin unload must not hang on one.
   *
   * @returns nothing; resolves on quiescence or on the drain deadline.
   */
  async drain(): Promise<void> {
    this.cancel({ kind: 'disposed' }, { keepInbox: true })
    if (this.isQuiescent()) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#quiescence.delete(wake)
        this.#logger?.debug(
          `claude-code-agent: ${this.id} did not reach quiescence within ${this.#disposeDrainMs}ms; `
          + 'closing the session anyway')
        resolve()
      }, this.#disposeDrainMs)
      timer.unref?.()
      const wake = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.#quiescence.add(wake)
    })
  }

  /**
   * Hand one message to the seam and remember which uuid carries it.
   * @param delivery - the message, its inbox target, and its text.
   * @returns nothing.
   */
  private deliver(delivery: Delivery): void {
    const mode = sendMode(delivery.target, delivery.wakeup)
    try {
      const uuid = this.#cc.send(delivery.text, { mode })
      this.#uuids.set(delivery.message.id, uuid)
    } catch (error) {
      // The session went away between the inbox insertion and the send. The
      // message never reached Claude Code, so it must not sit in the inbox
      // claiming it is pending.
      this.#logger?.debug(`claude-code-agent: ${this.id} send failed: ${describe(error)}`)
      this.inbox.remove(delivery.message.id)
      this.#uuids.delete(delivery.message.id)
    }
    this.sync()
  }

  /**
   * Deliver everything a settled maintenance task held back, oldest first.
   * @returns nothing.
   */
  private flushParked(): void {
    const parked = this.#parked.splice(0, this.#parked.length)
    for (const delivery of parked) this.deliver(delivery)
  }

  /**
   * Drop parked (never-delivered) work on a `keepInbox: false` cancel. These
   * are the only messages this adapter can honestly cancel: they never reached
   * the subprocess, so nothing else has to agree.
   * @returns nothing.
   */
  private discardParked(): void {
    const parked = this.#parked.splice(0, this.#parked.length)
    for (const delivery of parked) this.inbox.remove(delivery.message.id)
  }

  /**
   * Re-read the seam and publish whatever changed: the inbox projection, the
   * status transition, and any parked `whenIdle()`.
   * @returns nothing.
   */
  private sync(): void {
    this.reconcileInbox()
    const status = this.#closed ? 'idle' : projectStatus(this.#cc.status)
    if (status !== this.#status) {
      this.#status = status
      this.#dispatch.emit('agent/status', { status })
    }
    this.settleQuiescence()
  }

  /**
   * Fold the seam's outbox states into the durable inbox.
   *
   * The rule is one sentence: **the inbox is a projection of the outbox.** A
   * `committed` message ran, so it is CLAIMED (a pure deletion, published as
   * `agent/inbox/claimed`); a `cancelled` one never will, so it is REMOVED
   * (a canceled splice, published as `agent/inbox/discarded`); a `queued` one
   * is still pending and stays.
   *
   * Claiming goes through `Inbox.claim()` rather than a splice because that is
   * the verb whose durable event is a pure deletion — splicing would record the
   * message as *canceled*, which is the opposite of what happened. `claim()`
   * takes the whole `next-step` list plus (optionally) one `next-turn` head, so
   * it is only issued when every message it would take has actually committed.
   *
   * **This runs on EVERY message the seam emits** — once per streamed assistant
   * chunk, thousands of times per session — so it is written to cost nothing
   * until it has something to do. Two guards, both load-bearing:
   *
   * - An empty inbox returns immediately. That is the state a session spends
   *   nearly all of its life in, and it has nothing to remove and nothing to
   *   claim, so not even the outbox projection is worth building.
   * - The turn number is resolved LAZILY. `Session.events` rebuilds and freezes
   *   a copy of the entire log on every read after an append, and the mirror
   *   appends per chunk — so reading it unconditionally here would copy the
   *   whole log once per chunk and make a long session quadratic in its own
   *   length. `tests/orderings.spec.ts` pins that it is not read until a claim
   *   is actually owed.
   *
   * @returns nothing.
   */
  private reconcileInbox(): void {
    if (!this.inbox.hasPending) return
    const states = new Map(this.#cc.outbox().map(entry => [entry.uuid, entry.state]))
    for (const message of [...this.inbox.nextStep, ...this.inbox.nextTurn]) {
      const uuid = this.#uuids.get(message.id)
      if (uuid === undefined || states.get(uuid) !== 'cancelled') continue
      this.inbox.remove(message.id)
      this.#uuids.delete(message.id)
    }

    const committed = (message: UserMessage): boolean => {
      const uuid = this.#uuids.get(message.id)
      return uuid !== undefined && states.get(uuid) === 'committed'
    }
    // Resolved lazily, and at most once: the scan is only owed by a reconcile
    // that actually claims something.
    let turn: number | undefined
    for (;;) {
      const step = this.inbox.nextStep
      const stepReady = step.every(committed)
      const head = this.inbox.nextTurn[0]
      if (stepReady && head !== undefined && committed(head)) {
        this.forget(this.inbox.claim('next-turn', turn ??= this.currentTurn()))
        continue
      }
      if (stepReady && step.length > 0) {
        this.forget(this.inbox.claim('next-step', turn ??= this.currentTurn()))
        continue
      }
      break
    }
  }

  /**
   * Drop the uuid mapping of messages that are no longer pending.
   * @param messages - the messages that just left the inbox.
   * @returns nothing.
   */
  private forget(messages: readonly UserMessage[]): void {
    for (const message of messages) this.#uuids.delete(message.id)
  }

  /**
   * The turn number claimed messages are attributed to.
   *
   * Read from the log rather than counted here: the mirror owns turn framing
   * for a CC-backed session (one Claude Code turn is one dsh turn), so the last
   * `turn/start` it appended IS the current turn. Counting independently would
   * drift the moment Claude Code opened a turn on its own (auto-resume, a
   * scheduled trigger).
   *
   * @returns the open (or most recent) turn number, or 0 before the first.
   */
  private currentTurn(): number {
    const start = this.session.events.findLast(event => event.type === 'turn/start')
    return start?.data.turn ?? 0
  }

  /**
   * Whether no turn, task or queued message remains.
   * @returns true when {@link ClaudeCodeAgent.whenIdle} may resolve.
   */
  private isQuiescent(): boolean {
    if (this.#maintenance !== undefined) return false
    if (this.#parked.length > 0) return false
    if (this.#closed || this.#cc.status === 'closed') return true
    if (this.#cc.status === 'running') return false
    return !this.#cc.outbox().some(entry => entry.state === 'queued')
  }

  /**
   * Release every parked `whenIdle()` once quiescence holds.
   * @returns nothing.
   */
  private settleQuiescence(): void {
    if (!this.isQuiescent()) return
    const waiters = [...this.#quiescence]
    this.#quiescence.clear()
    for (const wake of waiters) wake()
  }

  /**
   * Record, in the transcript itself, content that could not reach Claude Code.
   *
   * A `notice` is exactly the right `ContextForm` for this — "a one-off account
   * of something that just happened" — and it REQUIRES a bounded summary, which
   * is why the account is built through `boundContextSummary()`. Written to the
   * log rather than only to the logger because the human reading the transcript
   * is the one who needs to know their image never got there.
   *
   * @param message - the message whose blocks were dropped.
   * @param dropped - the dropped block types, in order.
   * @param delivered - whether the message's text was still delivered.
   * @returns nothing.
   */
  private recordDroppedBlocks(message: UserMessage, dropped: readonly string[], delivered: boolean): void {
    const kinds = [...new Set(dropped)].join(', ')
    const account = delivered
      ? `Claude Code received the text of this message only; ${dropped.length} non-text block(s) (${kinds}) were dropped`
      : `Nothing was sent to Claude Code: this message carried only non-text blocks (${kinds})`
    this.#logger?.debug(`claude-code-agent: ${this.id} message ${message.id}: ${account}`)
    try {
      this.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: account }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-claude-code-agent',
          form: 'notice',
          summary: boundContextSummary(account),
        },
      }), { surfaceOp: 'append' })
    } catch (error) {
      // The log is a mirror, not the source of truth: failing to record the
      // loss must never fail the send that caused it.
      this.#logger?.debug(`claude-code-agent: ${this.id} could not record dropped blocks: ${describe(error)}`)
    }
  }
}

/**
 * Project the seam's four-state lifecycle onto dsh's two.
 * @param status - the Claude Code session status.
 * @returns `running` while a turn is in flight, `idle` otherwise.
 */
function projectStatus(status: string): AgentStatus {
  return status === 'running' ? 'running' : 'idle'
}

/**
 * Choose the seam send mode for one dsh inbox routing.
 * @param target - the inbox boundary.
 * @param wakeup - whether delivery may wake the session.
 * @returns the seam's send mode.
 */
function sendMode(target: InboxTarget, wakeup: boolean): CcSendMode {
  if (!wakeup) return 'inject'
  return target === 'next-step' ? 'steer' : 'followup'
}

/**
 * Build one immutable `AgentOptions` snapshot.
 * @param provider - the provider route.
 * @param model - the model, when the seam reports one.
 * @returns the frozen options object.
 */
function freezeOptions(provider: string, model: string | undefined): AgentOptions {
  return Object.freeze({ provider, ...(model === undefined ? {} : { model }) })
}

/**
 * Render any thrown value for a log line.
 * @param error - the thrown value.
 * @returns a one-line description.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
