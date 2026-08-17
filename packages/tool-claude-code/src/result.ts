/**
 * Pure projections from one Claude Code result envelope onto the JSON shapes
 * these tools return.
 *
 * Every function here is total and defensive. `CcSdkMessage` is a deliberately
 * open union (~38 variants and growing), so a field is read only when it has
 * the type we need and is otherwise absent from the projection — never `null`,
 * never `NaN`, never a present-and-undefined key (`exactOptionalPropertyTypes`).
 *
 * Shapes confirmed against a recorded SDK 0.3.233 `result` message
 * (`packages/claude-code/tests/fixtures/plain-text.json`):
 *
 * ```jsonc
 * { "type": "result", "subtype": "success",
 *   "result": "<final assistant text>",
 *   "total_cost_usd": 0.0123,
 *   "usage": { "input_tokens": 4, "output_tokens": 51,
 *              "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
 *   "modelUsage": { "claude-haiku-4-5-…": { "contextWindow": 200000, … } } }
 * ```
 *
 * @module @deepseek-ai/dsh-tool-claude-code
 */

import type { CcMessageEnvelope } from '@deepseek-ai/dsh-claude-code'

/** Token counts as the tools report them (the SDK's own field names). */
export interface CcUsageProjection {
  /** Prompt tokens the turn consumed. */
  readonly input_tokens: number
  /** Completion tokens the turn produced. */
  readonly output_tokens: number
}

/** What a completed turn contributes to a tool result. */
export interface CcResultProjection {
  /** Final assistant text, when the turn produced one. */
  readonly result?: string
  /** Token counts, when the SDK reported them. */
  readonly usage?: CcUsageProjection
  /** Turn cost in USD, when the SDK reported one. */
  readonly cost_usd?: number
}

/** Context-window occupancy as `claude_code_status` reports it. */
export interface CcContextUsageProjection {
  /** Tokens the live context occupies (see {@link projectContextUsage} for how it is derived). */
  readonly used_tokens: number
  /** The model's context window, when the result named one. */
  readonly max_tokens?: number
}

/**
 * Project a result envelope onto `{ result?, usage?, cost_usd? }`.
 *
 * A steering artifact never reaches here (the seam suppresses it from
 * `lastResult`/`waitForResult`), but an INTERRUPTED turn's
 * `error_during_execution` result does, and it carries no text — so the
 * projection is simply empty for it rather than reporting an empty string as an
 * answer.
 *
 * @param envelope - the result envelope, or undefined when no turn has finished.
 * @returns the projection; every field is absent unless the SDK reported it.
 */
export function projectResult(envelope: CcMessageEnvelope | undefined): CcResultProjection {
  if (envelope === undefined) return {}
  const message = envelope.message
  const text = readString(message['result'])
  const usage = projectUsage(asRecord(message['usage']))
  const cost = readNumber(message['total_cost_usd'])
  return {
    ...(text === undefined || text.length === 0 ? {} : { result: text }),
    ...(usage === undefined ? {} : { usage }),
    ...(cost === undefined ? {} : { cost_usd: cost }),
  }
}

/**
 * Project context-window occupancy from the latest result.
 *
 * This is the cheapest REAL source available today: neither `CcSession` nor the
 * SDK exposes a running context meter, but every `result` message reports the
 * usage of the request that produced it, and a Claude Code turn resends the
 * whole live context — so the prompt side of the last turn (fresh + cached
 * input) plus what that turn wrote back is a faithful lower bound on current
 * occupancy. `contextWindow` from `modelUsage` supplies the ceiling when the
 * CLI reported one.
 *
 * It is an APPROXIMATION and is documented as one: it is a snapshot of the last
 * completed turn, so it does not move while a turn is in flight, and it omits
 * whatever the CLI has since compacted away.
 *
 * @param envelope - the latest result envelope, or undefined when none exists.
 * @returns the occupancy, or undefined when the result reported no usable usage.
 */
export function projectContextUsage(
  envelope: CcMessageEnvelope | undefined,
): CcContextUsageProjection | undefined {
  if (envelope === undefined) return undefined
  const usage = asRecord(envelope.message['usage'])
  if (usage === undefined) return undefined
  const used = sum([
    readNumber(usage['input_tokens']),
    readNumber(usage['cache_read_input_tokens']),
    readNumber(usage['cache_creation_input_tokens']),
    readNumber(usage['output_tokens']),
  ])
  if (used === undefined) return undefined
  const max = readContextWindow(asRecord(envelope.message['modelUsage']))
  return {
    used_tokens: Math.round(used),
    ...(max === undefined ? {} : { max_tokens: max }),
  }
}

/**
 * Project the two token counts the tool schemas declare.
 * @param usage - the `usage` record off a result message.
 * @returns the counts, or undefined when neither was reported.
 */
function projectUsage(usage: Record<string, unknown> | undefined): CcUsageProjection | undefined {
  if (usage === undefined) return undefined
  const input = readNumber(usage['input_tokens'])
  const output = readNumber(usage['output_tokens'])
  if (input === undefined && output === undefined) return undefined
  return { input_tokens: Math.round(input ?? 0), output_tokens: Math.round(output ?? 0) }
}

/**
 * The largest positive `contextWindow` any model in `modelUsage` reported.
 *
 * A turn that switched models mid-flight lists more than one entry; the window
 * that matters for "how full is this session" is the largest one, and a zero
 * (the CLI's "unknown") is ignored rather than reported as a ceiling of 0.
 * @param modelUsage - the `modelUsage` record off a result message.
 * @returns the window, or undefined when none was reported.
 */
function readContextWindow(modelUsage: Record<string, unknown> | undefined): number | undefined {
  if (modelUsage === undefined) return undefined
  let best: number | undefined
  for (const entry of Object.values(modelUsage)) {
    const window = readNumber(asRecord(entry)?.['contextWindow'])
    if (window === undefined || window <= 0) continue
    best = best === undefined ? window : Math.max(best, window)
  }
  return best === undefined ? undefined : Math.round(best)
}

/**
 * Add the reported terms, ignoring the absent ones.
 * @param terms - the candidate numbers.
 * @returns the total, or undefined when nothing was reported.
 */
function sum(terms: readonly (number | undefined)[]): number | undefined {
  let total: number | undefined
  for (const term of terms) {
    if (term === undefined) continue
    total = (total ?? 0) + term
  }
  return total
}

/**
 * Read a finite number off an open-union field.
 * @param value - the raw field value.
 * @returns the number when it is finite, else undefined.
 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read a string off an open-union field.
 * @param value - the raw field value.
 * @returns the string, or undefined.
 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Narrow an open-union field to a plain record.
 * @param value - the raw field value.
 * @returns the record, or undefined when the field is not one.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
