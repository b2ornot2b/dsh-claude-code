import { describe, expect, it } from 'vitest'

import { createLocalSource } from '../src/discovery-local.ts'
import type { CcRegistryEntry, CcStoreEntry } from '../src/discovery-local.ts'

/**
 * The local source. On this host the SDK store read is authoritative and costs
 * 64 ms for eight sessions (design P1), so nothing here spawns a probe.
 *
 * The registry and the store overlap by construction: a running session has
 * both a registry file and a transcript. Both are reported; the coordinator's
 * dedupe decides which wins.
 */

const NOW = 1_787_128_000_000

const REGISTRY: CcRegistryEntry[] = [{
  sessionId: '11111111-1111-4111-8111-111111111111',
  pid: 4242,
  cwd: '/Users/b2/Developer/mine/b2infra',
  name: 'b2infra-bd',
  kind: 'interactive',
  entrypoint: 'sdk-cli',
  version: '2.1.233',
  startedAt: NOW - 300_000,
  liveness: 'confirmed',
}]

const STORE: CcStoreEntry[] = [{
  sessionId: '11111111-1111-4111-8111-111111111111',
  cwd: '/Users/b2/Developer/mine/b2infra',
  summary: 'Session discovery work',
  gitBranch: 'feature/session-discovery',
  lastModified: NOW - 30_000,
  createdAt: NOW - 300_000,
  fileSize: 603_777,
}, {
  sessionId: '22222222-2222-4222-8222-222222222222',
  cwd: '/Users/b2/Developer/mine/dsh-claude-code',
  customTitle: 'Review and plan DSH Claude Code integration',
  lastModified: NOW - 4 * 60 * 60 * 1000,
  fileSize: 4_384_613,
}]

describe('createLocalSource', () => {
  it('reports live sessions as live-external and store sessions as resumable', async () => {
    const source = createLocalSource({
      host: 'b2studio',
      listSessions: async () => Promise.resolve(STORE),
      readRegistry: async () => Promise.resolve(REGISTRY),
      now: () => NOW,
    })

    const result = await source.discover({
      now: NOW, includeResumable: true, recentWindowMs: 604_800_000,
      maxResumable: 50, includeTitles: true,
    })

    const live = result.sessions.filter(entry => entry.origin === 'live-external')
    const resumable = result.sessions.filter(entry => entry.origin === 'resumable')
    expect(live).toHaveLength(1)
    expect(live[0]?.live?.pid).toBe(4242)
    expect(live[0]?.live?.liveness).toBe('confirmed')
    expect(live[0]?.sendable).toBe(false)
    expect(live[0]?.resumable).toBe(true)
    expect(live[0]?.host).toBe('b2studio')
    expect(live[0]?.fidelity).toBe('sdk')
    expect(resumable.map(entry => entry.sessionId)).toContain(
      '22222222-2222-4222-8222-222222222222')
    // customTitle wins over summary, and both beat firstPrompt.
    expect(resumable.find(entry =>
      entry.sessionId === '22222222-2222-4222-8222-222222222222')?.title)
      .toBe('Review and plan DSH Claude Code integration')
  })

  it('omits titles when asked, and omits resumables when not asked for', async () => {
    const source = createLocalSource({
      host: 'b2studio',
      listSessions: async () => Promise.resolve(STORE),
      readRegistry: async () => Promise.resolve(REGISTRY),
      now: () => NOW,
    })

    const untitled = await source.discover({
      now: NOW, includeResumable: true, recentWindowMs: 604_800_000,
      maxResumable: 50, includeTitles: false,
    })
    expect(untitled.sessions.every(entry => entry.title === undefined)).toBe(true)

    const liveOnly = await source.discover({
      now: NOW, includeResumable: false, recentWindowMs: 604_800_000,
      maxResumable: 50, includeTitles: true,
    })
    expect(liveOnly.sessions.every(entry => entry.origin === 'live-external')).toBe(true)
  })

  it('warns instead of throwing when a reader fails', async () => {
    const source = createLocalSource({
      host: 'b2studio',
      listSessions: async () => Promise.reject(new Error('store unreadable')),
      readRegistry: async () => Promise.resolve(REGISTRY),
      now: () => NOW,
    })

    const result = await source.discover({
      now: NOW, includeResumable: true, recentWindowMs: 604_800_000,
      maxResumable: 50, includeTitles: true,
    })

    expect(result.warnings.join('\n')).toContain('store unreadable')
    expect(result.sessions).toHaveLength(1)   // the registry still answered
  })
})
