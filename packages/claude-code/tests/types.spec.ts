import {
  ASK_FALLBACKS, CC_AUTH_MODES, CC_PERMISSION_MODES, CC_SESSION_STATUSES, CC_SETTING_SOURCES,
  ClaudeCodeError, isCcSessionId, newCcSessionId,
} from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

describe('session identity', () => {
  it('mints a bare UUID, because the SDK requires one and dsh ids are not UUIDs by default', () => {
    const id = newCcSessionId()
    expect(isCcSessionId(id)).toBe(true)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('mints a distinct id every call', () => {
    expect(newCcSessionId()).not.toBe(newCcSessionId())
  })

  it('rejects the dsh session-id shapes that are NOT valid for the SDK', () => {
    // The store's default mint, the agent-loop mint, and the apiproxy mint.
    expect(isCcSessionId('session-1')).toBe(false)
    expect(isCcSessionId(`agent-session-${newCcSessionId()}`)).toBe(false)
    expect(isCcSessionId(`session-${newCcSessionId()}`)).toBe(false)
    expect(isCcSessionId('')).toBe(false)
  })
})

describe('closed vocabularies', () => {
  it('pins the six verified permission modes', () => {
    expect(CC_PERMISSION_MODES).toEqual([
      'default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto',
    ])
  })

  it('pins the remaining unions', () => {
    expect(CC_SETTING_SOURCES).toEqual(['user', 'project', 'local'])
    expect(CC_AUTH_MODES).toEqual(['subscription', 'api-key'])
    expect(ASK_FALLBACKS).toEqual(['deny', 'first-option', 'error'])
    expect(CC_SESSION_STATUSES).toEqual(['starting', 'running', 'idle', 'closed'])
  })
})

describe('ClaudeCodeError', () => {
  it('carries a routable code and a HarnessError-compatible shape', () => {
    const error = new ClaudeCodeError('nope', 'UNKNOWN_SESSION')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('UNKNOWN_SESSION')
    expect(error.name).toBe('ClaudeCodeError')
    expect(error.message).toBe('nope')
  })

  it('preserves a cause', () => {
    const cause = new Error('root')
    expect(new ClaudeCodeError('wrapped', 'SESSION_LIMIT', { cause }).cause).toBe(cause)
  })
})
