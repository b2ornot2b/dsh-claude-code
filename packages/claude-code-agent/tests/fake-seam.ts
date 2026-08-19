/**
 * Offline stand-ins for everything the adapter talks to.
 *
 * Two different fakes, because the adapter has two different jobs:
 *
 * - {@link FakeCcSession} plays the seam's session ACTOR. The adapter's whole
 *   behaviour is decisions it makes about session state (status transitions,
 *   outbox reconciliation, send-mode routing), so a scriptable actor pins them
 *   to the letter without a subprocess — and without the seam's own protocol
 *   layer in between, which is tested in its own package.
 * - {@link mountSeam} mounts the REAL `SessionStore`, `AgentRegistry` and
 *   `ClaudeCodeService` (the last one over the seam's own fake backend), which
 *   is what the spawn/teardown tests need: the registration contract, the
 *   exact-disposer rule and the teardown order are only meaningful against the
 *   real registries.
 *
 * Not a spec file: `vitest` collects `*.spec.ts` only, while
 * `tsconfig.tests.json` still type-checks this module.
 */

import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { ClaudeCodeService, newCcSessionId } from '@deepseek-ai/dsh-claude-code'
import type {
  CcInterruptOutcome, CcMessageEnvelope, CcOutboxEntry, CcSendMode, CcSendOptions, CcSessionId,
  CcSessionSnapshot, CcSessionStatus, CcUuid,
} from '@deepseek-ai/dsh-claude-code'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'

import type { CcAgentSession } from '@deepseek-ai/dsh-claude-code-agent'

import { createFakeBackend } from '../../claude-code/tests/fake-backend.ts'
import type { FakeBackend } from '../../claude-code/tests/fake-backend.ts'

export { createFakeBackend } from '../../claude-code/tests/fake-backend.ts'

/** Let every pending microtask and one macrotask turn drain. */
export async function settle(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

/** A promise plus its resolver (`Promise.withResolvers` needs Node 22; this repo targets 20). */
export interface Deferred {
  /** The promise a test parks on. */
  readonly promise: Promise<void>
  /** Settle it. */
  resolve(): void
}

/**
 * Build a deferred.
 * @returns the promise and its resolver.
 */
export function deferred(): Deferred {
  let resolve = (): void => {}
  const promise = new Promise<void>((settleIt) => { resolve = () => { settleIt() } })
  return { promise, resolve: () => { resolve() } }
}

/**
 * Build one identified user message.
 * @param text - the message text.
 * @returns a user-sourced message carrying exactly that text.
 */
export function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * Build one identified user message with arbitrary blocks.
 * @param content - the blocks to carry.
 * @returns a user-sourced message carrying them verbatim.
 */
export function blockMessage(content: ContentBlock[]): UserMessage {
  return createUserMessage({ content, source: { kind: 'user' } })
}

/** One send the fake actor received. */
export interface FakeSend {
  /** The text handed to the seam. */
  readonly text: string
  /** Which inbox verb it was routed as. */
  readonly mode: CcSendMode
  /** The uuid the fake stamped on it. */
  readonly uuid: CcUuid
}

/**
 * A scriptable stand-in for `CcSession`, satisfying {@link CcAgentSession}.
 *
 * It reproduces exactly the parts of the real actor the adapter reads: the
 * four-state lifecycle, the three send modes (an `inject` commits immediately
 * and starts no turn; anything else queues and makes the session `running`),
 * and the outbox states an interrupt receipt reconciles into.
 */
export class FakeCcSession implements CcAgentSession {
  /** The shared dsh/CC identity. */
  readonly id: CcSessionId
  /** Every send received, in order. */
  readonly sends: FakeSend[] = []
  /** Every interrupt received, in order. */
  readonly interrupts: { readonly keepQueued: boolean }[] = []
  /** Every model switch received, in order. */
  readonly models: (string | undefined)[] = []
  /** Set to make the next {@link FakeCcSession.send} throw. */
  failNextSend: Error | undefined

  #status: CcSessionStatus = 'starting'
  #model: string | undefined
  #counter = 0
  /** A fixed origin for the snapshot's clock fields; this double has no lifetime of its own. */
  readonly #openedAt = Date.now()
  readonly #outbox = new Map<CcUuid, CcOutboxEntry>()
  readonly #messageListeners = new Set<(envelope: CcMessageEnvelope) => void>()
  readonly #closeListeners = new Set<() => void>()

  /**
   * @param id - the shared identity; a fresh bare UUID by default.
   * @param model - the model the snapshot reports.
   */
  constructor(id: CcSessionId = newCcSessionId(), model?: string) {
    this.id = id
    this.#model = model
  }

  /** The seam's four-state lifecycle. */
  get status(): CcSessionStatus {
    return this.#status
  }

  /**
   * Record one send and move the status machine exactly as the real actor does.
   * @param input - the text (or an envelope).
   * @param options - the send mode.
   * @returns the stamped uuid.
   */
  send(input: string | { readonly content: string, readonly uuid?: CcUuid }, options: CcSendOptions = {}): CcUuid {
    if (this.failNextSend !== undefined) {
      const error = this.failNextSend
      this.failNextSend = undefined
      throw error
    }
    const mode = options.mode ?? 'followup'
    const text = typeof input === 'string' ? input : input.content
    this.#counter += 1
    const uuid: CcUuid = `fake-${this.#counter}-0000-0000-000000000000`
    this.sends.push({ text, mode, uuid })
    this.#outbox.set(uuid, {
      uuid,
      mode,
      sentAt: this.#counter,
      state: mode === 'inject' ? 'committed' : 'queued',
    })
    if (mode !== 'inject') this.#status = 'running'
    return uuid
  }

  /**
   * Record one interrupt. It does NOT settle the turn on its own — a test
   * drives that with {@link FakeCcSession.completeTurn}, exactly as the real
   * abort result would.
   * @param options - whether queued messages survive.
   * @returns the receipt outcome.
   */
  async interrupt(options: { readonly keepQueued?: boolean } = {}): Promise<CcInterruptOutcome> {
    const keepQueued = options.keepQueued ?? true
    this.interrupts.push({ keepQueued })
    const queued = [...this.#outbox.values()].filter(entry => entry.state === 'queued')
    if (keepQueued) {
      return await Promise.resolve({
        stillQueued: queued.map(entry => entry.uuid),
        cancelled: [],
        receiptSupported: true,
      })
    }
    for (const entry of queued) this.#outbox.set(entry.uuid, { ...entry, state: 'cancelled' })
    return await Promise.resolve({
      stillQueued: [],
      cancelled: queued.map(entry => entry.uuid),
      receiptSupported: true,
    })
  }

  /** @returns a snapshot of the outbox in send order. */
  outbox(): readonly CcOutboxEntry[] {
    return [...this.#outbox.values()]
  }

  /** @returns the public value projection. */
  snapshot(): CcSessionSnapshot {
    return {
      id: this.id,
      status: this.#status,
      cwd: '/fake/cwd',
      openedAt: this.#openedAt,
      lastActivityAt: this.#openedAt,
      ...(this.#model === undefined ? {} : { model: this.#model }),
      pendingAsks: 0,
      // This double never routes an ask, so nothing can ever be pending on it —
      // and nothing can ever have settled on it either.
      pendingAskDetails: [],
      recentAsks: [],
    }
  }

  /**
   * Record a model switch.
   * @param model - the requested model.
   * @returns nothing.
   */
  async setModel(model?: string): Promise<void> {
    this.models.push(model)
    this.#model = model
    await Promise.resolve()
  }

  /**
   * Subscribe to messages.
   * @param listener - called per message.
   * @returns an unsubscribe function.
   */
  onMessage(listener: (envelope: CcMessageEnvelope) => void): () => void {
    this.#messageListeners.add(listener)
    return () => { this.#messageListeners.delete(listener) }
  }

  /**
   * Subscribe to the close edge.
   * @param listener - called once, after close.
   * @returns an unsubscribe function.
   */
  onClose(listener: () => void): () => void {
    if (this.#status === 'closed') {
      listener()
      return () => {}
    }
    this.#closeListeners.add(listener)
    return () => { this.#closeListeners.delete(listener) }
  }

  // ---- test-driving surface ----

  /**
   * End the running turn: every queued message commits and the session goes
   * idle, announced by one `result` message (the real turn boundary).
   * @returns nothing.
   */
  completeTurn(): void {
    for (const entry of this.#outbox.values()) {
      if (entry.state === 'queued') this.#outbox.set(entry.uuid, { ...entry, state: 'committed' })
    }
    this.#status = 'idle'
    this.emit({ type: 'result', subtype: 'success' })
  }

  /**
   * Emit the abort artifact of a `steer` send: the real actor suppresses this
   * result from `completeTurn()`, so the session stays `running` and the refold
   * turn continues. Reproduced here so the adapter's status projection can be
   * asserted across the abort-and-refold window.
   * @returns nothing.
   */
  emitSteerArtifact(): void {
    this.emit({ type: 'result', subtype: 'error_during_execution' })
  }

  /**
   * Commit exactly one queued message, leaving the rest queued and the session
   * running — the state a partially-drained batch leaves behind.
   * @param uuid - the entry to commit.
   * @returns nothing.
   */
  commitOnly(uuid: CcUuid): void {
    const entry = this.#outbox.get(uuid)
    if (entry === undefined) throw new Error(`fake session has no outbox entry ${uuid}`)
    this.#outbox.set(uuid, { ...entry, state: 'committed' })
    this.emit({ type: 'result', subtype: 'success' })
  }

  /**
   * Forget one outbox entry — the state the adapter would see if a uuid it is
   * still tracking never appears in the receipt (a resumed actor, a pruned
   * outbox). The real seam never does this; the probe exists to pin what the
   * adapter does when the outbox cannot answer for a message.
   * @param uuid - the entry to drop.
   * @returns nothing.
   */
  dropOutboxEntry(uuid: CcUuid): void {
    this.#outbox.delete(uuid)
  }

  /**
   * Emit one raw message, with the seam's default metadata.
   * @param message - the message body.
   * @returns nothing.
   */
  emit(message: { readonly type: string, readonly subtype?: string }): void {
    const envelope: CcMessageEnvelope = {
      message,
      meta: {
        sessionId: this.id,
        receivedAt: 0,
        interruptArtifact: false,
        interruptedTurn: false,
        reinit: false,
      },
    }
    for (const listener of [...this.#messageListeners]) listener(envelope)
  }

  /**
   * Move the lifecycle without sending anything (the handshake completing, a
   * turn Claude Code started on its own).
   * @param status - the new status.
   * @returns nothing.
   */
  setStatus(status: CcSessionStatus): void {
    this.#status = status
    this.emit({ type: 'system', subtype: 'status' })
  }

  /**
   * Close the session, as the seam's own `close()` does.
   * @returns nothing.
   */
  close(): void {
    this.#status = 'closed'
    for (const listener of [...this.#closeListeners]) listener()
    this.#closeListeners.clear()
    this.#messageListeners.clear()
  }
}

/** A mounted, offline composition: real registries, fake Claude Code backend. */
export interface MountedSeam {
  /** The root context every service is mounted on. */
  readonly ctx: Context
  /** The seam's fake SDK backend and the queries it handed out. */
  readonly fake: FakeBackend
  /** Dispose the whole composition. */
  dispose(): Promise<void>
}

/**
 * Mount `SessionStore` + `AgentRegistry` + `ClaudeCodeService` on one context,
 * with the seam driven by a fake backend so `open()` spawns nothing.
 * @returns the mounted context and its teardown.
 */
export async function mountSeam(): Promise<MountedSeam> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const fake = createFakeBackend()
  function mountClaudeCode(inner: Context): void {
    void new ClaudeCodeService(inner, { prewarm: false }, { backend: fake.backend })
  }
  await ctx.plugin(mountClaudeCode)
  return {
    ctx,
    fake,
    dispose: async () => {
      await ctx.fiber.dispose()
    },
  }
}
