# @deepseek-ai/dsh-tool-claude-code

Model-facing tools over the [`@deepseek-ai/dsh-claude-code`](../claude-code/README.md) capability seam (`ctx.claudeCode`): `claude_code_open`, `claude_code_send`, `claude_code_wait`, `claude_code_status`, `claude_code_cancel`, and `claude_code_close`.

This package is `private: true` and keeps the `@deepseek-ai/dsh-*` name for future upstreaming — we cannot publish into the `@deepseek-ai` scope ourselves.

The plugin stays pending until both injected services exist (`inject: ['tools', 'claudeCode']`): a `ToolRuntime` (`@deepseek-ai/dsh-tools`) and the Claude Code seam. It never imports `@anthropic-ai/claude-agent-sdk` directly — only `packages/claude-code` may.

**Status as of Phase 2: every tool body is still a typed stub.** The schemas below (parameters and output) are the lasting contract — `execute()` always rejects with `ClaudeCodeError` (`code: 'NOT_IMPLEMENTED'`) naming Phase 5, the phase that wires a real Claude Code session actor behind these calls. Nothing here fakes a session, a status, or a result.

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

Output is a const-discriminated `oneOf`: `{ kind: 'session', session_id, status }` or `{ kind: 'background', jobId, ccSessionId }` — the same idiom `@deepseek-ai/dsh-tool-bash`'s `bash` tool uses for its foreground/background split.

### `claude_code_send`

Send a message to an open session: `mode: 'followup'` queues it for after the current turn finishes; `mode: 'steer'` interrupts the in-flight turn with it. Returns `{ status }`.

### `claude_code_wait`

Wait for a session to finish its current turn (or `timeout_ms` to elapse). Returns `{ status, result?, usage?, cost_usd? }` — `result` and the usage/cost fields are present only when the turn actually completed and the SDK reported them.

### `claude_code_status`

Read a session's current status without waiting: `{ status, pending_asks, context_usage? }`.

### `claude_code_cancel`

Cancel an in-flight turn. `keep_queued: false` (the default) additionally suppresses queued `claude_code_send` follow-ups made against this session — **this is a dsh-side rule this integration enforces on top of the cancel, not a Claude Code CLI feature, and it is never persisted to the session's own settings** (see `ctx.claudeCode.config.ask.persistAlwaysAllow`, which is the same kind of integration-owned state, not SDK persistence). Returns `{ still_queued: string[] }`, the ids of any sends that stayed queued.

### `claude_code_close`

Close a session: settle its pending asks as denied, then close the underlying SDK query. Idempotent. Returns `{ closed: true }`.

## Model Experience

### `claude_code_open`

#### What the model sees

The generated `claude_code_open` schema (six optional fields beyond the required `cwd`) plus, on a successful call in a later phase, either a session line (`session <id> (<status>)`) or a background-job acknowledgement (`started background job <jobId> (session <ccSessionId>)`). Until Phase 5 every call instead returns `Error: claude_code_open is not implemented until Phase 5 …` — note that the seam behind it IS live as of Phase 2, so a caller that needs a session today drives `ctx.claudeCode` directly.

#### Token effect

Fixed schema cost on every request where the tool is visible; the result is a small fixed line, not open-ended session output.

#### KV Cache effect

Prefix-stable while the tool's registration and schema are unchanged; a scoped restriction or plugin reload invalidates reuse from this tool's definition onward.

### `claude_code_send`

#### What the model sees

The generated schema (`session_id`, `message`, `mode`) and, once implemented, `session <id> is now <status>`.

#### Token effect

Fixed schema cost; result is one short status line.

#### KV Cache effect

Same as `claude_code_open`.

### `claude_code_wait`

#### What the model sees

The generated schema (`session_id`, optional `timeout_ms`) and, once implemented, either the session's final assistant text or a `status: <status>` line when no result text is available yet.

#### Token effect

Fixed schema cost; the result is data-dependent (the session's own output), unlike this package's other five tools.

#### KV Cache effect

Same as `claude_code_open`.

### `claude_code_status`

#### What the model sees

The generated schema (`session_id`) and, once implemented, a one-line summary (`session <id>: <status>, <n> pending ask(s)[, <n> tokens used]`).

#### Token effect

Fixed schema cost; small fixed result line.

#### KV Cache effect

Same as `claude_code_open`.

### `claude_code_cancel`

#### What the model sees

The generated schema (`session_id`, optional `keep_queued`) and, once implemented, `cancelled session <id>` or `cancelled session <id>; still queued: <ids>`.

#### Token effect

Fixed schema cost; small fixed result line.

#### KV Cache effect

Same as `claude_code_open`.

### `claude_code_close`

#### What the model sees

The generated schema (`session_id`) and, once implemented, `closed session <id>`.

#### Token effect

Fixed schema cost; small fixed result line.

#### KV Cache effect

Same as `claude_code_open`.

## Known Limitations and Deferred Work

- **Every `execute()` body is `NOT_IMPLEMENTED` until Phase 5.** No tool in this package opens, drives, or observes a real Claude Code session yet; the schemas are final, the bodies are stubs.
- **`claude_code_open`'s `background: true` branch requires a jobs composition.** Composing background mode needs `@deepseek-ai/dsh-jobs` (a jobs controller) plus `@deepseek-ai/dsh-tool-jobs` (the generic `job_output`/`job_kill` tools a background Claude Code session would be controlled through), matching `@deepseek-ai/dsh-tool-bash`'s `run_in_background`. Without them, `ctx.jobs.start()` throws; Phase 5 must surface that as a clear tool error, not a crash, exactly like the bash tool does today.
- **`claude_code_cancel`'s `keep_queued` suppression is dsh-side bookkeeping**, not a Claude Code CLI concept and not written to `settings.local.json` — see the seam's `ask.persistAlwaysAllow` note for the same distinction applied to permission rules.
- **`claude_code_wait`'s `usage`/`cost_usd` shape is provisional.** The exact fields the Claude Agent SDK reports (input/output token counts, cache tokens, cost) are pinned once Phase 5 wires a real session actor against SDK 0.3.233; this package's `usage` schema (`input_tokens`, `output_tokens`) is a reasonable placeholder, not verified against the SDK yet.
- **No `presentResult` presenters yet.** Each tool declares `presentCall` (a generic card) but no `presentResult`; a completed call renders the raw `output.render` text until a later phase adds richer completed-state cards.
