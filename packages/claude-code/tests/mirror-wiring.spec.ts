/**
 * The mirror's wire-in: `open({ mirror })` and `ctx.claudeCode.attachMirror()`.
 *
 * The seam keeps `@deepseek-ai/dsh-session` OPTIONAL for pure-SDK consumers —
 * it is a peer dependency used for types, and a composition that never passes a
 * dsh session never constructs one. Everything here runs on the fake backend;
 * no subprocess is ever spawned.
 */

import { tmpdir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import { ClaudeCodeError, ClaudeCodeService } from '@deepseek-ai/dsh-claude-code'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import { createFakeBackend, settle } from './fake-backend.ts'
import type { FakeBackend } from './fake-backend.ts'

/** An absolute directory that certainly exists — `open()` validates `cwd` up front. */
const CWD = tmpdir()

/**
 * Mount the Claude Code service and a real session store side by side.
 * @returns the service, the fake backend, a dsh session factory and a disposer.
 */
async function mount(): Promise<{
  service: ClaudeCodeService
  fake: FakeBackend
  newSession(id: string): Session
  dispose(): Promise<void>
}> {
  const fake = createFakeBackend()
  const ctx = new Context()
  let service: ClaudeCodeService | undefined
  function claudeCodeMirrorMount(inner: Context): void {
    service = new ClaudeCodeService(inner, {}, { backend: fake.backend, drainPollMs: 1 })
  }
  const fiber = await ctx.plugin(claudeCodeMirrorMount)
  const storeFiber = await ctx.plugin(SessionStore)
  const store = ctx.get('sessions')
  if (service === undefined || store === undefined) throw new Error('mount did not complete')
  return {
    service,
    fake,
    newSession: (id: string) => store.create(SessionId(id)),
    dispose: async () => {
      await storeFiber.dispose()
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

describe('open({ mirror })', () => {
  it('attaches before the opening prompt, so its turn is framed', async () => {
    const { service, fake, newSession, dispose } = await mount()
    try {
      const log = newSession('44444444-5555-4666-8777-888888888888')
      const snapshot = await service.open({
        cwd: CWD,
        prompt: 'summarize this repo',
        mirror: { session: log },
      })
      await settle()

      expect(log.events.map(event => event.type)).toEqual(['turn/start', 'user/message'])
      expect(log.deriveMessages()[0]?.content).toEqual([{ type: 'text', text: 'summarize this repo' }])

      // …and the live session's messages keep flowing into the same log.
      await fake.queries[0]?.emitResult('success')
      expect(log.events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
      expect(service.get(snapshot.id)?.status).toBe('idle')
    } finally {
      await dispose()
    }
  })
})

describe('ClaudeCodeService.attachMirror()', () => {
  it('mirrors a session opened idle, and disposes itself when the session closes', async () => {
    const { service, fake, newSession, dispose } = await mount()
    try {
      const log = newSession('55555555-6666-4777-8888-999999999999')
      const snapshot = await service.open({ cwd: CWD })
      const handle = service.attachMirror(snapshot.id, log)

      service.session(snapshot.id)?.send('hello there')
      await settle()
      expect(log.events.map(event => event.type)).toEqual(['turn/start', 'user/message'])

      // Closing the Claude Code session detaches the mirror: a stale mirror
      // holding a listener on a dead actor is a leak, not a feature. It also
      // FINALIZES first — the turn that was open will never get its result, and
      // a log with a dangling `turn/start` can never be appended to again.
      await service.close(snapshot.id)
      expect(log.events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
      expect(handle.mirror.hasOpenTurn).toBe(false)
      const [turnEnd] = log.events.filter(event => event.type === 'turn/end')
      expect(turnEnd?.type === 'turn/end' ? turnEnd.data.reason : undefined)
        .toEqual({ kind: 'aborted', reason: { kind: 'disposed' } })

      const before = log.events.length
      await fake.queries[0]?.emitResult('success')
      expect(log.events.length).toBe(before)
      expect(() => { handle.dispose() }).not.toThrow()
    } finally {
      await dispose()
    }
  })

  it('refuses an unknown session id', async () => {
    const { service, newSession, dispose } = await mount()
    try {
      const log = newSession('66666666-7777-4888-8999-aaaaaaaaaaaa')
      expect(() => service.attachMirror(SessionId('77777777-8888-4999-8aaa-bbbbbbbbbbbb'), log))
        .toThrow(ClaudeCodeError)
      expect(log.events).toHaveLength(0)
    } finally {
      await dispose()
    }
  })
})
