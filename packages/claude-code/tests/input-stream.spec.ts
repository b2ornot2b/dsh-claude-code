import { createInputStream, isCcSessionId } from '@deepseek-ai/dsh-claude-code'
import type { CcSdkUserMessage } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

/**
 * The input stream is the session's lifeline: if it completes, the SDK closes
 * the subprocess's stdin and every in-flight permission callback becomes
 * undeliverable. These tests pin the three properties that guarantee it —
 * it never completes on its own, it stamps every message, and `end()` is a
 * one-way door.
 */

/**
 * Read the next message, failing rather than hanging when none arrives.
 * @param iterator - the stream's iterator.
 * @param timeoutMs - how long to wait.
 * @returns the message, or the string `'timeout'`.
 */
async function next(
  iterator: AsyncIterator<CcSdkUserMessage>,
  timeoutMs = 50,
): Promise<CcSdkUserMessage | 'timeout'> {
  return await Promise.race([
    iterator.next().then(result => (result.done === true ? 'timeout' as const : result.value)),
    new Promise<'timeout'>(resolve => { setTimeout(() => { resolve('timeout') }, timeoutMs) }),
  ])
}

describe('createInputStream: stamping', () => {
  it('stamps a fresh uuid on every message and returns it', async () => {
    const stream = createInputStream()
    const first = stream.push({ content: 'one' })
    const second = stream.push({ content: 'two' })

    expect(first).not.toBe(second)
    expect(isCcSessionId(first)).toBe(true)
    expect(isCcSessionId(second)).toBe(true)

    const iterator = stream[Symbol.asyncIterator]()
    const message = await next(iterator)
    expect(message).not.toBe('timeout')
    expect((message as CcSdkUserMessage).uuid).toBe(first)
    stream.end()
  })

  it('honors a caller-supplied uuid instead of minting one', async () => {
    const stream = createInputStream()
    const supplied = '11111111-2222-4333-8444-555555555555' as const
    expect(stream.push({ content: 'replay', uuid: supplied })).toBe(supplied)
    stream.end()
  })

  it('builds a complete, well-formed SDK user message', async () => {
    const stream = createInputStream()
    stream.push({ content: 'hello', sessionId: 'session-1', priority: 'now', shouldQuery: false })
    const iterator = stream[Symbol.asyncIterator]()
    const message = await next(iterator) as CcSdkUserMessage

    expect(message.type).toBe('user')
    expect(message.message).toEqual({ role: 'user', content: 'hello' })
    expect(message.parent_tool_use_id).toBeNull()
    expect(message.session_id).toBe('session-1')
    expect(message.priority).toBe('now')
    expect(message.shouldQuery).toBe(false)
    stream.end()
  })

  it('omits priority and shouldQuery entirely when unset (a plain followup)', async () => {
    const stream = createInputStream()
    stream.push({ content: 'plain' })
    const iterator = stream[Symbol.asyncIterator]()
    const message = await next(iterator) as CcSdkUserMessage

    expect('priority' in message).toBe(false)
    expect('shouldQuery' in message).toBe(false)
    stream.end()
  })
})

describe('createInputStream: never completes while the session lives', () => {
  it('parks instead of finishing when the queue drains', async () => {
    const stream = createInputStream()
    stream.push({ content: 'first' })
    const iterator = stream[Symbol.asyncIterator]()

    expect(await next(iterator)).not.toBe('timeout')

    // The SDK is now parked on us. It must STAY parked — a completed iterator
    // closes the subprocess's stdin and kills the permission channel.
    let settled = false
    const parked = iterator.next().then(result => {
      settled = true
      return result
    })
    await new Promise<void>(resolve => { setTimeout(resolve, 25) })
    expect(settled).toBe(false)

    stream.push({ content: 'later' })
    const resumed = await parked
    expect(resumed.done ?? false).toBe(false)
    expect((resumed.value as CcSdkUserMessage).message.content).toBe('later')
    stream.end()
  })

  it('yields messages exactly once, in push order', async () => {
    const stream = createInputStream()
    stream.push({ content: 'a' })
    stream.push({ content: 'b' })
    stream.push({ content: 'c' })
    stream.end()

    const seen: string[] = []
    for await (const message of stream) seen.push(message.message.content)
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('reports how many messages are waiting for the SDK', () => {
    const stream = createInputStream()
    expect(stream.pending).toBe(0)
    stream.push({ content: 'queued' })
    expect(stream.pending).toBe(1)
    stream.end()
  })
})

describe('createInputStream: end() is a one-way door', () => {
  it('is idempotent', () => {
    const stream = createInputStream()
    stream.end()
    stream.end()
    expect(stream.ended).toBe(true)
  })

  it('refuses a push after end with a typed SESSION_CLOSED error', () => {
    const stream = createInputStream()
    stream.end()
    expect(() => stream.push({ content: 'too late' }))
      .toThrowError(expect.objectContaining({ name: 'ClaudeCodeError', code: 'SESSION_CLOSED' }))
  })

  it('completes the iterator once ended, after draining what was queued', async () => {
    const stream = createInputStream()
    const iterator = stream[Symbol.asyncIterator]()
    stream.push({ content: 'last' })
    stream.end()

    expect(await next(iterator)).not.toBe('timeout')
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })
})
