/**
 * The Claude Agent SDK boundary, expressed as an injectable seam.
 *
 * Two invariants shape this file:
 *
 * 1. **Only this package may import `@anthropic-ai/claude-agent-sdk`** (Phase 1
 *    contract §1.2), and **no SDK type may reach any emitted `.d.ts`**. Every
 *    type below is therefore declared HERE, in this seam's own vocabulary, and
 *    the only place the SDK's types are touched is inside {@link realBackend}'s
 *    function bodies. Because `realBackend` is annotated with the SDK-free
 *    {@link QueryBackend}, `lib/types/backend.d.ts` contains no reference to the
 *    SDK at all — verified after every build.
 * 2. **The declarations are structurally checked against the real SDK.**
 *    `realBackend` passes our option objects straight to `query()`/`startup()`
 *    and returns the SDK's handles as ours, with **no casts**. If a future SDK
 *    bump changes a shape we depend on, this file stops compiling — which is
 *    the point. Never "fix" such a break with an `as`; fix the declaration.
 *
 * Unit tests inject a fake backend; nothing else in the package is allowed to
 * reach for `query()` directly.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  listSessions as sdkListSessions, query as sdkQuery, startup as sdkStartup,
} from '@anthropic-ai/claude-agent-sdk'

import type { CcRegistryEntry, CcStoreEntry } from './discovery-local.ts'
import type { CcPermissionMode, CcSettingSource } from './types.ts'

/**
 * A UUID in the shape the SDK's own `uuid` fields demand (a template-literal
 * type, not a plain `string`). `node:crypto`'s `randomUUID()` returns exactly
 * this, so stamping is a no-cast operation.
 */
export type CcUuid = `${string}-${string}-${string}-${string}-${string}`

/**
 * One message coming out of a Claude Code session.
 *
 * Deliberately loose: the SDK's `SDKMessage` is a ~38-variant union that grows
 * every release, so this seam types the fields every variant carries and leaves
 * the rest to the index signature. Consumers (the Phase 3 mirror) MUST have a
 * default-ignore branch and must never exhaustively switch on `type`.
 */
export type CcSdkMessage = {
  /** Message kind (`'assistant'`, `'user'`, `'result'`, `'system'`, `'stream_event'`, …). */
  readonly type: string
  /** Sub-kind, present on `system` (`'init'`, …) and `result` (`'success'`, `'error_during_execution'`, …) messages. */
  readonly subtype?: string
  /** The message's own uuid. For results this is NOT the uuid of the user message that caused it. */
  readonly uuid?: string
  /** The CLI-side session id — always equal to the id we minted. */
  readonly session_id?: string
  /** Everything else the variant carries. Read defensively; the union is open. */
  readonly [field: string]: unknown
}

/**
 * A user message on the way IN to a session. Mirrors the SDK's `SDKUserMessage`
 * for exactly the fields this integration sets.
 *
 * `uuid` is what makes interrupt-receipt reconciliation possible (spike 3):
 * un-stamped messages are invisible to the receipt, so
 * {@link CcInputStream.push} stamps every message.
 */
export interface CcSdkUserMessage {
  /** Always `'user'`. */
  readonly type: 'user'
  /** The Anthropic-shaped message body. Text-only in Phase 2. */
  readonly message: { readonly role: 'user', readonly content: string }
  /** Tool-use parent for subagent-addressed messages; `null` for main-thread messages. */
  readonly parent_tool_use_id: string | null
  /** The session this message belongs to. The SDK accepts `''` and fills it in. */
  readonly session_id?: string
  /** Reconciliation key. Always set by this package. */
  readonly uuid?: CcUuid
  /**
   * `'now'` aborts the running turn and refolds both instructions into one
   * fresh turn (spike 2 — this is the closest thing to steering the SDK has).
   * Omitted means "queue as its own next turn".
   */
  readonly priority?: 'now' | 'next' | 'later'
  /**
   * `false` appends the message to the transcript WITHOUT starting a turn — the
   * native equivalent of dsh's `inject()` (delta S7).
   */
  readonly shouldQuery?: boolean
}

/**
 * One rule inside a {@link CcPermissionSuggestion} — the exact shape the SDK's
 * `PermissionRuleValue` carries, and the shape the integration-owned rule cache
 * stores (`src/ask/rules.ts`).
 */
export interface CcPermissionRuleValue {
  /** The tool the rule is about (`'Bash'`, `'Read'`, …). */
  readonly toolName: string
  /** The rule body, e.g. a Bash prefix pattern (`'npm test:*'`). Absent means "the whole tool". */
  readonly ruleContent?: string
}

/**
 * One permission update the CLI SUGGESTS when it prompts ("allow this again
 * without asking"). Deliberately looser than the SDK's six-variant union so a
 * new variant cannot break the build — every field a variant may carry is
 * optional here, and the router reads only `type`/`behavior`/`destination`/`rules`.
 *
 * **These are never echoed back.** Phase 0 spike 4 proved a headless
 * `canUseTool` returning `updatedPermissions` writes nothing to disk with any
 * `settingSources` value: persistence is the interactive TUI's job. The
 * integration owns its own rule cache instead, and these suggestions are the
 * KEY it is consulted with.
 */
export interface CcPermissionSuggestion {
  /** `'addRules'`, `'replaceRules'`, `'removeRules'`, `'setMode'`, `'addDirectories'`, `'removeDirectories'`. */
  readonly type: string
  /** Where the CLI would have written it (`'localSettings'` is the project-local layer). */
  readonly destination: string
  /** `'allow'` / `'deny'` / `'ask'` on the rule variants. */
  readonly behavior?: string
  /** The rules, on the rule variants. */
  readonly rules?: readonly CcPermissionRuleValue[]
  /** The directories, on the directory variants. */
  readonly directories?: readonly string[]
  /** The mode, on the `setMode` variant. */
  readonly mode?: string
}

/**
 * Context the SDK hands to the permission callback (delta S2). Every field the
 * ask channel reads is declared; the SDK's object carries a few more.
 */
export interface CcPermissionRequest {
  /** Aborted when the tool call is abandoned; settle the ask and answer promptly. */
  readonly signal: AbortSignal
  /** Correlates with the `tool_use` block id — the `callId` for dsh approval. */
  readonly toolUseID: string
  /** The control-request envelope id. THE idempotency key: redelivery reuses it. */
  readonly requestId: string
  /** Pre-rendered prompt sentence ("Claude wants to read foo.txt"), when the CLI supplies one. */
  readonly title?: string
  /** Short noun phrase for the action ("Read file"). */
  readonly displayName?: string
  /** Human-readable subtitle explaining the consequence of allowing. */
  readonly description?: string
  /** Path that triggered the prompt, for path-scoped denials. */
  readonly blockedPath?: string
  /** Why the prompt fired at all. */
  readonly decisionReason?: string
  /** Sub-agent id, when the call came from a subagent rather than the main thread. */
  readonly agentID?: string
  /**
   * What the CLI would persist if a human said "always allow". The rule cache
   * (`src/ask/rules.ts`) is keyed on the `destination: 'localSettings'` entries;
   * they are NEVER echoed back as `updatedPermissions` (spike 4).
   */
  readonly suggestions?: readonly CcPermissionSuggestion[]
  /**
   * Set when a user-configured `permissions.ask` RULE forced this prompt. A
   * rule-forced ask states the user's own intent to be asked, so the rule cache
   * must not short-circuit it.
   */
  readonly matchedAskRule?: {
    /** Which settings layer the ask rule came from. */
    readonly source: string
    /** The tool the ask rule names. */
    readonly toolName: string
    /** The rule body, when the ask rule is scoped. */
    readonly ruleContent?: string
  }
}

/**
 * The answer a permission callback returns. Never `null`: the SDK reads `null`
 * as "the consumer already answered out of band", and an accidental `null`
 * blocks the tool forever (there is no park deadline).
 *
 * Allow ALWAYS carries `updatedInput` — the SDK's older allow-without-input
 * path is version-gated and we never rely on it.
 */
export type CcPermissionDecision =
  | {
    /** Let the tool run. */
    readonly behavior: 'allow'
    /** The (possibly rewritten) tool input. Always sent. */
    readonly updatedInput: Record<string, unknown>
  }
  | {
    /** Refuse the tool call. */
    readonly behavior: 'deny'
    /** Explanation delivered to the model as the tool result. */
    readonly message: string
    /** Also stop the turn (deny-and-interrupt in one step) — used by `askFallback: 'error'`. */
    readonly interrupt?: boolean
  }

/**
 * The permission callback signature, in this seam's vocabulary. The ask router
 * (`src/ask/router.ts`) is the real implementation; a session wired to no ask
 * channel keeps the fail-closed deny, so a live session can never silently act
 * without a decision.
 */
export type CcCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  request: CcPermissionRequest,
) => Promise<CcPermissionDecision>

/** One slash command the CLI advertises at initialize time. */
export interface CcSlashCommandInfo {
  /** Command name without the leading slash. */
  readonly name: string
  /** What the command does. */
  readonly description: string
}

/** One model the CLI offers. */
export interface CcModelInfoEntry {
  /** Model identifier to pass as `model`. */
  readonly value: string
  /** Human-readable name. */
  readonly displayName: string
}

/**
 * Account projection straight from the CLI. Mirrors the SDK's `AccountInfo`;
 * the service maps it onto the public {@link CcAccountInfo}.
 */
export interface CcAccountData {
  /** Logged-in account email, when the CLI reports one. */
  readonly email?: string
  /** Organization name, when the CLI reports one. */
  readonly organization?: string
  /** Subscription tier (e.g. a Max plan). */
  readonly subscriptionType?: string
  /** Where the token came from, when reported. */
  readonly tokenSource?: string
  /** Where an API key came from, when one is in play — the subscription-auth smoking gun. */
  readonly apiKeySource?: string
  /** Active API backend (`firstParty`, `bedrock`, …). */
  readonly apiProvider?: string
}

/** The initialize response, cached on the session at {@link CcSession.open}. */
export interface CcInitializeResult {
  /** Slash commands this session supports. */
  readonly commands: readonly CcSlashCommandInfo[]
  /** Models this session may switch to. */
  readonly models: readonly CcModelInfoEntry[]
  /** Which account the subprocess authenticated as. */
  readonly account: CcAccountData
  /** Output style name in force. */
  readonly output_style: string
}

/**
 * The interrupt receipt (`interrupt_receipt_v1`).
 *
 * Caveats that are contract, not trivia: only uuid-stamped main-thread messages
 * appear; an empty `still_queued` does NOT mean nothing else will run; and the
 * list may contain uuids we never sent (cron triggers, auto-resume) — ignore
 * unknown ones rather than treating them as an error.
 */
export interface CcInterruptReceipt {
  /** Uuids of queued user messages that SURVIVE this interrupt and will each run. */
  readonly still_queued: readonly string[]
  /** Uuids cancelled by the interrupt. Only present on CLIs driving `cancel_queued` — the public SDK cannot request it in 0.3.233. */
  readonly cancelled?: readonly string[]
}

/**
 * The subset of the SDK `Query` handle this integration drives. Streaming-input
 * mode is mandatory: every control method below (and the permission callback)
 * exists only when `prompt` is an `AsyncIterable`.
 */
export interface CcBackendQuery extends AsyncIterable<CcSdkMessage> {
  /**
   * Abort the running turn.
   * @returns the receipt on CLIs advertising `interrupt_receipt_v1`, `undefined` on older ones.
   */
  interrupt(): Promise<CcInterruptReceipt | undefined>
  /**
   * The cached initialize response (commands, models, account).
   * @returns the initialize result.
   */
  initializationResult(): Promise<CcInitializeResult>
  /**
   * Switch the model mid-session.
   * @param model - model id, or omitted for the CLI default.
   */
  setModel(model?: string): Promise<void>
  /**
   * Switch the permission mode mid-session.
   * @param mode - the new mode.
   */
  setPermissionMode(mode: CcPermissionMode): Promise<void>
  /**
   * Ask the CLI who it is authenticated as.
   * @returns the account projection.
   */
  accountInfo(): Promise<CcAccountData>
  /** Close the query and its subprocess. No further messages arrive. */
  close(): void
}

/**
 * A pre-warmed subprocess handle. **Single use**: `query()` may be called once,
 * and the options were fixed at `startup()` time — which is why
 * {@link WarmPool} only serves an `open()` whose resolved options match the
 * warmed ones.
 */
export interface CcWarmQuery {
  /**
   * Attach the input stream to the already-initialized subprocess.
   * @param prompt - the never-completing input stream.
   * @returns the live query handle.
   */
  query(prompt: AsyncIterable<CcSdkUserMessage>): CcBackendQuery
  /** Discard the warm subprocess without ever sending a prompt. */
  close(): void
}

/**
 * Options passed to `query()`/`startup()`. Exactly the fields this integration
 * sets — adding one here is a deliberate act, because every field is part of
 * the {@link warmFingerprint} equality question.
 */
export interface CcQueryOptions {
  /** OUR session id (a bare UUID). Never let the CLI mint one. */
  readonly sessionId?: string
  /** Resume this session's history. */
  readonly resume?: string
  /** Fork the resumed session instead of continuing it; requires `sessionId` + `resume`. */
  readonly forkSession?: boolean
  /** Absolute working directory. */
  readonly cwd?: string
  /** Model id; omitted means the CLI default. */
  readonly model?: string
  /** Permission mode for the session. */
  readonly permissionMode?: CcPermissionMode
  /** System prompt; always the `claude_code` preset, optionally with appended text. */
  readonly systemPrompt?: {
    readonly type: 'preset'
    readonly preset: 'claude_code'
    readonly append?: string
  }
  /** On-disk setting layers. ALWAYS sent explicitly — omitting it loads every source (delta S1). */
  readonly settingSources?: CcSettingSource[]
  /** Emit `stream_event` partial messages, required for `assistant/chunk` mirroring. */
  readonly includePartialMessages?: boolean
  /** Permission callback. Streaming-input mode only. */
  readonly canUseTool?: CcCanUseTool
  /** The COMPLETE subprocess environment — it replaces, never merges (delta S9). */
  readonly env?: Record<string, string | undefined>
  /** Subprocess stderr sink. */
  readonly stderr?: (data: string) => void
  /** Cancellation for the whole query. */
  readonly abortController?: AbortController
  /** Escape hatch to an already-installed `claude` executable. */
  readonly pathToClaudeCodeExecutable?: string
}

/**
 * The SDK boundary as a two-method interface. Everything in this package talks
 * to Claude Code through it, so a unit test can drive a complete session
 * lifecycle offline by injecting a fake.
 */
export interface QueryBackend {
  /**
   * Start a session on a fresh subprocess.
   * @param params - the input stream and the resolved options.
   * @returns the live query handle.
   */
  query(params: {
    prompt: AsyncIterable<CcSdkUserMessage>
    options: CcQueryOptions
  }): CcBackendQuery
  /**
   * Spawn and initialize a subprocess ahead of time (~300ms of init latency,
   * spike 5). The returned handle is single-use.
   * @param params - the options to fix at startup, and an optional initialize timeout.
   * @returns the warm handle.
   */
  startup(params: {
    options: CcQueryOptions
    initializeTimeoutMs?: number
  }): Promise<CcWarmQuery>
}

/**
 * The real backend: `query()` and `startup()` from
 * `@anthropic-ai/claude-agent-sdk@0.3.233`.
 *
 * The bodies below are the ONLY place the SDK's types are exercised, and they
 * contain no casts on purpose — type-checking this object is the compile-time
 * proof that every declaration above still matches the installed SDK.
 */
export const realBackend: QueryBackend = {
  query(params) {
    return sdkQuery({ prompt: params.prompt, options: params.options })
  },
  async startup(params) {
    return await sdkStartup({
      options: params.options,
      ...(params.initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs: params.initializeTimeoutMs }),
    })
  },
}

const execFileAsync = promisify(execFile)

/** How long `ps` may take confirming a registry pid's start time before its liveness degrades to `'assumed'`. */
const PROC_START_CONFIRM_TIMEOUT_MS = 5_000

/**
 * List this host's resumable sessions from the SDK's own store (design §5.1,
 * P1): the local read is authoritative — `customTitle`, the SDK's summary
 * folding — and costs nothing but an in-process scan, so the local discovery
 * source never shells out to the probe the way a mesh host does.
 *
 * This is the second of the two SDK-boundary readers `discovery-local.ts`
 * consumes through injection; wrapped here because this file is the only
 * place in the package permitted to import the SDK.
 *
 * @param options - `limit` caps how many rows come back.
 * @returns the store entries, in the SDK's own most-recent-first order.
 */
export async function listLocalStore(options: { limit: number }): Promise<CcStoreEntry[]> {
  const sessions = await sdkListSessions({ limit: options.limit, includeProgrammatic: true })
  return sessions.map(session => ({
    sessionId: session.sessionId,
    summary: session.summary,
    lastModified: session.lastModified,
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(session.customTitle === undefined ? {} : { customTitle: session.customTitle }),
    ...(session.firstPrompt === undefined ? {} : { firstPrompt: session.firstPrompt }),
    ...(session.gitBranch === undefined ? {} : { gitBranch: session.gitBranch }),
    ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
    ...(session.fileSize === undefined ? {} : { fileSize: session.fileSize }),
  }))
}

/**
 * Whether a pid currently exists. `ESRCH` means it does not; `EPERM` means the
 * kernel found the process but refused the signal because we do not own it —
 * which still proves it exists. Any other failure (a non-numeric pid slipping
 * through, an exotic platform errno) is treated as "does not exist": this
 * function may only ever be asked to prove liveness, never assume it.
 * @param pid - the process id to probe.
 * @returns true when the pid names a live process.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Best-effort confirmation that a registry entry's pid is the SAME process
 * that wrote the file, not a reused one (design P5, §5.2): compare the
 * `procStart` the file recorded against `ps -o lstart=` for the running pid.
 * Every failure path — no recorded `procStart`, `ps` missing, a timeout, a
 * platform that formats `lstart` differently — degrades to `'assumed'`. This
 * function must never upgrade confidence, only ever hold it back: an
 * `'assumed'` liveness that turns out fine costs nothing, a `'confirmed'` one
 * that turns out to be pid reuse reports someone else's session as live.
 * @param pid - the process id.
 * @param recordedProcStart - the start-time string the registry file recorded, when present.
 * @returns `'confirmed'` when the two agree, `'assumed'` otherwise.
 */
async function confirmLiveness(
  pid: number,
  recordedProcStart: string | undefined,
): Promise<'confirmed' | 'assumed'> {
  if (recordedProcStart === undefined) return 'assumed'
  try {
    const { stdout } = await execFileAsync(
      'ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: PROC_START_CONFIRM_TIMEOUT_MS })
    return stdout.trim() === recordedProcStart ? 'confirmed' : 'assumed'
  } catch {
    return 'assumed'
  }
}

/** The fields this reader tolerates from one `~/.claude/sessions/<pid>.json` file, all unvalidated. */
interface RawRegistryFile {
  readonly pid?: unknown
  readonly sessionId?: unknown
  readonly cwd?: unknown
  readonly name?: unknown
  readonly kind?: unknown
  readonly entrypoint?: unknown
  readonly version?: unknown
  readonly startedAt?: unknown
  readonly procStart?: unknown
}

/**
 * Read this host's live-session registry (design §5.2): one small JSON file
 * per process under `$HOME/.claude/sessions/`. Mirrors
 * `scripts/claude-inventory`'s liveness rule exactly, since that Python probe
 * is the reference implementation the mesh's remote hosts run: a registry
 * entry counts as live only when its pid currently exists (P5 — the registry
 * is known to hold week-old dead entries), and a dead one is dropped outright
 * rather than reported — the transcript-store reader will still surface it as
 * `resumable` if it falls inside the recency window.
 *
 * @returns live registry entries, one per pid confirmed to still exist.
 */
export async function readLocalRegistry(): Promise<CcRegistryEntry[]> {
  const root = join(homedir(), '.claude', 'sessions')
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }

  const entries: CcRegistryEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let raw: RawRegistryFile
    try {
      raw = JSON.parse(await readFile(join(root, name), 'utf8')) as RawRegistryFile
    } catch {
      continue
    }
    if (typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') continue
    if (!pidAlive(raw.pid)) continue
    const procStart = typeof raw.procStart === 'string' ? raw.procStart : undefined
    entries.push({
      sessionId: raw.sessionId,
      pid: raw.pid,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      liveness: await confirmLiveness(raw.pid, procStart),
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
      ...(typeof raw.entrypoint === 'string' ? { entrypoint: raw.entrypoint } : {}),
      ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
      ...(typeof raw.startedAt === 'number' ? { startedAt: raw.startedAt } : {}),
    })
  }
  return entries
}
