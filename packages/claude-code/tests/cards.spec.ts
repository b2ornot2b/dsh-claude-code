import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { presentCcToolCall, presentCcToolResult } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

import type { RecordedFixture } from './fixtures/types.ts'

/**
 * Cards for Claude Code's own tools (spec §6).
 *
 * Two things are pinned here, and the second is the one that matters:
 *
 * 1. The exact card each recognized CC tool produces — `terminal` for `Bash`,
 *    `diff` for `Write`/`Edit`, `read` for a completed `Read`, and a
 *    category-hinted generic for everything else.
 * 2. **Totality.** Every presenter is called on a replay path, so a malformed,
 *    truncated or simply unfamiliar input must produce a card rather than
 *    throw — a throwing presenter takes out the transcript, not just the card
 *    (dsh soft-falls, but only after logging an error for every event).
 *
 * The last block replays REAL recorded traffic, so the argument shapes asserted
 * here are the CLI's, not a guess about them.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

describe('Bash → terminal', () => {
  it('titles the card with the command and carries the description above it', () => {
    expect(presentCcToolCall('Bash', {
      command: 'echo fixture-hello',
      description: 'Run echo command to print fixture-hello',
    })).toEqual({
      card: 'terminal',
      title: 'echo fixture-hello',
      description: 'Run echo command to print fixture-hello',
    })
  })

  it('collapses a multi-line command into the single line a card header is', () => {
    const view = presentCcToolCall('Bash', { command: 'set -e\nnpm run build\nnpm test' })
    expect(view).toEqual({ card: 'terminal', title: 'set -e npm run build npm test' })
  })

  it('elides a command too long for a header, rather than emitting it whole', () => {
    const view = presentCcToolCall('Bash', { command: `echo ${'x'.repeat(500)}` })
    expect(view.title).toHaveLength(120)
    expect(view.title.endsWith('…')).toBe(true)
  })

  it('keeps a backgrounded run generic: there is no output to fill a terminal with', () => {
    expect(presentCcToolCall('Bash', { command: 'sleep 100', run_in_background: true })).toEqual({
      card: 'generic',
      title: 'Bash: sleep 100',
      kind: 'execute',
      rawInput: 'sleep 100',
    })
  })

  it('carries the output but NEVER a fabricated exit code', () => {
    const view = presentCcToolResult('Bash', { command: 'echo hi' }, { text: 'hi\n', isError: false })
    // Claude Code's Bash result is text plus an `is_error` flag and nothing
    // else, so an exit pill would be an invention.
    expect(view).toEqual({ card: 'terminal', output: 'hi\n' })
    expect(view).not.toHaveProperty('exitCode')
  })

  it('renders a failed command as a plain result, not as a terminal success card', () => {
    expect(presentCcToolResult('Bash', { command: 'false' }, { text: 'boom', isError: true }))
      .toBeUndefined()
  })
})

describe('Write / Edit → diff', () => {
  it('gives a Write a null before-image, because a call-time presenter cannot read the file', () => {
    expect(presentCcToolCall('Write', { file_path: '/repo/src/a.ts', content: 'export const a = 1\n' }))
      .toEqual({
        card: 'diff',
        title: 'Write a.ts',
        diffs: [{ path: '/repo/src/a.ts', oldText: null, newText: 'export const a = 1\n' }],
        locations: [{ path: '/repo/src/a.ts' }],
      })
  })

  it('gives an Edit the before-image it actually has', () => {
    expect(presentCcToolCall('Edit', {
      file_path: '/repo/src/a.ts',
      old_string: 'const a = 1',
      new_string: 'const a = 2',
    })).toEqual({
      card: 'diff',
      title: 'Edit a.ts',
      diffs: [{ path: '/repo/src/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
      locations: [{ path: '/repo/src/a.ts' }],
    })
  })

  it('repeats the diff on the result, so raw result text does not replace the card', () => {
    expect(presentCcToolResult(
      'Edit',
      { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' },
      { text: 'The file /repo/a.ts has been updated.', isError: false },
    )).toEqual({ card: 'diff', diffs: [{ path: '/repo/a.ts', oldText: 'x', newText: 'y' }] })
  })

  it('falls back to generic when the arguments do not describe a file change', () => {
    // An `Edit` whose `new_string` never finished streaming.
    expect(presentCcToolCall('Edit', { file_path: '/repo/a.ts', old_string: 'x' }))
      .toEqual({ card: 'generic', title: 'Edit: /repo/a.ts', kind: 'edit', rawInput: '/repo/a.ts', locations: [{ path: '/repo/a.ts' }] })
  })

  it('accepts an empty Write, which is a real thing to do to a file', () => {
    const view = presentCcToolCall('Write', { file_path: '/repo/empty.txt', content: '' })
    expect(view).toMatchObject({ card: 'diff', diffs: [{ oldText: null, newText: '' }] })
  })
})

describe('Read', () => {
  it('stays a generic read card while pending, and follows along to the offset', () => {
    expect(presentCcToolCall('Read', { file_path: '/repo/a.ts', offset: 40 })).toEqual({
      card: 'generic',
      title: 'Read: /repo/a.ts',
      kind: 'read',
      rawInput: '/repo/a.ts',
      locations: [{ path: '/repo/a.ts', line: 40 }],
    })
  })

  it('recovers the numbered window from the result, keeping the file\'s own numbering', () => {
    expect(presentCcToolResult('Read', { file_path: '/repo/a.ts', offset: 3 }, {
      text: '     3\tconst a = 1\n     4\tconst b = 2\n',
      isError: false,
    })).toEqual({
      card: 'read',
      path: '/repo/a.ts',
      offset: 3,
      lines: [{ number: 3, text: 'const a = 1' }, { number: 4, text: 'const b = 2' }],
      totalLines: 2,
      lang: 'ts',
    })
  })

  it('omits the language hint for an extension it does not know', () => {
    const view = presentCcToolResult('Read', { file_path: '/repo/notes.zzz' }, {
      text: '     1\thello',
      isError: false,
    })
    expect(view).not.toHaveProperty('lang')
  })

  it('abandons the whole projection when ANY line is unnumbered', () => {
    // A partial parse would silently drop lines and show a file that is missing
    // content, with nothing saying so. The plain text card is the honest answer.
    expect(presentCcToolResult('Read', { file_path: '/repo/a.ts' }, {
      text: '     1\tconst a = 1\n<system-reminder>the file was truncated</system-reminder>',
      isError: false,
    })).toBeUndefined()
  })

  it('preserves a blank line inside the window rather than dropping it', () => {
    const view = presentCcToolResult('Read', { file_path: '/repo/a.ts' }, {
      text: '     1\ta\n     2\t\n     3\tb',
      isError: false,
    })
    expect(view).toMatchObject({ lines: [
      { number: 1, text: 'a' }, { number: 2, text: '' }, { number: 3, text: 'b' },
    ] })
  })
})

describe('everything else → generic, with a category hint', () => {
  it.each([
    ['Grep', { pattern: 'TODO' }, 'search', 'TODO'],
    ['Glob', { pattern: '**/*.ts' }, 'search', '**/*.ts'],
    ['WebFetch', { url: 'https://example.com' }, 'fetch', 'https://example.com'],
    ['WebSearch', { query: 'dsh harness' }, 'search', 'dsh harness'],
    ['TodoWrite', { todos: [] }, 'other', undefined],
    ['Task', { description: 'explore' }, 'other', undefined],
  ])('%s', (name, input, kind, salient) => {
    const view = presentCcToolCall(name, input)
    expect(view.card).toBe('generic')
    expect(view).toMatchObject({ kind })
    if (salient !== undefined) expect(view).toMatchObject({ title: `${name}: ${salient}`, rawInput: salient })
  })

  it('gives an unknown tool `other` rather than guessing from its name', () => {
    // An MCP tool. Prefix-guessing here would mislabel exactly the tools nobody
    // writing this has seen.
    const view = presentCcToolCall('mcp__github__create_issue', { title: 'bug' })
    expect(view).toEqual({
      card: 'generic',
      title: 'mcp__github__create_issue',
      kind: 'other',
      rawInput: { title: 'bug' },
    })
  })

  it('adds nothing to a result it has nothing to say about', () => {
    expect(presentCcToolResult('Grep', { pattern: 'x' }, { text: 'a.ts:1:x', isError: false }))
      .toBeUndefined()
  })
})

describe('totality: a presenter must never throw on a replay path', () => {
  const inputs: unknown[] = [
    undefined, null, 0, '', 'a string', [], [1, 2], true,
    {}, { command: 42 }, { command: '' }, { command: '   ' },
    { file_path: null }, { file_path: '/a', content: 7 },
    { file_path: '/a', old_string: 1, new_string: 2 },
    { offset: -1, file_path: '/a' }, { offset: 1.5, file_path: '/a' },
    { file_path: '/a', offset: Number.NaN },
    Object.create(null) as unknown,
  ]

  it.each(['Bash', 'Write', 'Edit', 'Read', 'Grep', 'Unknown'])('presentCcToolCall(%s, …)', (name) => {
    for (const input of inputs) {
      expect(() => presentCcToolCall(name, input)).not.toThrow()
      const view = presentCcToolCall(name, input)
      // Every card is renderable: a tagged card with a non-empty title.
      expect(['generic', 'terminal', 'diff']).toContain(view.card)
      expect(view.title.length).toBeGreaterThan(0)
    }
  })

  it.each(['Bash', 'Write', 'Edit', 'Read', 'Grep', 'Unknown'])('presentCcToolResult(%s, …)', (name) => {
    for (const input of inputs) {
      for (const outcome of [{ text: '', isError: false }, { text: 'x', isError: true }, { text: '\n\n', isError: false }]) {
        expect(() => presentCcToolResult(name, input, outcome)).not.toThrow()
      }
    }
  })

  it('is pure: the same inputs give a deeply equal card, and the input is not mutated', () => {
    const input = { command: 'ls -la', description: 'list' }
    const frozen = JSON.stringify(input)
    expect(presentCcToolCall('Bash', input)).toEqual(presentCcToolCall('Bash', input))
    expect(JSON.stringify(input)).toBe(frozen)
  })
})

describe('replayed against real recorded Claude Code traffic', () => {
  /**
   * Every `tool_use` block and its answering `tool_result`, from one fixture.
   * @param scenario - the fixture slug.
   * @returns the paired calls.
   */
  function pairs(scenario: string): Array<{
    name: string
    input: unknown
    outcome: { text: string, isError: boolean }
  }> {
    const raw = readFileSync(path.join(here, 'fixtures', `${scenario}.json`), 'utf8')
    const fixture = JSON.parse(raw) as RecordedFixture
    const calls = new Map<string, { name: string, input: unknown }>()
    const out: Array<{ name: string, input: unknown, outcome: { text: string, isError: boolean } }> = []
    for (const entry of fixture.entries) {
      if (entry.kind !== 'message') continue
      const message = entry.envelope.message as Record<string, unknown>
      const body = message['message'] as { content?: unknown } | undefined
      const content = body?.content
      if (!Array.isArray(content)) continue
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'tool_use' && typeof block['id'] === 'string') {
          calls.set(block['id'], { name: String(block['name']), input: block['input'] })
        }
        if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
          const call = calls.get(block['tool_use_id'])
          if (call === undefined) continue
          out.push({
            ...call,
            outcome: {
              text: typeof block['content'] === 'string' ? block['content'] : '',
              isError: block['is_error'] === true,
            },
          })
        }
      }
    }
    return out
  }

  it('produces the exact terminal card pair for the recorded Bash call', () => {
    const recorded = pairs('tool-call')
    expect(recorded).toHaveLength(1)
    const [call] = recorded
    if (call === undefined) throw new Error('the fixture recorded no tool call')
    expect(call.name).toBe('Bash')

    // Asserted against the RECORDED input, not against a transcribed literal:
    // `description` is prose the model writes, so it differs between sweeps of
    // the same scenario. The mapping is what this pins — the command becomes
    // the title, the model's description rides above the card — and pinning the
    // prose instead would make an honest re-record look like a regression.
    const input = call.input as { command: string, description: string }
    expect(presentCcToolCall(call.name, call.input)).toEqual({
      card: 'terminal',
      title: input.command,
      description: input.description,
    })
    expect(input.command).toBe('echo fixture-hello')
    expect(presentCcToolResult(call.name, call.input, call.outcome)).toEqual({
      card: 'terminal',
      output: 'fixture-hello',
    })
  })

  it.each(['plain-text', 'steer', 'tool-call'])('never throws over the whole %s fixture', (scenario) => {
    for (const { name, input, outcome } of pairs(scenario)) {
      expect(() => presentCcToolCall(name, input)).not.toThrow()
      expect(() => presentCcToolResult(name, input, outcome)).not.toThrow()
    }
  })
})
