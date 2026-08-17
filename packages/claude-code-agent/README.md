# @deepseek-ai/dsh-claude-code-agent

The `Agent`-adapter consumer for the DeepSeek Harness: it will publish a `ctx.agents` entry
backed by a live Claude Code session, so a CC session is a first-class citizen a human can talk
to in the dsh UI (spec §7). It depends on the capability seam, `@deepseek-ai/dsh-claude-code`
(`ctx.claudeCode`), and on `@deepseek-ai/dsh-agent`'s registry (`ctx.agents`).

**Ships last.** This package's real behavior lands in **Phase 6**, after the seam's session
actor (Phase 2), the mirror (Phase 3), and the ask/approval wiring (Phase 4) all exist to adapt
against. Every other phase can be built and tested without it.

> **Package naming.** This package is `private: true` and is not published. It keeps the
> `@deepseek-ai/dsh-*` name so that upstreaming into the harness monorepo is a mechanical move
> rather than a rename — we do not own the `@deepseek-ai` npm scope and cannot publish into it.

**Status as of Phase 2: still the Phase 1 scaffold** (the adapter itself lands in Phase 6). `apply()` validates its (currently field-less)
configuration and logs a mount marker with clean teardown. It registers **nothing** with
`ctx.agents` — no `Agent`, no factory call, nothing a listener could observe. The exported
`createClaudeCodeAgent()` has its Phase 6 signature and always rejects with `ClaudeCodeError`
code `NOT_IMPLEMENTED`.

---

## What this package will do (Phase 6)

Implement dsh's `Agent` interface (`@deepseek-ai/dsh-agent`) over a Claude Code session opened
through `ctx.claudeCode`:

| `Agent` member | Planned implementation |
|---|---|
| `id` | the shared `SessionId` (see "Shared identity" below) |
| `session` | the mirrored `dsh-session` `Session` for this CC session |
| `status` | `'running'` from first send until the matching `SDKResultMessage`, else `'idle'` |
| `options` | `{ provider: 'claude-code', model }`; see "No `setModel()`" below |
| `send(msg, target, wakeup)` | pushed to the SDK input stream; `target` recorded in the mirror only |
| `followup(msg)` | send, framed as a new turn (SDK: default-priority queued message) |
| `steer(msg)` | send mid-turn (SDK: `priority: 'now'`) — see "Steering" below |
| `inject(msg)` | appended to the transcript without waking a turn (SDK: `shouldQuery: false`) |
| `cancel(cause, opts)` | interrupt the SDK query; `keepInbox` preserves queued/steering work |
| `whenIdle()` | resolves on `SDKResultMessage` with an empty input queue |
| `runMaintenance(task)` | claims the true-idle phase for compaction/export-style tasks |
| `inbox` | mirror of the agent's own pending queue, reconciled from interrupt receipts |
| `ctx` | the agent-scoped context handed to it at registration |

### Shared identity (D6/D7)

`ctx.agents.enter(agent, owner)` throws unless `agent.id === agent.session.id`. Phase 6 makes
that hold by construction, not by convention: mint the identity once with
`newCcSessionId()` — the seam's `SessionId(randomUUID())` — and hand that *exact* value to
**both** the dsh `Session` this adapter creates **and** the SDK's `options.sessionId` when it
calls `ctx.claudeCode.open()`. There is no id map in either direction (see the seam's README,
"Fork semantics"): dsh mints, CC receives.

Registration itself uses `ctx.agents.register(agent)` for the ordinary case — an
already-constructed `Agent` — reserving `enter()` + `announce()` for the case where the SDK's
async session-open must complete *before* the agent becomes visible to `agent/created`
listeners (setup completes while unpublished, then `announce()` makes it live). Either way,
**the returned disposer's identity is load-bearing**: Phase 6 must yield the *exact* function
`register()`/`enter()` returns into the composite teardown, never a wrapper closure around it —
wrapping it breaks `AgentRegistry`'s internal bookkeeping of which entry it corresponds to.

### No `setModel()` on `AgentOptions` (D7)

`AgentOptions` is a plain readonly `{ provider?, model?, maxTokens? }` — there is no
`setModel()` method, and dsh's own model-switching mechanism
(`installModelSelection()` + the `agent/request` waterfall) **never fires** for a CC-backed
agent (see §7.1 below). So model changes for a live CC session go through the SDK's own
`query.setModel()` / `applyFlagSettings()`, and `options.model` is only ever a **snapshot**
taken at open — it does not update reactively when the model changes mid-session.

### Steering ≠ token-level steering (Phase 0 spike 2)

`steer()`'s closest available mapping is `priority: 'now'`, but it is **not** a mid-generation
edit: the SDK's mid-turn semantics are **abort-and-refold**. Sending with `priority: 'now'`
kills the in-flight turn (the SDK reports it as an `SDKResultMessage` with subtype
`error_during_execution` and empty text), then runs **one fresh turn** containing both the
original instructions and the steering message together. Two consequences the adapter must
handle:

- The mirror must swallow that `error_during_execution` result as an **internal artifact** of
  the steer mechanism, not surface it as a real turn failure.
- Turn-1 tokens are re-paid — steering is not free the way in-context steering would be.

Plain (default-priority) sends mid-turn do **not** interrupt anything: the current turn
completes fully, and the new message becomes the sole content of its own following turn. That
is exactly dsh `followup()` — no special handling needed there. (`priority: 'next'`/`'later'`
were not exercised by the spike; treat them as `followup()`-equivalent until verified.)

### `inject()` → `shouldQuery: false` (S7)

dsh's `inject()` doc says "prepend to the next outbound message"; the reality (confirmed against
`@deepseek-ai/dsh-agent`'s own doc comment) is that it **appends** to a durable inbox and emits
`agent/inbox/spliced` — it does not prepend. The SDK has an exact-shaped native mechanism for
this: `SDKUserMessage.shouldQuery: false` appends content to the CC transcript **without**
triggering a turn, which is precisely dsh `inject()`'s "queue model-facing context without
waking the driver" contract. Phase 6 maps `inject()` sends onto `shouldQuery: false` messages,
not onto a manually-buffered prepend.

---

## §7.1 — What silently will not work

`agent/pre-step`, `agent/request`, and `agent/request-error` are dispatched **only** from
`ReactLoopAgent`'s loop, wrapped directly around dsh's own `ctx.llm.stream()` call (confirmed
against `packages/core/agent-loop/src/agent.ts` in the harness reference checkout). A CC-backed
agent makes no such call — Claude Code drives its own model requests inside its own subprocess.
**Every plugin that depends on one of these waterfalls or events is silently inert for an agent
this package registers.** No error, no warning: the listener is simply never invoked. The same
is true of `tools/pre-execute` and the rest of `tools/*`, which are dispatched only through
`ctx.tools` and never see a CC tool call at all.

This is the single most important thing to get right when composing plugins with this adapter.
A plugin author who has only ever seen `ReactLoopAgent`-driven agents has every reason to expect
these hooks to work; document it prominently wherever this package is composed with third-party
plugins.

### Substitutes

| dsh mechanism (inert for CC) | What it normally does | CC-native substitute |
|---|---|---|
| `agent/pre-step` | inject context before a step | `agent.inject()` → SDK `shouldQuery: false` |
| `agent/request` (model switching) | swap the model per request | SDK `query.setModel()` |
| `agent/request` (config replacement) | replace the frozen call config | SDK `applyFlagSettings()` — **note:** system-prompt options are resolved once at CC startup and have **no mid-session effect**; there is no substitute for "change the system prompt mid-session" |
| `agent/request-error` (retry) | veto/own model-request retry | CC's own retry ladder; expose `CLAUDE_CODE_MAX_RETRIES` and friends via the seam's `config.env` overlay |
| `tools/pre-execute` (policy: allow/deny/ask) | gate a tool call before it executes | CC's `PreToolUse` hook, mapped by this adapter onto the equivalent dsh event name so existing `tools/*` listeners keep seeing traffic |
| `tools/*` (post-execute, result shaping) | observe/shape a tool result | CC's `PostToolUse` hook, mapped the same way |
| (new) permission prompts | — | CC's `PermissionRequest` hook, routed through `ctx.approval` / `ctx.userQuestions` exactly like a dsh-native tool ask |

Set `includeHookEvents: true` on the underlying query if you additionally want the raw CC hook
lifecycle to appear in the SDK message stream (useful for debugging the mapping itself, not
required for the mapping to work).

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

---

## Model Experience

None, directly: this scaffold registers no `Agent`, no tool schema, no system-prompt
contribution, and dispatches no event — there is nothing here yet for a model to see. Once
Phase 6 lands, the model-visible surface is entirely Claude Code's own: its system prompt, its
tool set, its transcript. This package's job is routing and identity, not content it originates.

#### KV Cache effect

None. This package contributes no content to any model request, dsh's or Claude Code's own, so
it cannot invalidate a prefix on either side. (Claude Code manages its own subprocess-local
cache over its own transcript; this package neither feeds nor invalidates it.)

## Known Limitations and Deferred Work

- **`createClaudeCodeAgent()` is unimplemented (lands in Phase 6)** — always rejects with
  `ClaudeCodeError` code `NOT_IMPLEMENTED` and a message naming Phase 6. Its parameter and
  return types (`CcAgentOptions` → `Promise<Agent>`) are final; only the body is a stub.
- **Nothing is registered with `ctx.agents`** — mounting this plugin has no observable effect
  beyond the logged mount/unmount marker. `agent/created`, `agent/disposed`, and every other
  `dsh-agent` event never fire because of this package until Phase 6.
- **§7.1's inert waterfalls have no workaround yet** — because nothing is registered yet,
  the question is moot for now; it becomes live the moment Phase 6 publishes the first agent,
  and the substitutes table above is the contract that phase must satisfy.
- **Turn framing is undecided in code, only in the plan** — the spec review's Phase 6 note says
  to reuse Phase 3's `turn/start`-on-claim / close-on-result framing; nothing in this package
  implements or tests that yet.
- **No real-Loader composition test yet** — `tests/exports.spec.ts` emulates
  `Loader.unwrapExports` verbatim (same pattern as the seam package) rather than booting a real
  `cordis.yml`, for the same reason the seam defers it: under vitest's transform pipeline,
  importing the built `lib/index.js` would load a second copy of cordis and break service
  resolution. Lands with Phase 6 alongside the real agent implementation.
- **`AgentOptions` model snapshot goes stale** — once Phase 6 lands, `options.model` reflects
  only the model at open time; a mid-session `query.setModel()` change is not reflected back
  into `Agent.options` automatically (see "No `setModel()`" above). Any UI reading
  `agent.options.model` for a CC-backed agent must account for this.
