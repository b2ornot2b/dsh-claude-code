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
  { kind: 'tool', regex: /toolu_[A-Za-z0-9_-]+/g },
  // Anthropic provider message ids.
  { kind: 'msg', regex: /msg_[A-Za-z0-9_-]+/g },
]

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
    if (typeof value === 'string') return scrubString(value)
    if (typeof value === 'number') {
      return key !== undefined && NUMERIC_SCRUB_FIELDS.has(key) ? 0 : value
    }
    if (Array.isArray(value)) return value.map(entry => scrubValue(entry, undefined))
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
