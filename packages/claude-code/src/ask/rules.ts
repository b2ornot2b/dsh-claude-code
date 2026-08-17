/**
 * The integration-owned "always allow" rule cache (Phase 0 spike 4).
 *
 * The design change this file encodes: **the SDK does not persist permission
 * decisions for us.** Echoing a prompt's `suggestions` back as
 * `updatedPermissions` from a headless `canUseTool` wrote nothing to
 * `.claude/settings.local.json` — with `settingSources: []` AND with
 * `['local']`. That write is the interactive TUI's job, not part of `query()`'s
 * contract. So the integration keeps its own JSON store, consults it INSIDE
 * `canUseTool` before prompting, and never ships `settingSources: ['local']`
 * just to get persistence (which would also load the user's real project
 * settings into an embedded agent).
 *
 * The cache is deliberately conservative:
 *
 * - It matches on the exact rule the CLI itself would have written — the
 *   `destination: 'localSettings'` / `type: 'addRules'` / `behavior: 'allow'`
 *   suggestion attached to the prompt — never on a tool name alone. `Bash` is
 *   not a permission; `Bash(npm test:*)` is.
 * - EVERY rule of every qualifying suggestion must be stored, and each must
 *   name the tool being decided. A partial match prompts.
 * - A prompt forced by the user's own `permissions.ask` rule
 *   (`matchedAskRule`) is never short-circuited — that rule IS the user saying
 *   "ask me about this". The router enforces that before calling in here.
 * - `persistAlwaysAllow: false` disables READS as well as writes: the switch
 *   means "no remembered grants", not "remember but do not write".
 *
 * **Known limitation.** dsh's approval seam has no `'always'` outcome (delta
 * D2: the vocabulary is `allowed-once | rejected | cancelled | unavailable`),
 * and the questions seam is not a permission channel, so no UI answer can
 * currently ADD a rule. Entries therefore arrive from configuration
 * (`ask.rules`) or programmatically ({@link CcAskRules.add}); the UI-driven
 * path lands the day dsh grows the outcome, and needs no change here beyond
 * calling `add()`.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import type { CcPermissionSuggestion } from '../backend.ts'
import type { CcAskRuleConfig, ResolvedClaudeCodeConfig } from '../config.ts'
import type { CcLogger } from '../types.ts'

/**
 * One remembered grant. The shape is the SDK's own `PermissionRuleValue` (and
 * the configuration's {@link CcAskRuleConfig}), so a stored entry can be
 * compared to a prompt's suggestion field for field.
 */
export type CcAskRule = CcAskRuleConfig

/** The on-disk document. Versioned so a future format change is detectable rather than silent. */
export interface CcAskRuleFile {
  /** Format version. Currently `1`. */
  readonly version: number
  /** The remembered grants. */
  readonly rules: readonly CcAskRule[]
}

/** Current {@link CcAskRuleFile} version. */
export const CC_RULE_FILE_VERSION = 1

/** Directory the default rule-cache path lives in, under the session's `cwd`. */
export const CC_RULE_CACHE_DIR = '.dsh-claude-code'

/** File name of the default rule cache. */
export const CC_RULE_CACHE_FILE = 'always-allow.json'

/** How to construct one rule cache. */
export interface CcAskRulesDeps {
  /** Absolute path of the JSON store. */
  readonly path: string
  /** `config.ask.persistAlwaysAllow`. False disables reads AND writes. */
  readonly enabled: boolean
  /** Rules from configuration. Consulted like stored ones, never written back. */
  readonly seed?: readonly CcAskRule[]
  /** Diagnostics sink. A malformed file is logged here, never thrown. */
  readonly logger?: CcLogger
}

/**
 * Where one session's rule cache lives.
 *
 * `ask.ruleCachePath` may be absolute (a shared store for a fleet) or relative
 * (resolved against the session's `cwd`, so a per-project store needs no
 * absolute path in config). Unset means `<cwd>/.dsh-claude-code/always-allow.json`
 * — beside the project the grants are about, and outside `.claude/` so it can
 * never be confused with settings the CLI itself reads.
 *
 * @param config - the resolved plugin config.
 * @param cwd - the session's absolute working directory.
 * @returns the absolute path of the store.
 */
export function resolveRuleCachePath(config: ResolvedClaudeCodeConfig, cwd: string): string {
  const configured = config.ask.ruleCachePath
  if (configured === undefined) return resolve(cwd, CC_RULE_CACHE_DIR, CC_RULE_CACHE_FILE)
  return isAbsolute(configured) ? configured : resolve(cwd, configured)
}

/**
 * The rule cache for one session.
 *
 * Loading is lazy and failure-tolerant: a missing file is an empty cache, and a
 * malformed one is an empty cache plus a loud log line. Nothing here may throw
 * into `canUseTool`.
 */
export class CcAskRules {
  readonly #deps: CcAskRulesDeps
  /** Loaded rules keyed by {@link ruleKey}; undefined until the first read. */
  #index: Map<string, CcAskRule> | undefined

  /**
   * @param deps - path, enablement, seed rules, logger.
   */
  constructor(deps: CcAskRulesDeps) {
    this.#deps = deps
  }

  /**
   * Build the cache one session uses.
   * @param config - the resolved plugin config.
   * @param cwd - the session's absolute working directory.
   * @param logger - diagnostics sink.
   * @returns the cache, disabled when `ask.persistAlwaysAllow` is false.
   */
  static forSession(
    config: ResolvedClaudeCodeConfig,
    cwd: string,
    logger?: CcLogger,
  ): CcAskRules {
    return new CcAskRules({
      path: resolveRuleCachePath(config, cwd),
      enabled: config.ask.persistAlwaysAllow,
      ...(config.ask.rules.length === 0 ? {} : { seed: config.ask.rules }),
      ...(logger === undefined ? {} : { logger }),
    })
  }

  /** The absolute path of the store (whether or not it exists yet). */
  get path(): string {
    return this.#deps.path
  }

  /** Whether the cache is consulted at all. */
  get enabled(): boolean {
    return this.#deps.enabled
  }

  /**
   * Every rule currently in force (configuration seed plus stored entries).
   * @returns a fresh array; empty when the cache is disabled.
   */
  list(): readonly CcAskRule[] {
    if (!this.#deps.enabled) return []
    return [...this.load().values()]
  }

  /**
   * Would the stored grants make this prompt unnecessary?
   *
   * @param toolName - the tool being decided.
   * @param suggestions - the prompt's own `suggestions`, exactly as the SDK
   *   supplied them.
   * @returns true only when every rule of every `localSettings` allow-rule
   *   suggestion is already stored for this tool.
   */
  allows(toolName: string, suggestions: readonly CcPermissionSuggestion[] | undefined): boolean {
    if (!this.#deps.enabled) return false
    if (suggestions === undefined || suggestions.length === 0) return false
    const qualifying = suggestions.filter(isLocalAllowRule)
    if (qualifying.length === 0) return false

    const index = this.load()
    if (index.size === 0) return false
    for (const suggestion of qualifying) {
      const rules = suggestion.rules ?? []
      // A rule-less "allow" suggestion grants the whole tool; the cache never
      // matches one, because storing it would be a blanket grant by accident.
      if (rules.length === 0) return false
      for (const rule of rules) {
        if (rule.toolName !== toolName) return false
        if (!index.has(ruleKey(rule))) return false
      }
    }
    return true
  }

  /**
   * Remember one grant, and write it to disk.
   *
   * This is the seam a UI-driven "always allow" will call once dsh's approval
   * vocabulary can express it (see the module docs). Today it is used by
   * operators and tests.
   *
   * @param rule - the grant to store.
   * @returns true when the store now holds the rule, false when the cache is
   *   disabled or the write failed (both logged, never thrown).
   */
  add(rule: CcAskRule): boolean {
    if (!this.#deps.enabled) {
      this.#deps.logger?.debug(
        'claude-code ask: ignoring an always-allow rule because ask.persistAlwaysAllow is false')
      return false
    }
    const index = this.load()
    const key = ruleKey(rule)
    if (index.has(key)) return true
    const normalized: CcAskRule = {
      toolName: rule.toolName,
      ...(rule.ruleContent === undefined ? {} : { ruleContent: rule.ruleContent }),
    }
    // Re-read before writing: another session of this process (or another
    // process entirely) may have added a grant since this cache loaded, and
    // rewriting a stale view would silently DELETE it. A permission store that
    // forgets is worse than one that prompts.
    const merged = new Map<string, CcAskRule>()
    for (const stored of this.read()) merged.set(ruleKey(stored), stored)
    for (const [existing, value] of index) merged.set(existing, value)
    merged.set(key, normalized)
    index.clear()
    for (const [existing, value] of merged) index.set(existing, value)
    return this.write([...merged.values()])
  }

  /**
   * Drop the in-memory view so the next question re-reads the file (another
   * process, or a test, may have written it).
   * @returns nothing.
   */
  reload(): void {
    this.#index = undefined
  }

  /**
   * The rule index, loaded on first use.
   * @returns the index (seed rules first, then stored ones).
   */
  private load(): Map<string, CcAskRule> {
    const cached = this.#index
    if (cached !== undefined) return cached
    const index = new Map<string, CcAskRule>()
    for (const rule of this.#deps.seed ?? []) index.set(ruleKey(rule), rule)
    for (const rule of this.read()) index.set(ruleKey(rule), rule)
    this.#index = index
    return index
  }

  /**
   * Read the store. Any failure — absent, unreadable, malformed, wrong version
   * — yields no rules, because the fail-closed direction of a permission cache
   * is "prompt the human".
   * @returns the stored rules.
   */
  private read(): readonly CcAskRule[] {
    let raw: string
    try {
      raw = readFileSync(this.#deps.path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // A store that was never written is the normal case, not a fault.
      if (code !== 'ENOENT') {
        this.#deps.logger?.debug(
          `claude-code ask: rule cache ${this.#deps.path} could not be read (${describe(error)}); prompting as usual`)
      }
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.#deps.logger?.debug(
        `claude-code ask: rule cache ${this.#deps.path} is not valid JSON (${describe(error)}); `
        + 'treating it as empty and prompting as usual')
      return []
    }
    const document = parsed as Partial<CcAskRuleFile> | null
    if (document === null || typeof document !== 'object' || !Array.isArray(document.rules)) {
      this.#deps.logger?.debug(
        `claude-code ask: rule cache ${this.#deps.path} has no "rules" array; treating it as empty`)
      return []
    }
    if (document.version !== CC_RULE_FILE_VERSION) {
      this.#deps.logger?.debug(
        `claude-code ask: rule cache ${this.#deps.path} has version ${String(document.version)}, `
        + `expected ${CC_RULE_FILE_VERSION}; treating it as empty`)
      return []
    }
    const rules: CcAskRule[] = []
    for (const entry of document.rules) {
      const candidate = entry as Partial<CcAskRule> | null
      if (candidate === null || typeof candidate !== 'object') continue
      if (typeof candidate.toolName !== 'string' || candidate.toolName === '') continue
      if (candidate.ruleContent !== undefined && typeof candidate.ruleContent !== 'string') continue
      rules.push({
        toolName: candidate.toolName,
        ...(candidate.ruleContent === undefined ? {} : { ruleContent: candidate.ruleContent }),
      })
    }
    return rules
  }

  /**
   * Persist the whole rule set. Written to a sibling temp file and renamed, so
   * a crash mid-write cannot leave a half-parsed permission store behind.
   * @param rules - every rule to store (seed rules included: they are harmless duplicates).
   * @returns true when the write succeeded.
   */
  private write(rules: readonly CcAskRule[]): boolean {
    const document: CcAskRuleFile = { version: CC_RULE_FILE_VERSION, rules }
    const temporary = `${this.#deps.path}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.#deps.path), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify(document, undefined, 2)}\n`, 'utf8')
      renameSync(temporary, this.#deps.path)
      return true
    } catch (error) {
      this.#deps.logger?.debug(
        `claude-code ask: could not write the rule cache ${this.#deps.path}: ${describe(error)}`)
      // The in-memory index keeps the rule for this session only; a failed
      // write must not silently claim durability.
      return false
    }
  }
}

/**
 * Whether one suggestion is the "remember this allow, project-locally" one —
 * the only kind the cache mirrors.
 * @param suggestion - the suggestion to classify.
 * @returns true for `addRules` + `allow` + `localSettings`.
 */
function isLocalAllowRule(suggestion: CcPermissionSuggestion): boolean {
  return suggestion.type === 'addRules'
    && suggestion.behavior === 'allow'
    && suggestion.destination === 'localSettings'
}

/**
 * The exact-match key of one rule. `NUL` separates the fields so a tool name
 * containing the separator cannot forge a different rule's key.
 * @param rule - the rule.
 * @returns its key.
 */
function ruleKey(rule: CcAskRule): string {
  return `${rule.toolName}\u0000${rule.ruleContent ?? ''}`
}

/**
 * Render a thrown value for a log line.
 * @param error - the thrown value.
 * @returns a one-line description.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
