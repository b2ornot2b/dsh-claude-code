/**
 * A stable scrubber for recorded live fixtures.
 *
 * A live Claude Code session leaks non-determinism into every message: real
 * uuids, real tool-use ids, real token counts, real wall-clock timestamps, and
 * (via tool output) the real absolute tmp `cwd` the recorder ran in. None of
 * that is meaningful to the mirror's projection — what matters is STRUCTURE:
 * which block indices existed, which `tool_use` id a `tool_result` answered,
 * how many chunks a call produced. The scrubber replaces every non-deterministic
 * value with a stable placeholder so two recordings of "the same shape" of
 * session diff cleanly, while preserving every pairing relationship (the same
 * original value always scrubs to the same placeholder, wherever it recurs).
 *
 * Not a spec file: vitest only collects `*.spec.ts`, while `tsconfig.tests.json`
 * still type-checks this module (it lives under `packages/claude-code/tests/`).
 */

/** One instance of a scrubbing pass — holds the token → placeholder table. */
export interface Scrubber {
  /**
   * Deep-scrub a JSON-shaped value: id-like tokens (uuids, `toolu_…`, `msg_…`)
   * are replaced with stable placeholders (same input → same output, across the
   * WHOLE fixture, not just one call), known non-deterministic field names are
   * zeroed, and any configured literal substrings (the recorder's tmp `cwd`) are
   * replaced everywhere they appear, including inside larger strings.
   * @param value - the value to scrub (mutated copies only; the input is untouched).
   * @returns a structurally identical, fully scrubbed clone.
   */
  scrub<T>(value: T): T
}

/**
 * Field names whose numeric value is inherently non-deterministic across live
 * runs: token/cost accounting (both the SDK's `snake_case` wire fields and its
 * `camelCase` `modelUsage` projection of the SAME numbers) and every wall-clock
 * timing field the CLI's `result` message reports.
 */
const NUMERIC_SCRUB_FIELDS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'ephemeral_1h_input_tokens',
  'ephemeral_5m_input_tokens',
  'thinking_tokens',
  'inputTokens',
  'outputTokens',
  // The CLI's running estimate on `stream_event` progress messages. Recording
  // the SAME prompt twice produces different values (the model does not emit
  // identical token counts run to run), so these dirtied all three fixtures on
  // every sweep — the same class as the counters above, simply missed.
  'estimated_tokens',
  'estimated_tokens_delta',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'contextWindow',
  'maxOutputTokens',
  'costUSD',
  'total_cost_usd',
  'duration_ms',
  'duration_api_ms',
  'ttft_ms',
  'ttft_stream_ms',
  'time_to_request_ms',
  'request_sent_wall_ms',
  'num_turns',
  'sentAt',
  'receivedAt',
  'resetsAt',
])

/** Id-shaped substrings scrubbed wherever they occur, each with its own placeholder namespace. */
const ID_PATTERNS: ReadonlyArray<{ readonly kind: string, readonly regex: RegExp }> = [
  // Anthropic / Claude Code uuids (session ids, message uuids, request ids, …).
  { kind: 'uuid', regex: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi },
  // Anthropic tool_use block ids.
  { kind: 'tool', regex: /toolu_[A-Za-z0-9]{16,}/g },
  // Anthropic provider message ids: `msg_` then base62, no separators, always
  // long (`msg_011Ce8gmjWZRoiEDtCGReRAp` — 24 characters in the Phase 0 spike
  // logs). The length floor and the excluded `_`/`-` are BOTH load-bearing: the
  // permissive `msg_[A-Za-z0-9_-]+` this replaces also matched
  // `msg_lifecycle_v1`, one of the three capability names `system/init`
  // advertises, and rewrote it to `msg-scrubbed-0001` in every recorded
  // fixture. That is a scrubber destroying a deterministic, meaningful value —
  // the exact opposite of its job — and it silently corrupted the capability
  // list this seam feature-detects on (never version-sniffs, delta S14).
  { kind: 'msg', regex: /msg_[A-Za-z0-9]{16,}/g },
  // Anthropic API request ids (`req_011Ce9GpntFmd3MzGb7HNcyB`), which the CLI
  // echoes onto `stream_event` and `result` messages. Same shape rule as the
  // message ids above, and the same reason for the length floor.
  { kind: 'req', regex: /req_[A-Za-z0-9]{16,}/g },
]

/**
 * String fields whose value is a wall clock or a provider-side opaque blob:
 * different on every recording, and meaningless to the mirror's projection.
 *
 * - `timestamp` — the CLI's ISO instant on `stream_event`/`result` messages.
 *   The numeric timing fields were already zeroed; this is the same fact in
 *   string form, and it was dirtying every fixture on every sweep.
 * - `signature` — the thinking block's provider signature, a long base64 blob
 *   derived from the model's own output, so it changes whenever the text does.
 *   It has no dsh representation at all: `CcMirror.onBlockDelta` ignores
 *   `signature_delta` outright ("provider replay metadata with nowhere to
 *   live", delta D9), so preserving it records bytes nothing will ever read.
 */
const STRING_SCRUB_FIELDS = new Map<string, string>([
  ['timestamp', '1970-01-01T00:00:00.000Z'],
  ['signature', 'scrubbed-signature'],
])

/**
 * `system/init` fields that describe the RECORDER'S MACHINE rather than the
 * session: the slash commands, skills, subagents and plugins that happen to be
 * installed where the sweep ran.
 *
 * They are not test-relevant (the mirror ignores every one of them — see
 * `CcMirror.onSystem`, which reads `model` and nothing else off an init), they
 * change whenever anyone installs a plugin or a skill, and they carry the
 * recorder's personal configuration into a checked-in file. Left alone, every
 * `pnpm run test:live` on a different machine rewrites all three fixtures with
 * a diff that says nothing about Claude Code.
 *
 * Replaced with a marker rather than dropped, so the fixture still records that
 * the field existed and was an array — a future reader must not conclude the
 * CLI stopped sending it.
 *
 * `tools` is deliberately NOT here: it is also environment-dependent (plugin
 * and MCP tools appear in it), but it is the one list a mirror or card fixture
 * could legitimately be read against, so it stays verbatim and is documented as
 * the remaining churn source.
 */
const ENVIRONMENT_LIST_FIELDS = new Set([
  'slash_commands',
  'terminal_slash_commands',
  'skills',
  'agents',
  'plugins',
  'commands',
])

/** What an {@link ENVIRONMENT_LIST_FIELDS} array is replaced with. */
const SCRUBBED_LIST = ['scrubbed-machine-local-list']

/**
 * Blanket path scrubs that need no per-fixture literal: the CLI derives a
 * project-memory directory name from the (machine- and run-specific) cwd by
 * mangling every path separator into a dash, which is not reproducible from
 * the recorder's own `cwd` string and would otherwise leak straight through
 * `system/init`'s `memory_paths` field. Matched structurally instead: whatever
 * follows `.claude/projects/` up to the next path separator is machine-specific
 * noise, never test-relevant content.
 */
const BLANKET_PATTERNS: ReadonlyArray<{ readonly regex: RegExp, readonly replacement: string }> = [
  { regex: /\.claude\/projects\/[^/"\\]+/g, replacement: '.claude/projects/scrubbed-project-slug' },
  // `system/init.messaging_socket_path` embeds the live CLI subprocess's own
  // PID (`/tmp/cc-socks/<pid>.sock`) — a different, non-reproducible value on
  // every recording run, and not id-shaped enough for the uuid/toolu/msg
  // patterns below to catch. Left unscrubbed, every `pnpm run test:live` dirties
  // this field in the checked-in fixtures for no test-relevant reason.
  { regex: /cc-socks\/\d+\.sock/g, replacement: 'cc-socks/scrubbed.sock' },
]

/** One literal substring to replace everywhere it appears (e.g. a recorder's tmp cwd). */
export interface LiteralReplacement {
  readonly value: string
  readonly placeholder: string
}

/**
 * Build a scrubber. Fresh state per fixture: two fixtures recorded in the same
 * process must not share a token table, or one fixture's ids would leak stable
 * placeholders into the other's numbering.
 * @param literals - literal substrings to scrub first (before id-pattern scrubbing),
 *   e.g. `{ value: tmpCwdPath, placeholder: '/scrubbed/cwd' }`.
 * @returns a scrubber closed over its own token table.
 */
export function createScrubber(literals: readonly LiteralReplacement[] = []): Scrubber {
  const tokens = new Map<string, string>()
  const counters = new Map<string, number>()

  function placeholderFor(kind: string, original: string): string {
    const existing = tokens.get(original)
    if (existing !== undefined) return existing
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    const placeholder = `${kind}-scrubbed-${String(next).padStart(4, '0')}`
    tokens.set(original, placeholder)
    return placeholder
  }

  // Longest literal first: the recorder passes both a cwd and its realpath
  // (macOS resolves tmp dirs through a `/private` symlink), and the shorter one
  // is a SUBSTRING of the longer — replacing the short one first would leave a
  // stray `/private` prefix un-scrubbed forever.
  const orderedLiterals = [...literals].sort((left, right) => right.value.length - left.value.length)

  function scrubString(value: string): string {
    let out = value
    for (const { value: literal, placeholder } of orderedLiterals) {
      if (literal.length === 0) continue
      out = out.split(literal).join(placeholder)
    }
    for (const { regex, replacement } of BLANKET_PATTERNS) {
      out = out.replace(regex, replacement)
    }
    for (const { kind, regex } of ID_PATTERNS) {
      out = out.replace(regex, match => placeholderFor(kind, match))
    }
    return out
  }

  function scrubValue(value: unknown, key: string | undefined): unknown {
    if (typeof value === 'string') {
      const replacement = key === undefined ? undefined : STRING_SCRUB_FIELDS.get(key)
      return replacement ?? scrubString(value)
    }
    if (typeof value === 'number') {
      return key !== undefined && NUMERIC_SCRUB_FIELDS.has(key) ? 0 : value
    }
    if (Array.isArray(value)) {
      if (key !== undefined && ENVIRONMENT_LIST_FIELDS.has(key)) return [...SCRUBBED_LIST]
      return value.map(entry => scrubValue(entry, undefined))
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [entryKey, entryValue] of Object.entries(value)) out[entryKey] = scrubValue(entryValue, entryKey)
      return out
    }
    return value
  }

  return {
    scrub: <T>(value: T): T => scrubValue(value, undefined) as T,
  }
}
