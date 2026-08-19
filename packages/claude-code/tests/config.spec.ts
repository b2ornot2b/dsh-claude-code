import {
  ClaudeCodeError, DEFAULT_API_KEY_REF, DEFAULT_DELEGATED_ASK_TIMEOUT_MS, DEFAULT_DISCOVERY_CACHE_TTL_MS,
  DEFAULT_DISCOVERY_WINDOW_MS, DEFAULT_MAX_CONCURRENT_SESSIONS, DEFAULT_MAX_RESUMABLE, defaultHostLabel,
  resolveClaudeCodeConfig,
} from '@deepseek-ai/dsh-claude-code'
import type { ClaudeCodeConfig } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

/** Cast helper for the spec's YAML `null` placeholders, which the surface type forbids. */
function asConfig(value: unknown): ClaudeCodeConfig {
  return value as ClaudeCodeConfig
}

describe('resolveClaudeCodeConfig defaults', () => {
  it('resolves an empty config to the documented spec §10 defaults', () => {
    expect(resolveClaudeCodeConfig()).toEqual({
      prewarm: true,
      auth: 'subscription',
      apiKeyRef: DEFAULT_API_KEY_REF,
      defaults: {
        permissionMode: 'default',
        settingSources: [],
      },
      ask: {
        delegatedTimeoutMs: DEFAULT_DELEGATED_ASK_TIMEOUT_MS,
        fallback: 'deny',
        persistAlwaysAllow: true,
        rules: [],
      },
      limits: {
        maxConcurrentSessions: DEFAULT_MAX_CONCURRENT_SESSIONS,
      },
      env: {},
      hostLabel: defaultHostLabel(),
      discovery: {
        local: true,
        cacheTtlMs: DEFAULT_DISCOVERY_CACHE_TTL_MS,
        recentWindowMs: DEFAULT_DISCOVERY_WINDOW_MS,
        maxResumable: DEFAULT_MAX_RESUMABLE,
        includeTitles: true,
      },
    })
  })

  it('pins the default constants the README documents', () => {
    expect(DEFAULT_API_KEY_REF).toBe('ANTHROPIC_API_KEY')
    expect(DEFAULT_DELEGATED_ASK_TIMEOUT_MS).toBe(120_000)
    expect(DEFAULT_MAX_CONCURRENT_SESSIONS).toBe(4)
  })

  it('defaults settingSources to full isolation, never to "omitted"', () => {
    // Omitting settingSources at the SDK boundary loads ALL sources (the user's
    // real settings and CLAUDE.md). The resolved config must always carry an
    // explicit list so the session actor can pass one unconditionally.
    const resolved = resolveClaudeCodeConfig()
    expect(resolved.defaults.settingSources).toEqual([])
    expect('settingSources' in resolved.defaults).toBe(true)
  })

  it('leaves unset optional fields ABSENT rather than undefined-valued', () => {
    const resolved = resolveClaudeCodeConfig()
    expect('executablePath' in resolved).toBe(false)
    expect('model' in resolved.defaults).toBe(false)
    expect('appendSystemPrompt' in resolved.defaults).toBe(false)
    expect('timeoutMs' in resolved.ask).toBe(false)
    expect('ruleCachePath' in resolved.ask).toBe(false)
    expect('maxBudgetUsd' in resolved.limits).toBe(false)
    // The one whose absence is BEHAVIOUR, not just tidiness: unset means no
    // idle sweep is installed at all.
    expect('idleTimeoutMs' in resolved.limits).toBe(false)
  })

  it('treats an explicit YAML null exactly like an omitted key', () => {
    const resolved = resolveClaudeCodeConfig(asConfig({
      executablePath: null,
      defaults: { model: null, appendSystemPrompt: null },
      ask: { timeoutMs: null, ruleCachePath: null },
      limits: { maxBudgetUsd: null, idleTimeoutMs: null },
    }))
    expect(resolved).toEqual(resolveClaudeCodeConfig())
  })

  it('honours explicit values across every section', () => {
    const resolved = resolveClaudeCodeConfig({
      executablePath: '/usr/local/bin/claude',
      prewarm: false,
      auth: 'api-key',
      apiKeyRef: 'WORK_ANTHROPIC_KEY',
      defaults: {
        model: 'claude-sonnet-4-5',
        permissionMode: 'plan',
        settingSources: ['project'],
        appendSystemPrompt: 'Answer tersely.',
      },
      ask: {
        timeoutMs: 30_000,
        delegatedTimeoutMs: 5_000,
        fallback: 'first-option',
        persistAlwaysAllow: false,
        ruleCachePath: '/tmp/cc-rules.json',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
      },
      limits: { maxConcurrentSessions: 1, maxBudgetUsd: 10 },
      env: { CLAUDE_CODE_MAX_RETRIES: '2' },
    })
    expect(resolved.executablePath).toBe('/usr/local/bin/claude')
    expect(resolved.prewarm).toBe(false)
    expect(resolved.auth).toBe('api-key')
    expect(resolved.apiKeyRef).toBe('WORK_ANTHROPIC_KEY')
    expect(resolved.defaults).toEqual({
      model: 'claude-sonnet-4-5',
      permissionMode: 'plan',
      settingSources: ['project'],
      appendSystemPrompt: 'Answer tersely.',
    })
    expect(resolved.ask).toEqual({
      timeoutMs: 30_000,
      delegatedTimeoutMs: 5_000,
      fallback: 'first-option',
      persistAlwaysAllow: false,
      ruleCachePath: '/tmp/cc-rules.json',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
    })
    expect(resolved.limits).toEqual({ maxConcurrentSessions: 1, maxBudgetUsd: 10 })
    expect(resolved.env).toEqual({ CLAUDE_CODE_MAX_RETRIES: '2' })
  })

  it('keeps an explicitly configured idle timeout', () => {
    expect(resolveClaudeCodeConfig({ limits: { idleTimeoutMs: 900_000 } }).limits)
      .toEqual({ maxConcurrentSessions: DEFAULT_MAX_CONCURRENT_SESSIONS, idleTimeoutMs: 900_000 })
  })

  it('fills only the missing keys of a partially supplied section', () => {
    const resolved = resolveClaudeCodeConfig({ ask: { fallback: 'error' } })
    expect(resolved.ask.fallback).toBe('error')
    expect(resolved.ask.delegatedTimeoutMs).toBe(DEFAULT_DELEGATED_ASK_TIMEOUT_MS)
    expect(resolved.ask.persistAlwaysAllow).toBe(true)
  })
})

describe('resolveClaudeCodeConfig rejections', () => {
  it.each([
    ['an unknown permission mode', { defaults: { permissionMode: 'yolo' } }],
    ['an unknown setting source', { defaults: { settingSources: ['everything'] } }],
    ['an unknown auth mode', { auth: 'oauth' }],
    ['an unknown ask fallback', { ask: { fallback: 'shrug' } }],
    ['a non-boolean prewarm', { prewarm: 'yes' }],
    ['a zero concurrency limit', { limits: { maxConcurrentSessions: 0 } }],
    ['a fractional concurrency limit', { limits: { maxConcurrentSessions: 1.5 } }],
    ['a non-positive ask timeout', { ask: { timeoutMs: 0 } }],
    ['a negative budget', { limits: { maxBudgetUsd: -1 } }],
    ['a zero idle timeout', { limits: { idleTimeoutMs: 0 } }],
    ['a negative idle timeout', { limits: { idleTimeoutMs: -1 } }],
    ['a non-string env value', { env: { API_TIMEOUT_MS: 5000 } }],
  ])('rejects %s', (_label, value) => {
    expect(() => resolveClaudeCodeConfig(asConfig(value))).toThrow()
  })

  it('rejects api-key auth with a blank credential reference', () => {
    // Individually valid values, mutually inconsistent: an empty reference
    // resolves to nothing at spawn time and silently falls back to whatever the
    // ambient environment holds — the exact silent-billing failure the auth
    // switch exists to prevent.
    let caught: unknown
    try {
      resolveClaudeCodeConfig({ auth: 'api-key', apiKeyRef: '   ' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ClaudeCodeError)
    expect((caught as ClaudeCodeError).code).toBe('INVALID_CONFIG')
  })

  it('accepts api-key auth with the default reference', () => {
    expect(resolveClaudeCodeConfig({ auth: 'api-key' }).apiKeyRef).toBe(DEFAULT_API_KEY_REF)
  })
})

describe('discovery configuration', () => {
  it('defaults the discovery block and keeps it absent-safe', () => {
    const resolved = resolveClaudeCodeConfig({})

    expect(resolved.discovery).toEqual({
      local: true,
      cacheTtlMs: 15_000,
      recentWindowMs: 604_800_000,
      maxResumable: 50,
      includeTitles: true,
    })
    // hostLabel defaults to this host's short name, never an empty string.
    expect(resolved.hostLabel.length).toBeGreaterThan(0)
    expect(resolved.hostLabel).not.toContain('.')
  })

  it('accepts overrides', () => {
    const resolved = resolveClaudeCodeConfig({
      hostLabel: 'b2studio',
      discovery: { local: false, cacheTtlMs: 1, includeTitles: false },
    })

    expect(resolved.hostLabel).toBe('b2studio')
    expect(resolved.discovery.local).toBe(false)
    expect(resolved.discovery.cacheTtlMs).toBe(1)
    expect(resolved.discovery.includeTitles).toBe(false)
    expect(resolved.discovery.maxResumable).toBe(50)
  })
})
