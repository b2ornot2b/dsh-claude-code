/**
 * The fixture recorder (Stage 2, item 1): runs THREE tiny REAL Claude Code
 * sessions and writes every `onMessage`/`onSend` record into
 * `tests/fixtures/*.json`, scrubbed of every non-deterministic field (uuids,
 * session ids, timestamps, token counts, and the recorder's own tmp `cwd`).
 *
 * These files are the ONLY input the offline golden suite
 * (`tests/mirror-golden.spec.ts`) reads — regenerating them is optional (this
 * spec is gated exactly like every other live spec), but the committed JSON is
 * what makes the golden suite a regression net across changes to this file.
 *
 * Scenarios, matching the Stage 2 task exactly:
 *
 * a. `plain-text` — a plain two-sentence answer (text, possibly a thinking block).
 * b. `tool-call` — one Bash tool call in an isolated cwd under a hardcoded
 *    allow-everything `canUseTool` (tool_use + tool_result traffic).
 * c. `steer` — a mid-turn steer (spike 2's abort-and-refold): an interrupt
 *    artifact result the mirror must suppress, then the refolded turn's result.
 */

import { realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CcCanUseTool, CcMessageEnvelope, CcSendRecord } from '@deepseek-ai/dsh-claude-code'
import { describe, it } from 'vitest'

import { createScrubber } from '../fixtures/scrub.ts'
import type { FixtureEntry, RecordedFixture } from '../fixtures/types.ts'
import {
  disposeLive, LIVE, LIVE_MODEL, LIVE_TIMEOUT_MS, mountLive, onceMessage, removeCwd, tmpCwd,
} from './helpers.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(here, '..', 'fixtures')

/**
 * The hardcoded allow this task asks for: every tool call is let through with
 * its input unchanged. Real `canUseTool` policy lands in Phase 4; this recorder
 * only needs SOME decision that never hangs the subprocess.
 */
const allowAll: CcCanUseTool = async (_toolName, input) =>
  await Promise.resolve({ behavior: 'allow', updatedInput: input })

/**
 * One recorder: subscribes to a live session's `onSend` + `onMessage` and
 * accumulates ONE interleaved timeline — the exact chronology `CcMirror` would
 * see attached live, which matters most for a `steer` send that lands
 * mid-turn.
 */
interface Recorder {
  readonly entries: FixtureEntry[]
  attach(session: { onSend: (l: (send: CcSendRecord) => void) => void, onMessage: (l: (envelope: CcMessageEnvelope) => void) => void }): void
}

/** Build a recorder with an empty timeline. */
function createRecorder(): Recorder {
  const entries: FixtureEntry[] = []
  return {
    entries,
    attach(session) {
      session.onSend((send) => { entries.push({ kind: 'send', send }) })
      session.onMessage((envelope) => { entries.push({ kind: 'message', envelope }) })
    },
  }
}

/**
 * Scrub and write one fixture.
 * @param scenario - the fixture's slug and filename (`<scenario>.json`).
 * @param description - a human-readable one-liner recorded into the file.
 * @param entries - the recorder's interleaved timeline, in real arrival order.
 * @param cwd - the recorder's own tmp cwd — scrubbed everywhere it appears,
 *   including inside tool output text.
 * @returns nothing.
 */
function writeFixture(
  scenario: string,
  description: string,
  entries: readonly FixtureEntry[],
  cwd: string,
): void {
  // A FRESH scrubber per fixture: token numbering restarts at each file, which
  // is what keeps every committed fixture independently diffable. Both the raw
  // cwd AND its realpath are scrubbed (macOS resolves tmp dirs through a
  // `/private` symlink, so the CLI reports the resolved form in some fields and
  // the raw form in others), plus the developer's home directory — Claude Code
  // derives a project-memory path from it (`system/init`'s `memory_paths`).
  const scrubber = createScrubber([
    { value: cwd, placeholder: '/scrubbed/cwd' },
    { value: realpathSync(cwd), placeholder: '/scrubbed/cwd' },
    { value: homedir(), placeholder: '/scrubbed/home' },
  ])
  const fixture: RecordedFixture = {
    scenario,
    description,
    model: LIVE_MODEL,
    entries: entries.map((entry): FixtureEntry => entry.kind === 'send'
      ? {
        kind: 'send',
        send: scrubber.scrub({
          uuid: entry.send.uuid,
          mode: entry.send.mode,
          content: entry.send.content,
          sentAt: entry.send.sentAt,
        }),
      }
      : {
        kind: 'message',
        envelope: scrubber.scrub({
          message: entry.envelope.message,
          meta: {
            interruptArtifact: entry.envelope.meta.interruptArtifact,
            interruptedTurn: entry.envelope.meta.interruptedTurn,
            reinit: entry.envelope.meta.reinit,
          },
        }),
      }),
  }
  writeFileSync(path.join(fixturesDir, `${scenario}.json`), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
}

describe.skipIf(!LIVE)('fixture recorder (DSH_CC_LIVE=1)', () => {
  it(
    'records scenario a: a plain two-sentence answer',
    async () => {
      const cwd = tmpCwd('fixture-plain-text')
      const mounted = await mountLive()
      const { service } = mounted
      const recorder = createRecorder()
      try {
        const snap = await service.open({ cwd })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')
        recorder.attach(session)

        session.send('Write exactly two short sentences about the ocean.')
        await session.waitForResult(LIVE_TIMEOUT_MS)

        writeFixture(
          'plain-text',
          'A plain two-sentence answer: no tool calls, possibly a thinking block.',
          recorder.entries, cwd)
      } finally {
        await disposeLive(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'records scenario b: one Bash tool call under a hardcoded canUseTool allow',
    async () => {
      const cwd = tmpCwd('fixture-tool-call')
      const mounted = await mountLive({}, { canUseTool: allowAll })
      const { service } = mounted
      const recorder = createRecorder()
      try {
        const snap = await service.open({ cwd })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')
        recorder.attach(session)

        session.send(
          'Use the Bash tool to run `echo fixture-hello` and then tell me exactly what it printed, '
          + 'in one short sentence.')
        await session.waitForResult(LIVE_TIMEOUT_MS)

        writeFixture(
          'tool-call',
          'One Bash tool_use + tool_result pair, in an isolated cwd, under a hardcoded canUseTool allow.',
          recorder.entries, cwd)
      } finally {
        await disposeLive(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'records scenario c: a steer mid-turn (interrupt artifact + refolded turn)',
    async () => {
      const cwd = tmpCwd('fixture-steer')
      const mounted = await mountLive()
      const { service } = mounted
      const recorder = createRecorder()
      try {
        const snap = await service.open({ cwd })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')
        recorder.attach(session)

        session.send('Count from 1 to 30, one number per line, then say DONE.')
        // Wait for partials to actually be flowing before steering, so the
        // steer really lands mid-turn (spike 2's scenario), matching
        // `tests/live/steer.live.spec.ts`.
        await onceMessage(session, envelope => envelope.message.type === 'stream_event', 60_000)

        session.send('Also say BANANA at the end.', { mode: 'steer' })
        // The refolded turn's result is the only one that resolves
        // `waitForResult` (the interrupt artifact does not) — by the time this
        // settles, every entry (both results included) is already on
        // `recorder.entries` (session.ts resolves waiters, then fans out,
        // synchronously inside the same `observe()` call).
        await session.waitForResult(LIVE_TIMEOUT_MS)

        writeFixture(
          'steer',
          'A steer mid-turn: the aborted turn\'s error_during_execution artifact (suppressed by the '
          + 'mirror), then the refolded turn\'s real result.',
          recorder.entries, cwd)
      } finally {
        await disposeLive(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
