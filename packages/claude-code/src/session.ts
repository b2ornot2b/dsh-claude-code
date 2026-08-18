/**
 * `CcSession` — one live Claude Code session, owned end to end.
 *
 * It owns the SDK query handle, the never-completing input stream, the message
 * pump, the outbox (what we sent and what became of it) and the status machine.
 * Every timer and every loop is owned here so that {@link CcSession.close} leaks
 * nothing: an undisposed session is a subprocess holding a permission callback
 * nobody will ever answer.
 *
 * Design facts this file is built on (all verified in Phase 0, `spikes/`):
 *
 * - **Streaming input is mandatory** (§3.1) — the input stream never completes.
 * - **Every send is uuid-stamped** — otherwise the interrupt receipt is silently
 *   useless (gotcha 3).
 * - **`priority: 'now'` is abort-and-refold, not token steering** (spike 2): the
 *   running turn dies with an `error_during_execution` result carrying empty
 *   text, then ONE fresh turn runs both instructions. That result is an internal
 *   artifact; it is flagged on the envelope so the Phase 3 mirror can suppress it.
 * - **Queued messages coalesce** (spike 3): N still-queued messages run as ONE
 *   turn with ONE result. Never assume a 1:1 uuid→result mapping.
 * - **A fresh `system/init` follows an interrupted turn** (spike 3): more than
 *   one init per session is normal. Re-cache capabilities, never re-run `open()`.
 * - **`cancel_queued` is an SDK gap** (spike 3): the CLI advertises
 *   `interrupt_cancel_queued_v1` but `interrupt()` takes no arguments in
 *   0.3.233, so `keepQueued: false` is emulated here.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import type {
  CcAccountData, CcBackendQuery, CcCanUseTool, CcInitializeResult, CcInterruptReceipt,
  CcPermissionDecision, CcPermissionRequest, CcQueryOptions, CcSdkMessage, CcUuid, QueryBackend,
} from './backend.ts'
import type { CcPendingAsk } from './ask/table.ts'
import type { CcAskCallSite, CcAskTarget } from './ask/types.ts'
import type { ResolvedClaudeCodeConfig } from './config.ts'
import { createInputStream } from './input-stream.ts'
import type { CcInputStream } from './input-stream.ts'
import type { CcWarmLease } from './prewarm.ts'
import { ClaudeCodeError } from './types.ts'
import type {
  CcCloseReason, CcContextUsage, CcLogger, CcPermissionMode, CcSessionId, CcSessionSnapshot,
  CcSessionStatus,
} from './types.ts'

/**
 * How a send reaches the session. The three modes are dsh's three inbox verbs,
 * each mapped onto the SDK mechanism that actually implements it:
 *
 * | mode | SDK mechanism | effect |
 * |---|---|---|
 * | `followup` | plain uuid-stamped message | queues; runs as its own next turn |
 * | `steer` | `priority: 'now'` | aborts the running turn, refolds both instructions into one |
 * | `inject` | `shouldQuery: false` | appended to the transcript, starts no turn |
 */
export type CcSendMode = 'followup' | 'steer' | 'inject'

/** Options for {@link CcSession.send}. */
export interface CcSendOptions {
  /** Which inbox verb this is. Defaults to `'followup'`. */
  readonly mode?: CcSendMode
}

/** What the session knows about one message it sent. */
export type CcOutboxState =
  /** Handed to the SDK; has not yet been observed running. */
  | 'queued'
  /** Ran (or was folded into a turn that ran). */
  | 'committed'
  /** Discarded by a `keepQueued: false` cancel; it will never run. */
  | 'cancelled'

/** One outbox entry: what we sent, how, and what became of it. */
export interface CcOutboxEntry {
  /** The uuid stamped on the message — the interrupt receipt's key. */
  readonly uuid: CcUuid
  /** How it was sent. */
  readonly mode: CcSendMode
  /** `Date.now()` at send time. */
  readonly sentAt: number
  /** Reconciliation state. */
  readonly state: CcOutboxState
}

/**
 * Why a message is being fanned out, alongside the message itself. The Phase 3
 * mirror reads this instead of re-deriving the context it cannot see.
 */
export interface CcMessageMeta {
  /** The session that produced the message. */
  readonly sessionId: CcSessionId
  /** `Date.now()` when the pump observed it. */
  readonly receivedAt: number
  /**
   * True for the `error_during_execution` result that a `steer` send produces
   * when it aborts the running turn. It is an internal artifact of the steering
   * mechanism, not a failure: the mirror must NOT surface it as a turn error.
   *
   * Strictly narrower than {@link CcMessageMeta.interruptedTurn}: an artifact is
   * additionally SUPPRESSED — it never becomes `lastResult` and never settles a
   * `waitForResult()`, because the refolded turn's real result is still coming.
   */
  readonly interruptArtifact: boolean
  /**
   * True for the `error_during_execution` result of a turn THIS seam aborted —
   * either a `steer` send's implicit abort (spike 2) or an explicit
   * {@link CcSession.interrupt} (spike 3 observed the identical result shape for
   * both). The turn did not FAIL; it was cancelled on our own instruction, and a
   * mirror or an agent adapter must render it that way.
   *
   * A plain `interrupt()`'s abort result is flagged but NOT suppressed: with an
   * empty queue behind it, it is the only signal that the turn ended, so
   * withholding it would strand every `waitForResult()` until its timeout.
   *
   * Best-effort by construction: an `interrupt()` that lands between turns
   * produces no abort result at all, so the expectation is dropped at the next
   * turn boundary of any other kind rather than mislabelling a later failure.
   */
  readonly interruptedTurn: boolean
  /**
   * True for a `system/init` that is not the session's first — the SDK emits a
   * fresh one after every interrupted turn. Capabilities are re-cached; no
   * session lifecycle logic re-runs.
   */
  readonly reinit: boolean
}

/** One fan-out payload: the raw SDK message plus this seam's interpretation of it. */
export interface CcMessageEnvelope {
  /** The message exactly as the SDK produced it. */
  readonly message: CcSdkMessage
  /** Session-level context the mirror cannot derive on its own. */
  readonly meta: CcMessageMeta
}

/**
 * A fan-out subscriber.
 * @param envelope - the message and its metadata.
 */
export type CcMessageListener = (envelope: CcMessageEnvelope) => void

/**
 * One message this session SENT.
 *
 * Outgoing messages never come back over {@link CcSession.onMessage} — the CLI
 * does not echo the prompt it was given — so a mirror that must record
 * `user/message` framing (§5.2) has to observe the send side. This is that
 * seam, and it is deliberately the ONLY thing a mirror learns about sends.
 */
export interface CcSendRecord {
  /** The session that sent it. */
  readonly sessionId: CcSessionId
  /** The uuid the message was stamped with — the outbox and receipt key. */
  readonly uuid: CcUuid
  /** Which inbox verb this was. */
  readonly mode: CcSendMode
  /** The message text, exactly as handed to the SDK. */
  readonly content: string
  /** `Date.now()` at send time. */
  readonly sentAt: number
}

/**
 * A send subscriber.
 * @param send - what was sent.
 */
export type CcSendListener = (send: CcSendRecord) => void

/**
 * A close subscriber.
 *
 * It takes the REASON because a session no longer closes only when asked: a
 * subprocess that exits or dies closes its own session (see
 * {@link CcSession.close}), and the three consumers that ride this listener —
 * the service registry, the mirror's finalize, and a background job's
 * settlement — each need to tell "somebody asked" from "it died mid-turn".
 *
 * @param reason - why the session closed.
 */
export type CcCloseListener = (reason: CcCloseReason) => void

/** Identity and per-session shape of one `CcSession`. */
export interface CcSessionOptions {
  /** The shared dsh/CC id. A bare UUID, minted by the service (or pre-minted by the warm pool). */
  readonly id: CcSessionId
  /** Absolute working directory. */
  readonly cwd: string
  /** Model id; omitted means `config.defaults.model`, then the CLI default. */
  readonly model?: string
  /** Permission mode; omitted means `config.defaults.permissionMode`. */
  readonly permissionMode?: CcPermissionMode
  /** Resume this session's history. */
  readonly resume?: CcSessionId
  /**
   * Fork the resumed session rather than continuing it. A fork ALWAYS passes our
   * own fresh `sessionId` (spike 1: the SDK honors it, and the source session is
   * left untouched), so no id mapping exists anywhere.
   */
  readonly fork?: boolean
}

/**
 * The ask channel one session is wired to (Phase 4's `CcAskRouter` satisfies it
 * structurally).
 *
 * Stated here, in the session's own vocabulary, so the actor depends on the
 * CAPABILITY rather than on the router class: a test drives a two-line double,
 * and a session constructed without one still fails closed.
 */
export interface CcAskChannel {
  /** The permission callback the SDK is given. */
  readonly canUseTool: CcCanUseTool
  /** How many asks are awaiting an answer right now. */
  readonly pendingAsks: number
  /** WHAT is awaiting an answer right now — kind, tool, reason, and since when. */
  readonly pendingAskDetails: readonly CcPendingAsk[]
  /**
   * Set who answers for this session.
   * @param target - the dsh agent and its optional seam overrides.
   * @returns a disposer detaching exactly this target.
   */
  attachTarget(target: CcAskTarget): () => void
  /**
   * Point the channel at the mirror that logs this session's tool calls (§4.4).
   * @param site - the mirror.
   * @returns a disposer detaching exactly this call site.
   */
  attachCallSite(site: CcAskCallSite): () => void
  /**
   * Settle every pending ask as denied (the session's close path).
   * @param message - the deny message.
   * @returns how many asks were settled.
   */
  settleAll(message?: string): number
  /**
   * Subscribe to unanswerable-ask failures (`askFallback: 'error'`).
   * @param listener - called with the typed `ASK_UNANSWERABLE` error.
   * @returns an unsubscribe function.
   */
  onError(listener: (error: ClaudeCodeError) => void): () => void
}

/** Everything a session needs from its surroundings. Injected so unit tests run offline. */
export interface CcSessionDeps {
  /** The SDK boundary. Tests pass a fake. */
  readonly backend: QueryBackend
  /** The resolved plugin configuration. */
  readonly config: ResolvedClaudeCodeConfig
  /** Subprocess stderr / diagnostics sink. */
  readonly logger?: CcLogger
  /**
   * An explicit permission callback, overriding {@link CcSessionDeps.asks}.
   * Tests use it to script decisions; production wires the ask channel instead.
   * With neither, the session fails CLOSED — every tool call is denied with an
   * explanation, never silently allowed.
   */
  readonly canUseTool?: CcCanUseTool
  /**
   * The dsh ask channel (§4): permission prompts, clarifying questions and plan
   * reviews routed to `ctx.approval` / `ctx.userQuestions`. Owns the pending-ask
   * table, so it also answers {@link CcSession.pendingAsks} and drains on close.
   */
  readonly asks?: CcAskChannel
  /**
   * Resolve the API key for `auth: 'api-key'`. Phase 5 wires
   * `ctx.credentials.get(config.apiKeyRef)`; until then the hook is typed and
   * unset, and an api-key session inherits whatever the ambient env holds.
   * @returns the key, or undefined when none can be resolved.
   */
  readonly resolveApiKey?: () => Promise<string | undefined>
  /**
   * A pre-warmed subprocess to adopt instead of spawning a cold one. Its
   * `sessionId` and `AbortController` were fixed at `startup()`, so the session
   * adopts BOTH — the lease's id must equal this session's id.
   */
  readonly warm?: CcWarmLease
  /** Poll interval for the `keepQueued: false` drain loop. Defaults to 250ms; tests shrink it. */
  readonly drainPollMs?: number
}

/** Options for {@link CcSession.interrupt}. */
export interface CcInterruptOptions {
  /**
   * `true` (the default) leaves queued messages alone — they each run as their
   * own turn, exactly as the receipt promises. `false` asks for them to be
   * discarded, which this seam EMULATES (see {@link CcSession.interrupt}).
   */
  readonly keepQueued?: boolean
}

/** What an interrupt reports back to the caller. */
export interface CcInterruptOutcome {
  /** Uuids that survived and will still run. Empty after a successful `keepQueued: false` drain. */
  readonly stillQueued: readonly string[]
  /** Uuids this seam marked cancelled (emulated; see the method docs). */
  readonly cancelled: readonly string[]
  /** False when the CLI does not advertise `interrupt_receipt_v1` and returned no receipt. */
  readonly receiptSupported: boolean
}

/** One parked {@link CcSession.waitForResult} call. */
interface ResultWaiter {
  /**
   * Deliver the awaited result.
   * @param envelope - the result envelope.
   */
  resolve(envelope: CcMessageEnvelope): void
  /**
   * Fail the wait (timeout, or the session closed).
   * @param error - the reason.
   */
  reject(error: unknown): void
  /** The timeout handle, when the caller passed a deadline. */
  timer?: NodeJS.Timeout
}

/** Default poll interval between drain attempts. */
const DEFAULT_DRAIN_POLL_MS = 250

/** Fail-closed permission answer for a session wired to no ask channel at all. */
const DEFAULT_DENY_MESSAGE
  = 'Denied: this Claude Code session has no dsh ask channel attached, so no permission answerer '
  + 'exists. Nothing was executed.'

/**
 * One live Claude Code session.
 *
 * Lifecycle: `new CcSession(...)` → {@link CcSession.open} → any number of
 * {@link CcSession.send} / {@link CcSession.interrupt} / {@link CcSession.waitForResult}
 * → {@link CcSession.close}. Every method after `close()` either no-ops
 * (`close`) or throws `SESSION_CLOSED`.
 */
export class CcSession {
  /** The shared dsh/CC session id. */
  readonly id: CcSessionId

  readonly #options: CcSessionOptions
  readonly #deps: CcSessionDeps
  readonly #input: CcInputStream = createInputStream()
  readonly #abort: AbortController
  readonly #listeners = new Set<CcMessageListener>()
  readonly #sendListeners = new Set<CcSendListener>()
  readonly #outbox = new Map<string, CcOutboxEntry>()
  readonly #resultWaiters = new Set<ResultWaiter>()
  /** Resolvers woken by the pump on every turn boundary (used by the drain loop). */
  readonly #turnBoundaryWaiters = new Set<() => void>()
  /** One-shot close subscribers (the service's registry cleanup). */
  readonly #closeListeners = new Set<CcCloseListener>()
  /** Subscribers to unanswerable-ask failures. */
  readonly #askErrorListeners = new Set<(error: ClaudeCodeError) => void>()

  #status: CcSessionStatus = 'starting'
  #query: CcBackendQuery | undefined
  #pump: Promise<CcCloseReason> | undefined
  #initialize: CcInitializeResult | undefined
  #capabilities: readonly string[] = []
  #initCount = 0
  #model: string | undefined
  #contextUsage: CcContextUsage | undefined
  #lastResult: CcMessageEnvelope | undefined
  /** The last `ASK_UNANSWERABLE` failure the ask channel reported. */
  #lastAskError: ClaudeCodeError | undefined
  #closed = false
  #closing: Promise<void> | undefined
  /** Why this session closed, once it has. Undefined while it is still live. */
  #closeReason: CcCloseReason | undefined
  /**
   * Number of `error_during_execution` results still expected as steering
   * artifacts. A counter, not a boolean: two steers in flight produce two.
   */
  #pendingSteerArtifacts = 0
  /**
   * Number of abort results still expected from explicit {@link CcSession.interrupt}
   * calls. Unlike a steer artifact these are flagged but NOT suppressed — see
   * {@link CcMessageMeta.interruptedTurn}.
   */
  #pendingInterruptArtifacts = 0
  /** Uuids that started the turn currently running (they coalesce into one result). */
  #currentBatch: CcUuid[] = []
  /** Uuids queued while a turn was running; they become the next turn's batch. */
  #nextBatch: CcUuid[] = []

  /**
   * @param options - identity and per-session shape.
   * @param deps - backend, config and the seams a session reads opportunistically.
   */
  constructor(options: CcSessionOptions, deps: CcSessionDeps) {
    this.id = options.id
    this.#options = options
    this.#deps = deps
    this.#model = options.model ?? deps.config.defaults.model
    // A leased subprocess was started with ITS controller; adopting it is what
    // keeps `close()`'s abort meaningful for a warm session.
    this.#abort = deps.warm?.abortController ?? new AbortController()
    // The channel is per-session and dies with it, so this subscription needs no
    // disposer of its own.
    deps.asks?.onError((error) => {
      this.#lastAskError = error
      this.emitAskError(error)
    })
  }

  /** Lifecycle state: `starting` → `idle` ⇄ `running` → `closed`. */
  get status(): CcSessionStatus {
    return this.#status
  }

  /**
   * Why this session closed, or undefined while it is still live.
   *
   * `status === 'closed'` alone no longer means somebody asked for it: a dead
   * subprocess closes its own session now (see {@link CcSession.close}), so this
   * is what tells a clean exit from a crash.
   */
  get closeReason(): CcCloseReason | undefined {
    return this.#closeReason
  }

  /** Permission/question asks awaiting an answer (§4.6). Zero without an ask channel. */
  get pendingAsks(): number {
    return this.#deps.asks?.pendingAsks ?? 0
  }

  /**
   * WHAT those asks are: kind, tool, the reason the human is reading, and when
   * each started pending. Empty without an ask channel — and empty is the
   * honest answer there, because a session with no channel denies fail-closed
   * and never leaves anything pending.
   */
  get pendingAskDetails(): readonly CcPendingAsk[] {
    return this.#deps.asks?.pendingAskDetails ?? []
  }

  /**
   * The last unanswerable-ask failure, when `ask.fallback` is `'error'`.
   *
   * `'error'` denies with `interrupt: true` AND surfaces the failure here (and
   * to {@link CcSession.onAskError}) so the owning tool call can report the
   * routing failure instead of the model quietly improvising around it.
   */
  get lastAskError(): ClaudeCodeError | undefined {
    return this.#lastAskError
  }

  /** The CLI capabilities advertised on the latest `system/init` (feature-detect on these, never on a version). */
  get capabilities(): readonly string[] {
    return this.#capabilities
  }

  /** The cached initialize response, once {@link CcSession.open} has completed. */
  get initializeResult(): CcInitializeResult | undefined {
    return this.#initialize
  }

  /** The account the subprocess authenticated as, from the cached initialize response. */
  get account(): CcAccountData | undefined {
    return this.#initialize?.account
  }

  /** The latest result message seen, with its envelope metadata. */
  get lastResult(): CcMessageEnvelope | undefined {
    return this.#lastResult
  }

  /**
   * The outbox: every message this session sent, and what became of it.
   * @returns a snapshot array in send order (never a live view).
   */
  outbox(): readonly CcOutboxEntry[] {
    return [...this.#outbox.values()]
  }

  /**
   * The public value projection of this session.
   * @returns a serializable snapshot.
   */
  snapshot(): CcSessionSnapshot {
    return {
      id: this.id,
      status: this.#status,
      ...(this.#model === undefined ? {} : { model: this.#model }),
      pendingAsks: this.pendingAsks,
      pendingAskDetails: this.pendingAskDetails,
      ...(this.#contextUsage === undefined ? {} : { contextUsage: this.#contextUsage }),
      ...(this.#closeReason === undefined ? {} : { closeReason: this.#closeReason }),
    }
  }

  /**
   * Subscribe to every message this session produces. The Phase 3 mirror
   * attaches here.
   *
   * A listener that throws is isolated: it is logged and the other listeners
   * still run, because one bad subscriber must never stall the pump (which
   * would stall the subprocess).
   *
   * @param listener - called for each message, in arrival order.
   * @returns an unsubscribe function; calling it twice is harmless.
   */
  onMessage(listener: CcMessageListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Subscribe to every message this session SENDS.
   *
   * The Phase 3 mirror needs it because outgoing messages never come back over
   * {@link CcSession.onMessage}: the CLI does not echo the prompt it was given,
   * so the send side is the only place `turn/start` + `user/message` framing can
   * come from (§5.2). Listener failures are isolated exactly as in `onMessage`.
   *
   * @param listener - called for each send, synchronously, in send order.
   * @returns an unsubscribe function; calling it twice is harmless.
   */
  onSend(listener: CcSendListener): () => void {
    this.#sendListeners.add(listener)
    return () => {
      this.#sendListeners.delete(listener)
    }
  }

  /**
   * Run `listener` once, when this session finishes closing (for any reason,
   * including a teardown-driven close). The service uses it to drop the registry
   * entry so a closed session never lingers in `list()`.
   *
   * Subscribing to an ALREADY closed session runs the listener immediately with
   * the reason it closed for — the same value it would have received had it
   * been subscribed in time.
   *
   * @param listener - called after the session reaches `closed`, with why.
   * @returns an unsubscribe function.
   */
  onClose(listener: CcCloseListener): () => void {
    if (this.#closed) {
      listener(this.#closeReason ?? 'closed')
      return () => {}
    }
    this.#closeListeners.add(listener)
    return () => {
      this.#closeListeners.delete(listener)
    }
  }

  /**
   * Attach WHO answers this session's permission prompts, clarifying questions
   * and plan reviews (§4.5).
   *
   * Attach it BEFORE the first prompt: a tool call that lands with no target
   * is denied fail-closed, which is safe but wastes a turn.
   *
   * @param target - the dsh agent and its optional seam overrides.
   * @returns a disposer detaching exactly this target.
   * @throws {ClaudeCodeError} code `ASK_UNAVAILABLE` when the session was
   *   constructed without an ask channel (a white-box test, or a consumer that
   *   supplied its own `canUseTool`).
   */
  attachAskTarget(target: CcAskTarget): () => void {
    return this.askChannel().attachTarget(target)
  }

  /**
   * Point the ask channel at the mirror that logs this session's tool calls, so
   * an approval request can carry the `callId` of a call the UI already
   * streamed (§4.4). Owned by the service, which owns the mirror.
   *
   * @param site - the mirror.
   * @returns a disposer detaching exactly this call site.
   * @throws {ClaudeCodeError} code `ASK_UNAVAILABLE` without an ask channel.
   */
  attachAskCallSite(site: CcAskCallSite): () => void {
    return this.askChannel().attachCallSite(site)
  }

  /**
   * Subscribe to unanswerable-ask failures (`ask.fallback: 'error'`).
   * @param listener - called with the typed `ASK_UNANSWERABLE` error.
   * @returns an unsubscribe function.
   */
  onAskError(listener: (error: ClaudeCodeError) => void): () => void {
    this.#askErrorListeners.add(listener)
    return () => {
      this.#askErrorListeners.delete(listener)
    }
  }

  /**
   * Start the session: build the query (adopting a pre-warmed handle when one
   * was supplied), start the message pump, await the initialize handshake and
   * cache what it reports.
   *
   * The pump starts BEFORE the handshake is awaited on purpose: control
   * responses are delivered on the same stream the pump drains, so awaiting
   * `initializationResult()` without a live consumer deadlocks.
   *
   * @returns nothing; the session is `idle` when it resolves.
   * @throws {ClaudeCodeError} code `BACKEND_ERROR` when the SDK fails to start
   *   the session; the session is closed before the error propagates.
   */
  async open(): Promise<void> {
    if (this.#query !== undefined) return
    if (this.#closed) {
      throw new ClaudeCodeError(`claude-code: session ${this.id} is closed`, 'SESSION_CLOSED')
    }

    const warm = this.#deps.warm
    if (warm !== undefined && warm.sessionId !== this.id) {
      // The pool pre-mints the id and the session adopts it; a mismatch would
      // mean the CLI's transcript and dsh's session log disagree about identity.
      throw new ClaudeCodeError(
        `claude-code: warm lease ${warm.sessionId} cannot serve session ${this.id}`,
        'INVALID_SESSION_ID')
    }

    const options = await this.queryOptions()
    try {
      if (warm === undefined) {
        this.#query = this.#deps.backend.query({ prompt: this.#input, options })
      } else {
        // The warmed subprocess froze its options at startup(); only the two
        // indirection hooks can still be pointed at this session.
        warm.bind({
          canUseTool: options.canUseTool ?? denyAll,
          stderr: options.stderr ?? (() => {}),
        })
        this.#query = warm.query(this.#input)
      }
      const pump = this.runPump(this.#query)
      this.#pump = pump
      // Armed BEFORE the handshake is awaited: a subprocess that dies during
      // initialization ends the pump too, and the `BACKEND_ERROR` path below
      // closes with `'closed'` only because it gets there first (`#closing` is
      // set synchronously by `close()`, which is exactly the guard).
      this.armSelfClose(pump)
      this.cacheInitialize(await this.#query.initializationResult())
    } catch (error) {
      await this.close()
      throw new ClaudeCodeError(
        `claude-code: failed to open session ${this.id}: ${describe(error)}`,
        'BACKEND_ERROR',
        { cause: error })
    }
    if (this.#status === 'starting') this.#status = 'idle'
  }

  /**
   * Send one message.
   *
   * @param input - the message text, or an envelope with a caller-supplied uuid.
   * @param options - which inbox verb this is (`followup` by default).
   * @returns the uuid the message was stamped with — the key it appears under in
   *   the outbox and in any interrupt receipt.
   * @throws {ClaudeCodeError} code `SESSION_CLOSED` when the session is closed.
   */
  send(input: string | { readonly content: string, readonly uuid?: CcUuid }, options: CcSendOptions = {}): CcUuid {
    this.assertOpen()
    const mode = options.mode ?? 'followup'
    const init = typeof input === 'string' ? { content: input } : input

    const uuid = this.#input.push({
      content: init.content,
      ...(init.uuid === undefined ? {} : { uuid: init.uuid }),
      sessionId: this.id,
      // Steering is abort-and-refold, not token-level steering (spike 2).
      ...(mode === 'steer' ? { priority: 'now' as const } : {}),
      // Injection appends to the transcript and starts no turn (delta S7).
      ...(mode === 'inject' ? { shouldQuery: false } : {}),
    })

    const sentAt = Date.now()
    this.#outbox.set(uuid, { uuid, mode, sentAt, state: mode === 'inject' ? 'committed' : 'queued' })
    // Fanned out BEFORE the status machine moves: a subscriber only ever learns
    // that a message left, never how the session interpreted it.
    this.emitSend({ sessionId: this.id, uuid, mode, content: init.content, sentAt })

    if (mode === 'inject') {
      // No turn is started, so the status machine is untouched: an inject on an
      // idle session leaves it idle.
      return uuid
    }
    if (mode === 'steer') {
      // The running turn dies and both instructions refold into ONE fresh turn,
      // so the steer joins the CURRENT batch rather than starting a new one, and
      // the abort emits an `error_during_execution` result we must not read as a
      // turn boundary.
      if (this.#status === 'running') this.#pendingSteerArtifacts += 1
      this.#currentBatch.push(uuid)
    } else if (this.#status === 'running') {
      this.#nextBatch.push(uuid)
    } else {
      this.#currentBatch = [uuid]
    }
    this.#status = 'running'
    return uuid
  }

  /**
   * Wait for the current turn's result.
   *
   * @param timeoutMs - bounded wait; omitted means wait indefinitely.
   * @returns the latest result envelope. Resolves immediately when the session
   *   is already idle and a result has been seen.
   * @throws {ClaudeCodeError} code `TIMEOUT` when the wait elapses (the session
   *   keeps running), or `SESSION_CLOSED` when the session closes first.
   */
  async waitForResult(timeoutMs?: number): Promise<CcMessageEnvelope> {
    if (this.#closed) {
      throw new ClaudeCodeError(`claude-code: session ${this.id} is closed`, 'SESSION_CLOSED')
    }
    if (this.#status !== 'running' && this.#lastResult !== undefined) return this.#lastResult

    return await new Promise<CcMessageEnvelope>((resolve, reject) => {
      const waiter: ResultWaiter = {
        resolve: (envelope) => {
          this.clearWaiter(waiter)
          resolve(envelope)
        },
        reject: (error) => {
          this.clearWaiter(waiter)
          reject(error)
        },
      }
      if (timeoutMs !== undefined) {
        // `unref()` so a pending wait never holds the process open; the timer is
        // cleared on every settle path, so nothing outlives the session.
        waiter.timer = setTimeout(() => {
          waiter.reject(new ClaudeCodeError(
            `claude-code: session ${this.id} produced no result within ${timeoutMs}ms`,
            'TIMEOUT'))
        }, timeoutMs)
        waiter.timer.unref?.()
      }
      this.#resultWaiters.add(waiter)
    })
  }

  /**
   * Switch the model this session's next turns use.
   *
   * This is the ONLY model-switching path a CC-backed session has, and it is
   * the §7.1 substitute for a mechanism dsh has but cannot use here: dsh's own
   * model selection rides `installModelSelection()` + the `agent/request`
   * waterfall, which is dispatched only from `ReactLoopAgent` around
   * `ctx.llm.stream()` and therefore NEVER fires for a session Claude Code
   * drives (review finding D8). `AgentOptions` has no `setModel()` either
   * (D7) — so the adapter reaches through to here.
   *
   * The switch takes effect on the CLI's side; the snapshot is updated
   * optimistically to what was asked for, and the next `system/init` (the CLI
   * emits one after every interrupted turn) overwrites it with what the CLI
   * actually adopted.
   *
   * @param model - the model id, or omitted for the CLI's own default (which
   *   leaves `snapshot().model` ABSENT until the CLI reports one).
   * @returns nothing.
   * @throws {ClaudeCodeError} code `SESSION_CLOSED` when the session is closed
   *   or was never opened.
   */
  async setModel(model?: string): Promise<void> {
    this.assertOpen()
    const query = this.#query
    if (query === undefined) {
      throw new ClaudeCodeError(`claude-code: session ${this.id} is not open`, 'SESSION_CLOSED')
    }
    await query.setModel(model)
    this.#model = model
  }

  /**
   * Interrupt the running turn and reconcile the receipt.
   *
   * `keepQueued: true` (the default) is the honest mapping of dsh's
   * `cancel({ keepInbox: true })`: queued messages survive and each runs.
   *
   * `keepQueued: false` is **emulated**. The CLI advertises
   * `interrupt_cancel_queued_v1`, but SDK 0.3.233 exposes no way to drive it —
   * `interrupt()` takes no arguments and there is no `cancelAsyncMessage()`.
   * So this seam interrupts again each time a surviving turn starts, capped at
   * `still_queued.length + 2` attempts, and marks those uuids `cancelled` in the
   * outbox so nothing re-delivers them. Replace this with the native path the
   * moment the SDK exposes it (tracked in the README's deferred-work list).
   *
   * Either way the aborted turn emits its own `error_during_execution` result
   * (spike 3's probe log). It is flagged `meta.interruptedTurn` but deliberately
   * NOT suppressed: unlike a steer, an interrupt may have nothing queued behind
   * it, so that result is the only signal the turn ended.
   *
   * @param options - whether queued messages survive.
   * @returns what survived, what was cancelled, and whether a receipt was available.
   * @throws {ClaudeCodeError} code `SESSION_CLOSED` when the session is closed.
   */
  async interrupt(options: CcInterruptOptions = {}): Promise<CcInterruptOutcome> {
    this.assertOpen()
    const keepQueued = options.keepQueued ?? true
    const query = this.#query
    if (query === undefined) {
      throw new ClaudeCodeError(`claude-code: session ${this.id} is not open`, 'SESSION_CLOSED')
    }

    const receipt = await this.interruptOnce(query)
    const stillQueued = this.reconcileReceipt(receipt)
    if (keepQueued || stillQueued.length === 0) {
      return { stillQueued, cancelled: [], receiptSupported: receipt !== undefined }
    }
    const cancelled = await this.drainQueued(stillQueued)
    return {
      stillQueued: this.queuedUuids(),
      cancelled,
      receiptSupported: receipt !== undefined,
    }
  }

  /**
   * Close the session. Idempotent, and safe to call from a disposal path.
   *
   * Order is the one §5.4 requires, and it matters: pending asks settle FIRST,
   * so nothing is racing a held promise when the query goes away; the input
   * stream ends LAST, because ending it is what finally lets the subprocess
   * exit.
   *
   * **This is also the DEAD-SUBPROCESS path.** When the SDK's message iterator
   * completes — the subprocess exited, was killed, or its stream threw — the
   * pump calls this with `'exited'` or `'crashed'` instead of leaving the
   * session parked in `running` forever. That was the Phase 6 carry-forward
   * (api-contract correction 42): nothing closed on pump completion, so a dead
   * subprocess left `CcSession.status` at `running`, `agent.whenIdle()` unsettled,
   * pending asks held, the mirror's turn dangling and a background job unsettled
   * until something else happened to call `close()`. Routing pump death through
   * THIS method — rather than a parallel teardown — is what guarantees the two
   * paths cannot drift: there is exactly one close sequence, and `reason` is the
   * only thing that differs.
   *
   * @param reason - why the session is closing. Defaults to `'closed'` (somebody
   *   asked); the pump supplies `'exited'` / `'crashed'`.
   * @returns nothing; every waiter has been settled when it resolves.
   */
  async close(reason: CcCloseReason = 'closed'): Promise<void> {
    if (this.#closing !== undefined) return await this.#closing
    // REENTRANCY, not redundancy. `#closing` is assigned only AFTER `runClose()`
    // has run its whole synchronous prefix — which includes calling every
    // `onClose` listener — so a listener that closes the session from inside its
    // own notification would find `#closing` still unset and start a SECOND
    // close sequence over a half-torn-down session, re-notifying itself and
    // recursing until the stack ran out (`#closeListeners` is cleared after the
    // loop, not before it). `#closed` is set on `runClose()`'s first line, so it
    // is the flag that covers that window. Returning without awaiting is the
    // only correct answer here: the caller is running INSIDE the close it would
    // be waiting for.
    if (this.#closed) return
    this.#closing = this.runClose(reason)
    return await this.#closing
  }

  /**
   * Settle asks, tear down the query, end the stream, settle every waiter.
   * @param reason - why the session is closing.
   * @returns nothing.
   */
  private async runClose(reason: CcCloseReason): Promise<void> {
    this.#closed = true
    this.#closeReason = reason
    // 1. Settle pending asks — nothing may be left holding a promise the
    //    closed query can never answer (§4.6).
    this.settleAsks()
    // 2. Abort in-flight work, 3. close the query, 4. end the input stream.
    this.#abort.abort()
    try {
      this.#query?.close()
    } catch (error) {
      this.#deps.logger?.debug(`claude-code: session ${this.id} close() raised: ${describe(error)}`)
    }
    this.#input.end()
    this.#status = 'closed'

    this.settleWaiters(reason)
    for (const wake of [...this.#turnBoundaryWaiters]) wake()
    this.#turnBoundaryWaiters.clear()
    this.#listeners.clear()
    this.#sendListeners.clear()
    this.#askErrorListeners.clear()
    for (const listener of [...this.#closeListeners]) {
      try {
        listener(reason)
      } catch (error) {
        this.#deps.logger?.debug(`claude-code: session ${this.id} close listener threw: ${describe(error)}`)
      }
    }
    this.#closeListeners.clear()

    // The pump ends when the query's iterator completes; awaiting it here is
    // what guarantees no callback fires after close() resolves.
    try {
      await this.#pump
    } catch (error) {
      this.#deps.logger?.debug(`claude-code: session ${this.id} pump ended with: ${describe(error)}`)
    }
  }

  /**
   * Release every parked {@link CcSession.waitForResult} on the close path.
   *
   * Every waiter still parked here is FAILED, and that is not a shortcut: a
   * waiter only ever parks when this session owes it a result it has not
   * produced. {@link CcSession.waitForResult} hands back `#lastResult`
   * immediately whenever the session is not `running` and a result exists, and
   * {@link CcSession.observe} resolves every parked waiter the moment a
   * non-artifact result lands — so "the last result, if one arrived" is already
   * answered on those two paths, and by the time close runs, a still-parked
   * waiter is waiting on a turn that produced nothing.
   *
   * Resolving one from cache HERE would be actively wrong: the cached value is
   * the PREVIOUS turn's answer, and handing it to a caller that asked about the
   * turn the subprocess died in would attribute stale output to a request that
   * never completed.
   *
   * The reason travels in the message rather than in the code, because the code
   * is what consumers route on and `SESSION_CLOSED` is the same actionable fact
   * however the session ended: there is nothing left to wait for. Callers that
   * need the cause read {@link CcSessionSnapshot.closeReason}.
   *
   * @param reason - why the session is closing.
   * @returns nothing.
   */
  private settleWaiters(reason: CcCloseReason): void {
    const waiters = [...this.#resultWaiters]
    if (waiters.length === 0) return
    const closedError = new ClaudeCodeError(
      `claude-code: session ${this.id} closed before a result arrived (${reason})`, 'SESSION_CLOSED')
    for (const waiter of waiters) waiter.reject(closedError)
  }

  /**
   * Settle every pending ask as denied.
   *
   * Runs FIRST on the close path (§5.4): a subprocess holding a permission
   * promise nobody will ever resolve is exactly the leak `close()` exists to
   * prevent, and the SDK cancels the wait only when the query is cancelled.
   * @returns nothing.
   */
  private settleAsks(): void {
    const settled = this.#deps.asks?.settleAll() ?? 0
    if (settled > 0) {
      this.#deps.logger?.debug(
        `claude-code: session ${this.id} denied ${settled} pending ask(s) on close`)
    }
  }

  /**
   * The ask channel, or a typed failure naming the reason there is none.
   * @returns the channel.
   * @throws {ClaudeCodeError} code `ASK_UNAVAILABLE`.
   */
  private askChannel(): CcAskChannel {
    const asks = this.#deps.asks
    if (asks === undefined) {
      throw new ClaudeCodeError(
        `claude-code: session ${this.id} was constructed without a dsh ask channel, so nothing can `
        + 'answer its permission prompts',
        'ASK_UNAVAILABLE')
    }
    return asks
  }

  /**
   * Fan one unanswerable-ask failure out, isolating listener failures.
   * @param error - the typed failure.
   * @returns nothing.
   */
  private emitAskError(error: ClaudeCodeError): void {
    for (const listener of [...this.#askErrorListeners]) {
      try {
        listener(error)
      } catch (failure) {
        this.#deps.logger?.debug(
          `claude-code: session ${this.id} ask-error listener threw: ${describe(failure)}`)
      }
    }
  }

  /**
   * Refuse work on a closed session.
   * @throws {ClaudeCodeError} code `SESSION_CLOSED`.
   */
  private assertOpen(): void {
    if (this.#closed) {
      throw new ClaudeCodeError(`claude-code: session ${this.id} is closed`, 'SESSION_CLOSED')
    }
  }

  /**
   * Build the SDK options for this session (§3.2, with the review's corrections).
   * @returns the resolved options object.
   */
  private async queryOptions(): Promise<CcQueryOptions> {
    return await resolveQueryOptions(this.#options, this.#deps, this.#abort)
  }

  /**
   * The single consumer of the query's async iterator: fan-out plus the status
   * machine. One loop, owned by the session, awaited by `close()`.
   *
   * It resolves with the {@link CcCloseReason} its ending IMPLIES rather than
   * acting on it, because acting here would deadlock: `runClose()` awaits this
   * very promise, so a `close()` issued from inside the loop's own continuation
   * would wait for itself forever. {@link CcSession.armSelfClose} attaches the
   * close as a `.then` on the settled promise instead.
   *
   * @param query - the live query handle.
   * @returns why the session should close now that the iterator is done.
   */
  private async runPump(query: CcBackendQuery): Promise<CcCloseReason> {
    try {
      for await (const message of query) {
        this.observe(message)
      }
    } catch (error) {
      if (!this.#closed) {
        this.#deps.logger?.debug(`claude-code: session ${this.id} pump failed: ${describe(error)}`)
      }
      // A throwing iterator is a crash whatever the status machine believed:
      // the transport is gone, so nothing in flight can still be answered.
      return 'crashed'
    }
    // The iterator completed cleanly. Whether that was an orderly end or a kill
    // is decided by what was in flight: a turn still `running` will never get
    // the result that would have closed it.
    return this.#status === 'running' ? 'crashed' : 'exited'
  }

  /**
   * Close this session when its pump ends, unless a close is already under way.
   *
   * **The `.then` is not a stylistic choice — closing from inside the pump body
   * deadlocks.** `runClose()` awaits `#pump` (that await is what guarantees no
   * callback fires after `close()` resolves), so a `close()` issued from within
   * the loop's own execution would be waiting on the promise it is running
   * inside. Following the SETTLED promise instead is what makes the same close
   * sequence reachable from both directions.
   * `tests/session-death.spec.ts` bounds every case here for exactly that
   * reason: the in-pump version does not fail an assertion, it hangs.
   *
   * The guard makes a second close sequence over a half-torn-down session
   * impossible: `close()` sets `#closing` before it does anything else, so an
   * explicit close that is currently awaiting this very pump is already
   * accounted for by the time the pump resolves.
   *
   * Failures are swallowed into the logger on purpose. Nothing awaits this — it
   * is a detached continuation — so a rejection would become an unhandled one
   * and take the process down over a subprocess that had already died.
   *
   * @param pump - the pump promise to follow.
   * @returns nothing.
   */
  private armSelfClose(pump: Promise<CcCloseReason>): void {
    void pump.then(
      async (reason) => {
        if (this.#closing !== undefined) return
        this.#deps.logger?.debug(
          `claude-code: session ${this.id} pump ended (${reason}); closing the session`)
        await this.close(reason)
      },
      () => {
        // `runPump` catches everything it iterates; a rejection here would mean
        // the pump's own bookkeeping threw, which is still a dead session.
        if (this.#closing !== undefined) return undefined
        return this.close('crashed')
      },
    ).catch((error: unknown) => {
      this.#deps.logger?.debug(
        `claude-code: session ${this.id} self-close failed: ${describe(error)}`)
    })
  }

  /**
   * Interpret one message, update session state, then fan it out.
   * @param message - the raw SDK message.
   * @returns nothing.
   */
  private observe(message: CcSdkMessage): void {
    let interruptArtifact = false
    let interruptedTurn = false
    let reinit = false

    if (message.type === 'system' && message.subtype === 'init') {
      // More than one init per session is NORMAL: a fresh one follows every
      // interrupted turn (spike 3). Re-cache; never re-run open logic.
      this.#initCount += 1
      reinit = this.#initCount > 1
      const model = readString(message, 'model')
      if (model !== undefined) this.#model = model
      this.#capabilities = readStringArray(message, 'capabilities') ?? this.#capabilities
    } else if (message.type === 'result') {
      interruptArtifact = this.consumeSteerArtifact(message)
      // A steer's abort is an interrupt too — every artifact is an interrupted
      // turn, but only a steer's is suppressed from the public result surface.
      interruptedTurn = interruptArtifact || this.consumeInterruptArtifact(message)
      if (!interruptArtifact) this.completeTurn()
    }

    const envelope: CcMessageEnvelope = {
      message,
      meta: { sessionId: this.id, receivedAt: Date.now(), interruptArtifact, interruptedTurn, reinit },
    }
    if (message.type === 'result') {
      // A steering artifact is not a turn result: it must not become the value
      // `waitForResult()` hands back, now or from cache.
      if (!interruptArtifact) {
        this.#lastResult = envelope
        for (const waiter of [...this.#resultWaiters]) waiter.resolve(envelope)
      }
      for (const wake of [...this.#turnBoundaryWaiters]) wake()
      this.#turnBoundaryWaiters.clear()
    }
    this.emit(envelope)
  }

  /**
   * Decide whether a result is the abort artifact of a `steer` send.
   * @param message - the result message.
   * @returns true when it is an artifact the mirror must suppress.
   */
  private consumeSteerArtifact(message: CcSdkMessage): boolean {
    if (this.#pendingSteerArtifacts === 0) return false
    if (message.subtype !== 'error_during_execution') return false
    this.#pendingSteerArtifacts -= 1
    return true
  }

  /**
   * Decide whether a result is the abort of a turn an explicit
   * {@link CcSession.interrupt} killed.
   *
   * The expectation is dropped on any other kind of turn boundary: an interrupt
   * that lands after its turn already finished (or between turns) produces no
   * abort result, and a stale expectation would mislabel a genuinely failed turn
   * later on. Under-flagging is the safe direction.
   *
   * @param message - the result message.
   * @returns true when it is the abort result of an interrupt we issued.
   */
  private consumeInterruptArtifact(message: CcSdkMessage): boolean {
    if (this.#pendingInterruptArtifacts === 0) return false
    if (message.subtype !== 'error_during_execution') {
      this.#pendingInterruptArtifacts = 0
      return false
    }
    this.#pendingInterruptArtifacts -= 1
    return true
  }

  /**
   * End the running turn: commit the batch that ran and promote whatever queued
   * behind it (those messages coalesce into ONE next turn, spike 3).
   * @returns nothing.
   */
  private completeTurn(): void {
    for (const uuid of this.#currentBatch) this.commit(uuid)
    this.#currentBatch = this.#nextBatch
    this.#nextBatch = []
    this.#status = this.#currentBatch.length > 0 ? 'running' : 'idle'
  }

  /**
   * Mark one outbox entry committed, if it is still queued.
   * @param uuid - the message uuid.
   * @returns nothing.
   */
  private commit(uuid: string): void {
    const entry = this.#outbox.get(uuid)
    if (entry === undefined || entry.state !== 'queued') return
    this.#outbox.set(uuid, { ...entry, state: 'committed' })
  }

  /**
   * Apply an interrupt receipt to the outbox.
   *
   * The rules are the receipt's own caveats: uuids we know and that are ABSENT
   * from `still_queued` ran (commit them); uuids we do not know are ignored
   * rather than treated as errors (cron triggers and auto-resume continuations
   * appear there); and an absent receipt means the CLI predates
   * `interrupt_receipt_v1`, so nothing is reconciled.
   *
   * @param receipt - the receipt, or undefined on an older CLI.
   * @returns the surviving uuids this session actually sent.
   */
  private reconcileReceipt(receipt: CcInterruptReceipt | undefined): readonly string[] {
    if (receipt === undefined) return []
    const stillQueued = new Set(receipt.still_queued)
    for (const entry of [...this.#outbox.values()]) {
      if (entry.state !== 'queued') continue
      if (!stillQueued.has(entry.uuid)) this.commit(entry.uuid)
    }
    // Unknown uuids are dropped here, exactly as the receipt's contract demands.
    return receipt.still_queued.filter(uuid => this.#outbox.get(uuid)?.state === 'queued')
  }

  /**
   * Best-effort emulation of `cancel_queued: true`.
   * @param initial - the surviving uuids from the first receipt.
   * @returns the uuids marked cancelled.
   */
  private async drainQueued(initial: readonly string[]): Promise<readonly string[]> {
    const cancelled = new Set<string>()
    let remaining = [...initial]
    // The cap keeps a misbehaving CLI from spinning: each attempt should clear
    // at least one queued turn, and two spare attempts absorb coalescing.
    const cap = initial.length + 2
    const pollMs = this.#deps.drainPollMs ?? DEFAULT_DRAIN_POLL_MS

    for (const uuid of remaining) {
      this.cancel(uuid)
      cancelled.add(uuid)
    }

    for (let attempt = 0; attempt < cap && remaining.length > 0; attempt += 1) {
      // Wait for the next queued turn to start (observed as its result) or for
      // the poll interval, whichever comes first: interrupting between turns is
      // a no-op the CLI answers with an empty receipt.
      await this.nextTurnBoundary(pollMs)
      if (this.#closed || this.#query === undefined) break
      const receipt = await this.interruptOnce(this.#query)
      this.reconcileReceipt(receipt)
      // Survivors are read from the RAW receipt, not from the reconciliation:
      // a uuid this loop already marked `cancelled` still counts as surviving
      // until the CLI stops listing it, and unknown uuids are still ignored.
      remaining = (receipt?.still_queued ?? []).filter(uuid => this.#outbox.has(uuid))
      for (const uuid of remaining) {
        this.cancel(uuid)
        cancelled.add(uuid)
      }
    }

    if (remaining.length > 0) {
      this.#deps.logger?.debug(
        `claude-code: session ${this.id} drain gave up with ${remaining.length} queued message(s) still live`)
    }
    return [...cancelled]
  }

  /**
   * Issue ONE interrupt, recording that the running turn's abort result (if the
   * CLI produces one) is ours rather than a failure.
   * @param query - the live query handle.
   * @returns the receipt, or undefined on a CLI without `interrupt_receipt_v1`.
   */
  private async interruptOnce(query: CcBackendQuery): Promise<CcInterruptReceipt | undefined> {
    if (this.#status === 'running') this.#pendingInterruptArtifacts += 1
    return await query.interrupt()
  }

  /**
   * Mark one outbox entry cancelled so nothing re-delivers it.
   * @param uuid - the message uuid.
   * @returns nothing.
   */
  private cancel(uuid: string): void {
    const entry = this.#outbox.get(uuid)
    if (entry === undefined) return
    this.#outbox.set(uuid, { ...entry, state: 'cancelled' })
    this.#currentBatch = this.#currentBatch.filter(candidate => candidate !== uuid)
    this.#nextBatch = this.#nextBatch.filter(candidate => candidate !== uuid)
  }

  /** @returns the uuids still queued according to this session's outbox. */
  private queuedUuids(): readonly string[] {
    return [...this.#outbox.values()].filter(entry => entry.state === 'queued').map(entry => entry.uuid)
  }

  /**
   * Resolve on the next result message, or after `pollMs`, whichever is first.
   * The timer is always cleared, so a drain loop leaves nothing behind.
   * @param pollMs - the fallback interval.
   * @returns nothing.
   */
  private async nextTurnBoundary(pollMs: number): Promise<void> {
    await new Promise<void>(resolve => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.#turnBoundaryWaiters.delete(wake)
        resolve()
      }, pollMs)
      timer.unref?.()
      const wake = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      this.#turnBoundaryWaiters.add(wake)
    })
  }

  /**
   * Drop a settled waiter and its timer.
   * @param waiter - the waiter record.
   * @returns nothing.
   */
  private clearWaiter(waiter: ResultWaiter): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    this.#resultWaiters.delete(waiter)
  }

  /**
   * Cache what the initialize handshake reported.
   * @param result - the initialize response.
   * @returns nothing.
   */
  private cacheInitialize(result: CcInitializeResult): void {
    this.#initialize = result
  }

  /**
   * Fan one envelope out to every subscriber, isolating listener failures.
   * @param envelope - the message and its metadata.
   * @returns nothing.
   */
  private emit(envelope: CcMessageEnvelope): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(envelope)
      } catch (error) {
        this.#deps.logger?.debug(
          `claude-code: session ${this.id} message listener threw: ${describe(error)}`)
      }
    }
  }

  /**
   * Fan one send out to every send subscriber, isolating listener failures: a
   * mirror that throws must never fail the send that reached the subprocess.
   * @param send - what was sent.
   * @returns nothing.
   */
  private emitSend(send: CcSendRecord): void {
    for (const listener of [...this.#sendListeners]) {
      try {
        listener(send)
      } catch (error) {
        this.#deps.logger?.debug(
          `claude-code: session ${this.id} send listener threw: ${describe(error)}`)
      }
    }
  }
}

/** The slice of {@link CcSessionDeps} that option resolution actually reads. */
export type CcQueryOptionDeps = Pick<CcSessionDeps, 'config' | 'canUseTool' | 'asks' | 'logger' | 'resolveApiKey'>

/**
 * Build the SDK options for one session (§3.2, with the review's corrections).
 *
 * Exported because the warm pool needs the SAME options a session would resolve
 * in order to decide whether a warmed subprocess can serve it — computing them
 * twice from two code paths is how a pool starts serving subtly wrong
 * subprocesses.
 *
 * @param options - the session's identity and shape.
 * @param deps - config plus the injectable hooks.
 * @param abortController - the controller to hand the SDK.
 * @returns the fully resolved options.
 */
export async function resolveQueryOptions(
  options: CcSessionOptions,
  deps: CcQueryOptionDeps,
  abortController: AbortController,
): Promise<CcQueryOptions> {
  const config = deps.config
  const model = options.model ?? config.defaults.model
  const append = config.defaults.appendSystemPrompt
  // A live probe against SDK 0.3.233 confirms the letter of the SDK's own
  // rule: sending `sessionId` together with `resume` WITHOUT `forkSession`
  // is rejected outright ("--session-id can only be used with --continue or
  // --resume if --fork-session is also specified"; the subprocess exits 1
  // before `system/init`). So a plain resume must send `resume` ALONE — no
  // `sessionId` — and the CLI echoes back the resumed session's own id.
  // `options.id` (set by the caller — `service.ts` sets it to the resumed
  // id for a plain resume) is what dsh tracks it under either way.
  const forking = options.fork === true && options.resume !== undefined

  return {
    // Fresh session, or a fork: WE mint the id and hand it to the SDK (spike
    // 1). A plain resume sends no `sessionId` at all — see above.
    ...(options.resume === undefined || forking ? { sessionId: options.id } : {}),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(forking ? { forkSession: true } : {}),
    cwd: options.cwd,
    ...(model === undefined ? {} : { model }),
    permissionMode: options.permissionMode ?? config.defaults.permissionMode,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      ...(append === undefined ? {} : { append }),
    },
    // ALWAYS explicit: omitting this loads the user's real settings and
    // CLAUDE.md into an embedded agent (delta S1).
    settingSources: [...config.defaults.settingSources],
    includePartialMessages: true,
    // Precedence: an explicitly injected callback (tests, bespoke consumers),
    // then the dsh ask channel, then fail-closed.
    canUseTool: deps.canUseTool ?? deps.asks?.canUseTool ?? denyAll,
    env: await buildSessionEnv(deps),
    stderr: (data: string) => {
      deps.logger?.debug(`claude-code[${options.id}] ${data}`)
    },
    abortController,
    ...(config.executablePath === undefined ? {} : { pathToClaudeCodeExecutable: config.executablePath }),
  }
}

/**
 * Build the subprocess environment (§9, delta S9).
 *
 * `options.env` REPLACES the subprocess environment rather than merging it, so
 * `process.env` is spread FIRST — lose that and `PATH`/`HOME` go with it and the
 * subscription login stops resolving. Then `config.env` overlays. Then, under
 * `auth: 'subscription'`, `ANTHROPIC_API_KEY` is DELETED: leaving it set bills
 * the API instead of the subscription, silently and with no error anywhere.
 *
 * @param deps - config plus the (Phase 5) credential hook.
 * @returns the complete environment for the subprocess.
 */
export async function buildSessionEnv(
  deps: Pick<CcSessionDeps, 'config' | 'resolveApiKey'>,
): Promise<Record<string, string | undefined>> {
  const config = deps.config
  const env: Record<string, string | undefined> = { ...process.env, ...config.env }

  if (config.auth === 'subscription') {
    delete env['ANTHROPIC_API_KEY']
    return env
  }

  // api-key mode: Phase 5 resolves the REFERENCE through `ctx.credentials` so a
  // rotated key needs no restart. Until then the hook is unset and whatever the
  // ambient environment holds stands — which is why the auth switch is explicit.
  const resolved = await deps.resolveApiKey?.()
  if (resolved !== undefined) env[config.apiKeyRef] = resolved
  return env
}

/**
 * The fail-closed permission callback for a session with neither an injected
 * `canUseTool` nor an ask channel. It denies with an explanation rather than
 * throwing: a rejected `canUseTool` promise hangs the CLI forever (gotcha 9).
 * @param toolName - the tool the model wants to run.
 * @param _input - the tool input (unused).
 * @param _request - the request context (unused).
 * @returns a deny decision carrying the reason.
 */
const denyAll: CcCanUseTool = async (
  toolName: string,
  _input: Record<string, unknown>,
  _request: CcPermissionRequest,
): Promise<CcPermissionDecision> => {
  return await Promise.resolve({ behavior: 'deny', message: `${DEFAULT_DENY_MESSAGE} (tool: ${toolName})` })
}

/**
 * Render any thrown value for a log line.
 * @param error - the thrown value.
 * @returns a one-line description.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read a string field off an open-union SDK message.
 * @param message - the message.
 * @param field - the field name.
 * @returns the value when it is a string, else undefined.
 */
function readString(message: CcSdkMessage, field: string): string | undefined {
  const value = message[field]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read a string-array field off an open-union SDK message.
 * @param message - the message.
 * @param field - the field name.
 * @returns the value when it is an array of strings, else undefined.
 */
function readStringArray(message: CcSdkMessage, field: string): readonly string[] | undefined {
  const value = message[field]
  if (!Array.isArray(value)) return undefined
  return value.every(entry => typeof entry === 'string') ? (value as string[]) : undefined
}
