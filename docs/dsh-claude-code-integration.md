# Implementation Spec — `dsh-claude-code`

Bridge Claude Code (Agent SDK) into DeepSeek Harness so a Claude Code session can be
opened, driven, interrupted, and *answered* from inside dsh — both by a human at the dsh
UI and by a DeepSeek agent delegating work.

**Audience:** the implementing agent (Claude Code) working inside a `deepseek-harness`
checkout.

---

## 0. Before you write any code

This spec was written from published documentation. dsh moves fast and the SDK moves
faster. **Verify each of these against the actual source in the checkout / installed
package before relying on it.** Where reality differs from this document, reality wins —
note the delta at the bottom of this file as you go.

### Read first (dsh)

| Path | Why |
|---|---|
| `docs/cordis-primer.md` | plugin = object with `inject` + `apply(ctx)`; dispatch modes; effects |
| `docs/architecture.md` | plugin tree, layering, `packages/` conventions |
| `docs/subsystems/core.md` | `Agent`, `AgentHandle`, `ctx.agents`, `ctx.agentLoop`, `agent/*` events |
| `docs/subsystems/session.md` | the twelve `SessionEvent` variants and `deriveMessages()` |
| `docs/subsystems/approval.md` | `ctx.approval.request()` — **the tool-permission channel** |
| `docs/subsystems/user-questions.md` | `ctx.userQuestions.ask()` — **the clarifying-question channel** |
| `docs/subsystems/plan.md` | how dsh models plan review |
| `docs/subsystems/jobs.md` | `ctx.jobs.start()` — long-running work with owner cleanup |
| `docs/subsystems/subagent.md` | how dsh already models delegated agents |
| `docs/subsystems/credentials.md` | whether CC auth should live here |
| `docs/cookbook/adding-a-package.md` | package scaffolding, naming, build wiring |
| `docs/cookbook/adding-a-tool.md` | `defineTool`, `exec` contract, card presenters |
| `docs/cookbook/extension-cookbook.md` | hook-plugin patterns |
| `packages/shell/tool-bash/` | the three-package production reference; copy its shape |

### Read first (Claude Agent SDK)

| Page | Why |
|---|---|
| `agent-sdk/typescript` | `query()`, the `Query` object, full `Options` table |
| `agent-sdk/user-input` | `canUseTool` routing, `AskUserQuestion` answer encoding |
| `agent-sdk/permissions` | evaluation order, permission modes |
| `agent-sdk/sessions` | resume, fork, `sessionId` |
| `agent-sdk/hooks` | `PreToolUse`/`PostToolUse`/`PermissionRequest`, and the `defer` decision |
| `agent-sdk/streaming-vs-single-mode` | why streaming input is mandatory here |

Also check `@anthropic-ai/claude-agent-sdk` `CHANGELOG.md` — several behaviours below are
version-gated.

### Verify these specific assumptions

1. `SessionId` in dsh — is it a UUID string? The SDK's `options.sessionId` requires a
   UUID. If dsh ids are not UUIDs, you need a bidirectional map instead of shared identity
   (§2).
2. `ctx.approval.request()` still throws when no turn is open.
3. `ctx.userQuestions.ask()` still rejects with `DELEGATED_CALLER` for owned agents.
4. `AgentRegistry.register()` / `enter()` / `announce()` are still usable by a plugin
   outside `dsh-agent-loop` (§7 depends on this; §1–6 do not).
5. Whether `canUseTool`'s third argument carries a request id (`requestId`) in the
   installed SDK version. If it does, use it as the ask key; if not, mint your own.
6. Whether `packages/acp/acp` is an ACP *server* (dsh exposed to editors) or an ACP
   *client*. This spec assumes server, so it is not a route for hosting CC. If it is
   actually a client, stop and re-evaluate — `@zed-industries/claude-code-acp` would be a
   cheaper integration than this whole plugin.

---

## 1. What we are building, and what we are not

### Goals

- Open a Claude Code session from dsh, with a chosen cwd, model, and permission mode.
- Stream its output into the dsh session log so it renders in the Trajectory view.
- Send follow-ups and mid-turn steering into a live session.
- **Answer the things Claude Code asks** — tool-permission prompts, clarifying questions,
  and plan approval — through dsh's existing approval and user-question seams, not a
  bespoke channel.
- Interrupt, resume, fork, and dispose cleanly.
- Expose the same capability two ways: as model-facing tools (a DeepSeek agent delegates)
  and as a first-class `Agent` (a human drives it).

### Non-goals

- **Do not** implement Claude Code as an LLM provider adapter behind `ctx.llm`. CC is an
  agent loop with its own tools and its own history; nesting it inside dsh's loop produces
  two loops fighting over one session log. This is the single most important architectural
  decision in this document.
- Do not attempt to make CC's history derivable from dsh's session log (§8.1).
- Do not reimplement CC's tools inside dsh.

---

## 2. Package layout

Follow `packages/shell/tool-bash`'s three-package split.

```
packages/claude-code/
  claude-code/            → @deepseek-ai/dsh-claude-code
                            The seam: types, `ctx.claudeCode` service, the session actor,
                            event declarations. No model-facing surface.
  tool-claude-code/       → @deepseek-ai/dsh-tool-claude-code
                            Model-facing delegation tools. inject: ['tools','claudeCode']
  claude-code-agent/      → @deepseek-ai/dsh-claude-code-agent
                            The CC-backed `Agent` adapter. inject: ['agents','claudeCode']
                            Ship last; §1–6 are useful without it.
```

Rationale for the split: the tool package and the agent package are independently
mountable. A headless/CI composition wants the tools and not the agent; a UI composition
wants both. Nothing outside `claude-code/` may import the SDK directly.

Dependency: `@anthropic-ai/claude-agent-sdk`. It ships a native CLI binary as an optional
platform dependency — document this in the package README, because it roughly doubles
install size on Linux under package managers that ignore npm's `libc` field, and it fails
outright with `Native CLI binary for <platform> not found` when optional deps are skipped.
Expose `pathToClaudeCodeExecutable` in config as the escape hatch.

---

## 3. The session actor

One `CcSession` object per live Claude Code session. It owns the SDK `Query`, the input
stream, and the pending-ask table.

### 3.1 Streaming input is mandatory

`canUseTool`, `interrupt()`, `setModel()`, `setPermissionMode()`, and
`applyFlagSettings()` are **only available in streaming input mode**. Pass an
`AsyncIterable<SDKUserMessage>` as `prompt`, never a string. Implement a pushable async
iterable (a queue + a resolver) that never completes until the session is disposed — if
the input stream closes, the SDK closes stdin and permission callbacks stop being
deliverable.

### 3.2 Construction

```ts
this.query = query({
  prompt: this.inputStream,
  options: {
    sessionId,                    // === dsh SessionId, see §2 verification item 1
    resume, forkSession,          // for resume/fork
    cwd,
    model,
    permissionMode,               // 'default' | 'plan' | 'acceptEdits' | 'dontAsk' | 'auto'
    systemPrompt: { type: 'preset', preset: 'claude_code', append: config.appendPrompt },
    settingSources: config.settingSources ?? [],   // default: full isolation
    includePartialMessages: true, // needed for assistant/chunk mirroring
    canUseTool: this.#route.bind(this),
    hooks: this.#hooks(),
    env: this.#env(),             // see §6
    stderr: (d) => ctx.logger.debug(d),
    abortController: this.abort,
  },
})
```

Use `startup()` to pre-warm a subprocess at plugin mount when config enables it, then
`warm.query(stream)` on first open. Subprocess spawn + initialize is otherwise paid
inline on the first message and is very visible in a UI.

### 3.3 Lifecycle

- `open()` — construct, then `await query.initializationResult()`; cache
  `commands`, `models`, `agents`, `account` for the service surface.
- `send(message, { steering })` — push an `SDKUserMessage` onto the input stream.
  dsh's `followup` / `steer` / `inject` all become sends; the distinction is preserved in
  the mirrored session log, not in the SDK call.
- `interrupt()` — see §5.4.
- `close()` — settle all pending asks as deny, then `query.close()`.
- Everything registered through `ctx.effect()` so plugin unload tears every session down.

### 3.4 Register the session as a job

When a session is opened from a tool call, register it via
`ctx.jobs.start({ kind: 'claude-code', label, owner: exec.agent, run })`. This gets you
`job_kill`, owner-disposal cleanup, and the session fence for free, and it is the
idiomatic dsh answer to "a tool started something that outlives the call". Return the
typed handle (`{ kind: 'background', jobId, ccSessionId }`) — never make callers parse
prose for the id.

Note the jobs contract: once `ctx.jobs.start()` publishes the id, use the task-owned
cancellation signal, **not** `exec.signal`. Cancelling the outer tool call must not kill
a published Claude Code session.

---

## 4. The ask channel — the core of this integration

Claude Code asks for three different things through **one** callback. Route them to three
different dsh seams.

```
canUseTool(toolName, input, { signal, suggestions })
  │
  ├─ toolName === 'AskUserQuestion'  → ctx.userQuestions.ask()          → §4.2
  ├─ toolName === 'ExitPlanMode'     → ctx.userQuestions.ask() w/ intent → §4.3
  └─ everything else                 → ctx.approval.request()            → §4.1
```

`canUseTool` fires only when the SDK's permission flow falls through to a prompt:
`PreToolUse` hook → deny rules → allow rules → ask rules → permission mode → `canUseTool`.
It does **not** fire for tools auto-approved by `allowedTools` or by `acceptEdits` /
`bypassPermissions`. Two exceptions that always reach it: `AskUserQuestion`, and MCP tools
marked `requiresUserInteraction`. In `dontAsk` mode those are denied without invoking the
callback at all.

### 4.1 Tool permission → `ctx.approval`

```ts
const outcome = await ctx.approval.request({
  agent,                    // §4.5
  toolName,
  callId,                   // §4.4 — links the prompt to the already-streamed tool call
  reason: describeCall(toolName, input),
  signal,                   // the SDK's abort signal, passed straight through
})
return outcome === 'allowed-once'
  ? { behavior: 'allow', updatedInput: input }
  : { behavior: 'deny', message: denyMessage(outcome) }
```

Both sides are fail-closed and the mapping is exact:

| `ApprovalOutcome` | `PermissionResult` |
|---|---|
| `allowed-once` | `{ behavior: 'allow', updatedInput: input }` |
| `rejected` | `{ behavior: 'deny', message: 'User rejected this action' }` |
| `cancelled` | `{ behavior: 'deny', message: 'Request withdrawn' }` |
| `unavailable` | `{ behavior: 'deny', message: 'No approver available' }` |

**Always send `updatedInput` on allow.** Before Claude Code v2.1.207 an allow without it
was rejected as a deny with a raw Zod error.

**Hard constraint: `ctx.approval.request()` requires an open turn** on the requesting
agent's session — it appends an `approval/asked` / `approval/decided` audit pair and
rejects before appending anything if the session is idle. Consequences:

- In the **tool-delegation** shape (§6), the caller's turn is open by construction. Fine.
- In the **Agent-adapter** shape (§7), you must have opened a turn on the mirrored session
  before the first tool call arrives. Open `turn/start` when a user message is claimed and
  close it on `SDKResultMessage` (§5.2).
- If no turn is open, **do not** let the rejection propagate as an unhandled error — it
  will hang the CC session forever. Catch it and deny with a message that explains the
  state.

Pass `suggestions` through: on an "always allow" decision, filter for
`destination === 'localSettings'` and echo them back in `updatedPermissions` so future
sessions in that project skip the prompt. Only do this when the dsh answerer actually
expressed "always" — dsh's `allowed-once` deliberately does not.

### 4.2 Clarifying questions → `ctx.userQuestions`

`AskUserQuestion` input:

```json
{ "questions": [ { "question": "...", "header": "≤12 chars",
                   "options": [ { "label": "...", "description": "...",
                                  "preview": "optional, TS only" } ],
                   "multiSelect": false } ] }
```

Limits: 1–4 questions, 2–4 options each. Not available inside CC subagents.

Map to `AskUserQuestionRequest`:

| CC field | dsh `AskUserQuestionItem` |
|---|---|
| `question` | `question` — **and use it verbatim as `id`** (§4.2.1) |
| `header` | `header` |
| `options[].label` | `options[].label` |
| `options[].description` | `options[].description` |
| `multiSelect` | `multiSelect` |
| `options[].preview` | drop, or render into `detail` if the UI can take HTML |

Map the answer back:

```ts
const answers: Record<string, string | string[]> = {}
for (const item of answer.answers) {
  answers[item.id] = item.custom ?? (
    question.multiSelect ? item.selected : item.selected.join(', ')
  )
}
return { behavior: 'allow', updatedInput: { questions: input.questions, answers } }
```

Rules that bite:

- **`answers` is keyed by the question *text*, not by index or header.** Passing the
  original `questions` array back through is required for tool processing.
- dsh's `custom` (free-text "Other") maps onto CC's per-question free text: put the user's
  text in `answers[question]` — never the literal word "Other".
- For single-select, dsh says `custom` overrides `selected`. Honour that.
- dsh allows an answer item with empty `selected` and no `custom` (a skipped question).
  CC has no per-question skip. Either omit that key from `answers`, or set the top-level
  `response` field to a freeform string — when `response` is set, Claude receives
  "The user responded: …" instead of the per-question list. Prefer omission; use
  `response` only if the dsh UI offers a "dismiss and reply" affordance.

#### 4.2.1 Question ids

CC's answer encoding is keyed by question text, so the safest `id` is the question text
itself. If two questions in one call carry identical text (possible, if unlikely), suffix
the id and keep a local id→text map for the reverse mapping. Do not use array indices —
dsh explicitly promises stable ids so batched answers stay routable.

### 4.3 Plan approval → `ctx.userQuestions` with `plan-review`

dsh has a first-class presentation intent for exactly this:

```ts
{
  id: 'plan',
  question: 'Approve this plan?',
  detail: input.plan,                      // the plan markdown — required for an intent
  options: [{ label: 'Approve' }, { label: 'Keep planning' }],
  intent: { kind: 'plan-review', approve: 'Approve' },
}
```

`ask()` rejects an `approve` value that names none of the question's own options, and
rejects an intent on a question with no `detail`. Both are easy to get wrong; assert them
in tests.

On approve, allow the `ExitPlanMode` call. On decline, deny with the user's reasoning if
they typed any (`custom`) so Claude can revise rather than guess.

Check whether `docs/subsystems/plan.md` defines a dsh-side plan state that should also be
updated. If it does, wire it; do not invent a parallel plan concept.

### 4.4 `callId` correlation

dsh's `ApprovalRequest` deliberately omits tool arguments — the answerer is expected to
attach the prompt to the tool call the UI *already streamed*, via `callId`. So the mirror
must emit the `tool/call` session event **before** the approval request lands.

Ordering in practice: the SDK emits the assistant message containing the `tool_use` block,
then `canUseTool` fires for it. Maintain `Map<cc_tool_use_id, CallId>` populated by the
mirror (§5.3) and read by the router. If the router finds no entry — a race, or a tool
call CC never surfaced as a block — synthesize the `tool/call` event first, then request
approval. Never request approval with a `callId` the UI has not seen.

If the installed SDK does not expose the tool-use id to `canUseTool`, correlate on
`(toolName, deepEqual(input))` against the most recent unmatched call, and log loudly when
that heuristic is exercised. Re-check on SDK upgrades.

### 4.5 Which agent, and the delegation trap

`ctx.userQuestions.ask()` rejects with:

- `CALLER_NOT_LIVE` — the supplied agent is not the registry's exact live instance
- `DELEGATED_CALLER` — the agent is *owned by another agent*, i.e. a subagent, which has
  no human answerer and would block forever

This matters: if a DeepSeek subagent delegates to Claude Code and Claude Code asks a
clarifying question, `ask()` throws. **Handle it.** Configured fallback policy per session:

| `askFallback` | Behaviour when no human can answer |
|---|---|
| `deny` (default) | deny with a message telling Claude to proceed on its best assumption |
| `first-option` | answer each question with its first option; log the auto-answer |
| `error` | fail the delegating tool call with a clear message |

The same fallback covers `ApprovalOutcome === 'unavailable'`.

### 4.6 Pending, timeouts, and idempotency

- **The callback may pend indefinitely.** The SDK only cancels the wait when the query is
  cancelled. That is fine for a human at a UI and fatal for an unattended run.
- Configure `askTimeoutMs` (default: none for interactive sessions, 120 000 for
  tool-delegated ones). On timeout, apply `askFallback` and settle.
- Register the SDK-supplied `signal`'s abort to settle the ask as deny/cancel. dsh's
  approval seam treats an aborted signal as `'cancelled'` and discards a late answer, so
  both sides agree.
- **Make settlement idempotent per request.** `reinitialize()` and the
  `pending_permission_requests` array on reconnect will redeliver asks your callback has
  already seen. Keep the ask table keyed by request id and make a repeat delivery return
  the already-computed result rather than opening a second dsh prompt.
- For the "user might take hours" case, evaluate the `defer` hook decision, which lets the
  process exit and resume later from the persisted session. Out of scope for v1 but design
  the ask table so it can be added — do not close over live objects you cannot rebuild.

---

## 5. Mirroring into the dsh session log

### 5.1 The rule

The dsh session log for a CC-backed session is a **mirror, not a source of truth**. Write
this in the package README in exactly those words. dsh's normal invariant — everything the
model sees is rebuildable from the log — does not hold here, because Claude Code owns its
own history and compacts it independently.

Do not attempt to drive a CC request from `deriveMessages()`. Anything downstream that
assumes it can will be silently wrong the first time CC auto-compacts.

### 5.2 Turn framing

| SDK signal | dsh event |
|---|---|
| user message pushed into the input stream | `turn/start` (if none open) + `user/message` |
| first assistant activity after a turn opens | `step/start` |
| `SDKResultMessage` | `step/end`, `turn/end` |
| `SDKCompactBoundaryMessage` | log a distinct marker; see §8.1 |

CC's notion of a turn is coarser than dsh's step loop. Do not try to reproduce dsh's
step semantics exactly — one CC turn maps to one dsh turn with one or more steps, framed by
tool-call boundaries. Document the approximation.

### 5.3 Content

| SDK message | dsh event |
|---|---|
| `stream_event` (partial) | `assistant/chunk` |
| `SDKAssistantMessage` | `assistant/message` |
| `tool_use` block | `tool/call` — record `cc_tool_use_id → CallId` (§4.4) |
| `tool_result` block | `tool/result` |
| thinking blocks | `assistant/chunk` with the reasoning marker dsh uses |
| `SDKSystemMessage` (init) | `request/header` or session metadata, whichever fits |
| todo writes | `todo/write` if the shape matches; otherwise skip |

Subagent traffic: by default only `tool_use`/`tool_result` from CC subagents is emitted.
Set `forwardSubagentText: true` if you want the nested transcript, and carry
`parent_tool_use_id` into whatever dsh uses for nested presentation.

### 5.4 Cancellation

Order matters:

1. Settle every pending ask as deny/cancel (otherwise you race the interrupt against a
   held promise).
2. `await query.interrupt()`.
3. Read the receipt. On CLIs advertising `interrupt_receipt_v1`, it returns
   `{ still_queued: string[], cancelled?: string[] }` — the UUIDs of user messages that
   **survive** the interrupt and will each run as their own turn.
4. Reconcile: anything in `still_queued` stays pending in the mirrored inbox; anything
   absent is gone. **Do not resend a message listed in `still_queued`** — you get a
   duplicate turn.

Caveats on the receipt, straight from the docs: only messages enqueued with a UUID appear;
an empty array does not mean nothing else will run; only main-thread messages are listed;
and it can contain UUIDs you never sent (scheduled task triggers) — ignore unknown ids
rather than treating them as errors.

Map `cancel({ keepInbox: true })` onto a plain `interrupt()`; `keepInbox: false` onto the
control-protocol `cancel_queued: true` variant if the CLI advertises
`interrupt_cancel_queued_v1`, else interrupt and then explicitly discard.

---

## 6. Model-facing tools (`dsh-tool-claude-code`)

Register with `defineTool`. Follow the `execute` contract: typed args, one canonical JSON
return value, `output.render` for model-facing prose, `presentCall`/`presentResult` for
cards, presenters **pure** (they run on replay — no I/O, no clock, no session reads).

| Tool | Args | Canonical return |
|---|---|---|
| `claude_code_open` | `cwd`, `prompt`, `model?`, `permission_mode?`, `resume?`, `fork?`, `background?` | `{ session_id, job_id? , status }` |
| `claude_code_send` | `session_id`, `message`, `mode: 'followup'\|'steer'` | `{ status }` |
| `claude_code_wait` | `session_id`, `timeout_ms?` | `{ status, result?, usage?, cost_usd? }` |
| `claude_code_status` | `session_id` | `{ status, pending_asks, context_usage }` |
| `claude_code_cancel` | `session_id`, `keep_queued?` | `{ still_queued: string[] }` |
| `claude_code_close` | `session_id` | `{ closed: true }` |

Design notes:

- Synchronous mode (`background: false`) runs `open` → wait for `SDKResultMessage` →
  return the result text. This is the common delegation case and should be the default.
- Background mode returns `{ kind: 'background', jobId }` per the jobs contract and lets
  the DeepSeek agent poll or get notified.
- Use `exec.agent.inject({ content, source: { kind: 'plugin', plugin: 'dsh-claude-code' } })`
  to push CC progress into the delegating agent's next request. Remember: `inject` is
  **not a wake-up** — an idle agent stays idle. Guard against disposed agents with
  try/catch.
- Card presenters: mirror CC's own tool calls into dsh cards where the shape matches —
  `terminal` for CC `Bash`, `diff` for CC `Write`/`Edit`. This is where the integration
  stops feeling bolted on.
- Do not build permission policy into the tool. Use `tools/pre-execute` for allow/deny/ask
  policy over *these* tools, and let §4 handle policy inside the CC session.

---

## 7. The `Agent` adapter (`dsh-claude-code-agent`)

Ship this last. It is what makes a CC session a first-class citizen a human can talk to in
the dsh UI.

Implement dsh's `Agent` interface over a `CcSession`:

| `Agent` member | Implementation |
|---|---|
| `id` | the shared `SessionId` |
| `session` | the mirrored session (§5) |
| `status` | `running` from first send until `SDKResultMessage`, else `idle` |
| `options` | `{ provider: 'claude-code', model }`; `setModel()` on change |
| `send(msg, target, wakeup)` | push to the input stream; `target` recorded in the mirror only |
| `followup(msg)` | send, framed as a new turn |
| `steer(msg)` | send mid-turn |
| `inject(msg)` | buffer; prepend to the next outbound `SDKUserMessage` |
| `cancel(cause, opts)` | §5.4 |
| `whenIdle()` | resolves on `SDKResultMessage` with an empty input queue |
| `runMaintenance(task)` | claim the idle phase; used for compaction/export tasks |
| `inbox` | mirror of your own pending queue, reconciled from interrupt receipts |
| `ctx` | the agent-scoped context from `setup` |

Publish through `ctx.agents.enter(agent, owner)` → `setup` → `ctx.agents.announce(agent)`
so setup completes while the agent is unpublished, and assign the returned detach closure
into the composite teardown *at the right yield position* — yielding a wrapper instead of
the exact disposer leaves unregistration racing the final turn drain.

### 7.1 What silently will not work

`agent/pre-step` and `agent/request` are waterfalls around **dsh's** model call. A
CC-backed agent makes no such call, so every plugin depending on them is inert for it.
Document this prominently and provide the substitutes:

| dsh mechanism | CC substitute |
|---|---|
| `agent/pre-step` context injection | `inject()` buffer prepended to the next message |
| `agent/request` model switching | `query.setModel()` / `applyFlagSettings()` |
| `agent/request` config replacement | `applyFlagSettings()` (note: system-prompt options are **resolved once at startup** and have no mid-session effect) |
| `tools/pre-execute` policy | CC `PreToolUse` hooks, mapped into dsh events |
| `agent/request-error` retry | CC's own retry ladder; expose `CLAUDE_CODE_MAX_RETRIES` etc. via config |

Map CC's `PreToolUse` / `PostToolUse` / `PermissionRequest` hooks onto the equivalent dsh
event names so existing listeners keep seeing tool traffic. Set `includeHookEvents: true`
if you want the hook lifecycle in the message stream.

---

## 8. Known impedance mismatches — write these in the README

### 8.1 History ownership

CC owns and compacts its own transcript. `SDKCompactBoundaryMessage` tells you it happened
but the dsh log has no corresponding rewrite. After a compaction, the dsh mirror is a
*complete historical record* while CC's live context is a *summary*. Anything that assumes
those are the same thing is wrong. Log the boundary distinctly so the Trajectory view can
render it.

### 8.2 Fork semantics

dsh forks via seed replay on a new `SessionId`; CC forks via `resume` + `forkSession: true`,
minting a new session id server-side. These can be aligned but not made identical. Decide
one direction — CC's id wins, dsh mirrors it — and document it.

### 8.3 Approval audit vs CC's own record

dsh appends `approval/asked` / `approval/decided` to the mirror. CC records its own
permission decisions in its transcript. Two records of the same decision, neither
authoritative over the other. Acceptable; just do not let the UI imply otherwise.

### 8.4 Nested asks

CC subagents cannot use `AskUserQuestion` at all, and dsh refuses `ask()` for owned agents.
Two independent restrictions with the same practical effect: **depth-2 delegation cannot
ask a human.** Design the fallback policy (§4.5) accordingly rather than treating it as an
edge case.

---

## 9. Authentication (Max plan)

The SDK spawns the bundled Claude Code binary, which picks up the local subscription login.
Two things to get right:

1. **`options.env` replaces the subprocess environment rather than merging.** Always spread
   `{ ...process.env, ... }` or you lose `PATH` and the login stops resolving.
2. **Strip `ANTHROPIC_API_KEY`** from the env you pass, unless config explicitly selects
   API-key auth. Leaving it set silently bills the API instead of using the subscription —
   a failure mode with no error message.

Expose an `auth: 'subscription' | 'api-key'` config key that makes the choice explicit, and
surface `query.accountInfo()` through `ctx.claudeCode` so a user can confirm which is live.
Consider storing any API key through `ctx.credentials` rather than raw config.

**Distribution note for the README:** Anthropic's Agent SDK terms state that third-party
developers may not offer claude.ai login or subscription rate limits in their products
without prior approval. Running this plugin on your own machine against your own
subscription is ordinary use. Publishing it as a plugin that others point at *their* Max
plans is the case that note is about — say so in the README so nobody is surprised.

---

## 10. Configuration schema

```yaml
claude-code:
  executablePath: null            # pathToClaudeCodeExecutable escape hatch
  prewarm: true                   # startup() at mount
  auth: subscription              # subscription | api-key
  defaults:
    model: null                   # null = CLI default
    permissionMode: default
    settingSources: []            # [] = full isolation; ['project'] loads CLAUDE.md
    appendSystemPrompt: null
    effort: null
  ask:
    timeoutMs: null               # null = pend indefinitely (interactive)
    delegatedTimeoutMs: 120000
    fallback: deny                # deny | first-option | error
    persistAlwaysAllow: true      # echo localSettings suggestions back
  limits:
    maxConcurrentSessions: 4
    maxBudgetUsd: null
  env:
    API_TIMEOUT_MS: null
    CLAUDE_CODE_MAX_RETRIES: null
```

Note `settingSources: []` as the default. The SDK loads nothing by default and that is the
right posture for an embedded agent; opting into `['project']` is what makes `CLAUDE.md`
apply, and it should be a deliberate choice, not an accident.

---

## 11. Build order

Each phase should be independently mergeable and testable.

1. **Scaffold.** Three packages, config schema, `ctx.claudeCode` service stub, README with
   §8 and §9 written *first*.
2. **Session actor.** Open, stream, send, interrupt, close. Verify against a real CC
   session with `canUseTool` returning a hardcoded allow. No dsh integration yet.
3. **Mirror.** §5. Verify the Trajectory view renders a CC session sensibly.
4. **Ask channel.** §4. This is the phase to spend real time on. Ship §4.1 and §4.2 before
   §4.3.
5. **Tools.** §6, synchronous mode first, background/jobs second.
6. **Agent adapter.** §7.
7. **Cards.** Terminal and diff presenters for CC's `Bash`/`Write`/`Edit`.

---

## 12. Test plan

Follow `docs/testing.md` and the owning package's test documentation — a shipped
model- or UI-visible change requires the assembled coverage specified there.

Unit / contract:

- Ask router dispatches each of the three kinds to the right seam.
- `ApprovalOutcome` → `PermissionResult` table, all four rows, including `updatedInput`
  present on every allow.
- `AskUserQuestion` round trip: multi-select joined correctly, `custom` overrides
  `selected` on single-select, `questions` passed through unchanged, answer keys are
  question text.
- `plan-review` intent rejected when `approve` names no option, and when `detail` is absent.
- Idempotent ask settlement: deliver the same request id twice, assert one dsh prompt.
- Fallback policy fires on `DELEGATED_CALLER`, `CALLER_NOT_LIVE`, `unavailable`, and
  timeout.
- Approval requested with no open turn → denies with a message, does not throw upward.
- Interrupt receipt reconciliation, including unknown UUIDs in `still_queued`.
- Env construction: `PATH` survives, `ANTHROPIC_API_KEY` stripped under
  `auth: subscription`.

Integration (real CC subprocess, marked slow):

- Permission prompt end to end, allow and deny.
- Clarifying question end to end, including free text.
- Plan mode: `permissionMode: 'plan'` → questions → `ExitPlanMode` → approve → execution.
- Steering mid-turn changes behaviour.
- Interrupt during a long `Bash` call leaves the session usable.
- Resume: close, reopen with `resume`, assert continuity.
- Plugin unload disposes every live session and kills every subprocess.

Failure injection:

- Kill the CC subprocess mid-turn; assert the dsh agent reaches `idle` and pending asks
  settle.
- Never answer an ask; assert timeout + fallback and no leaked promise.
- Answer an ask after the query is cancelled; assert the late answer is discarded.

---

## 13. Deltas from this spec

Record anything you find that contradicts this document, with the source you checked.

Full verification report with citations: `docs/spec-review-and-plan.md` (2026-08-17, against
SDK 0.3.233 / CLI 2.1.233 / harness rc.5 working tree + published rc.7). Headline rows:

| Item | Spec said | Reality | Source |
|---|---|---|---|
| §0.1 SessionId | maybe UUID; else bidirectional map | Branded string, NOT UUID — but caller-supplied ids are first-class; mint `SessionId(randomUUID())` ourselves (ACP precedent), no map needed | `packages/core/session/src/types.ts:22`; `packages/acp/acp/src/index.ts:254` |
| §0.5 requestId | may not exist | Exists, plus `toolUseID`, `title`, `decisionReason` — §4.4 heuristic unnecessary | `sdk.d.ts:206-266` |
| §0.6 acp | server (assumed) | Confirmed server; but `subagent-acp` is an ACP client, and **`dsh-subagent-claude-code` already exists in-tree** (one-shot delegation, SDK 0.3.220, disabled in presets) — reuse its process/env code | `packages/subagent/subagent-claude-code/` |
| §10 settingSources | "SDK loads nothing by default" | Omitted = ALL sources loaded; `[]` must be passed explicitly for isolation | `sdk.d.ts:1980-1989` |
| §4.3 ExitPlanMode | `input.plan` | Untyped in .d.ts but live probe (2.1.233) confirms `{ plan, planFilePath }` at runtime | live probe |
| §4.2 answer encoding | text-keyed `answers` + `questions` passthrough | Confirmed by live probe end-to-end | live probe |
| §2 layout | "tool-bash three-package split" | tool-bash is one package; the trio is Definition/Provider/Consumer across the shell group; no `@deepseek-ai/dsh-core` exists | `packages/shell/README.md` |
| §3.4 jobs | `owner: exec.agent`; task-owned signal | `owner` optional — conditional spread required; cancellation channel is `JobHooks.cancel`; **`dsh-tool-jobs` must be loaded or `start()` throws**; `JobKindMap` merge needed | `packages/jobs/*` |
| §7 Agent | `options` + `setModel()` | `AgentOptions` readonly, no setModel; dsh model switching rides `agent/request` (inert for us) — CC-side `query.setModel()` only | `packages/core/agent/src/runtime-types.ts:24-31` |
| §7 inject | "prepend to next message" | dsh inject appends via durable inbox; better SDK mapping: `SDKUserMessage.shouldQuery:false` | `sdk.d.ts:4865+`; `agent.ts:130` |
| §5.2 events | "twelve variants" | 13 core + 46 build-wide; `steering/message` gone; reasoning = `reasoning-delta` chunk type; 4 `compaction/*` events | `packages/core/session/src/types.ts:236-333` |
| §5.3 mirror table | 7 SDK message kinds | ~38-variant union — default-ignore branch mandatory | `sdk.d.ts:4273` |
| (new) plugin shape | — | `export default` drops `inject` (post-mortem 0001) — named exports only | `docs/postmortem/0001-*` |
| (new) publishing | monorepo assumed | `@deepseek-ai/*@0.1.0-rc.7` published to npm; out-of-tree development viable via profiles | npm registry |
