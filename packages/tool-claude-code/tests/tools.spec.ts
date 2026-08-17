/**
 * Phase 5: the six tool bodies, driven through the REAL tool runtime against
 * the REAL seam on a fake SDK backend. Nothing here spawns a subprocess.
 *
 * Every assertion that reads `result.value` is also a schema round trip: the
 * runtime validates each canonical value against the tool's `output.schema`
 * before it hands it back, so a value that reaches an assertion has already
 * proven the schema accepts it (and, thanks to `additionalProperties: false`,
 * that the body invented no fields).
 */

import { describe, expect, it } from 'vitest'

import { CWD, fakeAgent, firstQuery, mountTools, settle, TOOL_NAMES, waitFor } from './harness.ts'
import { resolveAskTarget } from '../src/open.ts'
import { projectContextUsage, projectResult } from '../src/result.ts'

describe('package entry shape', () => {
  it('has no default export', async () => {
    const mod = await import('@deepseek-ai/dsh-tool-claude-code')
    expect('default' in mod).toBe(false)
  })

  it('exports exactly the plugin namespace plus the tool-layer constants', async () => {
    const mod = await import('@deepseek-ai/dsh-tool-claude-code')
    expect(Object.keys(mod).sort()).toEqual([
      'Config', 'MAX_WAIT_TIMEOUT_MS', 'SYNC_OPEN_TIMEOUT_MS', 'apply', 'inject', 'name',
    ])
  })
})

describe('tool-claude-code registration', () => {
  it('mounts alongside a ToolRuntime and the seam service', async () => {
    const harness = await mountTools()
    try {
      expect(harness.ctx.get('claudeCode')).toBeDefined()
      for (const toolName of TOOL_NAMES) {
        expect(harness.ctx.tools.get(toolName), `${toolName} should be registered`).toBeDefined()
      }
    } finally {
      await harness.dispose()
    }
  })

  it('registers every tool with a complete output declaration', async () => {
    const harness = await mountTools()
    try {
      for (const toolName of TOOL_NAMES) {
        const definition = harness.ctx.tools.get(toolName)
        expect(definition?.description.length ?? 0).toBeGreaterThan(0)
        expect(typeof definition?.output.render).toBe('function')
        expect(definition?.output.schema).toBeDefined()
      }
    } finally {
      await harness.dispose()
    }
  })

  it('rejects invalid arguments before the body runs', async () => {
    const harness = await mountTools()
    try {
      const result = await harness.call('claude_code_open', {})
      expect(result.isError).toBe(true)
      expect(harness.fake.queries).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })
})

describe('claude_code_open (synchronous)', () => {
  it('opens, sends the prompt, waits for the turn and returns its result', async () => {
    const harness = await mountTools()
    try {
      const pending = harness.call('claude_code_open', { cwd: CWD, prompt: 'summarize this repo' })
      const query = await firstQuery(harness)
      await query.emitResult('success', {
        result: 'two sentences about the ocean',
        usage: { input_tokens: 120, output_tokens: 34 },
        total_cost_usd: 0.0123,
      })

      const result = await pending
      expect(result.isError, JSON.stringify(result.error)).toBe(false)
      expect(result.value).toEqual({
        kind: 'session',
        session_id: expect.any(String),
        status: 'idle',
        result: 'two sentences about the ocean',
        usage: { input_tokens: 120, output_tokens: 34 },
        cost_usd: 0.0123,
      })
      // The prompt reached the subprocess uuid-stamped, exactly once.
      expect(query.sent.map(message => message.message.content)).toEqual(['summarize this repo'])
      expect(query.sent[0]?.uuid).toBeTypeOf('string')

      // The session STAYS OPEN for follow-ups; only close ends it.
      const sessionId = (result.value as { session_id: string }).session_id
      expect(harness.ctx.claudeCode.get(sessionId as never)?.status).toBe('idle')

      // …and the model sees the answer, not a bare status line.
      expect(result.content[0]).toMatchObject({ type: 'text' })
      expect(String((result.content[0] as { text: string }).text))
        .toContain('two sentences about the ocean')
    } finally {
      await harness.dispose()
    }
  })

  it('returns immediately for an idle open, with no result fields', async () => {
    const harness = await mountTools()
    try {
      const result = await harness.call('claude_code_open', { cwd: CWD })
      expect(result.isError, JSON.stringify(result.error)).toBe(false)
      expect(result.value).toEqual({
        kind: 'session',
        session_id: expect.any(String),
        status: 'idle',
      })
      const query = await firstQuery(harness)
      expect(query.sent).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('mirrors the session into a dsh session log sharing its id, framed from the first prompt', async () => {
    const harness = await mountTools()
    try {
      const pending = harness.call('claude_code_open', { cwd: CWD, prompt: 'hello' })
      const query = await firstQuery(harness)
      await query.emitResult('success', { result: 'hi' })
      const result = await pending
      const sessionId = (result.value as { session_id: string }).session_id

      const log = harness.ctx.get('sessions')?.get(sessionId as never)
      expect(log, 'a dsh session should exist under the SAME id').toBeDefined()
      // Proof the mirror was attached BEFORE the prompt was sent: a mirror
      // attached afterwards misses the turn that prompt opens.
      expect(log?.events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    } finally {
      await harness.dispose()
    }
  })

  it('opens unmirrored when the composition has no session store', async () => {
    const harness = await mountTools({ sessions: false })
    try {
      expect(harness.ctx.get('sessions')).toBeUndefined()
      const pending = harness.call('claude_code_open', { cwd: CWD, prompt: 'hello' })
      const query = await firstQuery(harness)
      await query.emitResult('success', { result: 'hi' })
      const result = await pending
      expect(result.isError, JSON.stringify(result.error)).toBe(false)
      expect(result.value).toMatchObject({ kind: 'session', result: 'hi' })
    } finally {
      await harness.dispose()
    }
  })

  it('surfaces a seam refusal with the seam\'s own code, unwrapped', async () => {
    const harness = await mountTools()
    try {
      const result = await harness.call('claude_code_open', { cwd: 'relative/not-allowed' })
      expect(result.isError).toBe(true)
      expect(result.error?.info?.code).toBe('INVALID_CWD')
      expect(result.error?.info?.name).toBe('ClaudeCodeError')
    } finally {
      await harness.dispose()
    }
  })
})

describe('claude_code_send / wait / status / cancel / close', () => {
  it('sends a followup and reports the post-send status', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)

      const sent = await harness.call('claude_code_send', {
        session_id: sessionId, message: 'go on', mode: 'followup',
      })
      expect(sent.isError, JSON.stringify(sent.error)).toBe(false)
      expect(sent.value).toEqual({ status: 'running' })
      await settle()
      expect(query.sent.map(message => message.message.content)).toEqual(['go on'])
      expect(query.sent[0]?.priority).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  it('steers with priority "now"', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)
      await harness.call('claude_code_send', {
        session_id: sessionId, message: 'actually, stop', mode: 'steer',
      })
      await settle()
      expect(query.sent[0]?.priority).toBe('now')
    } finally {
      await harness.dispose()
    }
  })

  it('waits for the current turn and projects result, usage and cost', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)
      await harness.call('claude_code_send', {
        session_id: sessionId, message: 'go', mode: 'followup',
      })

      const pending = harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: 5000 })
      await query.emitResult('success', {
        result: 'all done',
        usage: { input_tokens: 7, output_tokens: 3 },
        total_cost_usd: 0.5,
      })
      const waited = await pending
      expect(waited.isError, JSON.stringify(waited.error)).toBe(false)
      expect(waited.value).toEqual({
        status: 'idle',
        result: 'all done',
        usage: { input_tokens: 7, output_tokens: 3 },
        cost_usd: 0.5,
      })
    } finally {
      await harness.dispose()
    }
  })

  it('reports a wait that elapsed as CC_TIMEOUT naming the still-open session', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      await harness.call('claude_code_send', {
        session_id: sessionId, message: 'go', mode: 'followup',
      })

      const result = await harness.call('claude_code_wait', { session_id: sessionId, timeout_ms: 5 })
      expect(result.isError).toBe(true)
      expect(result.error?.info?.code).toBe('CC_TIMEOUT')
      expect(String(result.error?.message)).toContain(sessionId)
      // The session is untouched: still open, still running.
      expect(harness.ctx.claudeCode.get(sessionId as never)?.status).toBe('running')
    } finally {
      await harness.dispose()
    }
  })

  it('reports status with pending asks and context usage derived from the last turn', async () => {
    const harness = await mountTools()
    try {
      const pending = harness.call('claude_code_open', { cwd: CWD, prompt: 'hi' })
      const query = await firstQuery(harness)
      await query.emitResult('success', {
        result: 'hi back',
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 0,
          output_tokens: 10,
        },
        modelUsage: { 'claude-haiku-4-5': { contextWindow: 200_000 } },
      })
      const opened = await pending
      const sessionId = (opened.value as { session_id: string }).session_id

      const status = await harness.call('claude_code_status', { session_id: sessionId })
      expect(status.isError, JSON.stringify(status.error)).toBe(false)
      expect(status.value).toEqual({
        status: 'idle',
        pending_asks: 0,
        context_usage: { used_tokens: 160, max_tokens: 200_000 },
      })
    } finally {
      await harness.dispose()
    }
  })

  it('omits context_usage entirely when no turn has reported usage', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const status = await harness.call('claude_code_status', { session_id: sessionId })
      expect(status.value).toEqual({ status: 'idle', pending_asks: 0 })
    } finally {
      await harness.dispose()
    }
  })

  it('cancels, keeping queued sends by default, and reports the receipt survivors', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)
      for (const message of ['first', 'second']) {
        await harness.call('claude_code_send', { session_id: sessionId, message, mode: 'followup' })
      }
      const session = harness.ctx.claudeCode.session(sessionId as never)
      const queued = session?.outbox()[1]?.uuid
      expect(queued).toBeTypeOf('string')
      query.receipts.push({ still_queued: [String(queued)] })

      const cancelled = await harness.call('claude_code_cancel', { session_id: sessionId })
      expect(cancelled.isError, JSON.stringify(cancelled.error)).toBe(false)
      expect(cancelled.value).toEqual({ still_queued: [queued] })
      // Default `keep_queued` is true: exactly ONE interrupt, no drain loop.
      expect(query.interruptCount).toBe(1)
    } finally {
      await harness.dispose()
    }
  })

  it('drains queued sends when keep_queued is false', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)
      await harness.call('claude_code_send', { session_id: sessionId, message: 'one', mode: 'followup' })
      await harness.call('claude_code_send', { session_id: sessionId, message: 'two', mode: 'followup' })
      const session = harness.ctx.claudeCode.session(sessionId as never)
      const queued = String(session?.outbox()[1]?.uuid)
      query.receipts.push({ still_queued: [queued] }, { still_queued: [] })

      const cancelled = await harness.call('claude_code_cancel', {
        session_id: sessionId, keep_queued: false,
      })
      expect(cancelled.value).toEqual({ still_queued: [] })
      expect(query.interruptCount).toBeGreaterThan(1)
    } finally {
      await harness.dispose()
    }
  })

  it('closes a session and stays idempotent for an id it no longer knows', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)

      const closed = await harness.call('claude_code_close', { session_id: sessionId })
      expect(closed.isError, JSON.stringify(closed.error)).toBe(false)
      expect(closed.value).toEqual({ closed: true })
      expect(query.closed).toBe(true)
      expect(harness.ctx.claudeCode.get(sessionId as never)).toBeUndefined()

      const again = await harness.call('claude_code_close', { session_id: sessionId })
      expect(again.value).toEqual({ closed: true })
      const unknown = await harness.call('claude_code_close', { session_id: 'never-existed' })
      expect(unknown.value).toEqual({ closed: true })
    } finally {
      await harness.dispose()
    }
  })

  it('answers CC_NO_SESSION for every tool that needs a live session', async () => {
    const harness = await mountTools()
    try {
      const calls: Array<[string, Record<string, unknown>]> = [
        ['claude_code_send', { session_id: 'missing', message: 'hi', mode: 'followup' }],
        ['claude_code_wait', { session_id: 'missing' }],
        ['claude_code_status', { session_id: 'missing' }],
        ['claude_code_cancel', { session_id: 'missing' }],
      ]
      for (const [toolName, args] of calls) {
        const result = await harness.call(toolName, args)
        expect(result.isError, `${toolName} should fail`).toBe(true)
        expect(result.error?.info?.code, `${toolName} code`).toBe('CC_NO_SESSION')
        expect(result.error?.info?.name, `${toolName} name`).toBe('ClaudeCodeToolError')
      }
    } finally {
      await harness.dispose()
    }
  })

  it('HMR-disposes cleanly: the tools are gone and no session survives', async () => {
    const harness = await mountTools()
    const opened = await harness.call('claude_code_open', { cwd: CWD })
    const sessionId = (opened.value as { session_id: string }).session_id
    const query = await firstQuery(harness)
    await harness.dispose()
    expect(query.closed).toBe(true)
    expect(harness.ctx.get('claudeCode')).toBeUndefined()
    expect(sessionId).toBeTypeOf('string')
  })
})

describe('ask target resolution (§4.5)', () => {
  it('is absent for a headless tool call, so the seam fails closed', async () => {
    const harness = await mountTools()
    try {
      expect(resolveAskTarget(harness.ctx, {})).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  it('names the calling agent and marks it delegated when it is not a root', async () => {
    const harness = await mountTools()
    try {
      const agent = fakeAgent('subagent-7')
      const target = resolveAskTarget(harness.ctx, { agent })
      expect(target?.agent).toBe(agent)
      // No `ctx.agents` here: nothing can prove a human is attached, so the
      // honest answer is `delegated` (it only selects the shorter timeout).
      expect(target?.delegated).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})

describe('result projections', () => {
  it('is empty for an interrupted turn that carried no text', () => {
    const envelope = {
      message: { type: 'result', subtype: 'error_during_execution', result: '' },
      meta: {
        sessionId: 'x' as never,
        receivedAt: 0,
        interruptArtifact: false,
        interruptedTurn: true,
        reinit: false,
      },
    }
    expect(projectResult(envelope)).toEqual({})
    expect(projectContextUsage(envelope)).toBeUndefined()
    expect(projectResult(undefined)).toEqual({})
  })

  it('ignores a zero context window and keeps the largest reported one', () => {
    const envelope = {
      message: {
        type: 'result',
        usage: { input_tokens: 10, output_tokens: 1 },
        modelUsage: { a: { contextWindow: 0 }, b: { contextWindow: 200_000 } },
      },
      meta: {
        sessionId: 'x' as never,
        receivedAt: 0,
        interruptArtifact: false,
        interruptedTurn: false,
        reinit: false,
      },
    }
    expect(projectContextUsage(envelope)).toEqual({ used_tokens: 11, max_tokens: 200_000 })
  })
})

describe('a session outlives the tool call that opened it', () => {
  it('keeps running after claude_code_open returns, and accepts follow-ups', async () => {
    const harness = await mountTools()
    try {
      const pending = harness.call('claude_code_open', { cwd: CWD, prompt: 'step one' })
      const query = await firstQuery(harness)
      await query.emitResult('success', { result: 'one done' })
      const opened = await pending
      const sessionId = (opened.value as { session_id: string }).session_id

      await harness.call('claude_code_send', {
        session_id: sessionId, message: 'step two', mode: 'followup',
      })
      const waiting = harness.call('claude_code_wait', { session_id: sessionId })
      await waitFor(() => query.sent.length === 2, 'the follow-up to reach the subprocess')
      await query.emitResult('success', { result: 'two done' })
      const waited = await waiting
      expect(waited.value).toMatchObject({ result: 'two done', status: 'idle' })
    } finally {
      await harness.dispose()
    }
  })
})
