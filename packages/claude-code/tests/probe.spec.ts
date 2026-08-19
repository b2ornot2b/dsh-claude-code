import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
  live: { sessionId: string, pid: number, cwd: string, name?: string, liveness: string }[]
  resumable: { sessionId: string }[]
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
})
