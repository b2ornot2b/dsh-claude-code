# @deepseek-ai/dsh-claude-code

The Claude Code capability seam for the DeepSeek Harness: the `ctx.claudeCode` service, the
session type vocabulary, and the configuration schema. This package is **both the Service
Definition and the Service Provider** for the capability — the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`) is the backend, and no alternative provider is planned.
Nothing outside this package may import the SDK.

Consumers:

- `@deepseek-ai/dsh-tool-claude-code` — model-facing delegation tools (`inject: ['tools', 'claudeCode']`).
- `@deepseek-ai/dsh-claude-code-agent` — the CC-backed dsh `Agent` adapter (`inject: ['agents', 'claudeCode']`).

> **Package naming.** This package is `private: true` and is not published. It keeps the
> `@deepseek-ai/dsh-*` name so that upstreaming into the harness monorepo
> (`packages/claude-code/claude-code/`) is a mechanical move rather than a rename — we do not
> own the `@deepseek-ai` npm scope and cannot publish into it.

**Phase status: Phase 3 (mirror).** `open()` is real: it mints the shared dsh/CC id,
resolves the SDK options, spawns (or adopts a pre-warmed) Claude Code subprocess, awaits the
initialize handshake and registers the session. `send()` / `interrupt()` / `waitForResult()` /
`onMessage()` / `onSend()` live on the `CcSession` actor, reachable through
`ctx.claudeCode.session(id)`. A session's traffic can now be projected into a real dsh
session log — see [Mirroring](#mirroring-into-a-dsh-session-log).

Two things are still stubs, by design and with the phase named in the code: `canUseTool`
fails CLOSED (every tool call is denied with an explanation) until **Phase 4** wires the dsh
ask channel, and the model-facing `claude_code_*` tools in
`@deepseek-ai/dsh-tool-claude-code` are still registered-but-inert scaffolds until
**Phase 5**.

### Running the tests

```sh
pnpm test           # offline: build + unit + composition. No subprocess, no network.
pnpm run test:live  # opt-in: DSH_CC_LIVE=1, real subprocesses, real claude.ai subscription
```

`pnpm test` also boots the repo's real `tests/composition/cordis.yml` through the cordis
Loader, which imports each row's **built** `lib/index.js` — that is what proves the
`exports` map, the `inject` list, the `Config` schema and the SDK-free `lib/types` for real,
rather than against TypeScript sources.

The live suite (`tests/live/`) drives twelve real specs on
`claude-haiku-4-5-20251001` with one-sentence prompts and isolated tmp working
directories, and asserts on a `pgrep` delta that no subprocess outlives a test. It is
gated with `describe.skipIf` so the default suites stay offline-green. Two of those specs
serve the mirror: `record-fixtures.live.spec.ts` re-records the scrubbed transcripts under
`tests/fixtures/` (replayed offline by `mirror-golden.spec.ts`), and
`mirror-e2e.live.spec.ts` runs a live tool call through a real `SessionStore` session and
round-trips the resulting log through `Session.fromRestore`. A third,
`mirror-cancel.live.spec.ts`, covers the two turns that never get a normal result: one
interrupted mid-block, and one whose session is closed outright while it runs.

---

## The rule that governs everything downstream

**The dsh session log for a CC-backed session is a mirror, not a source of truth.**

dsh's normal invariant — everything the model sees is rebuildable from the log — does **not**
hold here, because Claude Code owns its own history and compacts it independently. Do not
attempt to drive a Claude Code request from `deriveMessages()`. Anything downstream that
assumes it can will be silently wrong the first time CC auto-compacts.

## Service API (`ctx.claudeCode`)

| Member | Phase 3 behavior |
|---|---|
| `open(options)` | opens (or resumes, or forks) a live session and returns its snapshot. Refuses a non-absolute or missing `cwd` with `INVALID_CWD` **before** anything spawns, and a session past `limits.maxConcurrentSessions` with `SESSION_LIMIT` |
| `get(id)` | the live snapshot of a registered session (status, model, pending asks), `undefined` when unknown |
| `list()` | every live session, in open order; a fresh array per call |
| `close(id)` | settles pending asks, aborts, closes the SDK query, ends the input stream, drops the registry entry |
| `session(id)` | the `CcSession` actor — `send` / `interrupt` / `waitForResult` / `onMessage`. Values (snapshots) cross tool boundaries; this handle does not |
| `accountInfo()` | the account from the first live session's cached initialize response. Throws `NO_LIVE_SESSION` when nothing is open: it never spawns a subprocess of its own |
| `attachMirror(id, session, opts?)` | mirrors a live session into a dsh session log (see below). Throws `UNKNOWN_SESSION` for an unregistered id; when the session closes the mirror is finalized (a turn left open by a mid-turn death is closed as `aborted`/`disposed`) and then detached |
| `config` | the schemastery-validated configuration |

All session lifecycle is registered through `ctx.effect()`, so disposing the plugin fiber
(HMR, plugin unload, process teardown) closes every session this service opened.

## Mirroring into a dsh session log

```ts
// Whenever `open()` carries a prompt, attach at open time: the prompt is sent
// synchronously inside open(), and a later attachment misses the turn it starts.
const snapshot = await ctx.claudeCode.open({ cwd, prompt, mirror: { session: dshSession } })

// A session opened idle (or a second log) can attach afterwards:
const { mirror, dispose } = ctx.claudeCode.attachMirror(snapshot.id, dshSession)
mirror.callIdFor('toolu_abc')   // the cc tool_use id -> dsh CallId table
```

The mirror is **write-only into dsh**. Its entire view of a Claude Code session is two
subscribe functions (`onMessage`, `onSend`), so it cannot send, interrupt, close, or register
a cordis waterfall listener — that is enforced by the type, not by a promise.

Turn framing follows what Claude Code actually does with a message, not just its mode: a
`followup` sent while a turn is running is QUEUED by CC and runs as its own later turn, so its
`user/message` is **deferred** to that turn's `turn/start` — recording it immediately would
put the prompt before the answer to the previous one. A `steer` is recorded in the open turn,
because the refold merges both instructions into it. An `inject` starts no turn at all.

When the Claude Code session closes, the service calls `mirror.finalize()` before detaching:
a session that dies mid-turn never emits the result that would have closed the dsh turn, and
a log with a dangling `turn/start` can never be appended to again. `finalize()` closes it as
`{ kind: 'aborted', reason: { kind: 'disposed' } }` and appends nothing when no turn is open.

What it writes: `turn/start` + `user/message` on a send; one dsh **step per model call**
(`step/start` … `assistant/chunk`* … `assistant/message` … `tool/call`* … `tool/result`* …
`step/end`); `turn/end` on the SDK result. Assistant content is accumulated from
`stream_event` partials — `SDKAssistantMessage` is a per-block *checkpoint* (spike 6) and is
used only as a checksum. Thinking becomes `block-start { blockType: 'reasoning' }` +
`reasoning-delta`. A steer's abort result is suppressed entirely (the turn refolds) along with
the partial model call it aborted, because the refold re-streams from a fresh `message_start`;
an `interrupt()`'s closes the turn as `aborted`, never as an error, and the killed call still
contributes the text and reasoning it had already streamed (a `tool_use` block whose arguments
were cut off does not — the JSON is truncated and no such call ran). A model call that
produced nothing at all gets no `assistant/message` rather than an empty one. Unknown SDK
message kinds — the union has ~38 variants and grows — are counted in `mirror.stats.ignored`
and dropped.

Not written: `request/header` (CC never discloses the request config it used, and a wrong
header poisons `foldRequestHeader()` downstream) and the text of user-role SDK messages
(prompts are recorded from the send side; an echo would duplicate them).

`@deepseek-ai/dsh-session` stays optional for pure-SDK consumers: it is a peer dependency used
for types, and a composition that never passes a dsh session never constructs one.

## Configuration

See `src/config.ts` for the authoritative schema and per-field documentation. Summary:

```yaml
claude-code:
  executablePath: null            # pathToClaudeCodeExecutable escape hatch (see install size)
  prewarm: true                   # SDK startup() at mount; ~300ms init win, no first-token win
  auth: subscription              # subscription | api-key
  apiKeyRef: ANTHROPIC_API_KEY    # credential REFERENCE name, never a raw key
  defaults:
    model: null                   # null/omitted = CLI default
    permissionMode: default       # default | acceptEdits | bypassPermissions | plan | dontAsk | auto
    settingSources: []            # [] = full isolation. See the warning below.
    appendSystemPrompt: null
  ask:
    timeoutMs: null               # null/omitted = pend indefinitely (interactive)
    delegatedTimeoutMs: 120000    # bounded wait when no human can be reached
    fallback: deny                # deny | first-option | error
    persistAlwaysAllow: true      # integration-owned rule cache — NOT SDK persistence
    ruleCachePath: null           # where that cache lives; null = harness default location
  limits:
    maxConcurrentSessions: 4
    maxBudgetUsd: null
  env: {}                         # extra passthrough env (e.g. CLAUDE_CODE_MAX_RETRIES)
```

### `settingSources: []` is load-bearing

The SDK loads **all** setting sources when `settingSources` is omitted — user settings,
project settings, and `CLAUDE.md` — matching CLI defaults. Isolation is opt-**in**, not
opt-out: an embedded agent must pass `[]` explicitly. Opting into `['project']` is what makes
a repository's `CLAUDE.md` apply to a delegated session, and it should be a deliberate choice.

### `persistAlwaysAllow` is our rule cache, not the SDK's

Phase 0 spike 4 established that echoing `updatedPermissions` from a headless `canUseTool`
**never writes `.claude/settings.local.json`** — with `settingSources: []` or `['local']`.
That disk write is the interactive TUI's job and is not part of `query()`'s contract. So
"always allow" is an **integration-owned rule cache**: a JSON store this package writes and
consults inside `canUseTool` before prompting, which keeps `settingSources: []` isolation
intact. `ruleCachePath` names that store. Do not ship `settingSources: ['local']` to get it.

### Install size and the executable escape hatch

`@anthropic-ai/claude-agent-sdk` ships its native CLI binary as **optional platform
dependencies**. Under package managers that ignore npm's `libc` field this roughly doubles
install size on Linux, and when optional dependencies are skipped entirely the SDK fails at
spawn time with `Native CLI binary for <platform> not found`. `executablePath` is the escape
hatch: point it at an already-installed `claude` executable and the bundled binary is unused.

---

## Authentication

The SDK spawns the bundled Claude Code binary, which picks up the local subscription login.
Two things must be right:

1. **`options.env` REPLACES the subprocess environment rather than merging it.** Always
   spread `{ ...process.env, ... }`, or `PATH`/`HOME` are lost and the login stops resolving.
   Omitting `env` entirely makes the subprocess inherit `process.env`.
2. **Strip `ANTHROPIC_API_KEY`** from the env passed under `auth: 'subscription'`. Leaving it
   set silently bills the API instead of using the subscription — a failure mode with no
   error message.

Under `auth: 'api-key'` the configuration stores a credential **reference** (`apiKeyRef`,
default `ANTHROPIC_API_KEY`), never a raw key; the value is resolved per operation through
`ctx.credentials` so rotation takes effect without a restart. `accountInfo()` surfaces which
auth is actually live.

**Distribution note.** Anthropic's Agent SDK terms state that third-party developers may not
offer claude.ai login or subscription rate limits in their products without prior approval.
Running this plugin on your own machine against your own subscription is ordinary use.
Publishing it as a plugin that other people point at *their* Max plans is the case that note
is about.

---

## Known impedance mismatches

### History ownership

CC owns and compacts its own transcript. `SDKCompactBoundaryMessage` tells you a compaction
happened, but the dsh log has no corresponding rewrite. After a compaction the dsh mirror is
a *complete historical record* while CC's live context is a *summary*. Anything that assumes
those are the same thing is wrong. The boundary is logged distinctly so the Trajectory view
can render it.

### Fork semantics — dsh's id wins (reversed from the original spec)

The original spec said CC mints the fork id and dsh mirrors it. Phase 0 spike 1 proved the
opposite is available and simpler: `resume` + `forkSession: true` + `sessionId: <fresh uuid>`
**honors our uuid for the fork**, history carries over, and the source session is untouched.
So: **dsh mints every session id** (a bare `randomUUID()`, branded as a dsh `SessionId`) and
hands the same value to the SDK as `options.sessionId`. There is no id map anywhere, in
either direction, and an externally minted non-UUID dsh id is never accepted for the SDK side.

### Approval audit vs CC's own record

dsh appends `approval/asked` / `approval/decided` to the mirror; CC records its own permission
decisions in its transcript. Two records of the same decision, neither authoritative over the
other. Acceptable — but the UI must not imply otherwise. Note also that the CLI's built-in
safe-command classifier auto-approves some calls *below* the `canUseTool` callback, so an
audit trail must never claim that every CC tool call passed through dsh approval.

### Nested asks — depth-2 delegation cannot ask a human

CC subagents cannot use `AskUserQuestion` at all, and dsh refuses `userQuestions.ask()` for
owned (delegated) agents. Two independent restrictions with the same practical effect. The
ask fallback policy (`ask.fallback`, `ask.delegatedTimeoutMs`) is the designed answer to this,
not an edge case.

### Waterfalls that are silently inert

`agent/pre-step`, `agent/request`, and `agent/request-error` are dispatched only around dsh's
own model call, and `tools/*` events only by `ctx.tools`. A CC-backed agent makes neither
call, so every plugin hooking them is inert for it. The Agent adapter package documents the
substitutes (`inject()` → `shouldQuery: false` sends, `query.setModel()`,
`applyFlagSettings()`, CC hooks mapped onto dsh event names).

---

## Model Experience

None **for the dsh model**, as this package registers no tool schema, no system-prompt
contribution, and no model-visible event. The model-facing surface belongs to
`@deepseek-ai/dsh-tool-claude-code` (delegation tools, still inert until Phase 5).

What Phase 3 adds is **human**-facing, not model-facing: the mirror projects a Claude Code
session into a dsh session log, so the harness UI renders a CC session with the same
turn/step/chunk vocabulary as a native one — streaming text and reasoning, tool calls with
their results, todo snapshots, and a turn that ends `completed` / `aborted` / `error`. The
`claude-code/compact` event marks where CC compacted its own transcript.

Two things a reader of that log must not assume. It is **not** the model's context (§5.1):
Claude Code owns and compacts its own history, so `deriveMessages()` reconstructs what dsh
observed, never what CC will send. And permission prompts are still invisible in it: the
`approval/asked` + `approval/decided` pair arrives with the ask channel in **Phase 4**, so
today's log shows a tool call that was silently denied by the fail-closed stub.

#### KV Cache effect

No direct effect: this package contributes nothing to a dsh model request, so it cannot
invalidate a request prefix. The Claude Code subprocess maintains its own independent cache
over its own transcript, which the dsh mirror neither feeds nor invalidates.

## Known Limitations and Deferred Work

- **Every tool call is denied until Phase 4** — the session's `canUseTool` is a fail-closed
  stub that answers `deny` with an explanation naming the phase. A live session can read
  nothing and write nothing until the dsh ask channel is wired; that is deliberate (a
  silently-allowing default is the one failure mode that cannot be undone).
- **A `claude-code/compact` event cannot be marked `ignorable` (dsh rc.7)** — a custom
  session event must carry `ignorable: true` on its ENVELOPE, or a persistence read path
  whose build does not know the type refuses the whole log. `Session.append()` builds and
  deep-freezes the envelope itself and offers no channel for the marker, so a log holding a
  live-appended compaction boundary is refused by a stock harness build. Two mitigations
  ship: `mirror: { compaction: 'skip' }` omits the event, and `markEventIgnorable(event)`
  stamps the marker at the seed/restore boundary, where envelopes ARE caller-supplied.
  Adopt `append(type, data, { ignorable: true })` when upstream exposes it.
- **The mirror's turn framing is an approximation, and it is one-directional** — CC's turn is
  coarser than dsh's step loop, so one CC turn becomes one dsh turn with one step per model
  call. Consequences a reader should know: a `tool_result` that arrives after its step closed
  is dropped (`stats.ignored['tool-result:orphan']`) because dsh's invariants reject it
  anywhere else; a turn CC starts on its own (auto-resume, a scheduled trigger) is opened
  defensively so nothing lands outside a turn; and a `followup` queued behind a running turn
  is recorded in the turn that RUNS it, which means the log's ordering follows CC's execution
  order rather than the wall-clock order of the sends.
- **A re-attached mirror does not inherit the previous one's pending tool calls** — the
  constructor folds turn/step numbering out of an existing log, but not its
  `tool_use → CallId` table, so a `tool_result` whose `tool/call` was written by an earlier
  mirror instance is dropped as an orphan. Attach once per session.
- **The mirror carries `parent_tool_use_id` only on `tool/result`** — dsh's `assistant/chunk`
  payload is the closed `StreamChunk` union and `tool/call` has no free field, so with
  `forwardSubagentText: true` a subagent's text and calls appear inline in the parent's step.
  Only `tool/result` can name its parent (in the event's tool-private `meta`).
- **`accountInfo()` needs a live session** — the account arrives with a session's initialize
  handshake, and this call deliberately never opens one; with an empty registry it throws
  `NO_LIVE_SESSION`.
- **Pre-warming starts helping from the SECOND open** — `startup()` freezes `cwd` (and every
  other option), so the first open of a given shape is always cold and the pool warms
  afterwards for the next one. A changed shape discards the held subprocess.
- **No model-facing tools yet (Phase 5)** — `@deepseek-ai/dsh-tool-claude-code` registers all
  six `claude_code_*` schemas so the composition is complete and typed, but their bodies do
  not drive a session yet. Drive sessions through `ctx.claudeCode` directly until then.
- **A resumed session keeps its id; a live one cannot be resumed** — SDK 0.3.233 refuses a
  caller-supplied `sessionId` alongside `resume` unless `fork` is set, so a plain resume
  continues under the id it resumed. Resuming a session that is still open in this context is
  refused with `SESSION_EXISTS` (two queries on one transcript); close it, or fork it.
- **An interrupted turn reports as an interrupted turn** — `interrupt()` makes the running
  turn end with an `error_during_execution` result. It is flagged `meta.interruptedTurn` so a
  mirror can render it as *cancelled*, but unlike a steer's artifact it is NOT suppressed: with
  nothing queued behind it, it is the only signal the turn ended, and withholding it would
  strand every `waitForResult()` until its timeout.
- **Steering re-pays the aborted turn's tokens** — `send(..., { mode: 'steer' })` is
  `priority: 'now'`, which aborts the running turn and refolds both instructions into one
  fresh turn (spike 2). It is not token-level steering, and the aborted turn's output is paid
  for twice.
- **Content blocks are text-only** — a send carries a string; images and tool results are not
  expressible through `CcSession.send()` yet.
- **The session log is a mirror** — replay, fork-by-seed-replay, and any `deriveMessages()`
  driven request are invalid for CC-backed sessions. There is no plan to make them valid;
  CC owns its transcript.
- **"Always allow" persistence is integration-owned** — the SDK never writes
  `settings.local.json` from a headless `canUseTool`, so rules cached by this package are not
  visible to the user's interactive Claude Code CLI, and vice versa. Two rule stores, no sync.
- **`cancel(keep_queued: false)` cannot use the native path** — the CLI advertises
  `interrupt_cancel_queued_v1`, but SDK 0.3.233 exposes no way to drive it (`interrupt()`
  takes no arguments). Queued-message cancellation is therefore emulated at our layer by
  treating the receipt's `still_queued` uuids as cancelled and never redelivering them.
  Tracked for adoption when the SDK exposes the native call.
- **Pre-warming is skipped for resumed and forked opens** — a warm handle is always a PLAIN
  session, because `warmFingerprint` ignores `resume`/`forkSession` (it must, so the pool's
  pre-minted id can be adopted) and a handle warmed with either baked in would be
  indistinguishable from a fresh one. Resuming still works; it just never comes from the pool
  and never seeds it.
- **Config `null` means "unset"** — the spec renders unset values as YAML `null`
  (`model: null`, `ask.timeoutMs: null`); the schema models them as absent optional fields.
  Both an explicit `null` and an omitted key resolve to the documented default behavior.
