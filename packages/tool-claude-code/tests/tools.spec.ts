import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { ClaudeCodeService } from '@deepseek-ai/dsh-claude-code'
import * as ToolClaudeCode from '@deepseek-ai/dsh-tool-claude-code'

const TOOL_NAMES = [
  'claude_code_open',
  'claude_code_send',
  'claude_code_wait',
  'claude_code_status',
  'claude_code_cancel',
  'claude_code_close',
]

/** Mount the tool plugin over a bare Context plus its required services. */
async function mount() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ClaudeCodeService)
  const fiber = await ctx.plugin(ToolClaudeCode)
  return { ctx, fiber }
}

let callCounter = 0
function callTool(ctx: Context, name: string, args: unknown) {
  const signal = new AbortController().signal
  return ctx.tools.execute({ signal, callId: CallId(`call-${++callCounter}`), name, arguments: args })
}

describe('package entry shape', () => {
  it('has no default export', async () => {
    const mod = await import('@deepseek-ai/dsh-tool-claude-code')
    expect('default' in mod).toBe(false)
  })

  it('exports exactly name, inject, Config, apply', async () => {
    const mod = await import('@deepseek-ai/dsh-tool-claude-code')
    expect(Object.keys(mod).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
  })
})

describe('tool-claude-code registration', () => {
  it('mounts alongside a ToolRuntime and the seam service', async () => {
    const { ctx, fiber } = await mount()
    try {
      expect(ctx.get('claudeCode')).toBeDefined()
      for (const toolName of TOOL_NAMES) {
        const definition = ctx.tools.get(toolName)
        expect(definition, `${toolName} should be registered`).toBeDefined()
      }
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('registers every tool with a complete, schema-valid output declaration', async () => {
    const { ctx, fiber } = await mount()
    try {
      for (const toolName of TOOL_NAMES) {
        const definition = ctx.tools.get(toolName)
        expect(definition?.description.length ?? 0).toBeGreaterThan(0)
        expect(definition?.output).toBeDefined()
        expect(typeof definition?.output.render).toBe('function')
        expect(definition?.output.schema).toBeDefined()
      }
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('HMR-disposes cleanly: ctx.tools no longer resolves the tools after teardown', async () => {
    const { ctx, fiber } = await mount()
    await fiber.dispose()
    for (const toolName of TOOL_NAMES) {
      expect(ctx.tools.get(toolName)).toBeUndefined()
    }
    await ctx.fiber.dispose()
  })
})

describe('tool-claude-code execution: NOT_IMPLEMENTED stubs', () => {
  it('claude_code_open surfaces NOT_IMPLEMENTED as a tool error, not a crash', async () => {
    const { ctx, fiber } = await mount()
    try {
      const result = await callTool(ctx, 'claude_code_open', { cwd: '/tmp/example' })
      expect(result.isError).toBe(true)
      expect(result.error?.info?.code).toBe('NOT_IMPLEMENTED')
      expect(result.error?.info?.name).toBe('ClaudeCodeError')
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('every other tool also surfaces NOT_IMPLEMENTED cleanly', async () => {
    const { ctx, fiber } = await mount()
    try {
      const calls: Array<[string, unknown]> = [
        ['claude_code_send', { session_id: 'x', message: 'hi', mode: 'followup' }],
        ['claude_code_wait', { session_id: 'x' }],
        ['claude_code_status', { session_id: 'x' }],
        ['claude_code_cancel', { session_id: 'x' }],
        ['claude_code_close', { session_id: 'x' }],
      ]
      for (const [toolName, args] of calls) {
        const result = await callTool(ctx, toolName, args)
        expect(result.isError, `${toolName} should fail`).toBe(true)
        expect(result.error?.info?.code, `${toolName} error code`).toBe('NOT_IMPLEMENTED')
      }
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects invalid arguments before reaching the NOT_IMPLEMENTED body', async () => {
    const { ctx, fiber } = await mount()
    try {
      const result = await callTool(ctx, 'claude_code_open', {})
      expect(result.isError).toBe(true)
      expect(result.error?.info?.code).not.toBe('NOT_IMPLEMENTED')
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})
