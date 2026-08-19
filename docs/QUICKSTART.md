# Quickstart

Zero to *"my dsh agent just delegated a task to Claude Code"*.

Two paths, in order. The first (**steps 1–3**) needs nothing but this repo and a logged-in
`claude` CLI, and ends with a real Claude Code subprocess writing a real file under a real
approval prompt. The second (**steps 4–6**) mounts the same three plugins into a running dsh
profile so a live agent can delegate from the dsh web UI.

If something goes wrong, [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) has every failure mode this
project actually hit, symptom first.

---

## Before you start: two things this project does not give you

**You need your own Claude Code access.** This repo is a *seam* — it drives the Claude Agent SDK,
which spawns the Claude Code CLI, which authenticates as **you**. A claude.ai subscription login
(`claude auth login`) or an Anthropic API key is required, and nothing here provides, proxies or
shares either one.

**Distribution note.** Anthropic's Agent SDK terms say third-party developers may not offer
claude.ai login or subscription rate limits inside their own products without prior approval.
Running this on your own machine against your own subscription is ordinary use. Shipping it as a
product that points *other people's* Max plans at it is the case that note is about — configure
`auth: 'api-key'` (with `ctx.credentials`) if you redistribute something built on this.

**Not published to npm.** All three packages are `private: true`. They keep the
`@deepseek-ai/dsh-*` names only so that upstreaming into the harness monorepo would be a *move*
rather than a rename — we do not own that npm scope. `npm install @deepseek-ai/dsh-claude-code`
will not work and is not meant to.

---

## 1. Prerequisites

| Requirement | Check |
|---|---|
| Node.js **>= 20** | `node -v` |
| **pnpm** (the repo pins `pnpm@10.33.0` via `packageManager`) | `pnpm -v` |
| A working **`claude` CLI login** | `claude auth status` |

If `claude auth status` shows you are not signed in:

```sh
claude auth login          # claude.ai subscription login
```

An `ANTHROPIC_API_KEY` in the environment works instead — but see step 4 and the
[API-key/subscription billing trap](TROUBLESHOOTING.md#anthropic_api_key-is-set-but-auth-is-subscription)
before you rely on it.

## 2. Clone, install, build

```sh
git clone <this-repo-url> dsh-claude-code
cd dsh-claude-code
pnpm install
pnpm run build
```

**The build is not optional.** Everything downstream — the demo, the composition tests, the
profile installer — boots packages through the cordis Loader, which `import()`s each package's
**built** entry point (`lib/index.js`), never its TypeScript sources.

Optional, offline, and a good sanity gate (no subprocess, no network):

```sh
pnpm run typecheck   # three packages + every spec, strict, skipLibCheck: false
pnpm test            # builds, then runs the offline suites
```

## 3. The fastest proof it works — the delegation demo

```sh
node examples/delegation-demo/run.mjs
```

That is the whole command. It:

1. boots [`examples/delegation-demo/cordis.yml`](../examples/delegation-demo/cordis.yml) through
   the real cordis Loader — all three packages of this repo plus `dsh-session`, `dsh-agent`,
   `dsh-system-prompt`, `dsh-tools`, `dsh-user-questions`, `dsh-user-approval`, `dsh-jobs-local`
   and `dsh-tool-jobs`. No test doubles, no mocked SDK;
2. registers a stand-in "DeepSeek agent" and an auto-answerer that **approves everything and logs
   what it approved**;
3. has that agent call the real `claude_code_open` tool, asking Claude Code to create
   `hello-from-claude-code.txt` with one exact line;
4. prints the tool's canonical JSON result, the mirrored dsh session's whole event-type timeline,
   and the created file's content;
5. closes the session, disposes the composition, and exits `0`.

Expect one real model turn on `claude-haiku-4-5-20251001` (pinned in that `cordis.yml`) and one
`Write` permission prompt, auto-approved by the demo's own answerer.

It runs in a fresh temp directory under `os.tmpdir()` and **does not clean up** — the created
file is left for you to look at. To choose the directory yourself:

```sh
node examples/delegation-demo/run.mjs --cwd /absolute/path/to/scratch
```

`--cwd` is the only argument the script parses; everything else is ignored. Exit `0` means the
file was created with byte-exact content and the mirror recorded the session.

> **Nothing printed for a while?** That is normal. Claude Code thinks before it acts, so the
> first permission prompt lands seconds — sometimes a minute or more — after the tool call
> starts. See [TROUBLESHOOTING](TROUBLESHOOTING.md#nothing-happens-for-a-minute-or-more).

---

## 4. Mount it into a real dsh profile

The demo proves the code works. This step puts the same plugins in front of a real agent.

```sh
scripts/install-into-dsh-profile.sh              # defaults to the profile named "web"
scripts/install-into-dsh-profile.sh <profile>    # or name one
DSH_HOME=/custom/dsh scripts/install-into-dsh-profile.sh <profile>   # default: ~/.dsh
```

What it does, in order:

1. runs `pnpm run build` for you;
2. **copies** each package's `lib/` + `package.json` into `~/.dsh/profiles/node_modules/@deepseek-ai/`
   (`dsh-claude-code`, `dsh-tool-claude-code`, `dsh-claude-code-agent`);
3. **symlinks** `@anthropic-ai/claude-agent-sdk` there (it has no dsh peers to mis-resolve, and
   copying its platform binaries would cost ~100 MB);
4. appends a marked block of compose rows to `~/.dsh/profiles/<profile>/cordis.patch.yml`.

Rollback is symmetrical:

```sh
scripts/install-into-dsh-profile.sh --uninstall <profile>
```

### Copying, not linking — and why you re-run this after every rebuild

A symlink back into this repo would make Node resolve the packages' bare imports from their
**real** location, pulling `@deepseek-ai/cordis` and the `dsh-*` peers out of *this repo's*
`node_modules`. Two copies of a module singleton break cordis service resolution outright.
Copying makes those bare imports resolve against the **profile's own** dsh packages instead,
whatever version they are.

The cost of that correctness: the profile holds a *snapshot*. **Re-run the installer after every
`pnpm run build`,** or the profile keeps running your previous code.

### The rows it adds

Exactly the block in [`scripts/rows.snippet.yml`](../scripts/rows.snippet.yml):

```yaml
- insert:
    - id: claude-code
      name: '@deepseek-ai/dsh-claude-code'
      config:
        prewarm: true
        auth: subscription
        defaults:
          permissionMode: default
          settingSources: []
        ask:
          fallback: deny
    - id: tool-claude-code
      name: '@deepseek-ai/dsh-tool-claude-code'
    - id: claude-code-agent
      name: '@deepseek-ai/dsh-claude-code-agent'
```

Three things about that block are load-bearing:

- **`insert:` is required.** A bare `id` + `name` row in a `cordis.patch.yml` is an *override* of
  an existing entry, and a patch that overrides an entry which does not exist is silently skipped
  with `patch: entry "..." not found`. Your tools then never appear and nothing reports an error.
- **`settingSources: []` is deliberate isolation.** The SDK loads *every* filesystem setting
  source when the key is omitted — including your global `CLAUDE.md` — into every delegated
  session. It has nothing to do with auth: credentials are not a setting source.
- **`ask.fallback: deny` is fail-closed.** An ask that cannot reach a human is denied, never
  granted.

Two more rows must be in the composition if you want
`claude_code_open({ background: true })`: a `ctx.jobs` provider —
`@deepseek-ai/dsh-jobs-local` is the one this repo's own compositions mount — **and**
`@deepseek-ai/dsh-tool-jobs`. Without them that one argument fails with `CC_NO_JOBS`; everything
else works untouched. (`@deepseek-ai/dsh-jobs` is the *definition* package and a peer dependency
of `dsh-tool-claude-code`; it is not a row you mount yourself.)

### The deployed-artifact caveat — read this before you edit anything by hand

Some dsh profiles are **deployed**: their `cordis.patch.yml` is installed from somewhere else by
a deploy script, so anything written into the profile copy is silently reverted on the next
deploy — while the daemon restarts believing it composed your rows.

The installer detects this (it looks for a `deployed to .../profiles` header in the file's first
five lines), **refuses to edit the copy, and exits `2`** after printing the exact rows to add.
The package files are still installed; only the rows are your job. Put them in the **source** the
profile is deployed from, re-deploy, then restart dsh.

Then restart dsh so the profile re-composes.

## 5. Your first delegation

Open the dsh web UI, pick an agent in that profile, and type something like:

```
Use claude_code_open to start a Claude Code session in /tmp/cc-scratch with the prompt:
"create a file notes.txt containing one line: hello from Claude Code".
Then call claude_code_wait on the session id it returns until the turn completes,
and tell me what the human decided on any permission prompts.
```

What to expect:

- `cwd` must be an **absolute** path, and the directory should already exist.
- `claude_code_open` opens the session, sends the prompt, and waits for that first turn. The
  session **stays open** after it returns — follow up with `claude_code_send`, and finish with
  `claude_code_close`.
- The seven tools available to the agent are `claude_code_open`, `_send`, `_wait`, `_status`,
  `_list`, `_cancel` and `_close`. If they are not in its tool list at all, jump to
  [TROUBLESHOOTING](TROUBLESHOOTING.md#the-agent-has-no-claude_code_-tools).

## 6. Answering the prompts in the dsh UI

Claude Code asks a human for three different things, and each is routed to the dsh seam that owns
it. All three appear in the dsh web UI like any other dsh prompt:

| What Claude Code did | Where it lands | What you do |
|---|---|---|
| Wants to run a tool (`Write`, `Bash`, `Edit`, …) | `ctx.approval.request()` — an approval prompt titled with the CLI's own one-liner, e.g. `Write: /tmp/cc-scratch/notes.txt` | approve or reject |
| Called `AskUserQuestion` | `ctx.userQuestions.ask()` — a clarifying question with options | pick an option, or type your own answer |
| Called `ExitPlanMode` | the same questions seam, with dsh's `plan-review` intent | approve the plan, or decline it with feedback |

Two behaviours worth knowing before you sit and stare at it:

- **Nothing times out on you by default.** `ask.timeoutMs` is unset in the shipped rows, which
  means an interactive ask pends *indefinitely* until you answer it (or the session is closed).
  That is the interactive posture, on purpose.
- **The waiting agent is not stuck.** `claude_code_wait` defaults to a 60-second wait and, when
  that elapses, **resolves** with `status: 'running'` plus `pending_ask_details` — the kind of
  ask, the tool, the exact sentence you are being shown, and how long it has been pending. The
  text it hands the model says plainly: a person must answer in the dsh UI, keep polling, do not
  cancel and do not open another session.
- **After you answer, the agent can prove it was you.** Completed turns carry `human_decisions`,
  each entry tagged `decided_by: 'human'` (you answered in the UI) or `'policy'` (a timeout, the
  fail-closed fallback, a stored always-allow rule, or the session closing). An agent that
  reports a policy denial as "the operator refused" is reading that field wrong.

---

## Where to go next

| | |
|---|---|
| A failure you are looking at right now | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) |
| Every tool argument, output field and error code | [`../packages/tool-claude-code/README.md`](../packages/tool-claude-code/README.md) |
| The seam: config schema, ask channel, mirror, limits, auth | [`../packages/claude-code/README.md`](../packages/claude-code/README.md) |
| CC-backed dsh agents | [`../packages/claude-code-agent/README.md`](../packages/claude-code-agent/README.md) |
| The complete export surface (source of truth) | [`phase1-api-contract.md`](phase1-api-contract.md) |
