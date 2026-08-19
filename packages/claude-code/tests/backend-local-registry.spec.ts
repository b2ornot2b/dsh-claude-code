import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { readLocalRegistry } from '../src/backend.ts'

/**
 * `readLocalRegistry` against a REAL filesystem fixture — the SDK-boundary
 * reader is otherwise only exercised through `createLocalSource`'s injected
 * fakes, which never proves the real reader's liveness rule actually holds.
 *
 * `os.homedir()` honours `$HOME` on POSIX, so a temp directory stands in for
 * `~/.claude/sessions` without touching this machine's real store. `$HOME` is
 * restored in `finally` regardless of pass/fail.
 */

/** A pid essentially guaranteed to name no running process on this machine. */
const DEAD_PID = 999_999

describe('readLocalRegistry', () => {
  it('drops a dead pid outright and never claims confirmed without a start-time match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-registry-'))
    const sessionsDir = join(root, '.claude', 'sessions')
    await mkdir(sessionsDir, { recursive: true })

    const livePid = process.pid
    await writeFile(join(sessionsDir, `${livePid}.json`), JSON.stringify({
      pid: livePid,
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: '/tmp/alive',
      name: 'alive-session',
      kind: 'interactive',
      entrypoint: 'sdk-cli',
      version: '2.1.233',
      startedAt: 1_787_000_000_000,
      // Deliberately NO procStart: the reader must never invent one to reach
      // 'confirmed' — an unconfirmable pid must degrade to 'assumed'.
    }))
    await writeFile(join(sessionsDir, `${DEAD_PID}.json`), JSON.stringify({
      pid: DEAD_PID,
      sessionId: '22222222-2222-4222-8222-222222222222',
      cwd: '/tmp/dead',
      name: 'stale-session',
    }))

    const previousHome = process.env.HOME
    process.env.HOME = root
    try {
      const entries = await readLocalRegistry()

      // The dead pid is dropped outright (P5): a live-session registry entry
      // whose process no longer exists is not reported as live at all — the
      // store scan is what would surface it, as 'resumable', if it is recent
      // enough.
      expect(entries.map(entry => entry.sessionId)).toEqual([
        '11111111-1111-4111-8111-111111111111',
      ])
      const [entry] = entries
      expect(entry?.pid).toBe(livePid)
      expect(entry?.cwd).toBe('/tmp/alive')
      expect(['confirmed', 'assumed']).toContain(entry?.liveness)
      // No procStart was recorded, so there is nothing to confirm against:
      // this MUST read 'assumed', never 'confirmed'.
      expect(entry?.liveness).toBe('assumed')
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  })
})
