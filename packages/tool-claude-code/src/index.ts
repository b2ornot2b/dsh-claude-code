/**
 * Model-facing tools over the Claude Code capability seam (`ctx.claudeCode`):
 * open, send, wait, status, list, cancel, and close a Claude Code session.
 *
 * **`claude_code_list` (the seventh tool) exists because every other one takes a
 * `session_id`.** That made the only reachable sessions the ones the caller had
 * personally opened and still remembered — while `limits.maxConcurrentSessions`
 * is enforced SERVICE-WIDE and the service outlives any one dsh session. An
 * agent could therefore be refused a slot by sessions it had no way to name. See
 * `list.ts`.
 *
 * NAMED EXPORTS ONLY. A `default` export here would make the cordis Loader
 * unwrap the module to that single value and silently discard the sibling
 * `name`/`inject`/`Config` exports, mounting the plugin with an empty inject
 * list (harness post-mortem 0001, "export default drops the plugin's
 * inject"). `tests/exports.spec.ts` asserts the absence of a default export.
 *
 * **Phase 5 wired every body to the real seam.** The schemas are the same
 * contract Phase 1 froze; `claude_code_open`'s session branch gained three
 * OPTIONAL fields (`result`, `usage`, `cost_usd`) because synchronous mode now
 * returns the turn it waited for, and nothing was removed or retyped.
 *
 * **Human-in-the-loop ergonomics.** An unfinished turn is not a failure here: a
 * Claude Code session routinely sits still because a person has not answered a
 * permission prompt in the dsh UI yet. So `claude_code_wait` defaults to a
 * ONE-MINUTE wait ({@link DEFAULT_WAIT_TIMEOUT_MS}) and, on expiry, RESOLVES
 * with `status: 'running'` plus `pending_asks`/`pending_ask_details` naming the
 * tool and the reason a human is looking at; synchronous `claude_code_open`
 * does the same at its own ceiling. Both used to throw `CC_TIMEOUT`, which a
 * delegating model reasonably read as "this session is broken" — and then
 * cancelled the turn and opened a fresh session, repeatedly, while the original
 * approval sat unanswered. The schema additions are strictly additive (new
 * optional fields on the existing branches, plus a required-and-always-present
 * `pending_ask_details` on `claude_code_status`).
 *
 * What this plugin does NOT do, on purpose:
 *
 * - **No permission policy** (delta D13). Policy over *these* tools belongs in
 *   `tools/pre-execute` (allow/deny/ask) or `ctx.tools.guard()`; policy INSIDE
 *   a Claude Code session is the seam's ask channel (§4). A tool that decided
 *   for itself would be a second, weaker policy engine.
 * - **No progress injection.** The spec's `exec.agent.inject(...)` note is
 *   redundant now that background sessions are dsh jobs:
 *   `@deepseek-ai/dsh-tool-jobs` already delivers a completion notice to the
 *   owning agent (injected into a busy owner, waking an idle one, bounded per
 *   owner). A second, unbounded notice path from this plugin would double every
 *   message and bypass those bounds. Documented as a deliberate deviation in
 *   the README.
 *
 * @module @deepseek-ai/dsh-tool-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import {
  CC_CLOSE_REASONS,
  CC_DISCOVERY_SCOPES,
  CC_PERMISSION_MODES,
  CC_SESSION_STATUSES,
  groupByOrigin,
} from '@deepseek-ai/dsh-claude-code'
import type { CcMessageEnvelope, CcSession, CcSessionId, CcSessionSnapshot } from '@deepseek-ai/dsh-claude-code'
// Side-effect type-only imports: they contribute the `Context` augmentations
// this plugin reads opportunistically (`ctx.jobs`), and they are erased at
// runtime, so a composition without a jobs runtime still mounts.
import type {} from '@deepseek-ai/dsh-jobs'

import { startBackgroundSession } from './background.ts'
import { abortedError, errorCode } from './errors.ts'
import {
  DISCOVERED_SESSION_ITEM_SCHEMA, projectDiscovered, projectSessions, renderSessionList, renderWideList,
  SESSION_LIST_SCHEMA,
} from './list.ts'
import { noSuchSession, openSession, requireSession } from './open.ts'
import {
  answerInDshUi, PENDING_ASK_DETAILS_SCHEMA, projectPendingAsks, renderPendingAsks, renderStillRunning,
} from './pending.ts'
import type { CcPendingAskProjection } from './pending.ts'
import {
  HUMAN_DECISIONS_SCHEMA, projectHumanDecisions, renderDecisionBlock, renderWithDecisions,
} from './receipts.ts'
import type { CcHumanDecisionProjection } from './receipts.ts'
import { projectContextUsage, projectResult } from './result.ts'

export const name = 'tool-claude-code'
export const inject = ['tools', 'claudeCode']

/** Reserved for future tuning (e.g. gating background-mode advertisement); empty in Phase 5. */
export interface Config {}

/** Runtime configuration schema for the Claude Code tool plugin. */
export const Config: z<Config> = z.object({})

/**
 * How long synchronous `claude_code_open` waits for the opening turn before it
 * gives up on WAITING (never on the session).
 *
 * Ten minutes is the same ceiling `@deepseek-ai/dsh-tool-jobs` puts on a bounded
 * job wait. A cap has to exist: a tool call that never returns holds the
 * caller's turn open forever, and the honest answer — "still running, here is
 * the id, here is what a human must approve" — is strictly more useful than a
 * hang. It stays at ten minutes because an OPEN is a one-shot the caller cannot
 * cheaply retry: unlike `claude_code_wait`, coming back early costs a whole
 * extra tool call to learn the id it already has.
 */
export const SYNC_OPEN_TIMEOUT_MS = 600_000

/**
 * What `claude_code_wait` waits when the model supplies no `timeout_ms`.
 *
 * One minute, NOT the ten-minute ceiling — and this is the single most
 * behaviourally significant number in this package. A poll that resolves in a
 * minute with "still running, blocked on `Write: /tmp/notes.txt`, a human must
 * answer" gives the caller something to report and something to do. A poll that
 * blocks for ten minutes and then throws gives it neither, and the production
 * trace shows exactly what a model does with that: it cancels and re-opens.
 *
 * A model that wants a longer block can still ask for one — up to
 * {@link MAX_WAIT_TIMEOUT_MS}.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000

/** Hard ceiling for `claude_code_wait`, applied to an oversized explicit `timeout_ms`. */
export const MAX_WAIT_TIMEOUT_MS = 600_000

/** Pure pending-call card shared by every tool below: a titled, category-iconed generic card. */
function genericCall(title: string, rawInput?: unknown): GenericCallView {
  return {
    card: 'generic',
    title,
    kind: 'execute',
    ...rawInput !== undefined ? { rawInput } : {},
  }
}

/**
 * Wait for a turn under a tool-layer cap, reporting expiry as `undefined`
 * rather than as a throw.
 *
 * **`undefined` is not a failure and must never be rendered as one.** "The turn
 * has not finished because a human has not answered the permission prompt yet"
 * is the EXPECTED steady state of this integration, and the seam's `TIMEOUT` is
 * how the actor says "your bounded wait elapsed", not "something broke". The
 * previous version rethrew it as `CC_TIMEOUT`; the caller — a model, reading a
 * tool error — did the reasonable thing with a failure and threw the session
 * away. Callers turn this `undefined` into a `status: 'running'` value carrying
 * the pending asks instead.
 *
 * The code is read off the thrown value rather than checked with `instanceof`:
 * two copies of a package on two resolution planes make identity checks
 * silently false.
 *
 * **The photo-finish is resolved in the result's favour.** The seam's timeout is
 * a `setTimeout` that rejects a parked waiter; a result landing in the same tick
 * loses the race by microtasks and the caller would be told "still running"
 * about a turn that has already finished — then be handed the answer only on its
 * NEXT poll, a minute later. So after a timeout we re-read
 * {@link CcSession.lastResult} and hand it back if a result arrived DURING this
 * wait. The identity comparison against the pre-wait value is what makes that
 * safe: `lastResult` survives turns, and returning a PREVIOUS turn's answer for
 * the turn we were actually waiting on would be a lie, not a rescue.
 * @param session - the live actor.
 * @param timeoutMs - the cap in milliseconds.
 * @returns the result envelope, or undefined when the wait elapsed with the turn
 *   still in flight (the session is untouched and still open).
 * @throws whatever the seam raised that was NOT a timeout — `SESSION_CLOSED`
 *   above all, which really is a failure and really does mean the session is gone.
 */
async function waitCapped(
  session: CcSession,
  timeoutMs: number,
): Promise<CcMessageEnvelope | undefined> {
  const before = session.lastResult
  try {
    return await session.waitForResult(timeoutMs)
  } catch (error) {
    if (errorCode(error) !== 'TIMEOUT') throw error
    const late = session.lastResult
    return late !== undefined && late !== before ? late : undefined
  }
}

/**
 * Clamp a model-supplied wait to something this layer will actually honor.
 *
 * An absent (or nonsensical) `timeout_ms` gets {@link DEFAULT_WAIT_TIMEOUT_MS},
 * not the ceiling: defaulting to the cap is what made every unattended poll a
 * ten-minute block. An explicit oversized value is still clamped to
 * {@link MAX_WAIT_TIMEOUT_MS} — a caller may ask for a long block, but not for
 * an unbounded one.
 * @param timeoutMs - the requested wait, if any.
 * @returns the effective wait in milliseconds.
 */
function effectiveWait(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_WAIT_TIMEOUT_MS
  }
  return Math.min(Math.round(timeoutMs), MAX_WAIT_TIMEOUT_MS)
}

/** The fields every "still running" answer carries, shared by open and wait. */
interface CcStillRunning {
  /** The lifecycle state, read from the same snapshot as the asks below. */
  readonly status: CcSessionSnapshot['status']
  /** The still-open session, repeated in the value so the model can wait again without re-deriving it. */
  readonly session_id: string
  /** How many asks are awaiting a human. */
  readonly pending_asks: number
  /** What those asks are. */
  readonly pending_ask_details: CcPendingAskProjection[]
}

/**
 * Read the still-open session's state and pending asks at expiry.
 *
 * **One `snapshot()`, not four getters.** `pending_asks` and
 * `pending_ask_details` must never disagree: a count of 1 with an empty detail
 * list is precisely the unusable signal this whole change exists to delete, and
 * a caller reading the two properties separately is one refactor (or one
 * awaited call slipped between them) away from producing exactly that.
 * `CcSession.snapshot()` reads the status, the count and the details from the
 * one ask table in a single synchronous projection, so the value is internally
 * consistent by construction rather than by convention. The status comes from
 * the same read for the same reason — "running, 0 pending" and "idle, 1 pending"
 * are both states a split read could invent.
 *
 * The clock is read ONCE, here, and the elapsed time is baked into the value —
 * so the presenters stay pure functions of `(args, value)` and a logged result
 * re-renders to exactly the prose the model originally saw.
 * @param session - the live actor.
 * @param sessionId - its id, as the caller wrote it.
 * @returns the shared "still running" fields.
 */
function stillRunning(session: CcSession, sessionId: string): CcStillRunning {
  const snapshot = session.snapshot()
  return {
    status: snapshot.status,
    session_id: sessionId,
    pending_asks: snapshot.pendingAsks,
    pending_ask_details: projectPendingAsks(snapshot.pendingAskDetails, Date.now()),
  }
}

/**
 * What a HUMAN decided during the turn this call waited on.
 *
 * The window is the turn, not the wait: `turnStartedAt` is stamped when the send
 * that started the turn landed, so an approval a person answered before this
 * particular `claude_code_wait` call was made is still reported by it. Filtering
 * on the wait's own start instead would drop exactly the decisions a poller
 * missed while it was not polling — and the whole point is that a delegating
 * agent must not have to have been watching.
 *
 * The `turnStart` argument is read BEFORE the wait so a follow-up turn that
 * begins while we are parked cannot move the window forward underneath us.
 *
 * An ask can also STRADDLE the boundary: raised during turn N, still on a
 * human's screen when an interrupt ends that turn, and answered after turn N+1
 * has already started. The window is the SETTLE time, so turn N+1 reports it —
 * the settle is the event, and the alternative is a decision that no tool call
 * ever mentions. It is projected with `asked_in_an_earlier_turn`, and the prose
 * says "raised during an EARLIER turn", so nothing reads as approval of the
 * current turn's work.
 *
 * @param session - the live actor.
 * @param turnStart - `session.turnStartedAt` as read before waiting.
 * @returns the projected decisions of that turn, oldest first (empty when a
 *   turn ran with no ask settled at all — which is itself worth reporting).
 */
function turnDecisions(session: CcSession, turnStart: number | undefined): CcHumanDecisionProjection[] {
  const snapshot = session.snapshot()
  // `?? 0` covers the session that never sent anything through this actor (a
  // resumed transcript, a white-box test): everything the table holds belongs to
  // the only turn there has been.
  const since = turnStart ?? snapshot.turnStartedAt ?? 0
  return projectHumanDecisions(snapshot.recentAsks.filter(receipt => receipt.settledAt >= since), since)
}

export function apply(ctx: Context, _config: Config = {}): void {
  const defaults = ctx.claudeCode.config.defaults

  ctx.tools.register(defineTool({
    name: 'claude_code_open',
    description: 'Open a new Claude Code session, or resume (optionally fork) an existing one, rooted at a working '
      + 'directory. With `prompt`, waits for that first turn and returns its answer; omit `prompt` to open idle and '
      + 'send the first message with `claude_code_send`. The session STAYS OPEN either way — follow up with '
      + '`claude_code_send`, then `claude_code_close` when you are done with it. Set `background: true` to run '
      + 'detached as a dsh job instead of synchronously (requires a jobs runtime in this composition).',
    parameters: {
      cwd: { type: 'string', required: true, description: 'Absolute working directory the session runs in.' },
      prompt: { type: 'string', description: 'First user message. Omit to open an idle session and send later.' },
      model: { type: 'string', description: 'Model id override; omit for the deployment default.' },
      permission_mode: {
        type: 'string',
        enum: CC_PERMISSION_MODES,
        description: `Permission mode; omit to use the deployment default (currently "${defaults.permissionMode}").`,
      },
      resume: { type: 'string', description: 'An existing Claude Code session id (bare UUID) to resume.' },
      fork: {
        type: 'boolean',
        description: 'Fork the resumed session instead of continuing it (requires `resume`); the source session is left untouched and the fork gets a fresh id.',
      },
      background: {
        type: 'boolean',
        description: 'Run detached from this tool call as a dsh job instead of synchronously; requires a jobs '
          + 'runtime (`@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`) loaded in this composition.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'session' },
              session_id: { type: 'string', required: true, description: 'The shared dsh/Claude Code session id.' },
              status: { type: 'string', required: true, enum: CC_SESSION_STATUSES },
              result: { type: 'string', description: 'Final assistant text of the opening turn, when one was sent and completed.' },
              usage: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  input_tokens: { type: 'integer', required: true },
                  output_tokens: { type: 'integer', required: true },
                },
              },
              cost_usd: { type: 'number', description: 'Opening-turn cost in USD, when the SDK reported one.' },
              pending_asks: {
                type: 'integer',
                description: 'Present ONLY when the opening turn was still running when this call returned: how '
                  + 'many asks are awaiting a human. The session is open; call claude_code_wait to keep waiting.',
              },
              pending_ask_details: PENDING_ASK_DETAILS_SCHEMA,
              human_decisions: {
                ...HUMAN_DECISIONS_SCHEMA,
                description: 'Present when the opening turn COMPLETED: the asks a human (or a policy) settled '
                  + 'during it. Report these as what the person actually decided — and never report a '
                  + '"policy" entry as a human\'s decision. ' + HUMAN_DECISIONS_SCHEMA.description,
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true, description: 'The dsh job id tracking this session open.' },
              ccSessionId: { type: 'string', required: true, description: 'The Claude Code session id the background job opens.' },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background job ${value.jobId} (session ${value.ccSessionId})`
          // `pending_asks` is the discriminator for the still-running branch: it
          // is set exactly when the sync wait expired with the turn in flight,
          // and absent on every completed (or idle) open.
          : value.pending_asks !== undefined
            ? renderStillRunning(value.session_id, value.status, value.pending_ask_details ?? [])
            : renderWithDecisions(
                `session ${value.session_id} (${value.status})`
                + (value.result === undefined ? '' : `\n\n${value.result}`),
                value.human_decisions ?? [],
                'during this opening turn'),
      } satisfies ContentBlock],
    },
    async execute(args, exec) {
      if (args.background === true) {
        // Everything about the background branch — the jobs-absent error, the
        // pre-publication abort check, the JobHooks contract — lives in
        // `background.ts`, next to the D10 rules it implements.
        const handle = await startBackgroundSession(ctx, args, exec)
        return { kind: 'background' as const, jobId: handle.jobId, ccSessionId: handle.ccSessionId }
      }

      // Nothing has spawned yet: an already-aborted call must not pay for a
      // subprocess (and a subscription slot) it will never read.
      if (exec.signal.aborted) throw abortedError('claude_code_open')

      const opened = await openSession(ctx, args, exec)
      // An idle open has no turn to wait for; waiting would park until the cap
      // elapsed and then report a timeout for a session that is working fine.
      if (!opened.prompted) {
        return { kind: 'session' as const, session_id: opened.id, status: opened.session.status }
      }
      // Read BEFORE the wait: `openSession` already sent the prompt, so this is
      // the opening turn's own start, and a queued follow-up that starts a
      // second turn while we are parked cannot move it.
      const turnStart = opened.session.turnStartedAt
      const envelope = await waitCapped(opened.session, SYNC_OPEN_TIMEOUT_MS)
      // Expiry is NOT a failure and does not close anything: the session is
      // open, the turn is still going, and — usually — a human simply has not
      // answered a permission prompt yet. Hand back the id and what is pending
      // so the caller can wait again instead of respawning.
      if (envelope === undefined) {
        return { kind: 'session' as const, ...stillRunning(opened.session, opened.id) }
      }
      return {
        kind: 'session' as const,
        session_id: opened.id,
        status: opened.session.status,
        ...projectResult(envelope),
        // Always present on a completed turn, empty included: "no human was
        // involved in this turn" is evidence too, and an ABSENT array would let
        // a model read "the tools cannot tell me" as "a human approved".
        human_decisions: turnDecisions(opened.session, turnStart),
      }
    },
    presentCall: args => genericCall(`Open Claude Code session in ${args.cwd}`, args.resume ?? args.cwd),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_send',
    description: 'Send a message to an open Claude Code session: `followup` queues it for after the current turn '
      + 'finishes; `steer` interrupts the in-flight turn with it. Use `claude_code_wait` to observe the result.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'The Claude Code session id to send to.' },
      message: { type: 'string', required: true, description: 'The message text.' },
      mode: {
        type: 'string',
        required: true,
        enum: ['followup', 'steer'],
        description: '`followup` queues after the current turn; `steer` interrupts it now.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: CC_SESSION_STATUSES },
        },
      },
      render: (args, value) => [{ type: 'text', text: `session ${args.session_id} is now ${value.status}` } satisfies ContentBlock],
    },
    async execute(args) {
      const session = requireSession(ctx, args.session_id)
      // `send()` is synchronous (it pushes onto the never-completing input
      // stream) and moves the status machine itself, so the snapshot taken
      // right after it is the post-send truth, not a stale read.
      session.send(args.message, { mode: args.mode === 'steer' ? 'steer' : 'followup' })
      return await Promise.resolve({ status: session.status })
    },
    presentCall: args => genericCall(`Send to Claude Code session ${args.session_id} (${args.mode})`, args.message),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_wait',
    description: 'Wait for an open Claude Code session to finish its current turn (or `timeout_ms` to elapse) and '
      + 'return its outcome: status, final text when the turn completed, and usage/cost when the SDK reported them. '
      + 'This NEVER fails just because the turn is unfinished: if the wait elapses it returns `status: "running"` '
      + 'with `pending_ask_details` naming any permission/question a human still has to answer in the dsh UI. That '
      + 'is a normal state — call this tool again to keep waiting; do not cancel the turn or open a new session.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'The Claude Code session id to wait on.' },
      timeout_ms: {
        type: 'number',
        description: 'Maximum time to wait, in milliseconds. Omitted means 60000 (one minute); values above the '
          + '600000 (10-minute) ceiling are clamped to it. Elapsing is not an error — you get the running status '
          + 'and what is pending.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: CC_SESSION_STATUSES },
          result: { type: 'string', description: 'Final assistant text, present when the turn completed.' },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              input_tokens: { type: 'integer', required: true },
              output_tokens: { type: 'integer', required: true },
            },
          },
          cost_usd: { type: 'number', description: 'Turn cost in USD, when the SDK reported one.' },
          session_id: {
            type: 'string',
            description: 'The still-open session, present ONLY when the wait elapsed with the turn still running '
              + '— pass it back to claude_code_wait to keep waiting.',
          },
          pending_asks: {
            type: 'integer',
            description: 'Present ONLY when the wait elapsed with the turn still running: how many asks are '
              + 'awaiting a human answer in the dsh UI.',
          },
          pending_ask_details: PENDING_ASK_DETAILS_SCHEMA,
          human_decisions: {
            ...HUMAN_DECISIONS_SCHEMA,
            description: 'Present when the turn COMPLETED: every ask settled during that turn, and WHO settled '
              + 'it. This is the only evidence that a person approved, rejected or answered anything — a tool '
              + 'call that simply happened proves nothing about who allowed it. ' + HUMAN_DECISIONS_SCHEMA.description,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        // Three cases, in the order they matter. A finished turn renders its
        // answer exactly as it always has, now led by what a human decided
        // during it. An elapsed wait renders the human-in-the-loop guidance —
        // the string the pending-ask change exists for. A turn that finished
        // with no text (an interrupted turn) renders its status, as before.
        text: value.pending_asks !== undefined && value.result === undefined
          ? renderStillRunning(value.session_id ?? '', value.status, value.pending_ask_details ?? [])
          : renderWithDecisions(
              value.result ?? `status: ${value.status}`,
              value.human_decisions ?? [],
              'this turn'),
      } satisfies ContentBlock],
    },
    async execute(args) {
      const session = requireSession(ctx, args.session_id)
      // Read BEFORE the wait: see `turnDecisions`.
      const turnStart = session.turnStartedAt
      const envelope = await waitCapped(session, effectiveWait(args.timeout_ms))
      // The regression the production trace demands: RESOLVE, do not reject.
      // A thrown timeout reads as "this session is broken" and the delegating
      // model cancels and re-opens; a resolved `running` reads as "not yet" and
      // it waits again — which is the only thing that can actually work while a
      // human has not clicked approve.
      if (envelope === undefined) return stillRunning(session, args.session_id)
      return {
        status: session.status,
        ...projectResult(envelope),
        human_decisions: turnDecisions(session, turnStart),
      }
    },
    presentCall: args => genericCall(`Wait for Claude Code session ${args.session_id}`),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_status',
    description: 'Read the current status of an open Claude Code session without waiting: lifecycle state, which '
      + 'permission/question asks are pending (tool name and the reason a human is being shown, in '
      + '`pending_ask_details`), and context-window occupancy when known.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'The Claude Code session id to inspect.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: CC_SESSION_STATUSES },
          close_reason: {
            type: 'string',
            enum: CC_CLOSE_REASONS,
            description: 'Why the session closed, present only when status is "closed": "closed" (something '
              + 'asked — claude_code_close, teardown), "exited" (the Claude Code subprocess ended on its own '
              + 'between turns) or "crashed" (it died mid-turn, so that turn produced no result).',
          },
          pending_asks: { type: 'integer', required: true, description: 'Number of permission/question asks currently awaiting an answer.' },
          pending_ask_details: { ...PENDING_ASK_DETAILS_SCHEMA, required: true },
          human_decisions: {
            ...HUMAN_DECISIONS_SCHEMA,
            required: true,
            description: 'Always present, empty when nothing has settled: the recent asks a human (or a policy) '
              + 'decided on this session, oldest first. ' + HUMAN_DECISIONS_SCHEMA.description,
          },
          context_usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              used_tokens: { type: 'integer', required: true },
              max_tokens: { type: 'integer' },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `session ${args.session_id}: ${value.status}`
          + (value.close_reason === undefined ? '' : ` (${value.close_reason})`)
          + `, ${value.pending_asks} pending ask(s)`
          + (value.context_usage !== undefined ? `, ${value.context_usage.used_tokens} tokens used` : '')
          // The count alone was the whole problem: it said something was
          // pending and never what. When anything IS pending, name it and say
          // who has to act.
          + (value.pending_ask_details.length === 0
            ? ''
            : `\n${renderPendingAsks(value.pending_ask_details)}\n${answerInDshUi(args.session_id)}`)
          // What has already been DECIDED, and by whom. A status read is where
          // an agent reconstructs what happened while it was not looking, and
          // it used to find no trace of the human at all.
          + (value.human_decisions.length === 0
            ? ''
            : `\n${renderDecisionBlock(value.human_decisions, 'on this session')}`),
      } satisfies ContentBlock],
    },
    async execute(args) {
      // The ONE tool that answers for a session that is no longer live. Every
      // other one needs something to drive and rightly fails `CC_NO_SESSION`;
      // this one is the question a caller asks precisely BECAUSE the session
      // stopped answering, and since a dead subprocess now closes its own
      // session, "no such session" would be a lie about a session the caller
      // was handed the id of moments earlier. The seam keeps a bounded
      // tombstone for exactly this call (`CLOSED_SESSION_HISTORY`).
      const session = ctx.claudeCode.session(args.session_id as CcSessionId)
      const snapshot = session?.snapshot() ?? ctx.claudeCode.get(args.session_id as CcSessionId)
      if (snapshot === undefined) throw noSuchSession(args.session_id)
      // Occupancy comes from the seam's own field when a future phase starts
      // reporting one, and otherwise from the last completed turn's usage —
      // the cheapest REAL source (see `projectContextUsage`). It stays ABSENT
      // rather than guessed when nothing has been reported yet. A tombstoned
      // session has no actor left to read a last result off, so it reports
      // whatever the final snapshot carried and nothing more.
      const contextUsage = snapshot.contextUsage === undefined
        ? projectContextUsage(session?.lastResult)
        : {
            used_tokens: snapshot.contextUsage.usedTokens,
            ...(snapshot.contextUsage.maxTokens === undefined
              ? {}
              : { max_tokens: snapshot.contextUsage.maxTokens }),
          }
      return await Promise.resolve({
        status: snapshot.status,
        ...(snapshot.closeReason === undefined ? {} : { close_reason: snapshot.closeReason }),
        pending_asks: snapshot.pendingAsks,
        // Always present, empty when nothing pends: an absent array would make
        // "nothing is pending" and "this build cannot tell you" the same value.
        pending_ask_details: projectPendingAsks(snapshot.pendingAskDetails, Date.now()),
        // A CLOSED session still reports its receipts: `entomb()` keeps the
        // actor's final snapshot, so "what did the human decide before this
        // session ended" survives the session itself — which is exactly when
        // somebody asks.
        human_decisions: projectHumanDecisions(snapshot.recentAsks),
        ...(contextUsage === undefined ? {} : { context_usage: contextUsage }),
      })
    },
    presentCall: args => genericCall(`Claude Code session ${args.session_id} status`),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_list',
    description: 'List Claude Code sessions, best close candidate first: id, working directory, status, how long '
      + 'each has been open, and which are BLOCKED on a human answering a permission/question in the dsh UI. Call '
      + 'this when claude_code_open fails with SESSION_LIMIT, or whenever you need a session id you did not open '
      + 'yourself — the concurrency limit is service-wide, so sessions from OTHER dsh sessions sharing this host '
      + 'can be holding the slots. Set `include_closed: true` to also see recently-closed sessions and why each '
      + 'one ended. By default this only sees sessions THIS composition opened; set `scope: "host"` or `"mesh"` to '
      + 'also find sessions running elsewhere that you did not open — those cannot be sent to, but they can be '
      + 'forked with claude_code_open({ resume, fork: true }).',
    parameters: {
      include_closed: {
        type: 'boolean',
        description: 'Also list recently-closed sessions (with close_reason). Defaults to false: only live '
          + 'sessions hold a concurrency slot.',
      },
      scope: {
        type: 'string',
        enum: CC_DISCOVERY_SCOPES,
        description: 'How wide to look. "composition" (default) lists only sessions this dsh composition holds '
          + 'open — the sessions that occupy a concurrency slot. "host" adds sessions running elsewhere on this '
          + 'machine plus recently-used sessions on disk. "mesh" adds the other configured hosts. Use a wider '
          + 'scope to find a session you did not open yourself; those cannot be sent to, but they can be forked '
          + 'with claude_code_open({ resume, fork: true }).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: SESSION_LIST_SCHEMA,
          external_live: {
            type: 'array',
            items: DISCOVERED_SESSION_ITEM_SCHEMA,
            description: 'Sessions running elsewhere — on this host, or (with scope "mesh") another configured '
              + 'host — that this composition did not open. Not sendable; fork one with claude_code_open({ '
              + 'resume, fork: true }). Present only when `scope` is "host" or "mesh".',
          },
          external_resumable: {
            type: 'array',
            items: DISCOVERED_SESSION_ITEM_SCHEMA,
            description: 'Sessions known only from disk — not currently running anywhere. Resume or fork one '
              + 'with claude_code_open. Present only when `scope` is "host" or "mesh".',
          },
          warnings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Discovery sources that could not be reached, e.g. "b2hx: unreachable (...)" — named so '
              + 'a wide search that found nothing can be told apart from a search that could not look. Present '
              + 'only when `scope` is "host" or "mesh".',
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: args.scope === undefined || args.scope === 'composition'
          ? renderSessionList(value.sessions, args.include_closed === true)
          : renderWideList(
              renderSessionList(value.sessions, args.include_closed === true),
              value.external_live ?? [],
              value.external_resumable ?? [],
              value.warnings ?? [],
              args.scope),
      } satisfies ContentBlock],
    },
    async execute(args) {
      // ONE clock reading for the whole listing, baked into the value: two rows
      // measured against two `Date.now()` calls would report ages that disagree
      // with each other by however long the projection took, and `render` must
      // stay a pure function of what was logged.
      const now = Date.now()
      const sessions = projectSessions(ctx.claudeCode.list(
        args.include_closed === true ? { includeClosed: true } : {}), now)
      const scope = args.scope ?? 'composition'
      // `'composition'` touches no discovery source at all — see
      // `ClaudeCode.discover`'s own doc comment — so the default call pays for
      // nothing beyond the inventory projection it already paid for, and the
      // returned value is exactly what this tool has always returned.
      if (scope === 'composition') return { sessions }
      const discovered = await ctx.claudeCode.discover({ scope })
      const groups = groupByOrigin(discovered.sessions)
      return {
        sessions,
        external_live: projectDiscovered(groups.liveExternal, now),
        external_resumable: projectDiscovered(groups.resumable, now),
        warnings: [...discovered.warnings],
      }
    },
    presentCall: () => genericCall('List Claude Code sessions'),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_cancel',
    description: 'Cancel an in-flight turn on an open Claude Code session. `keep_queued` defaults to true: messages '
      + 'already queued behind the cancelled turn still run. Pass `keep_queued: false` to suppress them too — a '
      + 'dsh-side rule this integration enforces on top of the cancel, not a Claude Code CLI feature; it is never '
      + "persisted to the session's own settings. Returns the ids of any sends that stayed queued.",
    parameters: {
      session_id: { type: 'string', required: true, description: 'The Claude Code session id to cancel.' },
      keep_queued: {
        type: 'boolean',
        description: 'Keep queued follow-up sends (default true); false additionally suppresses them.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          still_queued: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Ids of queued follow-up sends that remain queued after this cancel.',
          },
        },
      },
      // `still_queued` is ALWAYS stated, including when it is empty. The old
      // render omitted the empty case entirely, and the operator's delegating
      // agent read "cancelled session X" as "no still_queued value was
      // returned" — then reported the step as PARTIAL because it could not
      // confirm the very thing the tool had just told it. Zero is an answer.
      render: (args, value) => [{
        type: 'text',
        text: value.still_queued.length > 0
          ? `cancelled session ${args.session_id}; ${value.still_queued.length} queued message(s) survived and `
            + `will still run — still_queued: ${value.still_queued.join(', ')}`
          : `cancelled session ${args.session_id}; still_queued is empty: 0 queued messages survived this cancel.`,
      } satisfies ContentBlock],
    },
    async execute(args) {
      const session = requireSession(ctx, args.session_id)
      // The uuids come from the interrupt receipt, reconciled against the
      // session's own outbox: unknown uuids (cron triggers, auto-resume
      // continuations) are dropped rather than reported as ours.
      const outcome = await session.interrupt({ keepQueued: args.keep_queued ?? true })
      return { still_queued: [...outcome.stillQueued] }
    },
    presentCall: args => genericCall(`Cancel Claude Code session ${args.session_id}`),
  }))

  ctx.tools.register(defineTool({
    name: 'claude_code_close',
    description: 'Close a Claude Code session: settle its pending asks as denied, then close the underlying SDK '
      + 'query. Idempotent — closing an already-closed or unknown session still returns `closed: true`.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'The Claude Code session id to close.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true, const: true },
        },
      },
      render: args => [{ type: 'text', text: `closed session ${args.session_id}` } satisfies ContentBlock],
    },
    async execute(args) {
      // Everything downstream of the close is already wired by the seam and the
      // jobs runtime: the mirror finalizes its open turn and detaches
      // (`ClaudeCodeService.mirror`), and a background session's job settles
      // through the same `onClose` its producer subscribed to. Closing an
      // unknown id is not an error — the model asked for a session to be gone,
      // and it is.
      await ctx.claudeCode.close(args.session_id as CcSessionId)
      return { closed: true as const }
    },
    presentCall: args => genericCall(`Close Claude Code session ${args.session_id}`),
  }))
}
