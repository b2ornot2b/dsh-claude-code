# @deepseek-ai/dsh-claude-code-agent

The `Agent`-adapter consumer for the DeepSeek Harness: it publishes `ctx.agents` entries backed by
live Claude Code sessions, so a CC session is a first-class citizen a human can talk to in the dsh
UI (spec §7). It depends on the capability seam, `@deepseek-ai/dsh-claude-code`
(`ctx.claudeCode`), on `@deepseek-ai/dsh-agent`'s registry (`ctx.agents`), and on
`@deepseek-ai/dsh-session`'s store (`ctx.sessions`).

> **Package naming.** This package is `private: true` and is not published. It keeps the
> `@deepseek-ai/dsh-*` name so that upstreaming into the harness monorepo is a mechanical move
> rather than a rename — we do not own the `@deepseek-ai` npm scope and cannot publish into it.

**Status: implemented (Phase 6).** `apply()` provides `ctx.claudeCodeAgents`;
`createClaudeCodeAgent()` opens a Claude Code session, mirrors it into a real dsh session, and
registers a `ClaudeCodeAgent` with `ctx.agents` — returning the exact disposer that tears all of it
down again, in order.

---

## Two surfaces

```ts
// The function: works in any context that has the three services.
import { createClaudeCodeAgent } from '@deepseek-ai/dsh-claude-code-agent'
const { agent, dispose } = await createClaudeCodeAgent(ctx, { cwd: '/workspace/repo' })

// The service: the same thing with the composition's configured defaults folded in.
const handle = await ctx.claudeCodeAgents.spawn({ prompt: 'summarize this repo' })
ctx.claudeCodeAgents.list()          // every agent this plugin owns
await handle.dispose()
```

`cordis.yml` row:

```yaml
- id: claude-code-agent
  name: '@deepseek-ai/dsh-claude-code-agent'
  config:
    provider: claude-code            # reported as Agent.options.provider
    defaults:
      cwd: /workspace/repo
      model: claude-haiku-4-5-20251001
      permissionMode: default
```

Every **session** policy (auth, ask behavior, setting sources, limits, env) lives on
`ctx.claudeCode.config` and is resolved once by the seam. This plugin's config is only what a
composition wants to fix for the agents it spawns.

## What the adapter maps

| `Agent` member | Implementation |
|---|---|
| `id` | the shared `SessionId` — one bare UUID for both dsh and Claude Code (see "Shared identity") |
| `session` | the real dsh `Session` the seam's mirror writes into |
| `status` | the seam's status projected onto dsh's two: `running` while a turn is in flight, `idle` for `starting`/`idle`/`closed` |
| `options` | `{ provider, model }`, a LIVE projection of the seam's snapshot (see "Model switching") |
| `send(msg, target, wakeup)` | `next-turn`+wake → seam `followup`; `next-step`+wake → seam `steer`; `wakeup: false` → seam `inject` |
| `followup(msg)` | `send(msg, 'next-turn', true)` |
| `steer(msg)` | `send(msg, 'next-step', true)` — see "Steering" |
| `inject(msg)` | `send(msg, 'next-step', false)` → SDK `shouldQuery: false` |
| `cancel(cause, opts)` | seam `interrupt({ keepQueued: opts?.keepInbox ?? true })` — see "Cancellation" |
| `whenIdle()` | resolves when no turn runs, no maintenance task holds the phase, and the seam's outbox has nothing queued |
| `runMaintenance(task)` | claims the true-idle phase; a second claim (or a claim while a turn runs) throws **synchronously** |
| `inbox` | dsh's own `Inbox`, over the agent's session — a projection of the seam's outbox |
| `ctx` | an agent-scoped context (`dsh-scope`), carrying `ctx.agent`, unwound on disposal |

Everything above is a **projection** of seam state, never independent bookkeeping: `status` reads
`CcSession.status`, `options.model` reads the snapshot, and the inbox is reconciled from the outbox.
Nothing here can drift from what the subprocess is actually doing.

### Shared identity (D6)

`ctx.agents.enter(agent, owner)` throws unless `agent.id === agent.session.id`. That holds by
construction: the seam mints ONE bare UUID at `open()`, the dsh session is prepared under that exact
id, and `ClaudeCodeAgent`'s constructor refuses the pair if they ever differ — with a message naming
the real cause instead of leaving it to the registry. There is no id map in either direction: dsh
mints, Claude Code receives (Phase 0 spike 1, including forks).

### The inbox is a projection of the outbox

dsh's `Inbox` is durable: every insertion, claim and discard is an `agent/inbox/spliced` event on the
session log. The adapter keeps it honest against a queue it does not own:

| seam outbox state | inbox |
|---|---|
| `queued` | still pending |
| `committed` | **claimed** — `Inbox.claim()`, whose durable event is a pure deletion (a splice would record the message as *canceled*, the opposite of what happened) |
| `cancelled` | **discarded** — a canceled splice, which is exactly what it was |

An `inject` commits at send time (it starts no turn), so it is claimed immediately. A message the
seam refused outright (a closed session) is removed rather than left pending forever, which would
hang `whenIdle()`.

### Cancellation: `keepInbox` defaults to `true` here

`ReactLoopAgent` owns its inbox outright, so `cancel(cause)` with no options clears it. This adapter
does not own the queue — it lives inside the Claude Code subprocess, and `keepQueued: false` is
**emulated** (SDK 0.3.233 exposes no way to drive `interrupt_cancel_queued_v1`): the seam
re-interrupts as each surviving turn starts, capped, and marks what it managed to stop. That is lossy
and costs extra interrupts, so it is opt-in — matching `claude_code_cancel`'s own default
(`keep_queued: true`). **Pass `{ keepInbox: false }` explicitly to drive the drain.**

The inbox is reconciled from the outbox afterwards and never cleared optimistically: a message the
emulated drain could not stop is still going to run, and an inbox claiming otherwise would be a lie
the mirror would contradict a second later.

**The `cause` does not reach Claude Code.** `CcSession.interrupt()` takes no cause parameter (nor
does the SDK's `interrupt()`), so `AgentCancelCause` is used only as an active maintenance task's
abort reason. Every agent-driven interrupt the subprocess actually answers in time is mirrored as
`turn/end { aborted, reason: { kind: 'user' } }` regardless of the real cause; `{ kind: 'disposed' }`
appears only on the mirror's `finalize()` fallback, when the turn was still dangling at close time.
Precise cause attribution in the transcript would need a seam change.

### Model switching

`AgentOptions` is a readonly `{ provider?, model?, maxTokens? }` with no `setModel()` (D7), and dsh's
own model selection rides `installModelSelection()` + the `agent/request` waterfall, which never
fires here (§7.1). So model changes go through a **package-level** method:

```ts
await agent.setModel('claude-sonnet-4-5')   // ClaudeCodeAgent, not Agent
```

which reaches `CcSession.setModel()` (added in Phase 6 as a thin `query.setModel()` passthrough).
`agent.options.model` is a live projection of the seam's snapshot, so it reflects both this call and
whatever model the CLI reports on its next `system/init` — it is **not** the frozen startup snapshot
the Phase 1 scaffold promised.

### Steering ≠ token-level steering (Phase 0 spike 2)

`steer()` maps to `priority: 'now'`, which is **abort-and-refold**, not a mid-generation edit: the
in-flight turn is killed (the SDK reports an `SDKResultMessage` with subtype
`error_during_execution` and empty text) and ONE fresh turn runs both instructions together. The seam
flags that result as an internal artifact and the mirror suppresses it — but **turn-1 tokens are
re-paid**, so steering here is not the cheap operation it is in the dsh loop.

Plain (default-priority) sends mid-turn do not interrupt anything: the current turn completes and the
new message becomes the sole content of its own following turn. That is exactly `followup()`.

### `inject()` → `shouldQuery: false` (S7)

dsh's `inject()` **appends** to a durable inbox and emits `agent/inbox/spliced`; it does not prepend.
The SDK has an exact-shaped native mechanism: `SDKUserMessage.shouldQuery: false` appends to the CC
transcript **without** triggering a turn. Nothing is buffered here and prepended later.

### Non-text content

The seam's send channel is `{ content: string }` — the CLI's stdin protocol has no place for dsh's
richer blocks. `send()` therefore reduces a `UserMessage` to its `text` blocks, and when anything
else was present it records the loss **in the transcript** as a `notice`-form `user/message`
(bounded summary, per dsh's `ContextFormed` rules) as well as logging it. A message carrying **no**
text is not delivered at all and never enters the inbox — there is nothing to send, and a
permanently pending entry would hang `whenIdle()`.

### Turn framing

The mirror owns it: one Claude Code turn is one dsh turn, one model call is one dsh step (seam
README §5.2). The adapter never appends framing events of its own, and reads the current turn number
off the log's last `turn/start` so a turn Claude Code opened by itself (auto-resume, a scheduled
trigger) is attributed correctly.

---

## Spawn and teardown order

`createClaudeCodeAgent()` is mostly an argument about ORDER. Four lifetimes have to be nested, not
raced.

**Spawn**

1. `ctx.claudeCode.open()` **without the prompt** — the seam mints the shared id, and the dsh session
   that must carry it cannot exist first. A prompt passed here would be sent synchronously inside
   `open()`, before any mirror existed, and would be invisible in the dsh log.
2. `ctx.sessions.prepare(id, { meta: { cwd } })` — `prepare` + `enter` + `announce`, not `create()`,
   so the store attachment joins the ONE composite effect below (`SessionStore.prepare`'s own doc
   says exactly this).
3. Construct the `ClaudeCodeAgent`, which mints its `dsh-scope` scope.
4. One composite `ctx.effect`, yielding in this order: session `enter` → mirror + ask target →
   `ctx.agents.register(agent)` → the agent's `scope.rawDispose` → the seam-close disposer.
5. `agent/session-start` (`startup`, or `resume` when opened with `resume`).
6. The opening prompt, through `agent.followup()` — so it lands in the inbox and the mirror exactly
   as any later prompt does.

**Teardown** (cordis disposes composite effects in REVERSE yield order, which is why the yields read
as its inverse):

| # | step | why here |
|---|---|---|
| 1 | `agent.cancel({ kind: 'disposed' })`, then a **bounded** wait for quiescence | disposal IS a disposed-cause cancel followed by quiescence (`dsh-agent-loop`'s own shape). Bounded because a subprocess that already died never emits the result that would settle it, and plugin unload must not hang on one |
| 2 | `ctx.claudeCode.close(id)` | settles pending asks, **finalizes the mirror** (closing a turn the dead session will never finish — a dangling `turn/start` makes the log permanently unappendable), closes the subprocess |
| 3 | the agent scope unwinds | agent-local contributions go after the driver is quiet |
| 4 | the registry detaches → `agent/disposed` | matches `agent/disposed`'s documented position: "after driver quiescence and scoped-registration unwind, but before session detachment" |
| 5 | the session detaches from the store | **last**, because the store attachment installs the publication hooks: detaching earlier would publish none of the closing events step 2 just wrote |

`tests/spawn.spec.ts` asserts step 4's position directly — inside an `agent/disposed` listener, the
session is still in the store, the Claude Code session is already gone, and the mirror's `turn/end`
is already in the log.

**The disposer identity is load-bearing.** `ctx.agents.register()`'s exact return value is yielded
into the composite effect, never a wrapper: a wrapper would leave the unregistration disposing as a
concurrent sibling on owner unload, emitting `agent/disposed` while the final turn was still
draining (`AgentRegistry.register`'s own documentation).

---

## §7.1 — What silently will not work

`agent/pre-step`, `agent/request`, and `agent/request-error` are dispatched **only** from
`ReactLoopAgent`'s loop, wrapped directly around dsh's own `ctx.llm.stream()` call (confirmed against
`packages/core/agent-loop/src/agent.ts` in the harness reference checkout). A CC-backed agent makes
no such call — Claude Code drives its own model requests inside its own subprocess. **Every plugin
that depends on one of these waterfalls or events is silently inert for an agent this package
registers.** No error, no warning: the listener is simply never invoked. The same is true of
`tools/pre-execute` and the rest of `tools/*`, which are dispatched only through `ctx.tools` and
never see a CC tool call at all.

This is the single most important thing to get right when composing plugins with this adapter.
A plugin author who has only ever seen `ReactLoopAgent`-driven agents has every reason to expect
these hooks to work; document it prominently wherever this package is composed with third-party
plugins.

**This package registers no listener for any of them, deliberately** — faking one would let a plugin
author conclude the hook works when the thing it hooks never happens. `tests/inert.spec.ts` measures
that absence as a delta across mounting and spawning, so a future regression cannot slip in quietly.
`INERT_DSH_MECHANISMS` is the exported list.

### Substitutes

| dsh mechanism (inert for CC) | What it normally does | CC-native substitute | Shipped? |
|---|---|---|---|
| `agent/pre-step` | inject context before a step | `agent.inject()` → SDK `shouldQuery: false` | **yes** |
| `agent/request` (model switching) | swap the model per request | `agent.setModel()` → seam `CcSession.setModel()` → SDK `query.setModel()` | **yes** |
| `agent/request` (config replacement) | replace the frozen call config | SDK `applyFlagSettings()` — **note:** system-prompt options are resolved once at CC startup and have **no mid-session effect**; there is no substitute for "change the system prompt mid-session" | no |
| `agent/request-error` (retry) | veto/own model-request retry | CC's own retry ladder; expose `CLAUDE_CODE_MAX_RETRIES` and friends via the seam's `config.env` overlay | no (config only) |
| `tools/pre-execute` (policy: allow/deny/ask) | gate a tool call before it executes | the seam's ask channel: every `canUseTool` prompt is routed to `ctx.approval` / `ctx.userQuestions` (Phase 4) | **yes, differently** |
| `tools/*` (post-execute, result shaping) | observe/shape a tool result | the mirror's `tool/call` + `tool/result` events on the agent's session log — observable, not shapeable | partial |
| (new) permission prompts | — | the ask channel again, with this agent attached as the target (`delegated: false`, because a registered agent is a registry ROOT) | **yes** |

Set `includeHookEvents: true` on the underlying query if you additionally want the raw CC hook
lifecycle to appear in the SDK message stream (useful for debugging the mapping itself, not required
for the mapping to work).

---

## Known impedance mismatches (see also the seam's README)

- **History ownership** — CC compacts its own transcript; the dsh mirror does not rewrite to
  match. After compaction, the mirror is a complete historical record while CC's live context
  is a summary. Treating them as interchangeable is wrong.
- **Approval audit vs CC's own record** — two independent records of the same permission
  decision, neither authoritative over the other.
- **Nested asks** — CC subagents cannot call `AskUserQuestion` at all, and dsh refuses
  `ctx.userQuestions.ask()` for owned (delegated) agents. Depth-2 delegation cannot ask a human;
  design the ask fallback policy accordingly, not as an edge case.
- **A resumed Claude Code session gets a FRESH dsh log.** The adapter always prepares a new dsh
  session, so `resume`/`fork` carries history on the CC side while the mirror starts empty. The two
  are not the same record and never were.

## Model Experience

None, directly: this package registers no tool schema, contributes no system-prompt section, and
puts no text of its own into any model request. Once an agent is published, the model-visible
surface is entirely Claude Code's own — its system prompt, its tool set, its transcript.

The one exception is deliberate and bounded: when a `send()` carries content Claude Code cannot
receive, the adapter appends a `notice`-form `user/message` to the dsh session saying so. That is
mirror content (visible to a human reading the transcript, and to anything deriving messages from
that log), not something added to a Claude Code request — the subprocess never sees it.

#### KV Cache effect

None on Claude Code's side: this package contributes nothing to a CC request, so it cannot
invalidate the subprocess's own prefix cache. On the dsh side the agent's session log is a mirror
that no dsh model request is built from, so there is no prefix to invalidate there either.

## Known Limitations and Deferred Work

- **`keepInbox: false` is best-effort** — the seam's `keepQueued: false` drain is emulated (SDK
  0.3.233 exposes no `cancel_queued`), capped at `still_queued.length + 2` attempts. Messages that
  survive it stay pending in the inbox because they are still going to run. Replace with the native
  path when the SDK exposes it.
- **Disposal's quiescence wait is bounded** (`DEFAULT_DISPOSE_DRAIN_MS`, 5s). A subprocess wedged
  mid-turn is closed anyway rather than wedging plugin unload; the mirror still closes the open turn
  as `aborted`/`disposed`.
- **No `maxTokens`** — `AgentOptions.maxTokens` is never populated: Claude Code owns its own request
  configuration and the SDK exposes no per-request output-token control through `query()`.
- **`agent/turn-stopping` is never dispatched.** Like the §7.1 waterfalls it belongs to the loop's
  step machinery. A listener that steers from it will never run for a CC-backed agent.
- **One inbox target, two seam realities.** `send(msg, 'next-step', true)` maps to a steer, which
  Claude Code implements as abort-and-refold rather than as a step-boundary splice. The inbox target
  is recorded faithfully; the execution semantics are the SDK's.
- **A dead subprocess reaches `idle`** (fixed in Phase 7, in the seam, where it belonged). The seam
  now closes itself when the SDK's iterator completes or throws, so the adapter's existing
  `onClose` subscription carries the transition: the agent reads **`idle`**, a parked `whenIdle()`
  settles, and `runMaintenance()` will claim the phase again. No adapter code changed for this — it
  was always downstream of a close it had no signal to trigger. Disposal stays bounded anyway.
  The `tests/orderings.spec.ts` probe that pinned the OLD behaviour was written to fail exactly when
  the seam learned to self-close, and now asserts the new one.
- **The agent does NOT distinguish how the session ended.** `AgentStatus` is exactly
  `idle | running` and disposal is not a third value (D7), so `closed`, `exited` and `crashed` all
  project onto `idle`. WHY it ended is a seam-level fact: read
  `ctx.claudeCode.get(agent.id)?.closeReason`. Inventing an agent-level distinction would be a third
  status under another name.
- **The agent's own live suite exists** (`tests/live/`, seven specs, `DSH_CC_LIVE=1 pnpm run
  test:live`): basic drive + approval routing, steer refold, `AskUserQuestion`, both `keepInbox`
  defaults, mid-turn dispose, plugin-only HMR, and — Stage 2 of Phase 7 —
  `agent-kill.live.spec.ts`: a real SIGKILL on the spawned agent's subprocess, asserting
  `status` reaches `idle` and `whenIdle()` resolves with no `cancel()`/`dispose()` call at all
  (the LIVE half of the bullet above, observed against a real subprocess rather than the fake
  seam). Phase 7 also added the offline failure injection
  (`packages/claude-code/tests/session-death.spec.ts`, plus the inverted probe in
  `tests/orderings.spec.ts`). The agent-card / UI surface remains open (see the seam's own
  README: cards are structurally not representable in dsh rc.7).
