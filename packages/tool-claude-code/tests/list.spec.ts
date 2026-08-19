import type { CcSessionId, CcSessionSnapshot } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

import { EMPTY_SESSION_LIST, projectSessions, renderSessionList } from '../src/list.ts'
import type { CcSessionListEntry } from '../src/list.ts'

import { CWD, mountTools, settle } from './harness.ts'

/**
 * `claude_code_list` — the seventh tool.
 *
 * It exists because every other tool here takes a `session_id`, so the only
 * sessions a model could reach were the ones it had personally opened and still
 * remembered — while `limits.maxConcurrentSessions` is enforced across the whole
 * host service, which outlives any one dsh session. In the trace that motivated
 * it, an agent was refused a slot three times by sessions it could not name.
 */

/**
 * The rendered text of a tool result.
 * @param result - the execution result.
 * @returns the first content block's text.
 */
function text(result: { content: unknown[] }): string {
  return String((result.content[0] as { text?: unknown }).text ?? '')
}

describe('claude_code_list with nothing open', () => {
  it('returns an empty array and SAYS the list is empty', async () => {
    const harness = await mountTools()
    try {
      const result = await harness.call('claude_code_list', {})

      expect(result.isError).toBe(false)
      expect(result.value).toEqual({ sessions: [] })
      // "No sessions" and "I could not parse this" must never look alike.
      expect(text(result)).toBe(EMPTY_SESSION_LIST)
      expect(text(result)).toContain('claude_code_open')
    } finally {
      await harness.dispose()
    }
  })

  it('takes no required arguments', async () => {
    const harness = await mountTools()
    try {
      const definition = harness.ctx.tools.get('claude_code_list')
      const parameters = JSON.parse(JSON.stringify(definition?.parameters)) as { required?: string[] }

      expect(parameters.required ?? []).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
})

describe('claude_code_list with one session', () => {
  it('reports its id, cwd, status, age and (empty) pending asks', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id

      const result = await harness.call('claude_code_list', {})
      const { sessions } = result.value as unknown as { sessions: CcSessionListEntry[] }

      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({
        session_id: sessionId,
        status: 'idle',
        cwd: CWD,
        pending_asks: 0,
        pending_ask_details: [],
      })
      expect(sessions[0]?.age_ms).toBeGreaterThanOrEqual(0)
      // A live session carries no close reason.
      expect('close_reason' in (sessions[0] ?? {})).toBe(false)

      const rendered = text(result)
      expect(rendered).toContain('1 Claude Code session(s)')
      expect(rendered).toContain(sessionId)
      expect(rendered).toContain(CWD)
      // The fact the production agent could not deduce.
      expect(rendered).toContain('OTHER dsh sessions sharing this host service')
    } finally {
      await harness.dispose()
    }
  })
})

describe('claude_code_list with several sessions', () => {
  it('lists them all, best close candidate first', async () => {
    const harness = await mountTools()
    try {
      const opens = []
      for (let index = 0; index < 3; index += 1) {
        opens.push(await harness.call('claude_code_open', { cwd: CWD }))
      }
      const ids = opens.map(result => (result.value as { session_id: string }).session_id)
      // The third one is given a turn to run — `claude_code_send` returns as soon
      // as the message is queued, so nothing here waits on a result the fake
      // backend will never produce on its own.
      await harness.call('claude_code_send', { session_id: ids[2], message: 'a long job', mode: 'followup' })
      await settle()
      const result = await harness.call('claude_code_list', {})
      const { sessions } = result.value as unknown as { sessions: CcSessionListEntry[] }

      expect(sessions).toHaveLength(3)
      expect(sessions.map(entry => entry.session_id).sort()).toEqual([...ids].sort())
      // The session with a turn in flight sorts LAST: closing it kills work.
      expect(sessions.at(-1)?.session_id).toBe(ids[2])
      expect(sessions.at(-1)?.status).toBe('running')
    } finally {
      await harness.dispose()
    }
  })
})

describe('include_closed', () => {
  it('omits closed sessions by default — only live ones hold a slot', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      await harness.call('claude_code_close', { session_id: sessionId })

      const result = await harness.call('claude_code_list', {})

      expect(result.value).toEqual({ sessions: [] })
      expect(text(result)).toBe(EMPTY_SESSION_LIST)
    } finally {
      await harness.dispose()
    }
  })

  it('includes them, with why each one ended, when asked', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      await harness.call('claude_code_close', { session_id: sessionId })

      const result = await harness.call('claude_code_list', { include_closed: true })
      const { sessions } = result.value as unknown as { sessions: CcSessionListEntry[] }

      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({
        session_id: sessionId,
        status: 'closed',
        close_reason: 'closed',
        cwd: CWD,
      })
      expect(text(result)).toContain('0 live, 1 recently closed')
    } finally {
      await harness.dispose()
    }
  })

  it('reports a session the idle sweep reclaimed as "reaped", not as one somebody closed', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      // Exactly what the sweep does; driving the timer belongs to the seam's own
      // specs, the tool contract under test here is that the reason survives.
      await harness.ctx.claudeCode.close(sessionId as CcSessionId, 'reaped')

      const listed = await harness.call('claude_code_list', { include_closed: true })
      expect((listed.value as unknown as { sessions: CcSessionListEntry[] }).sessions[0]?.close_reason).toBe('reaped')

      // …and the status tool, which is where a caller whose session vanished
      // actually looks, accepts the new reason through its enum.
      const status = await harness.call('claude_code_status', { session_id: sessionId })
      expect(status.isError).toBe(false)
      expect(status.value).toMatchObject({ status: 'closed', close_reason: 'reaped' })
      expect(text(status)).toContain('(reaped)')
    } finally {
      await harness.dispose()
    }
  })

  it('does not show a resumed session as both live and closed', async () => {
    // A plain resume continues under the SAME id it resumes, so the id holds a
    // live record AND a tombstone. Two rows for one session — one of them saying
    // `closed` — is worse than no listing: a model reading the corpse would open
    // a replacement for a session that is sitting right there.
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      await harness.call('claude_code_close', { session_id: sessionId })
      const resumed = await harness.call('claude_code_open', { cwd: CWD, resume: sessionId })
      expect((resumed.value as { session_id: string }).session_id).toBe(sessionId)

      const result = await harness.call('claude_code_list', { include_closed: true })
      const { sessions } = result.value as unknown as { sessions: CcSessionListEntry[] }

      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.status).not.toBe('closed')
      expect(sessions[0]?.close_reason).toBeUndefined()
      expect(text(result)).toContain('1 live, 0 recently closed')
    } finally {
      await harness.dispose()
    }
  })
})

describe('the listing prose', () => {
  /**
   * One projected entry.
   * @param overrides - what the case is about.
   * @returns the entry.
   */
  function entry(overrides: Partial<CcSessionListEntry> = {}): CcSessionListEntry {
    return {
      session_id: 'session-a',
      status: 'idle',
      cwd: '/repo/api',
      age_ms: 900_000,
      pending_asks: 0,
      pending_ask_details: [],
      human_decisions_count: 0,
      ...overrides,
    }
  }

  it('names the tool a human is deciding, and says not to close that session', () => {
    const rendered = renderSessionList([
      entry(),
      entry({
        session_id: 'session-b',
        cwd: '/repo/web',
        pending_asks: 1,
        pending_ask_details: [{ kind: 'permission', tool_name: 'Write', reason: 'Write: /tmp/notes.txt', waiting_ms: 5_520_000 }],
      }),
    ], false)

    expect(rendered).toContain('2 Claude Code session(s)')
    expect(rendered).toContain('/repo/api')
    expect(rendered).toContain('permission ask for tool "Write"')
    expect(rendered).toContain('reason: Write: /tmp/notes.txt')
    expect(rendered).toContain('1h 32m')
    expect(rendered).toContain('1 session(s) are BLOCKED')
    expect(rendered).toContain('do not close those')
  })

  it('renders the empty case as prose, never as an empty table', () => {
    expect(renderSessionList([], false)).toBe(EMPTY_SESSION_LIST)
    expect(renderSessionList([], true)).toBe(EMPTY_SESSION_LIST)
  })
})

describe('projectSessions', () => {
  it('measures every age against ONE clock reading', () => {
    const now = 1_700_000_000_000
    const sessions = projectSessions([
      {
        id: 'a' as CcSessionId,
        status: 'idle',
        cwd: '/repo/api',
        openedAt: now - 120_000,
        lastActivityAt: now - 120_000,
        pendingAsks: 0,
        pendingAskDetails: [],
        recentAsks: [],
      },
    ], now)

    expect(sessions[0]?.age_ms).toBe(120_000)
  })

  it('projects a snapshot from a seam older than these fields instead of throwing', () => {
    // This package and the seam are published and RESOLVED separately, so a
    // deployment can run a tool newer than the service behind it. A listing that
    // throws is strictly worse than a listing that says less.
    const skewed = { id: 'skewed', status: 'idle', pendingAsks: 0 } as unknown as CcSessionSnapshot

    const sessions = projectSessions([skewed], 1_700_000_000_000)

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.pending_ask_details).toEqual([])
    expect(sessions[0]?.age_ms).toBe(0)
    expect(() => renderSessionList(sessions, false)).not.toThrow()
    expect(renderSessionList(sessions, false)).not.toContain('NaN')
  })
})

describe('claude_code_list scope', () => {
  it('defaults to composition and renders exactly the legacy text', async () => {
    const harness = await mountTools()
    try {
      const result = await harness.call('claude_code_list', {})

      expect(result.value).toEqual({ sessions: [] })
      expect(text(result)).toBe(EMPTY_SESSION_LIST)
    } finally {
      await harness.dispose()
    }
  })

  it('names what it searched and what failed when a wide scope finds nothing', async () => {
    const harness = await mountTools()
    try {
      harness.ctx.claudeCode.registerDiscoverySource({
        id: 'remote:b2hx',
        host: 'b2hx',
        discover: async () => Promise.reject(new Error('unreachable (ssh connect timeout 6000ms)')),
      })

      const result = await harness.call('claude_code_list', { scope: 'mesh' })

      // "nothing exists" and "I could not look" must never render alike.
      expect(text(result)).not.toBe(EMPTY_SESSION_LIST)
      expect(text(result)).toContain('b2hx')
      expect(text(result)).toContain('unreachable')
      expect((result.value as { warnings?: string[] }).warnings?.length).toBe(1)
    } finally {
      await harness.dispose()
    }
  })

  it('groups external live and resumable sessions with their hosts, composed section first', async () => {
    const harness = await mountTools()
    try {
      // A real composed session, so the ordering assertion below has
      // something to check the composed section against — `toContain`
      // cannot tell "present and first" from "present and last".
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const composedId = (opened.value as { session_id: string }).session_id

      harness.ctx.claudeCode.registerDiscoverySource({
        id: 'remote:b2umini',
        host: 'b2umini',
        discover: async request => Promise.resolve({
          generatedAt: request.now,
          cached: false,
          warnings: [],
          sessions: [{
            sessionId: '889cd0f8-30f5-4469-b63a-086d93cbb047' as CcSessionId,
            origin: 'live-external' as const, host: 'b2umini', sourceId: 'remote:b2umini',
            cwd: '/Users/b2/Developer/mine/grigios', title: 'grigios-cb',
            lastActivityAt: request.now - 600_000, sendable: false, resumable: true,
            fidelity: 'probe' as const, live: { liveness: 'assumed' as const, pid: 3796 },
          }, {
            sessionId: '43bc3d80-fb06-4f6e-805f-f3eeff272690' as CcSessionId,
            origin: 'resumable' as const, host: 'b2umini', sourceId: 'remote:b2umini',
            cwd: '/Users/b2/Developer/mine/grigios', title: 'fix the thing',
            lastActivityAt: request.now - 3_600_000, sendable: false, resumable: true,
            fidelity: 'probe' as const,
          }],
        }),
      })

      const result = await harness.call('claude_code_list', { scope: 'mesh' })
      const value = result.value as {
        external_live: { session_id: string, host: string, sendable: boolean }[]
        external_resumable: { session_id: string }[]
      }

      expect(value.external_live).toHaveLength(1)
      expect(value.external_live[0]?.host).toBe('b2umini')
      expect(value.external_live[0]?.sendable).toBe(false)
      expect(value.external_resumable).toHaveLength(1)

      const rendered = text(result)
      // Position, not mere presence: `toContain` alone would still pass if
      // "Resumable" rendered before "Running elsewhere", or if the composed
      // section were dropped entirely — a regression a model reading this
      // list would experience as the SESSION_LIMIT close-candidate promise
      // silently breaking.
      const composedIndex = rendered.indexOf(composedId)
      const liveIndex = rendered.indexOf('Running elsewhere')
      const resumableIndex = rendered.indexOf('Resumable')
      expect(composedIndex).toBeGreaterThanOrEqual(0)
      expect(liveIndex).toBeGreaterThan(composedIndex)
      expect(resumableIndex).toBeGreaterThan(liveIndex)
      expect(rendered).toContain('fork')          // says what CAN be done with it
      expect(rendered).toContain('b2umini')
    } finally {
      await harness.dispose()
    }
  })

  it('never forwards sendable: true from a discovery source — nothing outside this composition has a control channel', async () => {
    const harness = await mountTools()
    try {
      harness.ctx.claudeCode.registerDiscoverySource({
        id: 'remote:untrusted',
        host: 'b2untrusted',
        discover: async request => Promise.resolve({
          generatedAt: request.now,
          cached: false,
          warnings: [],
          sessions: [{
            sessionId: 'aaaaaaaa-0000-4000-8000-000000000000' as CcSessionId,
            origin: 'live-external' as const, host: 'b2untrusted', sourceId: 'remote:untrusted',
            cwd: '/tmp', lastActivityAt: request.now,
            // A misbehaving (or malicious) source claiming a control channel
            // it cannot possibly have. The projection must never repeat this
            // claim — a model reading the structured value, not the prose,
            // would otherwise try claude_code_send against it and fail.
            sendable: true, resumable: true,
            fidelity: 'probe' as const,
          }],
        }),
      })

      const result = await harness.call('claude_code_list', { scope: 'mesh' })
      const value = result.value as { external_live: { sendable: boolean }[] }

      expect(value.external_live).toHaveLength(1)
      expect(value.external_live[0]?.sendable).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  it('renders warnings alongside real sections, not only in the fully-empty case', async () => {
    const harness = await mountTools()
    try {
      harness.ctx.claudeCode.registerDiscoverySource({
        id: 'remote:b2umini',
        host: 'b2umini',
        discover: async request => Promise.resolve({
          generatedAt: request.now,
          cached: false,
          warnings: [],
          sessions: [{
            sessionId: '889cd0f8-30f5-4469-b63a-086d93cbb047' as CcSessionId,
            origin: 'live-external' as const, host: 'b2umini', sourceId: 'remote:b2umini',
            cwd: '/Users/b2/Developer/mine/grigios', lastActivityAt: request.now - 600_000,
            sendable: false, resumable: true, fidelity: 'probe' as const,
          }],
        }),
      })
      harness.ctx.claudeCode.registerDiscoverySource({
        id: 'remote:b2hx',
        host: 'b2hx',
        discover: async () => Promise.reject(new Error('unreachable (ssh connect timeout 6000ms)')),
      })

      const result = await harness.call('claude_code_list', { scope: 'mesh' })
      const rendered = text(result)

      // A source failing partway must not swallow the sessions the OTHER
      // sources found, and the found sessions must not swallow the warning.
      expect(rendered).toContain('Running elsewhere')
      expect(rendered).toContain('b2umini')
      expect(rendered).toContain('Warnings')
      expect(rendered).toContain('b2hx')
      expect(rendered).toContain('unreachable')
    } finally {
      await harness.dispose()
    }
  })
})
