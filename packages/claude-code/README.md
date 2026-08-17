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

**Phase status: Phase 2 (session actor).** `open()` is real: it mints the shared dsh/CC id,
resolves the SDK options, spawns (or adopts a pre-warmed) Claude Code subprocess, awaits the
initialize handshake and registers the session. `send()` / `interrupt()` / `waitForResult()` /
`onMessage()` live on the `CcSession` actor, reachable through `ctx.claudeCode.session(id)`.

Three things are still stubs, by design and with the phase named in the code: nothing is
mirrored into the dsh session log until **Phase 3**, `canUseTool` fails CLOSED (every tool
call is denied with an explanation) until **Phase 4** wires the dsh ask channel, and the
model-facing `claude_code_*` tools in `@deepseek-ai/dsh-tool-claude-code` are still
registered-but-inert scaffolds until **Phase 5**.

### Running the tests

```sh
pnpm test           # offline: build + unit + composition. No subprocess, no network.
pnpm run test:live  # opt-in: DSH_CC_LIVE=1, real subprocesses, real claude.ai subscription
```

`pnpm test` also boots the repo's real `tests/composition/cordis.yml` through the cordis
Loader, which imports each row's **built** `lib/index.js` — that is what proves the
`exports` map, the `inject` list, the `Config` schema and the SDK-free `lib/types` for real,
rather than against TypeScript sources.

The live suite (`tests/live/`) drives nine real sessions on
`claude-haiku-4-5-20251001` with one-sentence prompts and isolated tmp working
directories, and asserts on a `pgrep` delta that no subprocess outlives a test. It is
gated with `describe.skipIf` so the default suites stay offline-green.

---

## The rule that governs everything downstream

**The dsh session log for a CC-backed session is a mirror, not a source of truth.**

dsh's normal invariant — everything the model sees is rebuildable from the log — does **not**
hold here, because Claude Code owns its own history and compacts it independently. Do not
attempt to drive a Claude Code request from `deriveMessages()`. Anything downstream that
assumes it can will be silently wrong the first time CC auto-compacts.

## Service API (`ctx.claudeCode`)

| Member | Phase 2 behavior |
|---|---|
| `open(options)` | opens (or resumes, or forks) a live session and returns its snapshot. Refuses a non-absolute or missing `cwd` with `INVALID_CWD` **before** anything spawns, and a session past `limits.maxConcurrentSessions` with `SESSION_LIMIT` |
| `get(id)` | the live snapshot of a registered session (status, model, pending asks), `undefined` when unknown |
| `list()` | every live session, in open order; a fresh array per call |
| `close(id)` | settles pending asks, aborts, closes the SDK query, ends the input stream, drops the registry entry |
| `session(id)` | the `CcSession` actor — `send` / `interrupt` / `waitForResult` / `onMessage`. Values (snapshots) cross tool boundaries; this handle does not |
| `accountInfo()` | the account from the first live session's cached initialize response. Throws `NO_LIVE_SESSION` when nothing is open: it never spawns a subprocess of its own |
| `config` | the schemastery-validated configuration |

All session lifecycle is registered through `ctx.effect()`, so disposing the plugin fiber
(HMR, plugin unload, process teardown) closes every session this service opened.

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

None, as this package registers no tool schema, no system-prompt contribution, and no
model-visible event; the model-facing surface belongs to `@deepseek-ai/dsh-tool-claude-code`
(delegation tools) and to the mirrored session log rendered by the harness UI.

#### KV Cache effect

No direct effect: this package contributes nothing to a dsh model request, so it cannot
invalidate a request prefix. The Claude Code subprocess maintains its own independent cache
over its own transcript, which the dsh mirror neither feeds nor invalidates.

## Known Limitations and Deferred Work

- **Every tool call is denied until Phase 4** — the session's `canUseTool` is a fail-closed
  stub that answers `deny` with an explanation naming the phase. A live session can read
  nothing and write nothing until the dsh ask channel is wired; that is deliberate (a
  silently-allowing default is the one failure mode that cannot be undone).
- **Nothing is mirrored into the dsh session log yet (Phase 3)** — `onMessage()` is the
  attachment point and every envelope already carries the metadata the mirror needs
  (`interruptArtifact`, `reinit`), but no `SessionEvent` is appended anywhere.
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
