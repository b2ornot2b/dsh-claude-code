/**
 * The ask channel's approval path (§4.1), LIVE: a REAL Claude Code subprocess
 * asking a REAL `ctx.approval` — through the REAL `CcAskRouter` a session
 * installs by default (nothing here overrides `canUseTool`).
 *
 * Scenario (a) proves the whole chain end to end: a mutating Bash command that
 * cannot be auto-approved by the CLI's own safe-command classifier (spike 4)
 * reaches `canUseTool`, which asks `ctx.approval`; a scripted `'allowed-once'`
 * answer produces `updatedInput`, the file lands on disk, and the audit pair
 * (`approval/asked` → `approval/decided`) carries a `callId` that matches the
 * mirrored `tool/call` — because the agent's own session doubles as the
 * mirrored session (§7), this is a same-log correlation, not cross-log.
 *
 * Scenario (b) is the same shape with `'rejected'`: no file, and the deny
 * message dsh's §4.1 table specifies (`'User rejected this action'`) is the
 * literal text threaded back into the model as the tool result.
 *
 * Scenario (c) has no answerer attached at all: the real `ApprovalService`
 * itself answers `'unavailable'` (fail-closed, not this seam's doing), and the
 * fallback policy's deny message reaches CC.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  disposeLiveWithAsk, LIVE, LIVE_TIMEOUT_MS, mountLiveWithAsk, registerLiveRootAgent, removeCwd, tmpCwd,
} from './helpers.ts'
import { callAndResult, scriptApproval, toolResultIsError, toolResultText } from './ask-live-helpers.ts'

describe.skipIf(!LIVE)('ask channel — approval path, live (§4.1, DSH_CC_LIVE=1)', () => {
  it(
    'allows a real mutating Bash call on "allowed-once": file lands on disk, audit pair carries the mirrored callId',
    async () => {
      const cwd = tmpCwd('ask-approval-allow')
      const mounted = await mountLiveWithAsk()
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })
        const scripted = scriptApproval(ctx, 'allowed-once')

        const target = join(cwd, 'approved.txt')
        const snap = await service.open({
          cwd,
          ask: { agent: root.agent, delegated: false },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(
          `Use the Bash tool to run exactly: touch ${target}\n`
          + 'Do it directly, do not ask me first. Then reply with one short sentence confirming it ran.')
        await session.waitForResult(LIVE_TIMEOUT_MS)

        expect(existsSync(target)).toBe(true)
        expect(scripted.requests.length).toBeGreaterThanOrEqual(1)

        const types = root.session.events.map(event => event.type)
        expect(types).toContain('approval/asked')
        expect(types).toContain('approval/decided')

        const { call, result } = callAndResult(root.session, 'Bash')
        const asked = root.session.events.find(event => event.type === 'approval/asked')
        if (asked?.type !== 'approval/asked') throw new Error('missing approval/asked')
        expect(asked.data.callId).toBe(call.data.callId)
        expect(toolResultIsError(result)).toBe(false)
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'denies a real Bash call on "rejected": no file, and the exact §4.1 deny message reaches CC',
    async () => {
      const cwd = tmpCwd('ask-approval-reject')
      const mounted = await mountLiveWithAsk()
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })
        scriptApproval(ctx, 'rejected')

        const target = join(cwd, 'rejected.txt')
        const snap = await service.open({
          cwd,
          ask: { agent: root.agent, delegated: false },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(
          `Use the Bash tool to run exactly: touch ${target}\n`
          + 'Then reply with one short sentence about what happened.')
        await session.waitForResult(LIVE_TIMEOUT_MS)

        expect(existsSync(target)).toBe(false)
        expect(session.status).toBe('idle')

        const { result } = callAndResult(root.session, 'Bash')
        expect(toolResultIsError(result)).toBe(true)
        expect(toolResultText(result)).toContain('User rejected this action')
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'falls back to a deny when no approver is attached at all ("unavailable"), and the fallback message reaches CC',
    async () => {
      const cwd = tmpCwd('ask-approval-unavailable')
      const mounted = await mountLiveWithAsk()
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })
        // No `ctx.on('approval/request', ...)` listener at all: the real
        // ApprovalService itself answers 'unavailable'.

        const target = join(cwd, 'unavailable.txt')
        const snap = await service.open({
          cwd,
          ask: { agent: root.agent, delegated: false },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(
          `Use the Bash tool to run exactly: touch ${target}\n`
          + 'Then reply with one short sentence about what happened.')
        await session.waitForResult(LIVE_TIMEOUT_MS)

        expect(existsSync(target)).toBe(false)

        const { result } = callAndResult(root.session, 'Bash')
        expect(toolResultIsError(result)).toBe(true)
        const text = toolResultText(result)
        expect(text).toContain('no approver is available')
        expect(text).toContain('Nothing was executed')
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
