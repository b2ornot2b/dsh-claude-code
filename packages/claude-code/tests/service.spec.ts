import { Context } from '@deepseek-ai/cordis'
import { ClaudeCodeError, ClaudeCodeService, newCcSessionId } from '@deepseek-ai/dsh-claude-code'
import type { ClaudeCodeConfig } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

/**
 * Mount the service inside a real plugin fiber and hand back the RAW instance.
 *
 * `ctx.get('claudeCode')` returns a fresh traceable proxy on every access —
 * `ctx.get(k) !== ctx.get(k)` — so tests never identity-compare it, and the
 * white-box teardown test needs the underlying object.
 * @param config - surface config for the service under test.
 * @returns the root context, the mount fiber, and the raw service instance.
 */
async function mount(config: ClaudeCodeConfig = {}): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  service: ClaudeCodeService
}> {
  const ctx = new Context()
  let service: ClaudeCodeService | undefined
  // A named function declaration, not `Object.assign(fn, { name })`: a
  // function's own `name` is not writable.
  function claudeCodeTestMount(inner: Context): void {
    service = new ClaudeCodeService(inner, config)
  }
  const fiber = await ctx.plugin(claudeCodeTestMount)
  if (service === undefined) throw new Error('mount did not construct the service')
  return { ctx, fiber, service }
}

/** One fake session record, shaped like the service's private bookkeeping. */
interface FakeRecord {
  id: string
  status: string
  pendingAsks: number
  close(): Promise<void>
}

/**
 * Reach the private session registry. Phase 1 has no public way to register a
 * session, but the teardown loop is written now and must be proven now.
 * @param service - the raw service instance.
 * @returns its live session map.
 */
function sessionRegistry(service: ClaudeCodeService): Map<string, FakeRecord> {
  return (service as unknown as { sessions: Map<string, FakeRecord> }).sessions
}

describe('ClaudeCodeService mounting', () => {
  it('provides ctx.claudeCode with the resolved configuration', async () => {
    const { ctx, fiber } = await mount({ ask: { fallback: 'error' } })
    try {
      const service = ctx.get('claudeCode')
      expect(service).toBeDefined()
      expect(service?.config.ask.fallback).toBe('error')
      expect(service?.config.prewarm).toBe(true)
      expect(service?.config.defaults.settingSources).toEqual([])
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('mounts as a plain cordis plugin class too', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(ClaudeCodeService, { prewarm: false })
    try {
      expect(ctx.get('claudeCode')?.config.prewarm).toBe(false)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('ClaudeCodeService Phase 1 surface', () => {
  it('rejects open() with NOT_IMPLEMENTED naming the phase', async () => {
    const { ctx, fiber, service } = await mount()
    try {
      const error = await service.open({ cwd: '/tmp/project' }).then(
        () => undefined,
        (reason: unknown) => reason)
      expect(error).toBeInstanceOf(ClaudeCodeError)
      expect((error as ClaudeCodeError).code).toBe('NOT_IMPLEMENTED')
      expect((error as ClaudeCodeError).message).toContain('Phase 2')
      expect((error as ClaudeCodeError).message).toContain('/tmp/project')
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects accountInfo() with NOT_IMPLEMENTED', async () => {
    const { ctx, fiber, service } = await mount()
    try {
      const error = await service.accountInfo().then(
        () => undefined,
        (reason: unknown) => reason)
      expect(error).toBeInstanceOf(ClaudeCodeError)
      expect((error as ClaudeCodeError).code).toBe('NOT_IMPLEMENTED')
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('answers get/list/close against an empty registry', async () => {
    const { ctx, fiber, service } = await mount()
    try {
      const id = newCcSessionId()
      expect(service.get(id)).toBeUndefined()
      expect(service.list()).toEqual([])
      await expect(service.close(id)).resolves.toBe(false)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('returns a fresh list array on every call', async () => {
    const { ctx, fiber, service } = await mount()
    try {
      expect(service.list()).not.toBe(service.list())
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('ClaudeCodeService teardown (HMR safety)', () => {
  it('unregisters the service when the mounting fiber disposes, and remounts cleanly', async () => {
    const { ctx, fiber } = await mount()
    expect(ctx.get('claudeCode')).toBeDefined()

    await fiber.dispose()
    expect(ctx.get('claudeCode')).toBeUndefined()

    // Hot reload: the same context accepts a fresh mount with no leftover state.
    const second = await ctx.plugin(ClaudeCodeService, {})
    expect(ctx.get('claudeCode')?.list()).toEqual([])
    await second.dispose()
    expect(ctx.get('claudeCode')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('closes every registered session when the fiber disposes', async () => {
    // White box: Phase 1 has no way to register a session through the public
    // surface, but the teardown loop is written now and must be proven now —
    // an undisposed session leaves a Claude Code subprocess holding a
    // permission callback nobody will ever answer.
    const { ctx, fiber, service } = await mount()
    const id = newCcSessionId()
    let closed = 0
    const registry = sessionRegistry(service)
    registry.set(id, {
      id,
      status: 'idle',
      pendingAsks: 0,
      close: () => {
        closed += 1
        return Promise.resolve()
      },
    })
    expect(service.list()).toEqual([{ id, status: 'idle', pendingAsks: 0 }])

    await fiber.dispose()
    expect(closed).toBe(1)
    expect(service.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('raises a failing close as an AggregateError without stranding the other sessions', async () => {
    // cordis routes a rejecting disposer to `ctx.logger.error` rather than out
    // of `fiber.dispose()`, so the contract is asserted on the close routine
    // itself: one dead subprocess must not keep the others alive.
    const { ctx, fiber, service } = await mount()
    const failing = newCcSessionId()
    const healthy = newCcSessionId()
    let healthyClosed = false
    const registry = sessionRegistry(service)
    registry.set(failing, {
      id: failing,
      status: 'idle',
      pendingAsks: 0,
      close: () => Promise.reject(new Error('subprocess already gone')),
    })
    registry.set(healthy, {
      id: healthy,
      status: 'idle',
      pendingAsks: 0,
      close: () => {
        healthyClosed = true
        return Promise.resolve()
      },
    })

    const closeAll = (service as unknown as { closeAll(): Promise<void> }).closeAll.bind(service)
    const error = await closeAll().then(() => undefined, (reason: unknown) => reason)
    expect(healthyClosed).toBe(true)
    expect(registry.size).toBe(0)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(1)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
