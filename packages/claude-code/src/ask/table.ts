/**
 * The pending-ask table (§4.6): one entry per SDK permission request, keyed by
 * `requestId`, settled exactly once.
 *
 * Four things settle an ask, and the table is the only place that knows all
 * four:
 *
 * | settle | answer sent to the SDK |
 * |---|---|
 * | the dsh seam answered | that decision |
 * | the SDK's `signal` aborted | deny `'Request withdrawn'` — the same word dsh's approval seam uses for `'cancelled'` |
 * | the configured wait elapsed | the router's fallback decision |
 * | the session closed | deny, so no subprocess is left holding a promise nobody will resolve |
 *
 * **Idempotency is a contract, not an optimization** (delta S12): the SDK
 * redelivers in-flight `can_use_tool` requests after `reinitialize()`, and the
 * initialize response carries `pending_permission_requests` for the same
 * reason. A redelivered `requestId` must return the ORIGINAL settled decision
 * (or attach to the in-flight promise) — never open a second dsh prompt, which
 * a human would see as the harness asking twice for one action.
 *
 * The table holds no live dsh objects: an entry is a decision, a controller and
 * a timer. That is what keeps the `defer`-and-resume design (§4.6's last
 * bullet) possible later without a rewrite.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import type { CcPermissionDecision } from '../backend.ts'
import type { CcLogger } from '../types.ts'

/** Why an ask settled. Reported to {@link CcAskTableDeps.onSettle} for metrics/tests. */
export type CcAskSettleCause =
  /** A dsh seam produced the decision. */
  | 'answered'
  /** The SDK withdrew the request (its `signal` aborted). */
  | 'abort'
  /** The configured wait elapsed. */
  | 'timeout'
  /** The session closed with the ask still open. */
  | 'closed'
  /** The work function threw — a bug, contained into a deny. */
  | 'failed'

/**
 * Which of the three dsh seams an ask is parked on — the same three-way split
 * `CcAskRouter` routes `canUseTool` through (§4).
 *
 * Named for what a HUMAN is being asked to do, not for the dsh service behind
 * it: a consumer reading `pendingAskDetails` off a snapshot wants to tell "a
 * tool call is waiting for approval" from "the model asked you a question", and
 * `'approval'` / `'questions'` (the router's internal `CcAskKind`) are dsh
 * plumbing names that leak nothing useful upward.
 */
export type CcPendingAskKind = 'permission' | 'question' | 'plan'

/** Every {@link CcPendingAskKind}, for schema declaration and validation. */
export const CC_PENDING_ASK_KINDS: readonly CcPendingAskKind[] = ['permission', 'question', 'plan']

/**
 * HOW an ask ended. Every member maps to a settle path that exists in this
 * package; nothing here is aspirational.
 *
 * | outcome | produced by |
 * |---|---|
 * | `allowed` | `ApprovalOutcome === 'allowed-once'`, a plan `Approve`, or the stored rule cache |
 * | `rejected` | `ApprovalOutcome === 'rejected'`, or a plan declined with `Keep planning` |
 * | `cancelled` | the prompt was dismissed or withdrawn (SDK abort, session close, `ASK_CANCELLED`) |
 * | `answered` | a clarifying question came back with selections/custom text (or the `first-option` fallback produced them) |
 * | `timed-out` | `ask.timeoutMs` / `ask.delegatedTimeoutMs` elapsed |
 * | `fallback-denied` | the fallback policy denied (`deny` / `error`, or `first-option` with nothing to pick) |
 * | `unavailable` | nobody could be asked at all: no target, no seam, the approval seam answered `'unavailable'`, or the channel threw |
 */
export type CcAskOutcome =
  | 'allowed'
  | 'rejected'
  | 'cancelled'
  | 'answered'
  | 'timed-out'
  | 'fallback-denied'
  | 'unavailable'

/** Every {@link CcAskOutcome}, for schema declaration and validation. */
export const CC_ASK_OUTCOMES: readonly CcAskOutcome[] = [
  'allowed', 'rejected', 'cancelled', 'answered', 'timed-out', 'fallback-denied', 'unavailable',
]

/**
 * WHO settled an ask — the distinction a delegating agent could not previously
 * make, and the reason this whole receipt exists.
 *
 * - `human` — a dsh answerer came back with a decision: a person clicked
 *   approve/reject in the dsh UI, chose an option, typed custom text, approved
 *   or declined a plan, or dismissed the prompt to speak instead.
 * - `policy` — nobody was asked, or nobody answered: the stored rule cache, the
 *   fallback policy, a timeout, an SDK withdrawal, the session closing, or a
 *   composition with no approval/user-questions seam mounted.
 *
 * A consumer MUST NOT report a `policy` settle as a human's decision. In the
 * production trace that motivated this file, an agent reported a fail-closed
 * policy deny as "the human denied it" and a human answer as "the session chose
 * for itself"; both are the same missing bit.
 */
export type CcAskSource = 'human' | 'policy'

/** Every {@link CcAskSource}. */
export const CC_ASK_SOURCES: readonly CcAskSource[] = ['human', 'policy']

/**
 * One SETTLED ask, retained after the fact: the receipt for a decision.
 *
 * `CcPendingAsk` answers "what is a human being asked right now"; this answers
 * "what did a human (or a policy) actually decide". Without it a delegating
 * agent sees a tool call happen — or not happen — and has no way to tell an
 * approval a person granted from one a rule cache granted, a plan a person
 * approved from a plan mode that never engaged, or an option a person picked
 * from one the model invented.
 */
export interface CcAskReceipt {
  /** What the human was asked to do. */
  readonly kind: CcPendingAskKind
  /** The tool that was decided, when the ask named one. */
  readonly toolName?: string
  /** The same one-line description the human was shown, when there was one. */
  readonly reason?: string
  /** How it ended. */
  readonly outcome: CcAskOutcome
  /**
   * The human's actual choice, where one exists: the selected option label(s)
   * or custom text for a question, the decline feedback for a plan, or — for a
   * `policy` settle — which policy answered and why. ABSENT for a plain
   * allow/deny that carries no extra words.
   */
  readonly detail?: string
  /** `Date.now()` when the ask was opened. */
  readonly askedAt: number
  /** `Date.now()` when it settled. Per-turn filtering reads this. */
  readonly settledAt: number
  /** Who settled it. */
  readonly source: CcAskSource
}

/**
 * A decision PLUS what a receipt needs to describe it.
 *
 * The table knows when an ask settled and what the SDK was answered with; only
 * the caller knows whether a person decided it and what they chose. So `work`
 * (and `onTimeout`) may return this richer shape instead of a bare
 * {@link CcPermissionDecision} — and a bare decision is recorded as `policy`,
 * because a caller that says nothing about a human must never be reported as
 * one.
 */
export interface CcAskAnswer {
  /** What the SDK is answered with. */
  readonly decision: CcPermissionDecision
  /** How this ask ended. */
  readonly outcome: CcAskOutcome
  /** Who decided it. */
  readonly source: CcAskSource
  /** The human's choice, or which policy answered. */
  readonly detail?: string
}

/**
 * One ask currently awaiting an answer. A value, never a handle.
 *
 * `kind`, `reason` and `since` exist so a consumer can say WHAT is pending
 * instead of only HOW MANY. A count alone is what the production trace exposed
 * as unusable: `claude_code_status` could report "1 pending ask(s)" while the
 * ask table already held both the tool name and the CLI's own rendered sentence
 * for it, and nobody upstream could name what the human was supposed to approve.
 */
export interface CcPendingAsk {
  /** The SDK control-request id: the table's key and the idempotency key. */
  readonly requestId: string
  /** Which seam the ask is parked on, in human terms. */
  readonly kind: CcPendingAskKind
  /** The tool being decided. */
  readonly toolName: string
  /**
   * One line describing what is being asked, when the caller supplied one. For
   * a permission this is EXACTLY the string the router hands
   * `ctx.approval.request` as its `reason` (the CLI's pre-rendered `title`, or
   * `describeCall(...)` when the CLI supplied none), so the prose a delegating
   * model reads and the prose the human answers are the same words.
   */
  readonly reason?: string
  /** `Date.now()` when the ask was opened — the epoch ms a "pending for N" is measured from. */
  readonly since: number
  /**
   * `Date.now()` when the ask was opened.
   * @deprecated The original name for {@link CcPendingAsk.since}, kept so
   *   consumers written before `since` existed still compile. Always equal to it.
   */
  readonly startedAt: number
}

/** How to run one ask. */
export interface CcAskRunSpec {
  /** The SDK control-request id (delta S2). */
  readonly requestId: string
  /** The tool being decided, for diagnostics. */
  readonly toolName: string
  /**
   * Which seam this ask routes to. Optional so a caller that only cares about
   * idempotency (and every test that predates the field) still compiles;
   * `'permission'` is the safe default because it is the only kind whose
   * fallback can never auto-answer.
   */
  readonly kind?: CcPendingAskKind
  /** One line describing what is being asked, surfaced on {@link CcPendingAsk.reason}. */
  readonly reason?: string
  /** The SDK's abort signal; aborting withdraws the request. */
  readonly signal?: AbortSignal
  /** Bounded wait in ms; omitted means pend indefinitely (the interactive posture). */
  readonly timeoutMs?: number
  /**
   * The decision to answer with when the wait elapses. Called at most once, and
   * only on the timeout path — the router applies the fallback policy inside it.
   * @returns the timeout decision, optionally as a {@link CcAskAnswer} so the
   *   receipt can say WHICH policy answered (a bare decision is recorded as a
   *   `timed-out` policy settle).
   */
  onTimeout(): CcPermissionDecision | CcAskAnswer
}

/** Construction-time knobs. */
export interface CcAskTableDeps {
  /** Diagnostics sink. */
  readonly logger?: CcLogger
  /**
   * How many settled decisions to remember for redelivery. Bounded because the
   * SDK redelivers only in-flight requests: memory is a leak, not a feature.
   * Defaults to 512.
   */
  readonly retain?: number
  /**
   * How many settled-ask RECEIPTS to keep for consumers to read
   * ({@link CcAskTable.receipts}). Defaults to {@link DEFAULT_RECEIPT_LIMIT}.
   *
   * Deliberately much smaller than {@link CcAskTableDeps.retain}: retained
   * DECISIONS exist so a redelivered `requestId` gets the same answer, whereas
   * receipts are a human-readable tail a model reads in a tool result. Twenty
   * covers "what happened during this turn" with room to spare, and the bound
   * is what keeps a long-lived session from growing a transcript in memory.
   */
  readonly receiptLimit?: number
  /**
   * Observer for settled asks (tests and, later, metrics).
   * @param requestId - the settled ask.
   * @param cause - why it settled.
   */
  readonly onSettle?: (requestId: string, cause: CcAskSettleCause) => void
}

/** Deny message for an ask the SDK withdrew — dsh's own word for `'cancelled'`. */
export const ASK_WITHDRAWN_MESSAGE = 'Request withdrawn'

/** Deny message for an ask the session outlived. */
export const ASK_SESSION_CLOSED_MESSAGE
  = 'Denied: the Claude Code session closed while this request was waiting for an answer. Nothing was executed.'

/** Default number of settled decisions retained for redelivery. */
const DEFAULT_RETAIN = 512

/**
 * Default size of the settled-ask receipt ring: the last twenty asks of a
 * session, newest last, oldest evicted.
 *
 * A ring rather than a log because this is READ, not stored: a consumer wants
 * "what did a human decide during this turn", and a turn that settles more than
 * twenty asks has already told the reader everything it can absorb. The bound
 * also means a week-long session cannot accumulate an unbounded audit trail in
 * memory — the durable record is the dsh session log (§8.3), not this.
 */
export const DEFAULT_RECEIPT_LIMIT = 20

/** Receipt `detail` for an ask the SDK withdrew before anyone answered. */
export const ASK_WITHDRAWN_DETAIL
  = 'Claude Code withdrew the request before anyone answered it; no human was involved'

/** Receipt `detail` for an ask the session outlived. */
export const ASK_SESSION_CLOSED_DETAIL
  = 'the Claude Code session closed while this ask was still waiting; no human answered it'

/**
 * The largest delay `setTimeout` can express. Anything past it is clamped by
 * Node to **1ms** (with a `TimeoutOverflowWarning`), which would turn an
 * absurdly long configured wait into an instant fallback deny — the exact
 * opposite of what it asked for. We clamp to the ceiling instead: ~24.8 days is
 * "effectively never" for a session, and it is at least the right direction.
 */
const MAX_TIMER_MS = 2_147_483_647

/**
 * Normalize whatever a caller returned into a receipted answer.
 *
 * A bare {@link CcPermissionDecision} carries no claim about a human, so it is
 * recorded as `policy` — the safe direction. Reporting an unattributed allow as
 * "a human approved it" is precisely the lie these receipts exist to stop; the
 * reverse (a human decision under-reported as policy) is merely uninformative.
 *
 * @param value - the decision, or the richer answer.
 * @param bare - the outcome to record for a bare DENY (a bare allow is always
 *   `allowed`). Defaults to `fallback-denied`.
 * @returns the answer to settle with.
 */
function toAnswer(
  value: CcPermissionDecision | CcAskAnswer,
  bare: CcAskOutcome = 'fallback-denied',
): CcAskAnswer {
  if (!('behavior' in value)) return value
  return {
    decision: value,
    outcome: value.behavior === 'allow' ? 'allowed' : bare,
    source: 'policy',
  }
}

/**
 * The answer for an ask the SDK withdrew.
 * @returns the deny, receipted as a policy cancellation.
 */
function withdrawn(): CcAskAnswer {
  return {
    decision: { behavior: 'deny', message: ASK_WITHDRAWN_MESSAGE },
    outcome: 'cancelled',
    source: 'policy',
    detail: ASK_WITHDRAWN_DETAIL,
  }
}

/** One tracked ask. */
interface AskEntry {
  /** The promise every delivery of this `requestId` resolves from. */
  readonly promise: Promise<CcPermissionDecision>
  /** Resolve the promise. Called exactly once, guarded by {@link AskEntry.settled}. */
  readonly resolve: (decision: CcPermissionDecision) => void
  /** Cancels the dsh-side ask (approval reads it as `'cancelled'`; user-questions as `ASK_ABORTED`). */
  readonly controller: AbortController
  /** Detach the timer and every armed SDK signal listener. Grows as redeliveries arrive. */
  readonly teardown: (() => void)[]
  /** Every SDK signal already armed for this ask, so a repeat delivery arms nothing twice. */
  readonly signals: Set<AbortSignal>
  /** The public projection. */
  readonly pending: CcPendingAsk
  /** Set once the ask has an answer; a later answer is discarded. */
  settled?: CcPermissionDecision
}

/**
 * The per-session ask table. One instance per Claude Code session: the
 * `requestId` namespace is the session's control channel, and `settleAll()` is
 * the session's close path.
 */
export class CcAskTable {
  readonly #deps: CcAskTableDeps
  readonly #retain: number
  readonly #receiptLimit: number
  /** In-flight asks, by `requestId`. */
  readonly #open = new Map<string, AskEntry>()
  /** Settled decisions, by `requestId`, insertion-ordered for FIFO eviction. */
  readonly #settled = new Map<string, CcPermissionDecision>()
  /** The bounded receipt ring, oldest first (newest last). */
  readonly #receipts: CcAskReceipt[] = []

  /**
   * @param deps - logger, retention bound, receipt bound, settle observer.
   */
  constructor(deps: CcAskTableDeps = {}) {
    this.#deps = deps
    this.#retain = deps.retain ?? DEFAULT_RETAIN
    this.#receiptLimit = Math.max(0, deps.receiptLimit ?? DEFAULT_RECEIPT_LIMIT)
  }

  /** How many asks are awaiting an answer right now (snapshots report this). */
  get pendingCount(): number {
    return this.#open.size
  }

  /**
   * The asks awaiting an answer.
   * @returns a fresh array of value projections, in arrival order.
   */
  pending(): readonly CcPendingAsk[] {
    return [...this.#open.values()].map(entry => entry.pending)
  }

  /**
   * The asks that have SETTLED, newest last, bounded by
   * {@link CcAskTableDeps.receiptLimit}.
   * @returns a fresh array of receipts (never a live view).
   */
  receipts(): readonly CcAskReceipt[] {
    return [...this.#receipts]
  }

  /**
   * The receipts for asks that settled at or after `since` — how a consumer
   * asks "what did a human decide during THIS turn" without the table needing
   * to know what a turn is.
   * @param since - epoch ms; receipts with `settledAt >= since` are returned.
   * @returns the matching receipts, newest last.
   */
  receiptsSince(since: number): readonly CcAskReceipt[] {
    return this.#receipts.filter(receipt => receipt.settledAt >= since)
  }

  /**
   * Run one ask, or join the one already running under this `requestId`.
   *
   * @param spec - the request identity, signal and deadline.
   * @param work - performs the dsh-side ask. It receives a DERIVED signal that
   *   is aborted on timeout and on session close as well as on the SDK's own
   *   abort, so a dsh seam always learns that the question went away. It may
   *   return a {@link CcAskAnswer} to say who decided and what they chose; a
   *   bare decision is receipted as a `policy` settle.
   * @returns the decision — always a decision; this never rejects.
   */
  async run(
    spec: CcAskRunSpec,
    work: (signal: AbortSignal) => Promise<CcPermissionDecision | CcAskAnswer>,
  ): Promise<CcPermissionDecision> {
    const already = this.#settled.get(spec.requestId)
    if (already !== undefined) {
      // Redelivery after the answer landed: the SAME decision, no second prompt.
      this.#deps.logger?.debug(
        `claude-code ask: redelivered request ${spec.requestId} (${spec.toolName}) answered from the settled table`)
      return already
    }
    const open = this.#open.get(spec.requestId)
    if (open !== undefined) {
      // Redelivery while the human is still looking at the prompt: attach —
      // and arm the REDELIVERED request's own signal, because after a
      // `reinitialize()` that signal is the live transport and the original
      // one may never abort again.
      this.#deps.logger?.debug(
        `claude-code ask: redelivered request ${spec.requestId} (${spec.toolName}) attached to the in-flight ask`)
      this.arm(open, spec)
      return await open.promise
    }

    const entry = this.open(spec)
    // Withdrawn before we even asked (`open()` arms the signal, and an
    // already-aborted one settles on the spot): never bother a human with it.
    if (entry.settled !== undefined) return await entry.promise

    void this.pump(spec, entry, work)
    return await entry.promise
  }

  /**
   * Settle every open ask as denied — the session's close path (§5.4: asks
   * settle FIRST, before the query goes away).
   *
   * @param message - the deny message; defaults to the session-closed sentence.
   * @returns how many asks were settled.
   */
  settleAll(message: string = ASK_SESSION_CLOSED_MESSAGE): number {
    const ids = [...this.#open.keys()]
    for (const id of ids) {
      this.settle(id, {
        decision: { behavior: 'deny', message },
        // Nobody decided this: the session went away underneath a question a
        // person may still have been reading. Reporting it as a human's denial
        // would be the exact confusion these receipts exist to prevent.
        outcome: 'cancelled',
        source: 'policy',
        detail: ASK_SESSION_CLOSED_DETAIL,
      }, 'closed')
    }
    return ids.length
  }

  /**
   * Create and register one entry.
   * @param spec - the ask spec.
   * @returns the registered entry.
   */
  private open(spec: CcAskRunSpec): AskEntry {
    let resolve: (decision: CcPermissionDecision) => void = () => {}
    const promise = new Promise<CcPermissionDecision>(settle => { resolve = settle })
    const controller = new AbortController()

    // ONE clock read, shared by both names: `since` and `startedAt` must be the
    // same instant, or a consumer that migrated between them would report two
    // different pending durations for one ask.
    const openedAt = Date.now()
    const entry: AskEntry = {
      promise,
      resolve,
      controller,
      teardown: [],
      signals: new Set<AbortSignal>(),
      pending: {
        requestId: spec.requestId,
        kind: spec.kind ?? 'permission',
        toolName: spec.toolName,
        ...(spec.reason === undefined ? {} : { reason: spec.reason }),
        since: openedAt,
        startedAt: openedAt,
      },
    }
    this.#open.set(spec.requestId, entry)

    if (spec.timeoutMs !== undefined) {
      const delay = Math.min(spec.timeoutMs, MAX_TIMER_MS)
      if (delay !== spec.timeoutMs) {
        this.#deps.logger?.debug(
          `claude-code ask: request ${spec.requestId} (${spec.toolName}) asked for a ${spec.timeoutMs}ms wait; `
          + `clamping to the ${MAX_TIMER_MS}ms timer ceiling (an unclamped value fires immediately)`)
      }
      const timer = setTimeout(() => {
        // The router owns the policy; the table only knows the deadline passed.
        // A throwing policy is contained here: an exception raised inside a
        // timer callback is UNCATCHABLE by the caller, and it would leave the
        // ask pending forever with the process already on fire.
        let answer: CcAskAnswer
        try {
          answer = toAnswer(spec.onTimeout(), 'timed-out')
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          this.#deps.logger?.debug(
            `claude-code ask: the timeout policy for request ${spec.requestId} (${spec.toolName}) threw: ${detail}`)
          answer = {
            decision: {
              behavior: 'deny',
              message: `Denied: the dsh ask channel failed while timing out ${spec.toolName} (${detail}). `
                + 'Nothing was executed.',
            },
            outcome: 'unavailable',
            source: 'policy',
            detail: `the dsh ask channel failed while timing this ask out: ${detail}`,
          }
        }
        this.settle(spec.requestId, answer, 'timeout')
      }, delay)
      // A pending ask must never hold the process open by itself.
      timer.unref?.()
      entry.teardown.push(() => { clearTimeout(timer) })
    }

    this.arm(entry, spec)
    return entry
  }

  /**
   * Observe one delivery's abort signal on behalf of an entry.
   *
   * Called for the first delivery and for every redelivery: the SDK hands out a
   * fresh signal per delivery, and only the newest one is still wired to a live
   * transport after `reinitialize()`.
   *
   * @param entry - the tracked ask.
   * @param spec - the delivery whose signal should also withdraw it.
   * @returns nothing.
   */
  private arm(entry: AskEntry, spec: CcAskRunSpec): void {
    const signal = spec.signal
    if (signal === undefined || entry.signals.has(signal)) return
    entry.signals.add(signal)
    if (signal.aborted) {
      this.settle(spec.requestId, withdrawn(), 'abort')
      return
    }
    const onAbort = (): void => {
      this.settle(spec.requestId, withdrawn(), 'abort')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    entry.teardown.push(() => { signal.removeEventListener('abort', onAbort) })
  }

  /**
   * Drive the dsh-side ask and settle with whatever it produced.
   *
   * A throwing `work` is contained here: the ask channel's whole job is that
   * `canUseTool` always resolves, so an unexpected failure becomes a deny with
   * the reason in it rather than a rejected promise the CLI waits on forever.
   *
   * @param spec - the ask spec.
   * @param entry - the registered entry.
   * @param work - the dsh-side ask.
   * @returns nothing.
   */
  private async pump(
    spec: CcAskRunSpec,
    entry: AskEntry,
    work: (signal: AbortSignal) => Promise<CcPermissionDecision | CcAskAnswer>,
  ): Promise<void> {
    try {
      const answered = await work(entry.controller.signal)
      this.settle(spec.requestId, toAnswer(answered), 'answered')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.#deps.logger?.debug(
        `claude-code ask: request ${spec.requestId} (${spec.toolName}) failed unexpectedly: ${detail}`)
      this.settle(spec.requestId, {
        decision: {
          behavior: 'deny',
          message: `Denied: the dsh ask channel failed while deciding ${spec.toolName} (${detail}). `
            + 'Nothing was executed.',
        },
        outcome: 'unavailable',
        source: 'policy',
        detail: `the dsh ask channel failed while deciding this ask: ${detail}`,
      }, 'failed')
    }
  }

  /**
   * Settle one ask, once. A second call (a late answer racing an abort or a
   * timeout) is discarded — which is exactly how dsh's approval seam behaves on
   * its own side, so both agree without coordinating.
   *
   * @param requestId - the ask to settle.
   * @param answer - the answer to hand the SDK, plus who decided it.
   * @param cause - why it settled.
   * @returns nothing.
   */
  private settle(requestId: string, answer: CcAskAnswer, cause: CcAskSettleCause): void {
    const entry = this.#open.get(requestId)
    if (entry === undefined || entry.settled !== undefined) return
    entry.settled = answer.decision
    for (const off of entry.teardown) off()
    entry.teardown.length = 0
    // Abort AFTER recording the decision: a dsh seam still waiting on an
    // answerer learns the question went away, and its own late answer lands on
    // an already-settled entry.
    if (cause !== 'answered') entry.controller.abort()
    this.#open.delete(requestId)
    this.remember(requestId, answer.decision)
    // The receipt is written from the SETTLING answer, never re-derived later:
    // a second (discarded) answer racing this one must not rewrite the record
    // of what actually decided the ask.
    this.receipt(entry.pending, answer)
    entry.resolve(answer.decision)
    this.#deps.onSettle?.(requestId, cause)
  }

  /**
   * Append one receipt to the bounded ring, evicting the oldest past the bound.
   * @param pending - the ask as it was posed (kind, tool, reason, opened-at).
   * @param answer - how it settled.
   * @returns nothing.
   */
  private receipt(pending: CcPendingAsk, answer: CcAskAnswer): void {
    if (this.#receiptLimit === 0) return
    this.#receipts.push({
      kind: pending.kind,
      ...(pending.toolName === '' ? {} : { toolName: pending.toolName }),
      ...(pending.reason === undefined ? {} : { reason: pending.reason }),
      outcome: answer.outcome,
      ...(answer.detail === undefined || answer.detail === '' ? {} : { detail: answer.detail }),
      askedAt: pending.since,
      settledAt: Date.now(),
      source: answer.source,
    })
    while (this.#receipts.length > this.#receiptLimit) this.#receipts.shift()
  }

  /**
   * Retain one settled decision for redelivery, evicting the oldest past the
   * bound.
   * @param requestId - the settled ask.
   * @param decision - its answer.
   * @returns nothing.
   */
  private remember(requestId: string, decision: CcPermissionDecision): void {
    this.#settled.set(requestId, decision)
    while (this.#settled.size > this.#retain) {
      const oldest = this.#settled.keys().next()
      if (oldest.done === true) break
      this.#settled.delete(oldest.value)
    }
  }
}
