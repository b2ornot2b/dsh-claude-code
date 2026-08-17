/**
 * Shared assertion helpers for tests that replay (or drive) a mirror over a
 * REAL dsh {@link Session}: the golden fixture suite
 * (`tests/mirror-golden.spec.ts`) and the live end-to-end suite
 * (`tests/live/mirror-e2e.live.spec.ts`) both need the same relational-log
 * check, so it lives here once rather than twice.
 *
 * `assertFramingInvariants` is a deliberate re-statement of
 * `@deepseek-ai/dsh-session/invariant` (which needs the invariants service, not
 * part of these offline/live-but-seam-only suites): seq contiguity, one open
 * turn at a time with `nextTurn` numbering, no step outside a turn, and no
 * `tool/result` whose `tool/call` is not pending in the open step. Copied from
 * `tests/mirror.spec.ts`'s private helper rather than imported from it, so this
 * file adds nothing to that spec's import surface.
 *
 * Not a spec file: vitest only collects `*.spec.ts`, while `tsconfig.tests.json`
 * still type-checks this module.
 */

import { isJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { expect } from 'vitest'

/**
 * Re-check `assistant/chunk` block-index bookkeeping, scoped per STEP (indices
 * are only meaningful within the one model call that opened them): no
 * `block-start` reopens an index already open, no `block-end`/`*-delta` cites
 * an index that was never opened, and every open index is reset at `step/end`.
 *
 * Deliberately NOT a "every block-start eventually gets a block-end" check —
 * `CcMirror.discardInterruptedCall` (a `steer`'s abort) closes a step whose
 * last block never reached the provider's own `content_block_stop`, and
 * documented mirror behavior (matching how a killed call also gets no
 * synthetic `finish` chunk) is to leave it that way rather than invent a close
 * that never happened.
 * @param session - the dsh session whose `assistant/chunk` events to check.
 * @returns nothing.
 * @throws when a chunk's `index` bookkeeping is inconsistent.
 */
export function assertChunkIndices(session: Session): void {
  let open = new Set<number>()
  for (const event of session.events) {
    if (event.type === 'step/end') {
      open = new Set()
      continue
    }
    if (event.type !== 'assistant/chunk') continue
    const chunk = event.data.chunk
    switch (chunk.type) {
      case 'block-start':
        expect(open.has(chunk.index)).toBe(false)
        open.add(chunk.index)
        break
      case 'block-end':
        expect(open.has(chunk.index)).toBe(true)
        open.delete(chunk.index)
        break
      case 'text-delta':
      case 'reasoning-delta':
      case 'tool-call-delta':
        expect(open.has(chunk.index)).toBe(true)
        break
      default:
        break
    }
  }
}

/**
 * The event types of a session log, in order — the shape most assertions read.
 * @param session - the dsh session.
 * @returns the ordered type names.
 */
export function types(session: Session): string[] {
  return session.events.map(event => event.type)
}

/**
 * `types()`, with every RUN of consecutive `assistant/chunk` entries collapsed
 * to one `'assistant/chunk*'` marker. A real recorded transcript streams one
 * `assistant/chunk` per provider delta — dozens per model call — so an exact
 * type-sequence snapshot would be both enormous and brittle to the model's own
 * token-boundary choices. The SKELETON (turn/step/message/tool-call/tool-result
 * framing) is what a golden test should pin; the golden suite asserts chunk
 * PAYLOADS separately, and in bulk, via {@link eventsOfType}.
 * @param session - the dsh session.
 * @returns the collapsed type sequence.
 */
export function skeleton(session: Session): string[] {
  const out: string[] = []
  for (const type of types(session)) {
    if (type === 'assistant/chunk') {
      if (out[out.length - 1] !== 'assistant/chunk*') out.push('assistant/chunk*')
      continue
    }
    out.push(type)
  }
  return out
}

/**
 * Narrow one logged event by type.
 * @param session - the dsh session.
 * @param type - the event type to find.
 * @returns every matching event.
 */
export function eventsOfType<T extends SessionEvent['type']>(
  session: Session,
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return session.events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type)
}

/**
 * Re-check dsh's own relational log invariants over a produced log.
 * @param session - the session whose log to validate.
 * @returns nothing.
 * @throws when the log violates a framing invariant.
 */
export function assertFramingInvariants(session: Session): void {
  let openTurn: number | undefined
  let openStep: number | undefined
  let nextTurn = 1
  let nextStep = 1
  const pending = new Set<string>()
  for (const [index, event] of session.events.entries()) {
    expect(event.seq).toBe(index)
    switch (event.type) {
      case 'turn/start':
        expect(openTurn).toBeUndefined()
        expect(event.data.turn).toBe(nextTurn)
        openTurn = event.data.turn
        nextStep = 1
        break
      case 'turn/end':
        expect(openTurn).toBe(event.data.turn)
        expect(openStep).toBeUndefined()
        openTurn = undefined
        nextTurn = event.data.turn + 1
        break
      case 'step/start':
        expect(openTurn).toBe(event.data.turn)
        expect(openStep).toBeUndefined()
        expect(event.data.step).toBe(nextStep)
        openStep = event.data.step
        break
      case 'step/end':
        expect(openTurn).toBe(event.data.turn)
        expect(openStep).toBe(event.data.step)
        openStep = undefined
        nextStep = event.data.step + 1
        pending.clear()
        break
      case 'assistant/chunk':
      case 'assistant/message':
        expect(openTurn).toBe(event.data.turn)
        expect(openStep).toBe(event.data.step)
        break
      case 'tool/call':
        expect(openTurn).toBe(event.data.turn)
        expect(openStep).toBe(event.data.step)
        pending.add(event.data.callId)
        break
      case 'tool/result':
        expect(openTurn).toBe(event.data.turn)
        expect(openStep).toBe(event.data.step)
        expect(pending.has(event.data.message.source.callId)).toBe(true)
        pending.delete(event.data.message.source.callId)
        break
      case 'todo/write':
        expect(openTurn).not.toBeUndefined()
        break
      default:
        // Merge-extensible: a plugin event (ours included) constrains nothing.
        break
    }
    expect(isJsonValue(event.data)).toBe(true)
  }
}
