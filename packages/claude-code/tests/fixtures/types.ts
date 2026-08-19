/**
 * The on-disk shape of a recorded (and scrubbed) fixture — the single contract
 * between the live recorder (`tests/live/record-fixtures.live.spec.ts`, which
 * WRITES these files) and the golden replay suite (`tests/mirror-golden.spec.ts`,
 * which READS them). Kept separate from the recorder so the golden suite's
 * import graph stays offline-only.
 *
 * Not a spec file: vitest only collects `*.spec.ts`, while `tsconfig.tests.json`
 * still type-checks this module.
 */

import type { CcMessageEnvelope, CcSdkMessage, CcSendMode } from '@deepseek-ai/dsh-claude-code'

/** One scrubbed outgoing send, in the shape {@link CcMirror.recordSend} consumes. */
export interface FixtureSend {
  readonly uuid: string
  readonly mode: CcSendMode
  readonly content: string
  /** Always `0` after scrubbing — wall-clock send time carries no test-relevant signal. */
  readonly sentAt: number
}

/** One scrubbed incoming envelope, minus the fields the mirror never reads (`sessionId`, `receivedAt`). */
export interface FixtureEnvelope {
  readonly message: CcSdkMessage
  readonly meta: Pick<CcMessageEnvelope['meta'], 'interruptArtifact' | 'interruptedTurn' | 'reinit'>
}

/**
 * One point on the recorded timeline. A tagged union rather than two separate
 * lists (`sends[]` + `messages[]`) on purpose: `CcMirror` is fed by TWO
 * subscriptions racing in real time (`onSend` + `onMessage`), and a `steer`
 * send lands INTERLEAVED with the turn it aborts — replaying "every send, then
 * every message" would append both `user/message` events back-to-back instead
 * of straddling the aborted turn's chunks, producing a dsh log shape that never
 * actually occurred. One ordered timeline is the only faithful replay.
 */
export type FixtureEntry =
  | { readonly kind: 'send', readonly send: FixtureSend }
  | { readonly kind: 'message', readonly envelope: FixtureEnvelope }

/** One complete recorded (and scrubbed) live session, ready to replay through {@link CcMirror}. */
export interface RecordedFixture {
  /** Stable scenario slug — also the file's basename. */
  readonly scenario: string
  /** What this fixture demonstrates, for a human reading the committed JSON. */
  readonly description: string
  /** The model the recorder used (always `tests/live/helpers.ts`'s `LIVE_MODEL`). */
  readonly model: string
  /** Every send and every message, interleaved in the exact order they occurred. */
  readonly entries: readonly FixtureEntry[]
}
