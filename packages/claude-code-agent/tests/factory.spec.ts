import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { createClaudeCodeAgent } from '@deepseek-ai/dsh-claude-code-agent'

describe('createClaudeCodeAgent (Phase 1 stub)', () => {
  it('rejects with a ClaudeCodeError code NOT_IMPLEMENTED naming Phase 6', async () => {
    const ctx = new Context()
    await expect(createClaudeCodeAgent(ctx, { cwd: '/tmp/example' })).rejects.toMatchObject({
      name: 'ClaudeCodeError',
      code: 'NOT_IMPLEMENTED',
    })
    await ctx.fiber.dispose()
  })

  it('names Phase 6 and the requested cwd in its message, without leaking the SDK', async () => {
    const ctx = new Context()
    try {
      await createClaudeCodeAgent(ctx, { cwd: '/workspace/repo' })
      throw new Error('expected createClaudeCodeAgent to reject')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('Phase 6')
      expect(message).toContain('/workspace/repo')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
