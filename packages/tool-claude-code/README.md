# @deepseek-ai/dsh-tool-claude-code

Model-facing tools over the [`@deepseek-ai/dsh-claude-code`](../claude-code/README.md) capability seam (`ctx.claudeCode`): `claude_code_open`, `claude_code_send`, `claude_code_wait`, `claude_code_status`, `claude_code_cancel`, and `claude_code_close`.

This package is `private: true` and keeps the `@deepseek-ai/dsh-*` name for future upstreaming — we cannot publish into the `@deepseek-ai` scope ourselves.

The plugin stays pending until both injected services exist (`inject: ['tools', 'claudeCode']`): a `ToolRuntime` (`@deepseek-ai/dsh-tools`) and the Claude Code seam. Three further services are read opportunistically with `ctx.get(...)`, so the plugin mounts fine without any of them:

| Service | When present | When absent |
|---|---|---|
| `ctx.sessions` | every opened session is mirrored into a dsh session log **sharing its id** | the session runs unmirrored (no UI replay, no `callId` correlation for approvals) |
| `ctx.agents` | `delegated` is decided against `agents.roots()` | every ask target is `delegated: true` (the honest answer: nothing can prove a human is attached) |
| `ctx.jobs` | `background: true` registers the session as a dsh job | `background: true` fails with `CC_NO_JOBS` naming the packages to load |

It never imports `@anthropic-ai/claude-agent-sdk` — only `packages/claude-code` may. `@deepseek-ai/dsh-jobs` is a peer dependency for **types only** (the `Context` augmentation and the `JobKindMap` merge); there is no runtime import of it.

**Status: complete (Phase 7, final). Every tool body is live.** The schemas are the contract Phase 1 froze, plus three additive changes: `claude_code_open`'s session branch gained three optional fields (`result`, `usage`, `cost_usd`) in Phase 5, because synchronous mode now returns the turn it waited for; `claude_code_status` gained an optional `close_reason` in Phase 7, because a subprocess can now close its own session and the model needs to be told which of `closed` / `exited` / `crashed` happened; and all three of `claude_code_open` / `_wait` / `_status` gained pending-ask reporting (see below). Nothing has been removed or retyped.

### An unfinished turn is a value, not an error (read this second)

The most common reason a Claude Code session is "not done yet" is that **a human has not answered a permission prompt in the dsh UI**. That is a normal state of this integration, so the tools express it as data:

- `claude_code_wait` defaults to a **60-second** wait (not the 10-minute ceiling) and, when it elapses, RESOLVES with `{ status: 'running', session_id, pending_asks, pending_ask_details }`.
- Synchronous `claude_code_open` does the same at its own `SYNC_OPEN_TIMEOUT_MS` ceiling: the session branch, `status: 'running'`, the pending-ask fields, and no `result`.
- `claude_code_status` always carries `pending_ask_details` (empty when nothing pends).

Each entry is `{ kind: 'permission' | 'question' | 'plan', tool_name?, reason?, waiting_ms }`, where `reason` is **the same sentence the human is being shown** (`"Write: /private/tmp/scratch/notes.txt"`). The rendered text names the tool, the reason, how long it has been pending, and says plainly that a person must answer in the dsh web UI and that calling `claude_code_wait` again — not cancelling, not opening a new session — is the next step.

Both paths used to throw `CC_TIMEOUT` after a ten-minute block, and that code no longer exists. A production trace is why: a delegating model read the throw as a failure, cancelled the turn and opened a fresh session, three times over ~30 minutes, while the original `Write` approval sat unanswered and only a *count* of pending asks was ever exposed.

## Session lifecycle (read this first)

A Claude Code session **outlives the tool call that opened it**, in every mode. `claude_code_open` returns when the opening turn finishes (or immediately, when opened idle); the session stays open for `claude_code_send` follow-ups until one of:

- `claude_code_close` — the explicit end (settles pending asks as denied, then closes the SDK query);
- the seam's teardown effect — plugin unload, HMR, or process shutdown;
- `job_kill` (or owner disposal) — for a session opened with `background: true`.

Aborting the tool call does **not** close the session, and neither does an elapsed wait. If you stop caring about a session, close it: an open session holds a subprocess and, on a subscription, a session slot.

## Tools

### `claude_code_open`

Open a new session, or resume (optionally fork) an existing one, rooted at a working directory.

| Arg | Type | Notes |
|---|---|---|
| `cwd` | string (required) | Absolute working directory the session runs in. |
| `prompt` | string | First user message. Omit to open idle and send later. |
| `model` | string | Model id override; omit for the deployment default. |
| `permission_mode` | string enum | One of `CC_PERMISSION_MODES`; omit for the deployment default. |
| `resume` | string | An existing Claude Code session id (bare UUID) to resume. |
| `fork` | boolean | Fork the resumed session instead of continuing it; the source is untouched. |
| `background` | boolean | Run detached as a dsh job instead of synchronously. |

Output is a const-discriminated `oneOf`: `{ kind: 'session', session_id, status, result?, usage?, cost_usd?, pending_asks?, pending_ask_details? }` or `{ kind: 'background', jobId, ccSessionId }` — the same idiom `@deepseek-ai/dsh-tool-bash`'s `bash` tool uses for its foreground/background split.

**Synchronous mode (the default).** Opens, attaches the mirror, sends `prompt`, waits up to `SYNC_OPEN_TIMEOUT_MS` (10 minutes) for the turn, and returns its final text with usage/cost when the SDK reported them. Without `prompt` it returns as soon as the session is idle and waits for nothing. On expiry it **resolves** with `status: 'running'`, the session id, and `pending_asks` / `pending_ask_details` — **the session is still open and still working**; call `claude_code_wait` with that id.

**Background mode.** Registers the session as a dsh job (`kind: 'claude-code'`, label derived from the prompt, owned by the calling agent when there is one) and returns `{ kind: 'background', jobId, ccSessionId }`. The job **is** the session: `job_output` streams each completed turn's answer as a consuming delta, `job_kill` closes the session, and the job settles when the session closes. Requires `@deepseek-ai/dsh-jobs` (with a provider such as `@deepseek-ai/dsh-jobs-local`) **and** `@deepseek-ai/dsh-tool-jobs` in the composition.

Three refusals happen **before** anything is opened, and say so: `CC_NO_JOBS` (no jobs runtime — it names both packages), `CC_ABORTED` (the tool call was already aborted at the last instant this layer still owned it), and `CC_JOB_REJECTED` (the registry refused the registration — normally the default cap of **10 concurrent jobs per owner**; the message quotes the registry's own remedy, `job_kill` an unneeded job or wait for one to finish). Once the job id is published the opposite rule holds: **aborting the tool call no longer touches the session** — cancellation belongs to `job_kill` alone, which is the whole point of backgrounding it.

### `claude_code_send`

Send a message to an open session: `mode: 'followup'` queues it for after the current turn finishes; `mode: 'steer'` aborts the in-flight turn and refolds both instructions into one fresh turn (turn-1 tokens are re-paid — that is what the SDK's `priority: 'now'` does). Returns the post-send `{ status }`.

### `claude_code_wait`

Wait for a session to finish its current turn. `timeout_ms` defaults to **60 seconds** and is clamped to 10 minutes. Returns `{ status, result?, usage?, cost_usd? }` — `result` and the usage/cost fields are present only when the turn completed and the SDK reported them.

An elapsed wait is **not an error**: it resolves with `{ status: 'running', session_id, pending_asks, pending_ask_details }`, leaving the session running. Call the tool again to keep waiting. The three extra fields are optional and appear only on that branch, so a completed turn's value is unchanged.

### `claude_code_status`

Read a session's current status without waiting: `{ status, pending_asks, pending_ask_details, context_usage? }`.

`pending_ask_details` is always present and empty when nothing pends — an absent array would make "nothing is pending" indistinguishable from "this build cannot tell you".

`context_usage` is derived from the **latest completed turn's** reported usage (fresh + cached input, plus that turn's output), with `max_tokens` from the model's `contextWindow` when the CLI reported one. It is an approximation of occupancy, not a live meter: it does not move while a turn is in flight, and it is absent entirely until a turn has reported usage.

### `claude_code_cancel`

Cancel the in-flight turn. `keep_queued` defaults to **true**: messages already queued behind the cancelled turn still run, exactly as the interrupt receipt promises. Pass `keep_queued: false` to suppress them too — **a dsh-side rule this integration enforces on top of the cancel, not a Claude Code CLI feature, and never persisted to the session's own settings** (the SDK advertises `interrupt_cancel_queued_v1` but exposes no way to drive it, so the seam emulates it by re-interrupting as surviving turns start). Returns `{ still_queued: string[] }`, reconciled from the receipt against the session's own outbox.

### `claude_code_close`

Close a session: settle its pending asks as denied, then close the underlying SDK query. Idempotent — closing an already-closed or unknown session still returns `{ closed: true }`. The mirror finalizes its open turn and detaches, and a background session's job settles, both wired by the seam rather than by this tool.

## Model Experience

### `claude_code_open`

#### What the model sees

The generated schema (six optional fields beyond the required `cwd`) and, on success, either `session <id> (<status>)` followed by the opening turn's answer, or `started background job <jobId> (session <ccSessionId>)`. A synchronous open that outlives its ceiling renders the human-in-the-loop message instead (session id, the pending tool and reason, how long, and "call `claude_code_wait` again"). Failures are typed and actionable: `INVALID_CWD` / `SESSION_LIMIT` / `SESSION_EXISTS` / `BACKEND_ERROR` from the seam, `CC_NO_JOBS` / `CC_ABORTED` / `CC_JOB_REJECTED` from this layer. Every one of them names the remedy in words, because the model reads the message, not the code.

#### Token effect

Fixed schema cost on every request where the tool is visible. The **result is now data-dependent in synchronous mode**: it carries the delegated session's final answer, which is exactly the payload the delegation was for, and can be large. Background mode's result stays a small fixed line — the session's output is then read on demand through `job_output`, which is the cheaper shape for a long-running delegation.

#### KV Cache effect

Prefix-stable while the tool's registration and schema are unchanged; a scoped restriction or plugin reload invalidates reuse from this tool's definition onward.

### `claude_code_send`

#### What the model sees

The generated schema (`session_id`, `message`, `mode`) and `session <id> is now <status>`.

#### Token effect

Fixed schema cost; the result is one short status line. Note the asymmetry: the session's answer costs nothing here and everything in the following `claude_code_wait`.

#### KV Cache effect

Same as `claude_code_open`.

### `claude_code_wait`

#### What the model sees

The generated schema (`session_id`, optional `timeout_ms`) and one of three things: the session's final assistant text; a `status: <status>` line when the turn produced no text (an interrupted turn, for instance); or, when the wait elapsed, the blocked-on-a-human message — session id, the pending ask's kind/tool/reason, how long it has been pending, and the instruction to call `claude_code_wait` again rather than cancel or re-open.

The polling contract this implies: **wait, read, wait again.** A default wait is one minute, so a model that keeps calling it costs one small result line per minute while a human decides, and pays the session's real output exactly once, when the turn finishes.

#### Token effect

Fixed schema cost; the result is data-dependent — the session's own output — unlike this package's other four status-shaped tools. A session that writes long answers is paid for once per `claude_code_wait`, so prefer one wait per turn over polling.

#### KV Cache effect

Same as `claude_code_open`.

### `claude_code_status`

#### What the model sees

The generated schema (`session_id`) and a one-line summary (`session <id>: <status>, <n> pending ask(s)[, <n> tokens used]`). When something IS pending, that line is followed by a numbered list naming each ask's kind, tool and reason with how long it has been waiting, and the sentence telling the model a human must answer in the dsh web UI.

#### Token effect

Fixed schema cost; small fixed result line. Cheap enough to poll, and the right tool for "is it still running?" — `claude_code_wait` is the expensive one.

#### KV Cache effect

Same as `claude_code_open`.

### `claude_code_cancel`

#### What the model sees

The generated schema (`session_id`, optional `keep_queued`) and `cancelled session <id>` or `cancelled session <id>; still queued: <ids>`.

#### Token effect

Fixed schema cost; small fixed result line (bounded by the number of queued sends, which the model itself made).

#### KV Cache effect

Same as `claude_code_open`.

### `claude_code_close`

#### What the model sees

The generated schema (`session_id`) and `closed session <id>`.

#### Token effect

Fixed schema cost; small fixed result line.

#### KV Cache effect

Same as `claude_code_open`.

## Known Limitations and Deferred Work

- **No permission policy lives in these tools** (delta D13). Policy over *these* tools belongs in `tools/pre-execute` (`allow` / `deny` / `ask`) or the monotonic `ctx.tools.guard()`; policy *inside* a Claude Code session is the seam's ask channel (§4). A tool that decided for itself would be a second, weaker policy engine.
- **No progress injection, deliberately.** The spec's `exec.agent.inject(...)` note is redundant now that a background session is a dsh job: `@deepseek-ai/dsh-tool-jobs` already delivers the completion notice to the owning agent (injected into a busy owner, waking an idle one, bounded per owner). A second notice path from this plugin would double every message and bypass those bounds. Synchronous mode needs no progress channel — it returns the answer.
- **A background open that fails still leaves a `failed` job.** `JobStart.run()` must return hooks synchronously, so the open happens inside the job and a refusal (`INVALID_CWD`, `SESSION_LIMIT`, a dead subprocess) is reported to the caller AND recorded as a settled job in `job_list`.
- **A subprocess that dies on its own settles its job** (fixed in Phase 7; the seam grew the "pump ended → close" path). The outcome comes from the close reason: `crashed` (the subprocess ended mid-turn) settles `failed`, `exited` and `closed` settle `completed`, and an already-issued `cancel` wins over all three and settles `killed` — so `job_kill` is never relabelled as a crash. `done` still never rejects. Verified LIVE, not just against the offline `outcomeFor` table: `tests/live/tools-background-kill.live.spec.ts` SIGKILLs the real subprocess (never `job_kill`, never `claude_code_close`) and asserts the job settles `failed` exactly once, with no orphan.
- **`claude_code_cancel`'s `keep_queued` suppression is dsh-side bookkeeping**, not a Claude Code CLI concept and not written to `settings.local.json` — see the seam's `ask.persistAlwaysAllow` note for the same distinction applied to permission rules. It is emulated (re-interrupt as surviving turns start, capped) until the SDK exposes `interrupt_cancel_queued_v1`.
- **`waiting_ms` is measured from when the ask was registered**, not from when the human first saw it: the dsh prompt is raised a moment later (the router first correlates the mirror's `tool/call`, §4.4). The difference is milliseconds and always errs toward reporting a slightly longer wait.
- **A result landing as the wait expires is handed back, not deferred.** The seam's timeout rejects a parked waiter from a `setTimeout`, so a result arriving in the same tick loses by microtasks. `waitCapped` re-reads `CcSession.lastResult` after a `TIMEOUT` and returns it when it is a different envelope from the one held before the wait — so a finished turn is never reported as `running` with its answer withheld for another whole poll. Identity, not presence, is what is compared: `lastResult` outlives its turn, and handing back the PREVIOUS turn's answer would be worse than waiting.
- **`pending_asks` can never disagree with `pending_ask_details`.** Both (and the `status` beside them) come from one `CcSession.snapshot()` — a single synchronous projection of the one ask table — so a count with nothing described is unconstructible. A session that closed with an ask open reports `0` / `[]`, because `close()` denies every pending ask before it notifies the close listener that takes the tombstone; the model is never told to keep waiting for an answer that can no longer arrive.
- **An elapsed wait cannot distinguish "blocked on a human" from "genuinely slow"** beyond what `pending_ask_details` says. An empty array means no ask is pending — the turn is just still thinking — and the rendered text says exactly that rather than implying somebody must act.
- **`context_usage` is an approximation** derived from the last completed turn's usage, because neither the seam nor the SDK exposes a live context meter. It is absent rather than guessed before the first result.
- **No `presentResult` presenters.** Each tool declares `presentCall` (a generic card) but no `presentResult`, so a completed call renders its `output.render` text. Cards for the tool calls Claude Code makes INSIDE a session (terminal for CC `Bash`, diff for CC `Write`/`Edit`) are a different thing and are not representable in rc.7 — the projections live in the seam (`presentCcToolCall`/`presentCcToolResult`) with the full evidence trail; a dsh card is derived by a tool-registry name lookup, and CC's tool names are not registered.
- **`claude_code_status` is the only tool that answers for a closed session.** It reports `status` plus `close_reason` (`closed` / `exited` / `crashed`) for a session the seam still holds a tombstone for. `claude_code_send` / `_wait` / `_cancel` keep failing `CC_NO_SESSION`, because they need a live actor and the remedy really is "open one". Status is the call whose whole purpose is "what happened to it?" — answering `CC_NO_SESSION` there says "it was never opened here", which sends the model off to open a second session.
- **Background mode is capped by the jobs runtime, not by us.** `@deepseek-ai/dsh-jobs-local` allows 10 concurrent jobs per owner by default; the eleventh `claude_code_open({ background: true })` fails `CC_JOB_REJECTED` with the registry's own remedy, having opened nothing. Raise it with the provider's `maxConcurrentJobsPerOwner`, not here.
