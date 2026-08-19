import { tmpdir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import { ClaudeCodeService, CLOSED_SESSION_HISTORY } from '@deepseek-ai/dsh-claude-code'
import type { CcSessionId, ClaudeCodeConfig, ClaudeCodeServiceDeps } from '@deepseek-ai/dsh-claude-code'
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

describe('ClaudeCodeService.list({ includeClosed })', () => {
  it('appends the tombstones, and leaves the default listing live-only', async () => {
    const { service, dispose } = await mount({ prewarm: false })
    try {
      const gone = await service.open({ cwd: CWD })
      await service.close(gone.id)
      const live = await service.open({ cwd: CWD })

      // The default is what `open()`'s own slot accounting depends on: a caller
      // counting against `limits.maxConcurrentSessions` must not count corpses.
      expect(service.list().map(entry => entry.id)).toEqual([live.id])
      expect(service.list({ includeClosed: true }).map(entry => entry.id)).toEqual([live.id, gone.id])
      expect(service.list({ includeClosed: true }).find(entry => entry.id === gone.id))
        .toMatchObject({ status: 'closed', closeReason: 'closed' })
    } finally {
      await dispose()
    }
  })

  it('reports a resumed id ONCE — live — and not also as its own corpse', async () => {
    // A plain resume continues under the SAME id it resumes, so a session closed
    // here and then resumed here holds both a registry record and a tombstone.
    // Listing both would show one session twice, once as `closed`, and hang the
    // corpse's `closeReason` on the row a caller is about to send to.
    const { service, dispose } = await mount({ prewarm: false })
    try {
      const first = await service.open({ cwd: CWD })
      await service.close(first.id)
      const resumed = await service.open({ cwd: CWD, resume: first.id })
      expect(resumed.id).toBe(first.id)

      const listed = service.list({ includeClosed: true })
      expect(listed.map(entry => entry.id)).toEqual([first.id])
      expect(listed[0]?.status).not.toBe('closed')
      expect(listed[0]?.closeReason).toBeUndefined()
    } finally {
      await dispose()
    }
  })

  it('never resurrects an evicted tombstone', async () => {
    // The tombstone table is a bounded courtesy, not a history. Once an entry is
    // evicted it must be gone from every read, or the bound is decorative.
    const { service, dispose } = await mount({ prewarm: false })
    try {
      const ids: CcSessionId[] = []
      for (let index = 0; index <= CLOSED_SESSION_HISTORY; index += 1) {
        const opened = await service.open({ cwd: CWD })
        ids.push(opened.id)
        await service.close(opened.id)
      }
      const evicted = ids[0]
      if (evicted === undefined) throw new Error('no sessions were opened')

      const listed = service.list({ includeClosed: true })
      expect(listed).toHaveLength(CLOSED_SESSION_HISTORY)
      expect(listed.map(entry => entry.id)).not.toContain(evicted)
      expect(service.get(evicted)).toBeUndefined()
      // The newest close is still answerable, so the bound trimmed the right end.
      expect(listed.map(entry => entry.id)).toContain(ids[ids.length - 1])
    } finally {
      await dispose()
    }
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

describe('resume without an explicit cwd', () => {
  it('fills the cwd from discovery', async () => {
    const { service, fake, dispose } = await mount()
    try {
      const id = '77777777-7777-4777-8777-777777777777' as CcSessionId
      service.registerDiscoverySource({
        id: 'remote:test',
        host: 'b2studio',
        discover: async request => Promise.resolve({
          generatedAt: request.now,
          cached: false,
          warnings: [],
          sessions: [{
            sessionId: id,
            origin: 'resumable' as const,
            host: 'b2studio',
            sourceId: 'remote:test',
            cwd: '/Users/b2/Developer/mine/b2infra',
            lastActivityAt: request.now - 1_000,
            sendable: false,
            resumable: true,
            fidelity: 'probe' as const,
          }],
        }),
      })

      await service.open({ resume: id, fork: true })

      expect(fake.queries[0]?.options.cwd).toBe('/Users/b2/Developer/mine/b2infra')
    } finally {
      await dispose()
    }
  })

  it('refuses with INVALID_CWD when discovery cannot name the session', async () => {
    const { service, dispose } = await mount()
    try {
      await expect(service.open({
        resume: '88888888-8888-4888-8888-888888888888' as CcSessionId, fork: true,
      })).rejects.toMatchObject({ code: 'INVALID_CWD' })
    } finally {
      await dispose()
    }
  })
})
