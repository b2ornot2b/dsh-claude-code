/**
 * `createClaudeCodeAgent()` — open one Claude Code session and publish it as a
 * dsh agent, with a teardown order that survives HMR.
 *
 * Everything hard about this file is ORDER. Four lifetimes have to be nested,
 * not raced: the subprocess, the agent's scoped world, the registry entry, and
 * the session-store attachment. Cordis composite (generator) effects dispose in
 * REVERSE yield order, so the yields below read as the exact inverse of the
 * teardown they buy.
 *
 * @module @deepseek-ai/dsh-claude-code-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type { SessionStartSource } from '@deepseek-ai/dsh-agent'
import { ClaudeCodeError } from '@deepseek-ai/dsh-claude-code'
import type { CcLogger, CcSessionId } from '@deepseek-ai/dsh-claude-code'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

import { ClaudeCodeAgent } from './agent.ts'
import { CC_AGENT_PROVIDER } from './types.ts'
import type { CcAgentOptions } from './types.ts'

/**
 * One published CC-backed agent and the capability to tear exactly it down.
 *
 * Deliberately the same shape as `dsh-agent`'s own `AgentHandle`: the disposer
 * IS the capability — among consumers, only its holder can dispose this agent —
 * and `ctx.agents.get(id)` keeps returning the bare `Agent`.
 */
export interface CcAgentHandle {
  /** The published agent. */
  readonly agent: ClaudeCodeAgent
  /**
   * Tear this agent down: interrupt and drain, close the subprocess (which
   * finalizes the mirror), unwind the agent's scope, unregister it, and detach
   * its session from the store — in that order.
   * @returns nothing; resolves once teardown has settled.
   */
  dispose(): Promise<void>
}

/** Extra seams `createClaudeCodeAgent` accepts for testing. Production passes none. */
export interface CcAgentSpawnDeps {
  /** Diagnostics sink; defaults to `ctx.logger.debug`. */
  readonly logger?: CcLogger
  /** Bound on the disposal drain; see `DEFAULT_DISPOSE_DRAIN_MS`. */
  readonly disposeDrainMs?: number
}

/**
 * Open a Claude Code session and publish it as a dsh agent.
 *
 * The sequence, and why it is this sequence:
 *
 * 1. **`ctx.claudeCode.open()` WITHOUT the prompt.** The seam mints the shared
 *    id, and the dsh session that must carry that id cannot exist before it
 *    does. A prompt passed here would be sent synchronously inside `open()` —
 *    before any mirror exists — and would be invisible in the dsh log.
 * 2. **`ctx.sessions.prepare(id)`**, not `create()`: `prepare` + `enter` +
 *    `announce` is what lets the store attachment join the ONE composite effect
 *    below, so a fiber unload tears session and agent down as a single ordered
 *    chain rather than as racing siblings (`SessionStore.prepare`'s own doc says
 *    exactly this).
 * 3. **Construct the agent**, which mints its scope. `id === session.id` is
 *    checked here, not left to `AgentRegistry.enter()`.
 * 4. **One composite effect** (see the yields for the ordering argument).
 * 5. **`agent/session-start`**, the first startup-driving extension point.
 * 6. **The opening prompt**, sent through `agent.followup()` so it lands in the
 *    inbox and the mirror alike, exactly as any later prompt does.
 *
 * @param ctx - the context that owns the agent's lifetime. It must provide
 *   `ctx.claudeCode`, `ctx.agents` and `ctx.sessions`.
 * @param options - the session to open plus the provider label to report.
 * @returns the published agent and its exact disposer.
 * @throws {ClaudeCodeError} code `INVALID_CONFIG` when a required service is
 *   missing from the composition, or anything `ctx.claudeCode.open()` throws
 *   (`INVALID_CWD`, `SESSION_LIMIT`, `SESSION_EXISTS`, `BACKEND_ERROR`, …)
 *   untouched — the code is what a caller routes on.
 */
export async function createClaudeCodeAgent(
  ctx: Context,
  options: CcAgentOptions,
  deps: CcAgentSpawnDeps = {},
): Promise<CcAgentHandle> {
  const claudeCode = ctx.get('claudeCode')
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  if (claudeCode === undefined || agents === undefined || sessions === undefined) {
    throw new ClaudeCodeError(
      'claude-code-agent: createClaudeCodeAgent() needs ctx.claudeCode, ctx.agents and ctx.sessions; '
      + `missing: ${[
        claudeCode === undefined ? 'claudeCode' : undefined,
        agents === undefined ? 'agents' : undefined,
        sessions === undefined ? 'sessions' : undefined,
      ].filter(name => name !== undefined).join(', ')}`,
      'INVALID_CONFIG')
  }

  const logger: CcLogger = deps.logger ?? loggerFor(ctx)
  const { provider = CC_AGENT_PROVIDER, prompt, ...open } = options
  const snapshot = await claudeCode.open(open)
  const id: CcSessionId = snapshot.id

  // From here on the subprocess is LIVE: every failure path must close it, or a
  // composition bug strands a Claude Code process holding a permission callback
  // nobody will ever answer.
  try {
    const cc = claudeCode.session(id)
    if (cc === undefined) {
      throw new ClaudeCodeError(
        `claude-code-agent: the seam opened session ${id} but does not track it`, 'UNKNOWN_SESSION')
    }
    const session = sessions.prepare(id, { meta: { cwd: options.cwd } })
    const agent = new ClaudeCodeAgent({
      ctx,
      session,
      cc,
      provider,
      logger,
      ...(deps.disposeDrainMs === undefined ? {} : { disposeDrainMs: deps.disposeDrainMs }),
    })

    const dispose = ctx.effect(function* (): Iterable<() => Promise<void> | void> {
      // Disposed LAST. The store attachment installs the session's publication
      // hooks, and the mirror's `finalize()` (which closes a turn the dead
      // session will never finish) runs during the seam close BELOW — detaching
      // the session first would publish none of those closing events.
      yield sessions.enter(session)
      sessions.announce(session)

      // Attached AFTER the store attachment, so the mirror's very first append
      // is published — and BEFORE the agent is announced, so a synchronous
      // `agent/created` listener that sends to it cannot produce a prompt no
      // mirror was watching for. Nothing has been sent yet: `open()` was
      // deliberately called without the prompt. The seam binds the mirror's
      // lifetime to the Claude Code session (on close it finalizes, then
      // detaches), so there is nothing to yield for it here.
      claudeCode.attachMirror(id, session)
      // The agent answers its own session's asks. It is a registry ROOT
      // (`register()` records no owner), so `delegated: false` is a fact, not a
      // policy: `ctx.userQuestions.ask()` refuses a delegated caller, and this
      // one is exactly the agent a human is talking to.
      const detachAsk = claudeCode.attachAskTarget(id, { agent, delegated: false })

      // Disposed THIRD, and it must be the EXACT function `register()` returned:
      // a wrapper would leave the unregistration disposing as a concurrent
      // sibling on owner unload, emitting `agent/disposed` while the final turn
      // was still draining (`AgentRegistry.register`'s own doc).
      yield agents.register(agent)

      // Disposed SECOND: agent-scoped contributions unwind after the driver is
      // quiet and BEFORE the registry drops the agent — the position
      // `dsh-agent-loop` gives it, and what `agent/disposed`'s documentation
      // ("after driver quiescence and scoped-registration unwind, but before
      // session detachment") describes.
      yield agent.scope.rawDispose

      // Disposed FIRST: interrupt, drain (bounded), then close the subprocess —
      // which settles pending asks, finalizes the mirror and lets the process
      // exit. Everything above is still live while it happens, which is the
      // whole point of the ordering.
      yield async () => {
        await agent.drain()
        await claudeCode.close(id)
        detachAsk()
      }
    }, `claudeCodeAgent(${id})`)

    const source: SessionStartSource = options.resume === undefined ? 'startup' : 'resume'
    emitAgentEvent(ctx, agent, 'agent/session-start', { source })

    if (prompt !== undefined) {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
    }

    return {
      agent,
      dispose: async () => {
        await dispose()
      },
    }
  } catch (error) {
    await claudeCode.close(id)
    throw error
  }
}

/**
 * Read `ctx.logger` ONCE into a plain closure.
 *
 * cordis 4 hands out a fresh traceable proxy per service access, and an agent
 * outlives many of them; a captured proxy would outlive the fiber that made it.
 * @param ctx - the context to read the logger from.
 * @returns a plain diagnostics sink.
 */
function loggerFor(ctx: Context): CcLogger {
  const logger = ctx.logger
  return { debug: (message: string) => { logger.debug(message) } }
}
