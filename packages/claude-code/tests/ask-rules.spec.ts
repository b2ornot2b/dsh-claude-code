import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CC_RULE_CACHE_DIR, CC_RULE_CACHE_FILE, CC_RULE_FILE_VERSION, CcAskRules,
  resolveClaudeCodeConfig, resolveRuleCachePath,
} from '@deepseek-ai/dsh-claude-code'
import type { CcPermissionSuggestion } from '@deepseek-ai/dsh-claude-code'
import { afterEach, describe, expect, it } from 'vitest'

import { makeRequest, makeRouter, RecordingLogger } from './ask-helpers.ts'
import type { AskHarness } from './ask-helpers.ts'

/**
 * Spike 4's design change: the SDK persists nothing, so the integration owns an
 * always-allow cache and consults it INSIDE `canUseTool`. These tests pin the
 * conservative matching rule — the whole point of the cache is that it can only
 * ever skip a prompt the user already answered "always" to.
 */

/** Temp directories created by a test. */
const temporary: string[] = []
/** Harnesses built by a test. */
const built: AskHarness[] = []

afterEach(() => {
  while (built.length > 0) built.pop()?.cleanup()
  while (temporary.length > 0) {
    const directory = temporary.pop()
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * A fresh temp directory.
 * @returns its absolute path.
 */
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cc-rules-'))
  temporary.push(directory)
  return directory
}

/**
 * The `localSettings` allow-rule suggestion the CLI attaches to a Bash prompt.
 * @param ruleContent - the rule body.
 * @returns the suggestion list, including the two entries the cache must ignore.
 */
function bashSuggestions(ruleContent = 'npm test:*'): readonly CcPermissionSuggestion[] {
  return [
    { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent }] },
    { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent }] },
    { type: 'setMode', destination: 'session', mode: 'acceptEdits' },
  ]
}

describe('resolveRuleCachePath', () => {
  it('defaults to the session cwd, honours an absolute path, and resolves a relative one', () => {
    const cwd = '/tmp/cc-project'
    expect(resolveRuleCachePath(resolveClaudeCodeConfig(), cwd))
      .toBe(join(cwd, CC_RULE_CACHE_DIR, CC_RULE_CACHE_FILE))
    expect(resolveRuleCachePath(resolveClaudeCodeConfig({ ask: { ruleCachePath: '/etc/cc/rules.json' } }), cwd))
      .toBe('/etc/cc/rules.json')
    expect(resolveRuleCachePath(resolveClaudeCodeConfig({ ask: { ruleCachePath: 'rules.json' } }), cwd))
      .toBe(join(cwd, 'rules.json'))
  })
})

describe('CcAskRules', () => {
  it('matches only when every rule of the localSettings suggestion is stored', () => {
    const cwd = scratch()
    const rules = CcAskRules.forSession(resolveClaudeCodeConfig(), cwd)
    rules.add({ toolName: 'Bash', ruleContent: 'npm test:*' })

    expect(rules.allows('Bash', bashSuggestions())).toBe(true)
    expect(rules.allows('Bash', bashSuggestions('rm -rf:*'))).toBe(false)
    // Same rule body, different tool: never a match.
    expect(rules.allows('Read', bashSuggestions())).toBe(false)
  })

  it('never matches without a localSettings allow-rule suggestion', () => {
    const cwd = scratch()
    const rules = CcAskRules.forSession(resolveClaudeCodeConfig(), cwd)
    rules.add({ toolName: 'Bash', ruleContent: 'npm test:*' })

    expect(rules.allows('Bash', undefined)).toBe(false)
    expect(rules.allows('Bash', [])).toBe(false)
    expect(rules.allows('Bash', [
      { type: 'addRules', behavior: 'deny', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] },
    ])).toBe(false)
    // A rule-less "allow the whole tool" suggestion is a blanket grant.
    expect(rules.allows('Bash', [
      { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [] },
    ])).toBe(false)
  })

  it('persists to disk in the documented format and reloads it', () => {
    const cwd = scratch()
    const config = resolveClaudeCodeConfig()
    const rules = CcAskRules.forSession(config, cwd)

    expect(rules.add({ toolName: 'Bash', ruleContent: 'npm test:*' })).toBe(true)

    const document = JSON.parse(readFileSync(rules.path, 'utf8')) as unknown
    expect(document).toEqual({
      version: CC_RULE_FILE_VERSION,
      rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
    })
    expect(CcAskRules.forSession(config, cwd).allows('Bash', bashSuggestions())).toBe(true)
  })

  it('merges what another session wrote instead of clobbering it', () => {
    const cwd = scratch()
    const config = resolveClaudeCodeConfig()
    // Two sessions of the same process share one store, and each loaded its own
    // view of it. A blind rewrite of the second view would drop the first
    // session's grant — a permission store that silently forgets.
    const first = CcAskRules.forSession(config, cwd)
    const second = CcAskRules.forSession(config, cwd)
    // Loads the second view BEFORE the first session writes: that stale view is
    // the whole hazard.
    expect(second.list()).toEqual([])
    first.add({ toolName: 'Bash', ruleContent: 'npm test:*' })
    second.add({ toolName: 'Read', ruleContent: '/etc/hosts' })

    const document = JSON.parse(readFileSync(second.path, 'utf8')) as { rules: unknown[] }
    expect(document.rules).toEqual([
      { toolName: 'Bash', ruleContent: 'npm test:*' },
      { toolName: 'Read', ruleContent: '/etc/hosts' },
    ])
  })

  it('reads preseeded config rules without writing them back', () => {
    const cwd = scratch()
    const config = resolveClaudeCodeConfig({
      ask: { rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] },
    })
    const rules = CcAskRules.forSession(config, cwd)

    expect(rules.allows('Bash', bashSuggestions())).toBe(true)
    expect(rules.list()).toEqual([{ toolName: 'Bash', ruleContent: 'npm test:*' }])
    expect(() => readFileSync(rules.path, 'utf8')).toThrow()
  })

  it('disables reads AND writes when persistAlwaysAllow is false', () => {
    const cwd = scratch()
    const logger = new RecordingLogger()
    const config = resolveClaudeCodeConfig({
      ask: { persistAlwaysAllow: false, rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] },
    })
    const rules = CcAskRules.forSession(config, cwd, logger)

    expect(rules.enabled).toBe(false)
    expect(rules.allows('Bash', bashSuggestions())).toBe(false)
    expect(rules.add({ toolName: 'Bash', ruleContent: 'npm test:*' })).toBe(false)
    expect(rules.list()).toEqual([])
    expect(logger.saw('persistAlwaysAllow is false')).toBe(true)
  })

  it.each([
    ['unparsable JSON', 'not json at all'],
    ['no rules array', JSON.stringify({ version: 1 })],
    ['a future version', JSON.stringify({ version: 99, rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] })],
  ])('treats %s as an empty cache, loudly, and keeps prompting', (_name, contents) => {
    const cwd = scratch()
    const logger = new RecordingLogger()
    const config = resolveClaudeCodeConfig()
    const path = resolveRuleCachePath(config, cwd)
    mkdirSync(join(cwd, CC_RULE_CACHE_DIR), { recursive: true })
    writeFileSync(path, contents, 'utf8')

    const rules = CcAskRules.forSession(config, cwd, logger)

    expect(rules.allows('Bash', bashSuggestions())).toBe(false)
    expect(logger.lines.length).toBeGreaterThan(0)
  })

  it('skips malformed entries but keeps the well-formed ones', () => {
    const cwd = scratch()
    const config = resolveClaudeCodeConfig()
    const path = resolveRuleCachePath(config, cwd)
    mkdirSync(join(cwd, CC_RULE_CACHE_DIR), { recursive: true })
    writeFileSync(path, JSON.stringify({
      version: CC_RULE_FILE_VERSION,
      rules: [null, { ruleContent: 'x' }, { toolName: 'Bash', ruleContent: 5 }, { toolName: 'Bash', ruleContent: 'npm test:*' }],
    }), 'utf8')

    expect(CcAskRules.forSession(config, cwd).list())
      .toEqual([{ toolName: 'Bash', ruleContent: 'npm test:*' }])
  })

  it('is empty (not an error) when the store was never written', () => {
    const cwd = scratch()
    const logger = new RecordingLogger()

    expect(CcAskRules.forSession(resolveClaudeCodeConfig(), cwd, logger).list()).toEqual([])
    expect(logger.lines).toEqual([])
  })
})

describe('ask router: the rule cache short-circuit', () => {
  it('allows without prompting when a stored rule matches, and says so', async () => {
    const made = makeRouter({
      config: { ask: { rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] } },
    })
    built.push(made)
    const { router, approval, logger } = made

    const decision = await router.canUseTool(
      'Bash', { command: 'npm test' }, makeRequest({ suggestions: bashSuggestions() }))

    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } })
    expect(approval.requests).toHaveLength(0)
    expect(logger.saw('allowed by the stored always-allow rule cache')).toBe(true)
  })

  it('still prompts when the prompt was forced by the user\'s own ask rule', async () => {
    const made = makeRouter({ config: { ask: { rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] } } })
    built.push(made)

    await made.router.canUseTool('Bash', { command: 'npm test' }, makeRequest({
      suggestions: bashSuggestions(),
      matchedAskRule: { source: 'projectSettings', toolName: 'Bash' },
    }))

    expect(made.approval.requests).toHaveLength(1)
  })

  it('prompts when nothing is stored', async () => {
    const made = makeRouter()
    built.push(made)

    await made.router.canUseTool(
      'Bash', { command: 'npm test' }, makeRequest({ suggestions: bashSuggestions() }))

    expect(made.approval.requests).toHaveLength(1)
  })
})
