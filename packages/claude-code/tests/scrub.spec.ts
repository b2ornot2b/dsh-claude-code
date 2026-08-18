import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createScrubber } from './fixtures/scrub.ts'

/**
 * The fixture scrubber.
 *
 * A scrubber has exactly two jobs and they pull against each other: erase every
 * value that changes between recordings, and erase NOTHING else. Getting the
 * second one wrong is worse than getting the first one wrong — a leaked token
 * shows up as a dirty diff, while an over-scrubbed one silently rewrites the
 * recorded protocol and every test built on it believes the rewrite.
 *
 * Both directions are pinned here, plus the property the whole scheme rests on:
 * **scrubbing is deterministic and idempotent**, so two sweeps of the same
 * session shape produce byte-identical fixtures and re-scrubbing a committed
 * fixture is a no-op.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

/** The committed fixtures, which must already be fully scrubbed. */
const FIXTURES = ['plain-text', 'steer', 'tool-call']

describe('what the scrubber erases', () => {
  it('replaces uuids, tool_use ids and provider message ids with stable placeholders', () => {
    const scrubbed = createScrubber().scrub({
      session_id: '5f2a1c88-9f21-4a0b-8c33-7b1d2e4f6a90',
      tool_use_id: 'toolu_01ABCDEFGHIJKLMNOPQRSTUV',
      message_id: 'msg_011Ce8gmjWZRoiEDtCGReRAp',
    })
    expect(scrubbed).toEqual({
      session_id: 'uuid-scrubbed-0001',
      tool_use_id: 'tool-scrubbed-0001',
      message_id: 'msg-scrubbed-0001',
    })
  })

  it('gives one original value ONE placeholder, everywhere it recurs', () => {
    const scrubber = createScrubber()
    const first = scrubber.scrub({ id: '5f2a1c88-9f21-4a0b-8c33-7b1d2e4f6a90' })
    const second = scrubber.scrub({ nested: { ref: 'see 5f2a1c88-9f21-4a0b-8c33-7b1d2e4f6a90 above' } })
    // Pairing relationships are the whole point: a `tool_result` must still
    // name the `tool_use` it answers.
    expect(second.nested.ref).toContain(first.id)
  })

  it('zeroes token counts and wall-clock timings', () => {
    expect(createScrubber().scrub({ usage: { input_tokens: 4231, output_tokens: 17 }, duration_ms: 8123 }))
      .toEqual({ usage: { input_tokens: 0, output_tokens: 0 }, duration_ms: 0 })
  })

  it('replaces the subprocess PID in the messaging socket path', () => {
    expect(createScrubber().scrub({ messaging_socket_path: '/tmp/cc-socks/48213.sock' }))
      .toEqual({ messaging_socket_path: '/tmp/cc-socks/scrubbed.sock' })
  })

  it('replaces the machine-derived project-memory slug', () => {
    expect(createScrubber().scrub({ auto: '/home/me/.claude/projects/-private-var-folders-xy/memory/' }))
      .toEqual({ auto: '/home/me/.claude/projects/scrubbed-project-slug/memory/' })
  })

  it('replaces the recorder\'s own machine-local command/skill/plugin lists', () => {
    // These describe the machine the sweep ran on, change whenever anyone
    // installs a plugin, and carry a developer's personal configuration into a
    // checked-in file.
    expect(createScrubber().scrub({
      slash_commands: ['deep-research', 'my-private-workflow'],
      skills: ['dataviz'],
      agents: ['claude', 'Explore'],
      plugins: [],
    })).toEqual({
      slash_commands: ['scrubbed-machine-local-list'],
      skills: ['scrubbed-machine-local-list'],
      agents: ['scrubbed-machine-local-list'],
      plugins: ['scrubbed-machine-local-list'],
    })
  })

  it('replaces a configured literal everywhere, longest first', () => {
    const scrubber = createScrubber([
      { value: '/private/var/folders/t/session', placeholder: '/scrubbed/cwd' },
      { value: '/var/folders/t/session', placeholder: '/scrubbed/cwd' },
    ])
    // The short literal is a SUBSTRING of the long one; replacing it first
    // would strand a `/private` prefix forever.
    expect(scrubber.scrub({ cwd: '/private/var/folders/t/session/pkg' }))
      .toEqual({ cwd: '/scrubbed/cwd/pkg' })
  })
})

describe('what the scrubber must NOT erase', () => {
  it('leaves the capability names alone, msg_lifecycle_v1 included', () => {
    // The regression this test exists for: a permissive `msg_[A-Za-z0-9_-]+`
    // pattern matched `msg_lifecycle_v1` and rewrote it to `msg-scrubbed-0001`
    // in every committed fixture — a scrubber corrupting the deterministic
    // capability list this seam feature-detects on.
    expect(createScrubber().scrub({
      capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'],
    })).toEqual({
      capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'],
    })
  })

  it('leaves the model, the permission mode and the CLI version alone', () => {
    const init = {
      model: 'claude-haiku-4-5-20251001',
      permissionMode: 'default',
      claude_code_version: '2.1.233',
      apiKeySource: 'none',
    }
    expect(createScrubber().scrub(init)).toEqual(init)
  })

  it('leaves the tool list alone — the one list a fixture could be read against', () => {
    const tools = { tools: ['Bash', 'Read', 'Write', 'Edit'] }
    expect(createScrubber().scrub(tools)).toEqual(tools)
  })

  it('leaves ordinary prose containing short msg_ or toolu_ words alone', () => {
    const text = { result: 'see msg_v1 and toolu_x for details' }
    expect(createScrubber().scrub(text)).toEqual(text)
  })

  it('does not mutate its input', () => {
    const input = { session_id: '5f2a1c88-9f21-4a0b-8c33-7b1d2e4f6a90', nested: { n: 1 } }
    const before = JSON.stringify(input)
    createScrubber().scrub(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('determinism: two sweeps of one shape must be byte-identical', () => {
  it('gives two fresh scrubbers the same output for the same input', () => {
    const input = {
      a: '5f2a1c88-9f21-4a0b-8c33-7b1d2e4f6a90',
      b: 'msg_011Ce8gmjWZRoiEDtCGReRAp',
      c: ['toolu_01ABCDEFGHIJKLMNOPQRSTUV', { d: 'msg_011Ce8gmyKWw2FRDV5zsmVsP' }],
    }
    expect(JSON.stringify(createScrubber().scrub(input)))
      .toBe(JSON.stringify(createScrubber().scrub(input)))
  })

  it('numbers placeholders per fixture, not per process', () => {
    // Two fixtures recorded in one sweep must not share a token table, or the
    // second one's ids would start at whatever number the first stopped at.
    const first = createScrubber().scrub({ id: '11111111-1111-4111-8111-111111111111' })
    const second = createScrubber().scrub({ id: '22222222-2222-4222-8222-222222222222' })
    expect(first.id).toBe('uuid-scrubbed-0001')
    expect(second.id).toBe('uuid-scrubbed-0001')
  })

  it.each(FIXTURES)('re-scrubbing the committed %s fixture changes nothing', (scenario) => {
    // The idempotence that makes a re-record reviewable: if a sweep produces
    // the same session shape, the diff is empty. A fixture that changed here
    // would mean the committed file still holds something unscrubbed.
    const raw = readFileSync(path.join(here, 'fixtures', `${scenario}.json`), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    expect(createScrubber().scrub(parsed)).toEqual(parsed)
  })
})
