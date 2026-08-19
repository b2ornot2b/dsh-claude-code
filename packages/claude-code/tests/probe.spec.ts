import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * `claude-inventory` — the per-host probe.
 *
 * It reads files and never runs `claude`, because CLI version skew across this
 * mesh is already real: b2mini's PATH `claude` is 2.1.104 and rejects `--json`
 * (spec P4). And it validates liveness itself, because b2umini's registry
 * reported week-old pids as live interactive sessions (spec P5).
 */

const PROBE = fileURLToPath(new URL('../scripts/claude-inventory', import.meta.url))

/** A pid that cannot be running: above the platform maximum. */
const DEAD_PID = 4194303

interface ProbeOutput {
  schema: number
  host: string
  generatedAt: number
  home: string
  live: { sessionId: string, pid: number, cwd: string, name?: string, kind?: string, liveness: string }[]
  resumable: { sessionId: string, cwd: string, lastModified: number, sizeBytes: number, title?: string, gitBranch?: string, createdAt?: number }[]
  warnings: string[]
}

/**
 * Build a fixture `$HOME` containing a Claude Code state tree.
 * @param entries - registry files to write, keyed by filename.
 * @returns the fixture home directory.
 */
function fixtureHome(entries: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'cc-probe-'))
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  for (const [file, body] of Object.entries(entries)) {
    writeFileSync(join(home, '.claude', 'sessions', file), JSON.stringify(body))
  }
  return home
}

/**
 * Run the probe against a fixture home.
 * @param home - the fixture home directory.
 * @param args - extra CLI arguments.
 * @returns the parsed output.
 */
function runProbe(home: string, ...args: string[]): ProbeOutput {
  const raw = execFileSync('python3', [PROBE, '--home', home, ...args], { encoding: 'utf8' })
  return JSON.parse(raw) as ProbeOutput
}

/**
 * Write a transcript into a fixture home's store.
 * @param home - the fixture home.
 * @param slug - the project slug directory name.
 * @param id - the session id.
 * @param lines - JSONL entries.
 * @param ageMs - how long ago the file was last modified.
 */
function writeTranscript(
  home: string, slug: string, id: string, lines: unknown[], ageMs: number,
): void {
  const dir = join(home, '.claude', 'projects', slug)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  const when = (Date.now() - ageMs) / 1000
  utimesSync(file, when, when)
}

describe('claude-inventory live sessions', () => {
  it('reports a live session and drops one whose process is gone', () => {
    const home = fixtureHome({
      'alive.json': {
        pid: process.pid,
        sessionId: '11111111-1111-4111-8111-111111111111',
        cwd: '/Users/b2/Developer/mine/b2infra',
        startedAt: 1787120000000,
        version: '2.1.233',
        kind: 'interactive',
        entrypoint: 'sdk-cli',
        name: 'b2infra-bd',
      },
      'dead.json': {
        pid: DEAD_PID,
        sessionId: '22222222-2222-4222-8222-222222222222',
        cwd: '/Users/b2/Developer/mine/grigios',
        startedAt: 1786611479355,
        kind: 'interactive',
        name: 'grigios-cb',
      },
    })

    const out = runProbe(home)

    expect(out.schema).toBe(1)
    expect(out.host).not.toBe('')
    expect(out.generatedAt).toBeGreaterThan(0)
    expect(out.live.map(entry => entry.sessionId))
      .toEqual(['11111111-1111-4111-8111-111111111111'])
    expect(out.live[0]?.name).toBe('b2infra-bd')
    expect(out.live[0]?.liveness).toMatch(/^(confirmed|assumed)$/)
    // The dead entry is not live, and the probe never deletes the file it read.
    expect(out.live.some(entry => entry.pid === DEAD_PID)).toBe(false)
  })

  it('honours --no-titles by dropping the live entry\'s name too', () => {
    // `discovery.includeTitles: false` exists to keep names/prompt text off
    // the mesh (design §12). The local source already gates `name` behind
    // it; this proves the probe path — the ONLY path a remote host's live
    // sessions travel by — agrees, rather than leaking a name the local half
    // of the same control withholds.
    const home = fixtureHome({
      'alive.json': {
        pid: process.pid,
        sessionId: '11111111-1111-4111-8111-111111111111',
        cwd: '/Users/b2/Developer/mine/b2infra',
        kind: 'interactive',
        name: 'b2infra-bd',
      },
    })

    const out = runProbe(home, '--no-titles')

    expect(out.live).toHaveLength(1)
    expect(out.live[0]?.name).toBeUndefined()
    // The rest of the row survives — only the title-bearing field is scrubbed.
    expect(out.live[0]?.kind).toBe('interactive')
  })
})

describe('claude-inventory resumable sessions', () => {
  it('reports windowed transcripts newest-first with cwd, branch and a title', () => {
    const home = fixtureHome({})
    writeTranscript(home, '-Users-b2-Developer-mine-b2infra',
      '33333333-3333-4333-8333-333333333333', [
        { type: 'user', cwd: '/Users/b2/Developer/mine/b2infra', gitBranch: 'main',
          sessionId: '33333333-3333-4333-8333-333333333333',
          message: { role: 'user', content: 'plan the session discovery work' } },
      ], 60_000)
    writeTranscript(home, '-Users-b2-Developer-mine-old',
      '44444444-4444-4444-8444-444444444444', [
        { type: 'user', cwd: '/Users/b2/Developer/mine/old',
          message: { role: 'user', content: 'ancient work' } },
      ], 30 * 24 * 60 * 60 * 1000)

    const out = runProbe(home)

    // The 30-day-old transcript is outside the default 7-day window.
    expect(out.resumable.map(entry => entry.sessionId))
      .toEqual(['33333333-3333-4333-8333-333333333333'])
    const [entry] = out.resumable
    expect(entry?.cwd).toBe('/Users/b2/Developer/mine/b2infra')
    expect(entry?.gitBranch).toBe('main')
    expect(entry?.title).toContain('plan the session discovery')
    expect(entry?.sizeBytes).toBeGreaterThan(0)
  })

  it('honours --window-ms, --max-resumable and --no-titles', () => {
    const home = fixtureHome({})
    for (let index = 0; index < 3; index += 1) {
      writeTranscript(home, `-slug-${index}`, `5555555${index}-5555-4555-8555-555555555555`, [
        { type: 'user', cwd: `/tmp/p${index}`, message: { role: 'user', content: `prompt ${index}` } },
      ], (index + 1) * 60_000)
    }

    expect(runProbe(home, '--max-resumable', '2').resumable).toHaveLength(2)
    expect(runProbe(home, '--window-ms', '90000').resumable).toHaveLength(1)
    const scrubbed = runProbe(home, '--no-titles').resumable
    expect(scrubbed.every(entry => entry.title === undefined)).toBe(true)
  })
})

describe('claude-inventory degradation', () => {
  it('succeeds with warnings when there is no ~/.claude at all', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-probe-empty-'))

    const out = runProbe(home)

    expect(out.schema).toBe(1)
    expect(out.live).toEqual([])
    expect(out.resumable).toEqual([])
    // "nothing here" and "I could not look" must never render alike.
    expect(out.warnings.join('\n')).toContain('.claude')
  })

  it('warns about a malformed registry file without losing its siblings', () => {
    const home = fixtureHome({
      'good.json': {
        pid: process.pid, sessionId: '66666666-6666-4666-8666-666666666666', cwd: '/tmp',
      },
    })
    writeFileSync(join(home, '.claude', 'sessions', 'bad.json'), '{ not json')

    const out = runProbe(home)

    expect(out.live.map(entry => entry.sessionId))
      .toEqual(['66666666-6666-4666-8666-666666666666'])
    expect(out.warnings.join('\n')).toContain('bad.json')
  })

  it('degrades gracefully when sessions dir is unreadable, keeping resumable', () => {
    // Skip this test when running as root, since root ignores directory permissions
    if (process.getuid?.() === 0) {
      return
    }

    const home = fixtureHome({
      'live.json': {
        pid: process.pid, sessionId: '77777777-7777-4777-8777-777777777777', cwd: '/tmp',
      },
    })
    writeTranscript(home, '-slug-test', '88888888-8888-4888-8888-888888888888', [
      { type: 'user', cwd: '/tmp', message: { role: 'user', content: 'test' } },
    ], 60_000)

    const sessionsDir = join(home, '.claude', 'sessions')
    chmodSync(sessionsDir, 0o000)
    try {
      const out = runProbe(home)

      // Still returns schema 1, exits code 0 (no exception)
      expect(out.schema).toBe(1)
      expect(out.live).toEqual([])
      // Resumable should still have data (other half intact)
      expect(out.resumable).toHaveLength(1)
      expect(out.resumable[0]?.sessionId).toBe('88888888-8888-4888-8888-888888888888')
      // Warning should mention the unreadable sessions directory
      expect(out.warnings.join('\n')).toContain(sessionsDir)
    } finally {
      chmodSync(sessionsDir, 0o755)
    }
  })

  it('degrades gracefully when projects dir is unreadable, keeping live', () => {
    // Skip this test when running as root, since root ignores directory permissions
    if (process.getuid?.() === 0) {
      return
    }

    const home = fixtureHome({
      'live.json': {
        pid: process.pid, sessionId: '99999999-9999-4999-8999-999999999999', cwd: '/tmp',
      },
    })
    writeTranscript(home, '-slug-test', '10101010-1010-4101-8101-010101010101', [
      { type: 'user', cwd: '/tmp', message: { role: 'user', content: 'test' } },
    ], 60_000)

    const projectsDir = join(home, '.claude', 'projects')
    chmodSync(projectsDir, 0o000)
    try {
      const out = runProbe(home)

      // Still returns schema 1, exits code 0 (no exception)
      expect(out.schema).toBe(1)
      // Live should still have data (other half intact)
      expect(out.live).toHaveLength(1)
      expect(out.live[0]?.sessionId).toBe('99999999-9999-4999-8999-999999999999')
      expect(out.resumable).toEqual([])
      // Warning should mention the unreadable projects directory
      expect(out.warnings.join('\n')).toContain(projectsDir)
    } finally {
      chmodSync(projectsDir, 0o755)
    }
  })
})
