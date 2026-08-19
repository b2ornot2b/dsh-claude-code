# Troubleshooting

Every failure mode this integration actually hit, symptom first. If you are setting up for the
first time, [`QUICKSTART.md`](QUICKSTART.md) is the happy path.

| Symptom | Jump to |
|---|---|
| The agent's tool list has no `claude_code_*` tools | [→](#the-agent-has-no-claude_code_-tools) |
| Rows you added to a profile vanished | [→](#your-rows-disappeared-from-the-profile) |
| Your latest code change has no effect in dsh | [→](#dsh-is-running-yesterdays-build) |
| `Cannot find module` / a service never resolves after install | [→](#version-skew-between-this-repo-and-the-profile) |
| Nothing happens for a long time after a delegation | [→](#nothing-happens-for-a-minute-or-more) |
| `SESSION_LIMIT`: cannot open another session | [→](#session_limit-the-concurrency-cap-is-service-wide) |
| A prompt sits unanswered forever | [→](#an-ask-nobody-answers-pends-forever-by-design) |
| Billed for API usage while "on a subscription" | [→](#anthropic_api_key-is-set-but-auth-is-subscription) |
| `Native CLI binary for <platform> not found` | [→](#native-cli-binary-for-platform-not-found) |
| `TS6305` cascade from a build | [→](#ts6305-after-deleting-lib-by-hand) |

---

## The agent has no `claude_code_*` tools

**Symptom.** The agent answers "I don't have a tool for that", or its tool list simply has no
`claude_code_open`. Nothing errored. Nothing was logged.

**Cause.** The compose rows were never composed. The most common reason by far: the rows were
added to a `cordis.patch.yml` as bare `id` + `name` entries. In a patch file, a bare row is an
**override of an existing entry**, not a new one — and an override for an entry that does not
exist is skipped with `patch: entry "..." not found`. Silently, as far as the agent is concerned.

**Fix.**

1. Confirm what the profile actually composed:

   ```sh
   dsh --profile <profile> --dump-config
   ```

   Look for the three ids: `claude-code`, `tool-claude-code`, `claude-code-agent`. If they are
   absent, the rows did not land.
2. Make sure the rows sit under `insert:`, exactly as in
   [`scripts/rows.snippet.yml`](../scripts/rows.snippet.yml). `scripts/install-into-dsh-profile.sh`
   writes them that way for you.
3. Confirm the packages themselves are present:

   ```sh
   ls ~/.dsh/profiles/node_modules/@deepseek-ai/ | grep claude-code
   # dsh-claude-code  dsh-claude-code-agent  dsh-tool-claude-code
   ```
4. Restart dsh. Rows are read at compose time.

Related: `tool-claude-code` declares `inject: ['tools', 'claudeCode']`, so it stays **pending**
(mounted, but inactive and silent) until both services exist. If the `claude-code` row failed to
mount, the tools row never activates and nothing says so.

## Your rows disappeared from the profile

**Symptom.** You edited `~/.dsh/profiles/<profile>/cordis.patch.yml`, it worked, and after the
next deploy the tools were gone and the file no longer had your block.

**Cause.** That `cordis.patch.yml` is a **deployed artifact**, not a source of truth. A deploy
step installs it into the profile from somewhere else, so edits made to the profile copy are
reverted on the next deploy — and the daemon restarts believing it composed your rows. This cost
a full debugging cycle once; it looks exactly like "the rows silently stopped working".

**Fix.** Put the rows in the **source** the profile is deployed from, re-deploy, then restart dsh.

`scripts/install-into-dsh-profile.sh` detects this case (it looks for a `deployed to .../profiles`
header in the file's first five lines), **refuses to edit the deployed copy, prints the exact rows
to add, and exits `2`**. That exit code is the script telling you the package files installed fine
and only the rows are left to you — it is not a failure of the install.

## dsh is running yesterday's build

**Symptom.** You changed code, ran `pnpm run build`, restarted dsh — and the old behaviour is
still there.

**Cause.** `scripts/install-into-dsh-profile.sh` **copies** each package's built `lib/` into
`~/.dsh/profiles/node_modules/`. The profile holds a snapshot, not a live view of your working
tree.

**Fix.** Re-run the installer after every rebuild:

```sh
scripts/install-into-dsh-profile.sh <profile>   # it runs pnpm run build for you
```

**Why it copies instead of symlinking** (do not "fix" this by linking): Node resolves a symlinked
package's bare imports from the package's **real** location. A link back into this repo would
therefore resolve `@deepseek-ai/cordis` and the `dsh-*` peers to *this repo's own* `node_modules`
— a second copy of a module singleton, which breaks cordis service resolution. The symptom of
that mistake is not an import error; it is a service that mysteriously never resolves, or two
services that cannot see each other. Copying makes those bare imports resolve against the
profile's own dsh packages instead.

The Claude Agent SDK is the one exception the installer symlinks: it has no dsh peers to
mis-resolve, and copying its platform binaries would cost ~100 MB.

## Version skew between this repo and the profile

**Symptom.** Everything installs, but a service never resolves, a config key is rejected, or a
type-shaped runtime error appears only inside the profile — never in this repo's own tests.

**Cause.** This repo pins `@deepseek-ai/dsh-*@0.1.0-rc.7` exactly (see the root `package.json`
devDependencies). A dsh profile may be running a different rc.

**How to check:**

```sh
node -p "require('./package.json').devDependencies['@deepseek-ai/dsh-session']"   # this repo
cat ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-session/package.json | grep '"version"'
```

**What copying buys you.** Because the installer copies `lib/` rather than linking it, the
plugin's bare imports resolve against **the profile's own** dsh packages — so the plugin adopts
whatever `dsh-*` version the profile runs, instead of dragging rc.7 along beside it. Minor rc
skew usually just works for that reason. What copying cannot fix is a genuine API change between
rcs: if a seam this integration calls changed shape, rebuild against the profile's version.

`@deepseek-ai/cordis` is a **peer** dependency in all three packages, for the same reason: two
copies of cordis break service resolution.

## Nothing happens for a minute (or more)

**Symptom.** The agent calls `claude_code_open`, and then… nothing. No approval prompt in the dsh
UI, no output, for what feels like a long time.

**Cause.** This is almost always normal. Claude Code **thinks before it asks**: it reads files,
plans, and only then reaches for a tool that needs permission. The first ask therefore arrives
seconds — sometimes minutes — after the tool call starts. Meanwhile the seam is doing exactly
what it should and there is nothing to show.

**Fix.** Wait, and let the model poll. Concretely:

- `claude_code_wait` defaults to a **60-second** wait and **resolves** on expiry with
  `status: 'running'` plus `pending_ask_details` — it does not throw. The old behaviour (a
  ten-minute block, then a `CC_TIMEOUT` error) taught delegating models to cancel and re-open;
  that error code no longer exists.
- The rendered text tells the model to call `claude_code_wait` again and explicitly not to cancel
  or open a new session. If your agent is doing that anyway, it is ignoring the tool result.
- `claude_code_status` answers immediately, without waiting, and always carries
  `pending_ask_details` (empty when nothing pends).
- Synchronous `claude_code_open` has its own ten-minute ceiling and behaves the same way on
  expiry: `status: 'running'`, the session id, the pending asks. The session is untouched and
  still working.

If `pending_ask_details` is empty and the status is `running`, nothing is blocked on a human —
the turn is simply long.

## `SESSION_LIMIT`: the concurrency cap is service-wide

**Symptom.** `claude_code_open` fails with `SESSION_LIMIT`, and the agent insists it only has one
or two sessions open.

**Cause.** `limits.maxConcurrentSessions` (default **4**) is enforced **service-wide**, and the
service outlives any one dsh session. Slots can be held by sessions opened by *other* dsh sessions
sharing the host, or by earlier runs. In the trace that motivated this, one slot had been held for
1h32m by a session parked on a permission prompt nobody ever answered.

**Fix.**

1. The refusal message already carries the full inventory — every live session, its `cwd`, status,
   age, idle time, what it is blocked on, and which one is the best close candidate. The same data
   is on `error.data.sessionLimit`.
2. Call **`claude_code_list`** to see that inventory at any time (`include_closed: true` also shows
   recently-closed sessions and why each ended).
3. Close a session you no longer need with `claude_code_close`. Sessions are listed
   best-candidate-first; one with a pending ask is listed last and flagged **do not close** —
   somebody may be mid-decision, and closing it denies their tool call for them.
4. Raise `limits.maxConcurrentSessions` in the `claude-code` row if the cap itself is wrong.
5. For a long-lived host service that keeps accumulating abandoned sessions, set
   `limits.idleTimeoutMs`. It is **opt-in and unset by default** — unset installs no timer at all.
   When set, one service-wide sweep closes sessions that are `idle`, have **zero pending asks**,
   and have seen no activity for that long (`closeReason: 'reaped'`). A session with a pending ask
   is never reaped, however long it has sat.

## An ask nobody answers pends forever, by design

**Symptom.** A session sits blocked on a permission prompt indefinitely. Hours. Nothing times out.

**Cause.** `ask.timeoutMs` is **unset by default, and unset installs no timer at all**. An
interactive ask pends until a human answers it, an abort reaches it, or the session closes. That
is the deliberate interactive posture: a permission prompt has no park deadline, and denying
someone's work because they went to lunch is worse than waiting.

**Fix / the knobs:**

| Config | Effect |
|---|---|
| `ask.timeoutMs` | bounded wait for asks that *can* reach a human. Unset = pend indefinitely. |
| `ask.delegatedTimeoutMs` | bounded wait when **no human can be reached at all** — a delegated (owned) agent, no answerer registered, a dismissed prompt. Defaults to **120000** (2 minutes). |
| `ask.fallback` | what happens when a wait elapses or the ask cannot be routed: `deny` (default), `first-option`, or `error`. |

Two consequences to keep straight. A missing `ctx.approval` is **always** a fail-closed deny — no
fallback policy can turn an absent approver into a grant. And a settle that came from a timeout or
the fallback is recorded with `decided_by: 'policy'`, never `'human'`; an agent reporting that as
"the operator refused" is misreading the receipt.

## `ANTHROPIC_API_KEY` is set, but `auth` is `subscription`

**Symptom.** Everything works — and you are billed for API usage you thought your subscription
covered. There is no error message. This is the failure mode with the worst signal-to-cost ratio
in the whole integration.

**Cause.** The Claude Code subprocess picks up `ANTHROPIC_API_KEY` from its environment and uses
the API instead of your subscription login. Nothing warns you.

**What the seam does about it.** Under `auth: 'subscription'` (the default) the seam **deletes
`ANTHROPIC_API_KEY` from the environment it passes to the subprocess**. Related and equally
load-bearing: the SDK's `options.env` *replaces* the subprocess environment rather than merging
it, so the seam always spreads `process.env` first — otherwise `PATH`/`HOME` are lost and the
subscription login stops resolving at all.

**Fix.** Decide which one you want and configure it explicitly:

- **Subscription** — keep `auth: subscription`. You do not need a key, and one being set in your
  shell is harmless because the seam strips it.
- **API key** — set `auth: api-key`. The config stores a credential **reference** name
  (`apiKeyRef`, default `ANTHROPIC_API_KEY`) resolved per operation through `ctx.credentials`,
  never a raw key, so rotation needs no restart. An empty `apiKeyRef` under `auth: api-key` is
  rejected at config time with `INVALID_CONFIG` — precisely so it cannot silently fall back to
  whatever the ambient environment holds.

`accountInfo()` on the seam reports which auth is actually live — but it needs **at least one live
session** to answer, because the account details arrive with a session's own handshake. Open a
session first, then ask.

## `Native CLI binary for <platform> not found`

**Symptom.** A session fails at spawn time with that message, typically in CI, a container, or an
install run with optional dependencies disabled.

**Cause.** `@anthropic-ai/claude-agent-sdk` ships its native CLI binary as **optional platform
dependencies**. If your install skipped optional deps, or your package manager ignored npm's
`libc` field, the binary for your platform is not there. (The same mechanism roughly doubles
install size on Linux when the field is ignored the other way.)

**Fix.** Point the seam at a `claude` executable you already have:

```yaml
- id: claude-code
  name: '@deepseek-ai/dsh-claude-code'
  config:
    executablePath: /absolute/path/to/claude
```

`executablePath` is the `pathToClaudeCodeExecutable` escape hatch; with it set, the bundled binary
is never used. `which claude` will tell you the path.

## `TS6305` after deleting `lib/` by hand

**Symptom.** `pnpm run build` emits nothing, and dependent packages then fail with a cascade of
`TS6305: Output file ... has not been built from source file ...`.

**Cause.** `*.tsbuildinfo` is gitignored (so a fresh clone builds correctly), but deleting `lib/`
by hand leaves the sibling `tsconfig.tsbuildinfo` behind, and `tsc -b` believes it is up to date.

**Fix.**

```sh
pnpm run clean     # tsc -b --clean
pnpm run build
```

---

## Still stuck?

- `pnpm run typecheck` and `pnpm test` are fully offline — no subprocess, no network. If they
  pass, the problem is in composition or environment, not in this code.
- `pnpm run test:live` (`DSH_CC_LIVE=1`) spawns real Claude Code subprocesses against your real
  login. It is the fastest way to prove auth and the SDK are healthy end to end.
- `node examples/delegation-demo/run.mjs` is the smallest complete reproduction of the whole
  integration; if it exits `0`, the packages are fine and the profile is where to look.
- The upstream gaps table in the root [`README.md`](../README.md) lists behaviours that are
  *blocked upstream* rather than broken here — check it before filing a bug.
