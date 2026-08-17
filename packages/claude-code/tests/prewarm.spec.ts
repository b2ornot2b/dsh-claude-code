import { newCcSessionId, resolveClaudeCodeConfig, resolveQueryOptions, WarmPool, warmFingerprint } from '@deepseek-ai/dsh-claude-code'
import type { CcQueryOptions, CcSessionOptions } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

import { createFakeBackend } from './fake-backend.ts'

/**
 * The warm pool in isolation. Two properties matter more than the latency win
 * it exists for: it must never serve a subprocess whose frozen options differ
 * from what the session asked for, and it must never leave one running.
 */

/**
 * Resolve the options a session with `options` would send.
 * @param options - per-session shape (id defaults to a fresh one).
 * @returns the resolved query options.
 */
async function template(options: Partial<CcSessionOptions> = {}): Promise<CcQueryOptions> {
  return await resolveQueryOptions(
    { id: newCcSessionId(), cwd: '/tmp/warm-pool-spec', ...options },
    { config: resolveClaudeCodeConfig() },
    new AbortController())
}

describe('warmFingerprint', () => {
  it('ignores the fields a lease re-points (id, resume/fork, callbacks, controller)', async () => {
    const first = await template()
    const second = await template({ id: newCcSessionId() })
    expect(warmFingerprint(first)).toBe(warmFingerprint(second))
  })

  it('separates anything startup() freezes: cwd, model, permission mode, settings, env', async () => {
    const base = await template()
    expect(warmFingerprint(await template({ cwd: '/tmp/other' }))).not.toBe(warmFingerprint(base))
    expect(warmFingerprint(await template({ model: 'claude-sonnet-4-5' }))).not.toBe(warmFingerprint(base))
    expect(warmFingerprint(await template({ permissionMode: 'plan' }))).not.toBe(warmFingerprint(base))

    // env carries the auth decision: a subprocess warmed with an API key must
    // never serve a subscription session (that is the silent-billing bug).
    const withKey: CcQueryOptions = { ...base, env: { ...base.env, ANTHROPIC_API_KEY: 'sk-test' } }
    expect(warmFingerprint(withKey)).not.toBe(warmFingerprint(base))

    // …nor may a ROTATED key be served from a subprocess frozen with the old
    // one. The fingerprint carries a digest of the value, never the value.
    const rotated: CcQueryOptions = { ...base, env: { ...base.env, ANTHROPIC_API_KEY: 'sk-rotated' } }
    expect(warmFingerprint(rotated)).not.toBe(warmFingerprint(withKey))
    expect(warmFingerprint(withKey)).not.toContain('sk-test')
  })

  it('ignores ambient env noise the SDK itself writes into process.env', async () => {
    // Verified live: the Claude Agent SDK sets CLAUDE_AGENT_SDK_VERSION on
    // `process.env` as a one-time side effect of its first real
    // `query()`/`startup()` call. Fingerprinting the raw env spread made every
    // warm handle taken BEFORE that call unusable afterwards — prewarm was dead
    // from the second open onwards in any real composition.
    const base = await template()
    const noisy: CcQueryOptions = {
      ...base,
      env: { ...base.env, CLAUDE_AGENT_SDK_VERSION: '0.3.233', SOME_UNRELATED_VAR: 'x' },
    }
    expect(warmFingerprint(noisy)).toBe(warmFingerprint(base))
  })

  it('does not depend on key order', async () => {
    const base = await template()
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as CcQueryOptions
    expect(warmFingerprint(reordered)).toBe(warmFingerprint(base))
  })
})

describe('WarmPool', () => {
  it('serves a matching open under its own pre-minted id, then holds nothing', async () => {
    const fake = createFakeBackend()
    const pool = new WarmPool({ backend: fake.backend, enabled: true })
    const options = await template()

    await pool.prewarm(options)
    expect(pool.warm).toBe(true)
    expect(fake.warms).toHaveLength(1)

    const lease = pool.acquire(options)
    expect(lease?.sessionId).toBe(fake.warms[0]?.options.sessionId)
    expect(pool.warm).toBe(false)

    // The pre-minted id is a real dsh session id, minted by us — never the CLI.
    expect(lease?.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    await pool.close()
  })

  it('routes permission callbacks to the session that took the lease', async () => {
    const fake = createFakeBackend()
    const pool = new WarmPool({ backend: fake.backend, enabled: true })
    const options = await template()
    await pool.prewarm(options)
    const lease = pool.acquire(options)

    const warmed = fake.warms[0]?.options.canUseTool
    // Before binding: fail closed.
    const request = { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' }
    await expect(warmed?.('Bash', {}, request)).resolves.toMatchObject({ behavior: 'deny' })

    lease?.bind({ canUseTool: async () => await Promise.resolve({ behavior: 'allow', updatedInput: {} }), stderr: () => {} })
    await expect(warmed?.('Bash', {}, request)).resolves.toMatchObject({ behavior: 'allow' })
    await pool.close()
  })

  it('discards a stale handle on a mismatch instead of serving it', async () => {
    const fake = createFakeBackend()
    const pool = new WarmPool({ backend: fake.backend, enabled: true })
    await pool.prewarm(await template())

    expect(pool.acquire(await template({ cwd: '/tmp/somewhere-else' }))).toBeUndefined()
    expect(fake.warms[0]?.closed).toBe(true)
    expect(pool.warm).toBe(false)
    await pool.close()
  })

  it('holds at most one handle and re-warms only after the held one is taken', async () => {
    const fake = createFakeBackend()
    const pool = new WarmPool({ backend: fake.backend, enabled: true })
    const options = await template()

    await pool.prewarm(options)
    await pool.prewarm(options)
    expect(fake.warms).toHaveLength(1)

    pool.acquire(options)
    await pool.prewarm(options)
    expect(fake.warms).toHaveLength(2)
    await pool.close()
  })

  it('does nothing at all when disabled', async () => {
    const fake = createFakeBackend()
    const pool = new WarmPool({ backend: fake.backend, enabled: false })
    const options = await template()

    await pool.prewarm(options)
    expect(fake.warms).toEqual([])
    expect(pool.acquire(options)).toBeUndefined()
    await pool.close()
  })

  it('swallows a failed startup so an open degrades to cold rather than failing', async () => {
    const fake = createFakeBackend()
    fake.failStartup = true
    const logged: string[] = []
    const pool = new WarmPool({
      backend: fake.backend,
      enabled: true,
      logger: { debug: (line: string) => { logged.push(line) } },
    })

    await expect(pool.prewarm(await template())).resolves.toBeUndefined()
    expect(pool.warm).toBe(false)
    expect(logged.some(line => line.includes('pre-warm failed'))).toBe(true)
    await pool.close()
  })

  it('closes the held subprocess on teardown and refuses to warm afterwards', async () => {
    const fake = createFakeBackend()
    const pool = new WarmPool({ backend: fake.backend, enabled: true })
    const options = await template()
    await pool.prewarm(options)

    await pool.close()
    expect(fake.warms[0]?.closed).toBe(true)
    expect(pool.warm).toBe(false)

    await pool.prewarm(options)
    expect(fake.warms).toHaveLength(1)
  })

  it('closes a subprocess that finished warming after teardown began', async () => {
    const fake = createFakeBackend()
    const pool = new WarmPool({ backend: fake.backend, enabled: true })
    const warming = pool.prewarm(await template())
    // Teardown races the in-flight startup: the pool must still account for the
    // subprocess it is about to receive, or it orphans one per reload.
    const closing = pool.close()
    await Promise.all([warming, closing])

    expect(fake.warms[0]?.closed).toBe(true)
    expect(pool.warm).toBe(false)
  })
})
