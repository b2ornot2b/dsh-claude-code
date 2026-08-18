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

**Phase status: Phase 5 (model-facing tools).** `open()` is real: it mints the shared dsh/CC id,
resolves the SDK options, spawns (or adopts a pre-warmed) Claude Code subprocess, awaits the
initialize handshake and registers the session. `send()` / `interrupt()` / `waitForResult()` /
`onMessage()` / `onSend()` live on the `CcSession` actor, reachable through
`ctx.claudeCode.session(id)`. A session's traffic can now be projected into a real dsh
session log — see [Mirroring](#mirroring-into-a-dsh-session-log). Permission prompts,
clarifying questions and plan reviews now route to the dsh `ctx.approval` / `ctx.userQuestions`
seams — see [The ask channel](#the-ask-channel).

The six model-facing `claude_code_*` tools in `@deepseek-ai/dsh-tool-claude-code` are now
**real**: they open (synchronously or as a dsh job), send, wait, report status, cancel and
close through this seam, and they are what supplies the ask target below. A session opened
with no ask target still fails CLOSED (every tool call denied with an explanation), which is
the correct posture for a session nobody is watching.

Phase 6 landed the CC-backed dsh `Agent` adapter
(`@deepseek-ai/dsh-claude-code-agent`): it opens a session through this seam, mirrors it into a
real dsh session sharing the same id, and registers it with `ctx.agents`. The one thing it needed
here is `CcSession.setModel()` — a thin `query.setModel()` passthrough, and the only
model-switching path a CC-backed agent has (see "Waterfalls that are silently inert").

Still scaffolded, with the phase named in the code:

- **Phase 7** — rich tool cards. Every tool renders through the generic card today
  (`presentCall` returns `card: 'generic'`); the Claude-Code-specific views come later.

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

| Member | Phase 4 behavior |
|---|---|
| `open(options)` | opens (or resumes, or forks) a live session and returns its snapshot. Refuses a non-absolute or missing `cwd` with `INVALID_CWD` **before** anything spawns, and a session past `limits.maxConcurrentSessions` with `SESSION_LIMIT` |
| `get(id)` | the live snapshot of a registered session (status, model, pending asks), `undefined` when unknown |
| `list()` | every live session, in open order; a fresh array per call |
| `close(id)` | settles pending asks, aborts, closes the SDK query, ends the input stream, drops the registry entry |
| `session(id)` | the `CcSession` actor — `send` / `interrupt` / `waitForResult` / `onMessage`. Values (snapshots) cross tool boundaries; this handle does not |
| `accountInfo()` | the account from the first live session's cached initialize response. Throws `NO_LIVE_SESSION` when nothing is open: it never spawns a subprocess of its own |
| `attachMirror(id, session, opts?)` | mirrors a live session into a dsh session log (see below). Throws `UNKNOWN_SESSION` for an unregistered id; when the session closes the mirror is finalized (a turn left open by a mid-turn death is closed as `aborted`/`disposed`) and then detached |
| `attachAskTarget(id, target)` | sets who answers that session's permission prompts, questions and plan reviews; returns a disposer. Prefer `open({ ask })` — see the ask channel below |
| `config` | the schemastery-validated configuration |

All session lifecycle is registered through `ctx.effect()`, so disposing the plugin fiber
(HMR, plugin unload, process teardown) closes every session this service opened.

## The ask channel

Claude Code asks for three things through one callback, and each goes to the dsh seam that
owns it: `AskUserQuestion` → `ctx.userQuestions.ask()`, `ExitPlanMode` → the same seam with
dsh's own `plan-review` intent, everything else → `ctx.approval.request()`.

```ts
// Attach WHO answers at open time: the opening prompt is sent synchronously inside open(),
// so a target attached afterwards can miss the first tool call (which then fails closed).
await ctx.claudeCode.open({
  cwd,
  prompt,
  ask: { agent: exec.agent, delegated: false },   // Phase 5 passes the delegating agent
  mirror: { session: dshSession },                // gives approvals a real callId (§4.4)
})
```

Both seams are optional, and they fail differently on purpose:

- **No `ctx.approval`** → fail-closed deny, with an explanation. No fallback policy can turn
  a missing approver into a grant.
- **No `ctx.userQuestions`** (or any `UserQuestionError`: `DELEGATED_CALLER`,
  `CALLER_NOT_LIVE`, `NO_PROVIDER`, `ASK_ABORTED`, `ASK_CANCELLED`, `ASK_MISSING_AGENT`,
  `BAD_INTENT`, `EMPTY_QUESTIONS`) → the configured `ask.fallback`.

`ask.fallback` also covers approval `'unavailable'` and timeouts — never a decision. A
`rejected` (including the deterministic `policy: 'never'` fold) or `cancelled` outcome is
answered as-is.

| `ask.fallback` | behaviour |
|---|---|
| `deny` (default) | deny, telling Claude to proceed on its best assumption and say what it assumed |
| `first-option` | auto-answer each clarifying question with its first option, logged loudly. Permission prompts and plan reviews are DENIED instead: their first option is a grant |
| `error` | deny with `interrupt: true`, and surface a typed `ASK_UNANSWERABLE` error on the session (`session.onAskError`, `session.lastAskError`) |

Two invariants worth stating plainly, because both failure modes are unrecoverable: this
callback **never rejects** and **never returns `null`**. Either one leaves the Claude Code
subprocess waiting forever — permission prompts have no park deadline. Every error path,
including a dsh service throwing, becomes a decision.

Asks are tracked in a per-session table keyed by the SDK's `requestId`, so a redelivery after
`reinitialize()` returns the original answer instead of prompting a human twice; the table
settles on an answer, an abort, `ask.timeoutMs` / `ask.delegatedTimeoutMs`, or session close
(`close()` drains it before the query goes away). `session.pendingAsks` — and the snapshot
field of the same name — report what is still waiting.

Four orderings the table is explicit about, because each of them is a way to hang or mislead
a session rather than merely to answer it oddly:

- A **redelivery arms its own `signal`** on the ask it joins. After a `reinitialize()` the
  newest delivery is the live transport, and only it can report a withdrawal.
- **`ask.timeoutMs` unset installs no timer at all** — an interactive ask pends until a human,
  an abort, or `close()` reaches it. (A wait longer than `setTimeout`'s 32-bit ceiling is
  clamped to the ceiling; unclamped, Node would fire it after 1ms and deny instantly.)
- **An ask withdrawn while its `callId` is being correlated is never asked** — no synthesized
  `tool/call`, no `approval/asked` pair for a tool call Claude Code abandoned.
- **Nothing is answered from another ask's decision.** The table key falls back to the
  `tool_use` id (then to a counter) if a delivery ever arrives without a `requestId`, because
  two calls sharing one key would hand the second one a grant nobody gave.

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
    ruleCachePath: null           # null = <cwd>/.dsh-claude-code/always-allow.json
    rules: []                     # preseeded always-allow rules: [{ toolName, ruleContent }]
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

It lives at `<cwd>/.dsh-claude-code/always-allow.json` by default (`ruleCachePath` may be
absolute, or relative to the session `cwd`) and holds
`{ "version": 1, "rules": [{ "toolName": "Bash", "ruleContent": "npm test:*" }] }`. It is
consulted conservatively: a prompt is skipped only when EVERY rule of the
`destination: 'localSettings'` allow-rule suggestion the CLI attached to that prompt is
already stored for that tool, and never when the prompt was forced by the user's own
`permissions.ask` rule. A missing, unreadable or malformed file is an empty cache plus a log
line — the fail-closed direction here is "prompt the human". `persistAlwaysAllow: false`
disables reads as well as writes.

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
substitutes: `inject()` → `shouldQuery: false` sends, and model switching →
`CcSession.setModel()` (this seam's `query.setModel()` passthrough), both shipped; plus
`applyFlagSettings()` and CC hooks mapped onto dsh event names, which are not.

---

## Model Experience

None **for the dsh model**, as this package registers no tool schema, no system-prompt
contribution, and no model-visible event. The model-facing surface belongs entirely to
`@deepseek-ai/dsh-tool-claude-code` (the six live delegation tools — see that package's
README for what each one costs the model's context window).

What Phase 3 adds is **human**-facing, not model-facing: the mirror projects a Claude Code
session into a dsh session log, so the harness UI renders a CC session with the same
turn/step/chunk vocabulary as a native one — streaming text and reasoning, tool calls with
their results, todo snapshots, and a turn that ends `completed` / `aborted` / `error`. The
`claude-code/compact` event marks where CC compacted its own transcript.

Phase 4 adds the other half of that human-facing picture: an approval prompt now appends the
`approval/asked` + `approval/decided` audit pair to the ASKING agent's session, carrying the
`callId` of the `tool/call` the mirror already streamed — so a UI can attach the prompt to the
exact call it is about, instead of showing a tool call that silently failed.

Two things a reader of that log must not assume. It is **not** the model's context (§5.1):
Claude Code owns and compacts its own history, so `deriveMessages()` reconstructs what dsh
observed, never what CC will send. And the approval log is not a complete record of what CC
ran: the CLI's safe-command classifier auto-approves trivial commands below `canUseTool`, and
a rule-cache hit skips the prompt by design.

#### KV Cache effect

No direct effect: this package contributes nothing to a dsh model request, so it cannot
invalidate a request prefix. The Claude Code subprocess maintains its own independent cache
over its own transcript, which the dsh mirror neither feeds nor invalidates.

## Known Limitations and Deferred Work

- **No UI can add an always-allow rule yet** — dsh's approval vocabulary has no `'always'`
  outcome (`allowed-once | rejected | cancelled | unavailable`), and the questions seam is not
  a permission channel, so nothing a human clicks can write the rule cache. Entries come from
  `ask.rules` in configuration or programmatically via `CcAskRules.add()`. When dsh grows the
  outcome, the UI-driven path is one `add()` call away and nothing else changes.
- **A session with no ask target denies every tool call** — that is the fail-closed default,
  not a stub: a silently-allowing default is the one failure mode that cannot be undone.
  Attach a target at `open({ ask })` (or `attachAskTarget`) to give a session a human.
- **`ask.fallback: 'first-option'` never answers a permission prompt or a plan review** —
  §4.5's table says "approvals denied", and a plan review's first option (`Approve`) is a
  grant of exactly the authority the review exists to withhold. Only clarifying questions are
  auto-answered, and every auto-answer is logged loudly.
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
- **Rich tool cards are still Phase 7** — every `claude_code_*` call renders through the
  generic card today. The six model-facing tools themselves are real as of Phase 5 (see
  `@deepseek-ai/dsh-tool-claude-code`), and the CC-backed dsh `Agent` is real as of Phase 6
  (see `@deepseek-ai/dsh-claude-code-agent`).
- **A subprocess that dies on its own does not close its session** — a `CcSession` reaches
  `closed` only through `close()`, so an externally killed CLI leaves the session (and any
  job tracking it) `running` until something calls `close()`. A seam-side "pump ended →
  close" path is the fix and is deferred.
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
- **The rule cache is read once per session and written with a read-merge** — `add()` folds
  the file's current contents in before writing, so one session cannot delete a grant another
  just made. It is still a small local JSON file touched by synchronous `readFileSync` /
  `writeFileSync` on the permission path, and a writer racing between our read and our
  `rename` would still win; do not point `ruleCachePath` at a shared network location.
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
