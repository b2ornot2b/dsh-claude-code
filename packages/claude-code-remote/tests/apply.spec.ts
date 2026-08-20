import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { apply } from '../src/index.ts'
import type { CcDiscoverySource } from '@deepseek-ai/dsh-claude-code'

/**
 * `apply()`'s per-host resilience.
 *
 * The rest of this package treats one bad host as a warning, never a crash
 * for the others (`discover()` never rejects; a failed run degrades to a
 * named warning). `apply()` must hold to the same rule at MOUNT time: a host
 * with no usable argv (no `argv` of its own, and no `config.probe` to build
 * one from) must not take every other configured host down with it.
 */

/**
 * Provide a bare stub for the `claudeCode` service this plugin injects,
 * recording every source registered against it — same technique as
 * `claude-code-agent/tests/plugin.spec.ts`'s `stubServices`.
 * @param ctx - the context to provide the stub on.
 * @returns the sources registered, in registration order.
 */
function stubClaudeCode(ctx: Context): CcDiscoverySource[] {
  const registered: CcDiscoverySource[] = []
  ctx.reflect.provide('claudeCode', {
    registerDiscoverySource: (source: CcDiscoverySource) => {
      registered.push(source)
      return () => {}
    },
  } as never)
  return registered
}

describe('apply: per-host resilience', () => {
  it('registers every well-configured host even when one host cannot be turned into an argv', () => {
    const ctx = new Context()
    const registered = stubClaudeCode(ctx)

    apply(ctx, {
      hosts: [
        { label: 'good-a', argv: ['echo', 'a'] },
        // No argv of its own, and no config.probe: this host cannot be built
        // into a runnable command at all.
        { label: 'bad' },
        { label: 'good-b', argv: ['echo', 'b'] },
      ],
    })

    expect(registered.map(source => source.host)).toEqual(['good-a', 'good-b'])

    // Read the built-in logger's buffering exporter rather than spying on
    // `ctx.logger` directly: cordis 4 hands out a fresh traceable proxy per
    // access, so a spy attached to one access would never see a call made
    // through a different later access (never identity-compare cordis
    // services/contexts). `.info`, not `.warn`: cordis's default exporter
    // threshold silently drops `warn`-level messages (LoggerLevel.WARN sits
    // ABOVE the default LoggerLevel.INFO threshold) — verified empirically,
    // see the `apply()` doc comment.
    const skipMessages = ctx.logger.buffer.filter(message => message.type === 'info')
    expect(skipMessages.some(message => message.args.some(
      arg => typeof arg === 'string' && arg.includes('bad'),
    ))).toBe(true)
  })
})
