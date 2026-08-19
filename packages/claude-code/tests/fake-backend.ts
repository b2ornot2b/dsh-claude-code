/**
 * An offline stand-in for the Claude Agent SDK.
 *
 * Phase 2 is a protocol implementation: statuses, outbox reconciliation and the
 * drain loop are decisions the seam makes about messages it receives, so they
 * are testable to the letter without a subprocess. This fake plays the SDK's
 * side of that protocol — it records the options it was constructed with, drains
 * the input stream, lets a test emit any message, and answers `interrupt()` from
 * a scripted queue of receipts.
 *
 * Not a spec file: `vitest` collects `*.spec.ts` only, while
 * `tsconfig.tests.json` still type-checks this module.
 */

import type {
  CcBackendQuery, CcInitializeResult, CcInterruptReceipt, CcPermissionMode, CcQueryOptions,
  CcSdkMessage, CcSdkUserMessage, CcWarmQuery, QueryBackend,
} from '@deepseek-ai/dsh-claude-code'

/** Let every pending microtask and one macrotask turn drain. */
export async function settle(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

/** The canned initialize response every fake query answers with. */
export const FAKE_INITIALIZE: CcInitializeResult = {
  commands: [{ name: 'usage', description: 'Show usage' }],
  models: [{ value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' }],
  account: { email: 'tester@example.com', subscriptionType: 'max', apiProvider: 'firstParty' },
  output_style: 'default',
}

/** One fake `Query`: an async iterable a test drives message by message. */
export class FakeQuery implements CcBackendQuery {
  /** The options this query was constructed with. */
  readonly options: CcQueryOptions
  /** Every user message drained off the input stream, in order. */
  readonly sent: CcSdkUserMessage[] = []
  /** Receipts `interrupt()` answers with, in order; exhausted means `undefined`. */
  readonly receipts: (CcInterruptReceipt | undefined)[] = []
  /** How many times `interrupt()` was called. */
  interruptCount = 0
  /** Whether `close()` has been called. */
  closed = false
  /** Models passed to `setModel()`. */
  readonly models: (string | undefined)[] = []

  #queue: CcSdkMessage[] = []
  #done = false
  /** Set by {@link FakeQuery.failStream}: raised out of the iterator once the queue drains. */
  #failure: unknown
  #wake: (() => void) | undefined
  #waiting: Promise<void>

  /**
   * @param options - the options the backend was called with.
   * @param prompt - the session's input stream, drained in the background.
   */
  constructor(options: CcQueryOptions, prompt: AsyncIterable<CcSdkUserMessage>) {
    this.options = options
    this.#waiting = new Promise<void>(resolve => { this.#wake = resolve })
    void this.drain(prompt)
  }

  /**
   * Emit one message into the session's pump and wait for it to be observed.
   * @param message - the message to deliver.
   * @returns nothing.
   */
  async emit(message: CcSdkMessage): Promise<void> {
    this.#queue.push(message)
    this.signal()
    await settle()
  }

  /**
   * Emit a `result` message (the turn boundary the status machine keys on).
   * @param subtype - result subtype; defaults to a successful turn.
   * @param extra - extra fields to merge onto the message.
   * @returns nothing.
   */
  async emitResult(subtype = 'success', extra: Record<string, unknown> = {}): Promise<void> {
    await this.emit({ type: 'result', subtype, uuid: `result-${this.#queue.length}`, ...extra })
  }

  /**
   * Emit a `system/init` message.
   * @param extra - extra fields (model, capabilities, …).
   * @returns nothing.
   */
  async emitInit(extra: Record<string, unknown> = {}): Promise<void> {
    await this.emit({ type: 'system', subtype: 'init', ...extra })
  }

  /** Complete the message stream, as a dead subprocess would. */
  endStream(): void {
    this.#done = true
    this.signal()
  }

  /**
   * Make the message stream THROW rather than complete — a transport failure
   * (a broken pipe, a subprocess killed hard enough that the SDK's reader
   * errors) as distinct from an orderly end of stream.
   * @param error - the failure to raise out of the iterator.
   * @returns nothing.
   */
  failStream(error: unknown = new Error('claude-code: transport died')): void {
    this.#failure = error
    this.#done = true
    this.signal()
  }

  /**
   * The session's message source.
   * @returns an iterator over emitted messages.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<CcSdkMessage> {
    for (;;) {
      while (this.#queue.length > 0) {
        const next = this.#queue.shift()
        if (next !== undefined) yield next
      }
      // Everything already emitted is delivered first, THEN the failure: a
      // transport that dies mid-turn does not retract what it had sent.
      if (this.#failure !== undefined) throw this.#failure
      if (this.#done) return
      await this.#waiting
    }
  }

  /**
   * Answer the next scripted receipt.
   * @returns the receipt, or undefined when the script is exhausted.
   */
  async interrupt(): Promise<CcInterruptReceipt | undefined> {
    this.interruptCount += 1
    return await Promise.resolve(this.receipts.shift())
  }

  /** @returns the canned initialize result. */
  async initializationResult(): Promise<CcInitializeResult> {
    return await Promise.resolve(FAKE_INITIALIZE)
  }

  /**
   * Record a model switch.
   * @param model - the requested model.
   * @returns nothing.
   */
  async setModel(model?: string): Promise<void> {
    this.models.push(model)
    await Promise.resolve()
  }

  /**
   * Accept a permission-mode switch.
   * @param _mode - the requested mode (ignored).
   * @returns nothing.
   */
  async setPermissionMode(_mode: CcPermissionMode): Promise<void> {
    await Promise.resolve()
  }

  /** @returns the canned account. */
  async accountInfo(): Promise<CcInitializeResult['account']> {
    return await Promise.resolve(FAKE_INITIALIZE.account)
  }

  /** Close the fake query and end its stream. */
  close(): void {
    this.closed = true
    this.endStream()
  }

  /** Release the parked consumer and arm the next wait. */
  private signal(): void {
    const resolve = this.#wake
    this.#waiting = new Promise<void>(next => { this.#wake = next })
    resolve?.()
  }

  /**
   * Drain the input stream into {@link FakeQuery.sent}.
   * @param prompt - the session's input stream.
   * @returns nothing.
   */
  private async drain(prompt: AsyncIterable<CcSdkUserMessage>): Promise<void> {
    for await (const message of prompt) this.sent.push(message)
  }
}

/** One fake `WarmQuery`. */
export class FakeWarmQuery implements CcWarmQuery {
  /** The options frozen at `startup()`. */
  readonly options: CcQueryOptions
  /** The query handed out by {@link FakeWarmQuery.query}, once used. */
  used: FakeQuery | undefined
  /** Whether the warm handle was discarded. */
  closed = false

  /**
   * @param options - the startup options.
   */
  constructor(options: CcQueryOptions) {
    this.options = options
  }

  /**
   * Attach an input stream to the warm subprocess.
   * @param prompt - the session's input stream.
   * @returns the live fake query.
   */
  query(prompt: AsyncIterable<CcSdkUserMessage>): CcBackendQuery {
    this.used = new FakeQuery(this.options, prompt)
    return this.used
  }

  /** Discard the warm handle. */
  close(): void {
    this.closed = true
  }
}

/** A fake backend plus everything it has been asked to build. */
export interface FakeBackend {
  /** The injectable backend. */
  readonly backend: QueryBackend
  /** Every cold query created, in order. */
  readonly queries: FakeQuery[]
  /** Every warm handle created, in order. */
  readonly warms: FakeWarmQuery[]
  /** Set to make `startup()` reject, proving a failed pre-warm degrades to a cold open. */
  failStartup: boolean
}

/**
 * Build a fake backend.
 * @returns the backend and the handles it hands out.
 */
export function createFakeBackend(): FakeBackend {
  const queries: FakeQuery[] = []
  const warms: FakeWarmQuery[] = []
  const fake: FakeBackend = {
    queries,
    warms,
    failStartup: false,
    backend: {
      query(params) {
        const query = new FakeQuery(params.options, params.prompt)
        queries.push(query)
        return query
      },
      async startup(params) {
        if (fake.failStartup) throw new Error('fake: startup refused')
        const warm = new FakeWarmQuery(params.options)
        warms.push(warm)
        return await Promise.resolve(warm)
      },
    },
  }
  return fake
}
