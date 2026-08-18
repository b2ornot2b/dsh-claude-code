import { tmpdir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import { ClaudeCodeService } from '@deepseek-ai/dsh-claude-code'
import type { ClaudeCodeConfig, ClaudeCodeServiceDeps } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

import { createFakeBackend, settle } from './fake-backend.ts'
import type { FakeBackend } from './fake-backend.ts'

/**
 * The service as the owner of live sessions: minting ids, enforcing limits,
 * keeping the registry honest, proxying the account, and handing the warm pool
 * the next open. Driven through the fake backend, so no subprocess is ever spawned.
 */

/** An absolute directory that certainly exists — `open()` validates `cwd` up front. */
const CWD = tmpdir()

/**
 * Mount the service with a fake backend inside a real plugin fiber.
 * @param config - surface configuration.
 * @param extraDeps - additional injected seams.
 * @returns the context, fiber, raw service and the fake backend.
 */
async function mount(config: ClaudeCodeConfig = {}, extraDeps: Partial<ClaudeCodeServiceDeps> = {}): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  service: ClaudeCodeService
  fake: FakeBackend
  dispose(): Promise<void>
}> {
  const fake = createFakeBackend()
  const ctx = new Context()
  let service: ClaudeCodeService | undefined
  function claudeCodeSessionsMount(inner: Context): void {
    service = new ClaudeCodeService(inner, config, { backend: fake.backend, drainPollMs: 1, ...extraDeps })
  }
  const fiber = await ctx.plugin(claudeCodeSessionsMount)
  if (service === undefined) throw new Error('mount did not construct the service')
  return {
    ctx,
    fiber,
    service,
    fake,
    dispose: async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

describe('ClaudeCodeService.open()', () => {
  it('mints a bare-UUID id, registers the session and reports it live', async () => {
    const { service, fake, dispose } = await mount()
    try {
      const snapshot = await service.open({ cwd: CWD })

      expect(snapshot.status).toBe('idle')
      expect(fake.queries[0]?.options.sessionId).toBe(snapshot.id)
      expect(service.get(snapshot.id)).toEqual(snapshot)
      expect(service.list().map(entry => entry.id)).toEqual([snapshot.id])
      expect(service.session(snapshot.id)?.id).toBe(snapshot.id)
    } finally {
      await dispose()
    }
  })

  it('sends the opening prompt as a followup and shows the session running', async () => {
    const { service, fake, dispose } = await mount()
    try {
      const snapshot = await service.open({ cwd: CWD, prompt: 'summarize this repo' })
      await settle()

      expect(fake.queries[0]?.sent.map(message => message.message.content)).toEqual(['summarize this repo'])
      expect(service.get(snapshot.id)?.status).toBe('running')
    } finally {
      await dispose()
    }
  })

  it('reports the live model once the CLI announces one', async () => {
    const { service, fake, dispose } = await mount()
    try {
      const snapshot = await service.open({ cwd: CWD })
      await fake.queries[0]?.emitInit({ model: 'claude-haiku-4-5-20251001' })

      expect(service.get(snapshot.id)?.model).toBe('claude-haiku-4-5-20251001')
    } finally {
      await dispose()
    }
  })

  it('enforces limits.maxConcurrentSessions with a typed SESSION_LIMIT error', async () => {
    const { service, dispose } = await mount({ limits: { maxConcurrentSessions: 2 } })
    try {
      await service.open({ cwd: CWD })
      await service.open({ cwd: CWD })

      await expect(service.open({ cwd: CWD }))
        .rejects.toMatchObject({ name: 'ClaudeCodeError', code: 'SESSION_LIMIT' })
      expect(service.list()).toHaveLength(2)
    } finally {
      await dispose()
    }
  })

  it('does not register a session whose backend refused to start', async () => {
    const fake = createFakeBackend()
    const ctx = new Context()
    let service: ClaudeCodeService | undefined
    function refusingMount(inner: Context): void {
      service = new ClaudeCodeService(inner, {}, {
        backend: {
          query() { throw new Error('spawn failed') },
          startup: fake.backend.startup.bind(fake.backend),
        },
      })
    }
    const fiber = await ctx.plugin(refusingMount)
    try {
      await expect(service?.open({ cwd: CWD }))
        .rejects.toMatchObject({ name: 'ClaudeCodeError', code: 'BACKEND_ERROR' })
      expect(service?.list()).toEqual([])
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('ClaudeCodeService registry lifecycle', () => {
  it('close(id) closes the subprocess and drops the entry', async () => {
    const { service, fake, dispose } = await mount()
    try {
      const snapshot = await service.open({ cwd: CWD })

      await expect(service.close(snapshot.id)).resolves.toBe(true)
      expect(fake.queries[0]?.closed).toBe(true)
      // Dropped from the LIVE registry: nothing to drive, nothing in `list()`,
      // and a second close reports that there was nothing left to close.
      expect(service.session(snapshot.id)).toBeUndefined()
      expect(service.list()).toEqual([])
      await expect(service.close(snapshot.id)).resolves.toBe(false)
      // But `get()` still answers, from the tombstone, with WHY it ended.
      expect(service.get(snapshot.id)).toMatchObject({ status: 'closed', closeReason: 'closed' })
    } finally {
      await dispose()
    }
  })

  it('drops a session that closed itself', async () => {
    const { service, dispose } = await mount()
    try {
      const snapshot = await service.open({ cwd: CWD })
      await service.session(snapshot.id)?.close()

      expect(service.list()).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('closes every live session (and the warm pool) when the fiber disposes', async () => {
    const { service, fake, dispose } = await mount()
    const first = await service.open({ cwd: CWD })
    const second = await service.open({ cwd: CWD })
    expect(service.list().map(entry => entry.id)).toEqual([first.id, second.id])

    await dispose()

    expect(fake.queries.every(query => query.closed)).toBe(true)
    expect(fake.warms.every(warm => warm.closed || warm.used !== undefined)).toBe(true)
    expect(service.list()).toEqual([])
  })
})

describe('ClaudeCodeService.accountInfo()', () => {
  it('proxies the first live session\'s cached account without opening anything', async () => {
    const { service, fake, dispose } = await mount({ auth: 'subscription' })
    try {
      await service.open({ cwd: CWD })
      const queriesBefore = fake.queries.length

      await expect(service.accountInfo()).resolves.toEqual({
        auth: 'subscription',
        email: 'tester@example.com',
        subscriptionType: 'max',
        apiProvider: 'firstParty',
      })
      expect(fake.queries).toHaveLength(queriesBefore)
    } finally {
      await dispose()
    }
  })
})

describe('ClaudeCodeService warm pool integration', () => {
  it('opens the first session cold, then serves the next one warm under the pool\'s pre-minted id', async () => {
    const { service, fake, dispose } = await mount({ prewarm: true })
    try {
      const first = await service.open({ cwd: CWD })
      await settle()
      expect(fake.queries).toHaveLength(1)
      expect(fake.warms).toHaveLength(1)

      const second = await service.open({ cwd: CWD })
      // Served warm: no new cold query, and the id is the one the pool minted.
      expect(fake.queries).toHaveLength(1)
      expect(fake.warms[0]?.used).toBeDefined()
      expect(second.id).toBe(fake.warms[0]?.options.sessionId)
      expect(second.id).not.toBe(first.id)

      // …and the pool immediately prepares the next one.
      await settle()
      expect(fake.warms).toHaveLength(2)
    } finally {
      await dispose()
    }
  })

  it('falls back to a cold query when the options changed since warming', async () => {
    const { service, fake, dispose } = await mount({ prewarm: true })
    try {
      await service.open({ cwd: CWD })
      await settle()
      expect(fake.warms).toHaveLength(1)

      const different = await service.open({ cwd: CWD, model: 'claude-sonnet-4-5' })
      expect(fake.queries).toHaveLength(2)
      expect(fake.warms[0]?.closed).toBe(true)
      expect(different.id).not.toBe(fake.warms[0]?.options.sessionId)
    } finally {
      await dispose()
    }
  })

  it('never warms when prewarm is disabled', async () => {
    const { service, fake, dispose } = await mount({ prewarm: false })
    try {
      await service.open({ cwd: CWD })
      await service.open({ cwd: CWD })
      await settle()

      expect(fake.warms).toEqual([])
      expect(fake.queries).toHaveLength(2)
    } finally {
      await dispose()
    }
  })

  it('degrades to cold opens when pre-warming fails', async () => {
    const { service, fake, dispose } = await mount({ prewarm: true })
    try {
      fake.failStartup = true
      await service.open({ cwd: CWD })
      await settle()
      const second = await service.open({ cwd: CWD })

      expect(fake.warms).toEqual([])
      expect(fake.queries).toHaveLength(2)
      expect(second.status).toBe('idle')
    } finally {
      await dispose()
    }
  })

  it('never serves a resumed session from the pool', async () => {
    const { service, fake, dispose } = await mount({ prewarm: true })
    try {
      const first = await service.open({ cwd: CWD })
      await settle()
      expect(fake.warms).toHaveLength(1)
      // A plain resume continues under the SAME id, so the session it resumes
      // must be closed first (asserted on its own below).
      await service.close(first.id)

      const resumed = await service.open({ cwd: CWD, resume: first.id })
      expect(fake.queries).toHaveLength(2)
      expect(fake.queries[1]?.options.resume).toBe(first.id)
      expect(resumed.id).not.toBe(fake.warms[0]?.options.sessionId)
      // The id it continues under is the one it resumed — no fresh mint.
      expect(resumed.id).toBe(first.id)
    } finally {
      await dispose()
    }
  })

  it('never warms a subprocess with resume/forkSession baked into it', async () => {
    const { service, fake, dispose } = await mount({ prewarm: true })
    try {
      const first = await service.open({ cwd: CWD })
      await settle()
      await service.close(first.id)

      // `warmFingerprint` deliberately ignores resume/forkSession so a
      // pre-minted id can be adopted — which means a handle warmed WITH either
      // one would be indistinguishable from a plain one and could silently
      // continue somebody else's transcript. Every warm handle is a plain
      // session of the shape, whatever kind of open seeded it.
      await service.open({ cwd: CWD, resume: first.id, fork: true })
      await settle()
      expect(fake.warms.length).toBeGreaterThan(0)
      for (const warm of fake.warms) {
        expect('resume' in warm.options).toBe(false)
        expect('forkSession' in warm.options).toBe(false)
        expect(warm.options.sessionId).toBeDefined()
      }
    } finally {
      await dispose()
    }
  })

  it('refuses a plain resume of a session that is still open here', async () => {
    const { service, fake, dispose } = await mount({ prewarm: false })
    try {
      const first = await service.open({ cwd: CWD })

      // Continuing under the same id would overwrite the live registry entry
      // and leave two queries driving one CC transcript.
      await expect(service.open({ cwd: CWD, resume: first.id }))
        .rejects.toMatchObject({ name: 'ClaudeCodeError', code: 'SESSION_EXISTS' })
      expect(fake.queries).toHaveLength(1)
      expect(service.list()).toHaveLength(1)

      // Forking it is allowed: a fork gets its own freshly minted id.
      const forked = await service.open({ cwd: CWD, resume: first.id, fork: true })
      expect(forked.id).not.toBe(first.id)
      expect(service.list()).toHaveLength(2)
    } finally {
      await dispose()
    }
  })
})
