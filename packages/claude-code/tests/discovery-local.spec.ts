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
  // All three title sources present and distinguishable, so a `??` chain in
  // the wrong order is caught: customTitle must win over both of the others.
  customTitle: 'Review and plan DSH Claude Code integration',
  summary: 'a summary that must never win over a customTitle',
  firstPrompt: 'a first prompt that must never win over a customTitle',
  lastModified: NOW - 4 * 60 * 60 * 1000,
  fileSize: 4_384_613,
}, {
  sessionId: '33333333-3333-4333-8333-333333333333',
  cwd: '/Users/b2/Developer/mine/dsh-claude-code',
  // No customTitle here, so summary must win over firstPrompt.
  summary: 'summary wins when there is no customTitle',
  firstPrompt: 'a first prompt that must never win over a summary',
  lastModified: NOW - 5 * 60 * 60 * 1000,
  fileSize: 2_048,
}, {
  sessionId: '44444444-4444-4444-8444-444444444444',
  cwd: '/Users/b2/Developer/mine/dsh-claude-code',
  summary: 'stale session outside the 7-day recentWindowMs used below',
  // 8 days old: strictly past the 604_800_000 ms (7-day) window every test
  // below uses, so the cutoff must exclude it.
  lastModified: NOW - 8 * 24 * 60 * 60 * 1000,
  fileSize: 512,
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
    // customTitle wins over summary, which wins over firstPrompt — each
    // fixture entry above isolates one link of the chain.
    expect(resumable.find(entry =>
      entry.sessionId === '22222222-2222-4222-8222-222222222222')?.title)
      .toBe('Review and plan DSH Claude Code integration')
    expect(resumable.find(entry =>
      entry.sessionId === '33333333-3333-4333-8333-333333333333')?.title)
      .toBe('summary wins when there is no customTitle')
    // 44444444... is older than recentWindowMs and must be cut off.
    expect(resumable.map(entry => entry.sessionId)).not.toContain(
      '44444444-4444-4444-8444-444444444444')
  })

  it('omits titles when asked, and omits resumables when not asked for', async () => {
    // Counts calls rather than just inspecting output: a regression to
    // read-then-filter would still produce the right sessions below, but
    // would call listSessions when it must not be called at all.
    let listSessionsCalls = 0
    const source = createLocalSource({
      host: 'b2studio',
      listSessions: async () => {
        listSessionsCalls += 1
        return Promise.resolve(STORE)
      },
      readRegistry: async () => Promise.resolve(REGISTRY),
      now: () => NOW,
    })

    const untitled = await source.discover({
      now: NOW, includeResumable: true, recentWindowMs: 604_800_000,
      maxResumable: 50, includeTitles: false,
    })
    expect(untitled.sessions.every(entry => entry.title === undefined)).toBe(true)
    // The counter is live: an includeResumable: true request did read the store.
    expect(listSessionsCalls).toBe(1)

    const callsBeforeLiveOnly = listSessionsCalls
    const liveOnly = await source.discover({
      now: NOW, includeResumable: false, recentWindowMs: 604_800_000,
      maxResumable: 50, includeTitles: true,
    })
    expect(liveOnly.sessions.every(entry => entry.origin === 'live-external')).toBe(true)
    // includeResumable: false must skip the store read entirely, not read
    // and then filter — the call count must not move.
    expect(listSessionsCalls).toBe(callsBeforeLiveOnly)
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

  it('warns instead of throwing when the OTHER reader fails, and keeps the store answer', async () => {
    // Mirror of the previous case: the two readers are caught independently,
    // so a registry failure must not swallow the store's sessions.
    const source = createLocalSource({
      host: 'b2studio',
      listSessions: async () => Promise.resolve(STORE),
      readRegistry: async () => Promise.reject(new Error('registry unreadable')),
      now: () => NOW,
    })

    const result = await source.discover({
      now: NOW, includeResumable: true, recentWindowMs: 604_800_000,
      maxResumable: 50, includeTitles: true,
    })

    expect(result.warnings.join('\n')).toContain('registry unreadable')
    // Every session reported is resumable: the registry contributed nothing,
    // but the store still answered in full (minus the one stale entry).
    expect(result.sessions.length).toBeGreaterThan(0)
    expect(result.sessions.every(entry => entry.origin === 'resumable')).toBe(true)
  })
})
