# Session discovery, federation and resume — design

**Status:** design, approved 2026-08-19. Not implemented.
**Motivating trace:** a dsh session on b2studio, 2026-08-19, asked *"Can you list my open Claude
Code sessions?"*. `claude_code_list` answered `No Claude Code sessions are open in this
composition.` — correctly, and uselessly: **five** Claude Code sessions were running on that same
host at that moment, and the person asking could see them in their Claude app.

This document specifies the gap that answer exposes, and the design that closes it. Empirical
findings (§2) were measured on b2studio on 2026-08-19 against Claude Code `2.1.233` and
`@anthropic-ai/claude-agent-sdk@0.3.233`; every one of them changed the design, and several
killed an approach that looked obvious beforehand.

Related: [`phase1-api-contract.md`](phase1-api-contract.md) is the export-surface source of truth
this extends; [`dsh-claude-code-integration.md`](dsh-claude-code-integration.md) is the original
build spec.

---

## §1 The problem

`ClaudeCode.list()` and `claude_code_list` report exactly one thing: sessions **this dsh
composition holds open**. That is the correct denominator for the question the tool was built to
answer — *"`claude_code_open` just failed with `SESSION_LIMIT`; which slot may I close?"* — because
`limits.maxConcurrentSessions` counts composed sessions and nothing else.

It is the wrong denominator for the question a person actually asks. "My open Claude Code
sessions" means every session that exists on their machines: terminal sessions, background agents,
sandbox-container sessions, sessions on the other mesh hosts, and the recently-closed ones they
might want to pick back up. Three capabilities are missing, and the user's requirement is all
three:

1. **See everything.** One list covering the composition, this host, and the mesh.
2. **Continue anything.** Resume or fork a session that was started somewhere else.
3. **Be visible in the app.** A session dsh opens should be reachable from claude.ai / the Claude
   mobile and desktop apps, the way `claude --remote-control` sessions are.

### §1.1 Non-goals

- **Enumerating claude.ai *cloud* sessions.** No CLI or SDK surface for this was found (`--cloud`
  and `--teleport` create or attach; neither lists). Cloud-created sessions stay invisible to dsh
  until such a surface exists. `--teleport`'s interactive picker is not scriptable.
- **Sending to an external live session.** A session owned by another process has no control
  channel we may use. External live sessions are observable and forkable, never sendable. §3 makes
  that distinction explicit in the data model so a model cannot try.
- **Real-time push.** Discovery is polled and cached (§6.4). No watchers, no daemons.
- **Syncthing-replicating `~/.claude/`.** Considered and rejected: heavy JSONL churn, sync-conflict
  risk on live transcripts, and it still would not answer "is it running", so per-host probes would
  be needed anyway.

---

## §2 Empirical findings

Reproducible, and each one load-bearing. `P4`, `P5` and `P7` each invalidated a simpler design.

| id | Finding | Evidence | Design consequence |
|---|---|---|---|
| **P1** | `listSessions()` returns rich metadata fast: 8 sessions in **64 ms**, each with `sessionId`, `summary`, `customTitle?`, `firstPrompt?`, `cwd`, `gitBranch`, `createdAt`, `lastModified`, `fileSize`. `{ dir }` filters by project. | `listSessions({ limit: 8 })` in-process on b2studio | The *resumable* half of the list is nearly free on the local host, with no subprocess. §5.1 |
| **P2** | `~/.claude/sessions/<pid>.json` is the live-session registry. One small file per process: `{ pid, sessionId, cwd, startedAt, procStart, version, kind, entrypoint, messagingSocketPath, name, nameSource }`. | `cat ~/.claude/sessions/17576.json` | Liveness is a directory of tiny JSON files. No CLI spawn needed to enumerate live sessions. §5.2 |
| **P3** | `claude agents --json` exists and works headlessly (no TTY), returning live interactive + background sessions. | `claude agents --json`, and over `ssh -o BatchMode=yes b2umini.local '~/.local/bin/claude agents --json'` | Usable, but see P4 — **not** the mechanism we build on. |
| **P4** | **CLI version skew across the mesh is already real.** On b2mini, `claude` on `PATH` is Homebrew **2.1.104** and fails `--json` with `error: unknown option '--json'`; the current binary is `~/.local/bin/claude` (2.1.220). On b2umini, `claude` is not on the non-interactive `PATH` at all (binary at `~/.local/bin/claude`, 2.1.233). | per-host probe over SSH | **Discovery must not depend on the remote CLI.** The probe reads files (§5), so a host with an old, mislinked or absent `claude` still reports correctly. |
| **P5** | **The registry contains stale entries.** b2umini reported `kind: "interactive"` sessions with pids started 2026-08-11 — eight days before the probe. | `claude agents --json` on b2umini | The probe must validate liveness itself (§5.2). A list that reports week-old dead sessions as live is worse than no list. |
| **P6** | A mesh host can simply be unreachable: `b2hx.local` fails mDNS resolution from b2studio, and `b2hx.tail2e8f81.ts.net:22` timed out. | `ssh` probes | Partial results are the normal case. Unreachable hosts render as named warnings and never fail the call. §10 |
| **P7** | **The same repository has different absolute paths per host.** b2umini's live sessions report `cwd: /System/Volumes/Data/mnt/b2/Developer/mine/grigios` (its NFS view of b2studio's `/Users/b2/Developer/mine/grigios`). | `claude agents --json` on b2umini | Cross-host resume needs cwd translation, and the local project slug must be derived from the *translated* path. §8.2 |
| **P8** | `claude -p --remote-control` is accepted and completes in headless print mode; and `extraArgs: { 'remote-control': null }` passes cleanly through the SDK `query()` path (`system/init` received, `result: success`). | `echo '…' \| claude -p --remote-control`; an SDK streaming-input probe with `extraArgs` | App visibility (§9) is a small option passthrough, not a controller-bridge rewrite. What stays unverified is whether a long-lived session then *appears and is drivable* in the app — that needs a human looking at the app. |
| **P9** | A full `~/.claude/projects/*/*.jsonl` mtime scan costs **85 ms** for 1455 files (1309 project dirs); 89 files were modified in the last 24 h. There is no global session index; per-project dirs hold `<id>.jsonl` plus a tiny `<id>.ccr-tip.json` (`{ eventId, updatedAt }`). | `python3` stat sweep on b2studio | A bounded mtime-windowed scan is a viable store reader for hosts where the SDK is unavailable. §5.3 |
| **P10** | Transcripts get large: a single live session's JSONL was **9.5 MB**; another 4.4 MB. | `listSessions()` `fileSize` | Cross-host adoption must cap transfer size and compress. §8.2 |

---

## §3 The session model

Discovery returns one type with three **origins**. The origin determines what is true of a
session, and every consumer branches on it rather than guessing from other fields.

| origin | Meaning | Fidelity | `sendable` | `resumable` |
|---|---|---|---|---|
| `composed` | Opened by *this* dsh composition | Full: `CcSessionSnapshot` — status, pending asks, human-decision receipts, mirrored dsh session | **yes** | via fork |
| `live-external` | Running, but owned by another process: another terminal on this host, another mesh host, the sandbox container | Observational: id, cwd, name, kind, entrypoint, CLI version, age | no | **fork only** (§8.1) |
| `resumable` | On disk, not running | Store metadata: title, first prompt, git branch, timestamps, size | no | yes |

Why this is load-bearing: a model that cannot distinguish "I can send to this" from "I can only
fork this" will try to send, and the failure will look like a bug in the seam. The existing tool
surface has exactly one implicit origin (`composed`), which is why nothing needed the distinction
until now.

`sendable` and `resumable` are carried as explicit booleans rather than left to be re-derived from
`origin` by each consumer, so the rule lives in one place (the seam) and the rendered list can
state it in prose.

---

## §4 Architecture and boundaries

This repository is written to be upstreamable into the harness monorepo as a *move*, not a
rewrite. It therefore must not learn about anyone's specific machines. The split:

```
┌─ dsh-claude-code (generic, upstreamable) ─────────────────────────────┐
│                                                                       │
│  packages/claude-code            the seam                             │
│    + discovery coordinator: merge, dedupe, cache, clock-normalize     │
│    + LocalDiscoverySource: SDK listSessions() + session registry      │
│    + registerDiscoverySource() hook                                   │
│                                                                       │
│  packages/claude-code-remote     NEW: generic remote-probe source     │
│    runs a probe per configured target — any argv (ssh, container      │
│    exec, or a local run with --home) — parses §5.4, translates paths  │
│                                                                       │
│  scripts/claude-inventory        NEW: the probe (Python, stdlib only) │
│    reads ~/.claude; needs no `claude` binary and no Node              │
│                                                                       │
│  packages/tool-claude-code       + `scope` on claude_code_list        │
│                                  + `from_host` on claude_code_open    │
└───────────────────────────────────────────────────────────────────────┘
┌─ b2infra (site-specific: configuration and distribution only) ────────┐
│  etc/dsh/cordis.patch.yml        a 4th row: hosts, probe path, pathMap│
│  ~/infra/scripts/claude-inventory  the probe, Syncthing-replicated    │
└───────────────────────────────────────────────────────────────────────┘
```

Two decisions worth stating because the obvious alternatives are wrong:

**The remote source is generic, not a "mesh" plugin.** "Run a probe command against a list of
named targets and parse its JSON" carries no site knowledge. Host names, SSH aliases, tailnet
fallbacks, `container exec` argv and path-translation rules are all *config*. So the code
upstreams and only the YAML is local.

**The probe ships in this repo, and is distributed by b2infra.** The probe's output schema and the
plugin's parser must version together (§5.4), so they live in one repo. b2infra's deploy step
places it in `~/infra/scripts/`, which Syncthing already replicates to every host — no per-host
install, and no deploy step that can be forgotten. The plugin invokes it by absolute path, because
P4 proved the non-interactive `PATH` cannot be trusted.

---

## §5 The probe

`scripts/claude-inventory` — Python 3, standard library only (matching the house bash→Python
convention), runnable and debuggable by hand:

```
claude-inventory [--home DIR] [--window-ms MS] [--max-resumable N] [--no-titles]
```

`--home` exists for testability and for the container: it makes the whole probe a pure function of
a directory tree, so specs point it at a fixture (§11) and the sandbox is read with
`--home ~/claude-sandbox-home`. It reads only; it never spawns `claude`, never needs Node, and
never emits transcript bodies.

### §5.1 Fidelity tiers, stated honestly

Two readers of the same data, with different fidelity:

- **Local host — the SDK.** `listSessions()` (P1) gives authoritative metadata including
  `customTitle` and the SDK's own `summary` folding, in 64 ms, in-process. The local source uses
  it and does **not** shell out to the probe.
- **Remote hosts and the container — the probe.** Metadata is reconstructed from the files: title
  falls back to the first user prompt, and the SDK's summary-folding is not reproduced. This is
  documented, not hidden: each entry carries `fidelity: 'sdk' | 'probe'` so a renderer can say so
  when it matters.

### §5.2 Live sessions

Read `$HOME/.claude/sessions/*.json` (P2). For each entry, validate liveness rather than trusting
the file (P5): the pid must exist (`os.kill(pid, 0)`), and — to defend against pid reuse — the
recorded `procStart`/`startedAt` must agree with the running process's start time where the
platform exposes it (`ps -o lstart=` on macOS/Linux; best-effort, and the check's outcome is
reported per entry as `liveness: 'confirmed' | 'assumed'`). Entries that fail become
`resumable`, not `live-external`, and the dead registry file is left alone — the probe never
mutates state it does not own.

### §5.3 Resumable sessions

Scan `$HOME/.claude/projects/*/*.jsonl`, filtered by mtime against `--window-ms` (default 7 days),
capped at `--max-resumable` (default 50) newest-first. P9 measured the full stat sweep at 85 ms
for 1455 files, so the scan is cheap; parsing is what needs bounding, so only the windowed
survivors are opened, and only their first N lines are read (for `sessionId`, `cwd`, `gitBranch`
and the first user prompt), plus `<id>.ccr-tip.json` for a cheap last-activity timestamp.

`--no-titles` suppresses prompt excerpts entirely (§12).

### §5.4 Output schema

```jsonc
{
  "schema": 1,                       // major; the parser refuses unknown majors with a warning
  "host": "b2umini",                 // as the probe sees itself (hostname -s)
  "generatedAt": 1787128000000,      // the probe's own clock — used for skew normalization (§6.3)
  "home": "/Users/b2",
  "claudeVersion": "2.1.233",        // best-effort, from the newest registry entry; may be absent
  "live": [{
    "sessionId": "…", "cwd": "…", "name": "grigios-cb", "pid": 3796,
    "kind": "interactive", "entrypoint": "sdk-cli", "startedAt": 1786611479355,
    "version": "2.1.220", "liveness": "confirmed"
  }],
  "resumable": [{
    "sessionId": "…", "cwd": "…", "title": "…", "gitBranch": "main",
    "lastModified": 1787126593762, "createdAt": 1787122193422, "sizeBytes": 9582760
  }],
  "warnings": ["~/.claude/projects: not readable"]
}
```

Schema versioning is a hard requirement of the distribution model: Syncthing propagates the probe
to every host in seconds, but the dsh profile's copy of the plugin only changes when
`install-into-dsh-profile.sh` runs. The two *will* be mismatched at times. `schema` makes that a
named warning instead of a parse crash.

---

## §6 Seam additions

All additive. No existing signature, ordering promise or error code changes.

### §6.1 Types

```ts
export type CcSessionOrigin = 'composed' | 'live-external' | 'resumable'
export type CcDiscoveryScope = 'composition' | 'host' | 'mesh'

export interface CcDiscoveredSession {
  readonly sessionId: CcSessionId
  readonly origin: CcSessionOrigin
  readonly host: string                 // the source's host label; the local host names itself
  readonly sourceId: string             // which source reported it, for debugging
  readonly cwd: string                  // translated to THIS host's paths where a map applies
  readonly remoteCwd?: string           // the untranslated path, when it differed (P7)
  readonly title?: string
  readonly gitBranch?: string
  readonly lastActivityAt: number       // clock-normalized (§6.3)
  readonly createdAt?: number
  readonly sendable: boolean            // true iff origin === 'composed'
  readonly resumable: boolean
  readonly fidelity: 'sdk' | 'probe'
  readonly live?: {
    readonly pid?: number
    readonly kind?: string
    readonly entrypoint?: string
    readonly claudeVersion?: string
    readonly liveness: 'confirmed' | 'assumed'
  }
  readonly composed?: CcSessionSnapshot  // present iff origin === 'composed'
  readonly sizeBytes?: number
}

export interface CcDiscoveryResult {
  readonly sessions: readonly CcDiscoveredSession[]
  readonly warnings: readonly string[]   // "b2hx: unreachable (ssh connect timeout 6000ms)"
  readonly generatedAt: number
  readonly cached: boolean
}

export interface CcDiscoverySource {
  readonly id: string
  readonly host: string
  discover(options: CcDiscoverRequest): Promise<CcDiscoveryResult>
}
```

### §6.2 Interface

```ts
interface ClaudeCode {
  // …existing…
  discover(options?: CcDiscoverOptions): Promise<CcDiscoveryResult>
  registerDiscoverySource(source: CcDiscoverySource): () => void
}
```

`CcDiscoverOptions`: `{ scope?, maxAgeMs?, refresh?, includeResumable? }`. `scope: 'composition'`
answers from the registry alone and touches no source — so the default path costs nothing.

The disposer return follows `attachAskTarget`'s existing shape, so a source-providing plugin
unregisters through `ctx.effect` like everything else.

### §6.3 Merge, dedupe, clock normalization

Sources are queried in parallel; a source that rejects or exceeds its deadline contributes a
warning, never an exception. Then:

**Dedupe by `sessionId`**, precedence `composed` > `live-external` > `resumable`. All three
collisions are expected, not edge cases: a composed session also has an on-disk transcript, and a
live session on this host appears in both the registry and the store scan.

**Normalize clocks.** Each probe reports its own `generatedAt` (§5.4). The coordinator computes
`offset = localNow - result.generatedAt` and applies it to that source's timestamps, so a host with
a skewed clock cannot produce a session that is "open for -3 hours" or sort to the wrong end. This
mirrors `inventory.ts`'s existing `elapsed()` defence, which floors at 0 rather than trusting a
clock.

**Never reorder the composed group.** `buildSessionInventory()`'s ordering is a promise the
`SESSION_LIMIT` path depends on ("the first row is the one you may close"). Composed sessions keep
that exact order; other origins sort by `lastActivityAt` descending within their own groups.

### §6.4 Config

```yaml
discovery:
  local: true            # the built-in local source
  cacheTtlMs: 15000      # per-source TTL; refresh: true bypasses
  recentWindowMs: 604800000
  maxResumable: 50
  includeTitles: true    # §12
```

Absent `discovery`, behaviour is exactly today's. The remote-source plugin carries its own config
(hosts, probe path, timeouts, `pathMap`) and registers itself with the seam on `apply`.

---

## §7 Tool surface

### §7.1 `claude_code_list`

New parameter `scope` (`'composition' | 'host' | 'mesh'`, default `'composition'`). The default
preserves the current output, ordering, prose and every existing spec.

Wider scopes render **grouped** sections rather than one merged ranking, because a single rank
cannot serve both "which may I close" and "what can I work with":

```
3 Claude Code session(s) in this composition, best close candidate first:
  1. <id>  idle   open 12m 04s  /Users/b2/Developer/mine/b2infra
  …
Running elsewhere (not sendable — fork to continue):
  b2studio  <id>  interactive  open 1h 02m  claude-mem/observer-sessions  "observer-sessions-34"
  b2umini   <id>  interactive  open 8d      …/mine/grigios  "grigios-cb"  (assumed live)
Resumable (on disk, not running):
  b2studio  <id>  4h ago  main  /Users/b2/Developer/mine/dsh-claude-code  "Review and plan DSH…"
Warnings:
  b2hx: unreachable (ssh connect timeout 6000ms)
```

Output schema gains optional `external_live`, `external_resumable` and `warnings` alongside the
existing `sessions`; `additionalProperties: false` and the post-execute output validation mean both
shapes must be declared, and the render stays a total function of `(args, value)` with the clock
read once in `execute` — the existing contract, unchanged.

The empty-state prose changes for wide scopes only. The current `EMPTY_SESSION_LIST` string is
what produced the motivating trace's misleading answer; at `scope: 'mesh'` with nothing found it
must say what was searched and what was unreachable, because "nothing exists" and "I could not
look" must never render alike.

### §7.2 `claude_code_open`

Gains `from_host` (phase 2b) to adopt a session another host owns. `resume` and `fork` keep their
meanings. The fork-if-live rule (§8.1) is enforced in the **seam**, not the tool, so the agent
adapter inherits it.

`claude_code_list`'s description gains one sentence pointing at `scope` for the "sessions I did not
open" case — that description is the only place a model learns the tool can answer the question at
all.

---

## §8 Resume

### §8.1 Same host (phase 2a)

Largely present already: `open({ resume, fork })` works, and `resolveQueryOptions` correctly emits
a bare `resume` for a continue and `sessionId + resume + forkSession` for a fork. Two additions:

**Discovery supplies the cwd.** A resumable session's cwd is known; requiring the model to
re-supply it invites a wrong guess, and a wrong cwd is exactly the failure mode already recorded in
`learnings/dsh-claude-code.md` (relative paths resolving against `$HOME`). When `resume` is given
and `cwd` is omitted, the seam fills it from discovery, and refuses with a clear error if discovery
cannot name it.

**Refuse a plain resume of a session that is live anywhere** — new error code
`SESSION_LIVE_ELSEWHERE`, carrying the host, pid and name, and telling the caller to pass
`fork: true`. Today's `SESSION_EXISTS` guard only sees composed sessions, so nothing currently
prevents dsh from appending to a transcript another live process is writing. That is transcript
corruption, and P5 shows long-lived external sessions are normal here.

### §8.2 Cross host (phase 2b)

Adoption, in order: locate via discovery; refuse over a size cap (P10: 9.5 MB is real, so cap and
compress — `ssh host gzip -c <path>`); translate the cwd through the configured `pathMap` (P7);
derive the local project slug from the *translated* cwd (the observed encoding replaces `/` with
`-`); write the transcript into the local store under its **original** session id, because that is
what `resume` looks up; then open with `resume: <sourceId>, fork: true, cwd: <translatedCwd>`.

Fork, never continue: the source host keeps an intact transcript, and the fork gets a fresh id, so
adoption is non-destructive by construction.

**One unknown, and it is phase 2b's first task, not an assumption.** Transcript entries carry
their own `cwd` values. Whether Claude Code re-reads those on resume — and therefore whether an
adopted transcript needs its embedded paths rewritten — is unverified. The phase begins with a
spike: adopt a small real session from b2umini, fork it, and check the resumed session's own view
of its cwd. If rewriting is needed, it happens during import, and the spike's finding is recorded
in `learnings/dsh-claude-code.md` either way.

---

## §9 App visibility

Add `extraArgs?: Record<string, string | null>` to `CcQueryOptions` (the SDK has supported it all
along; the seam simply never declared it) and a seam config `remoteControl`:

```yaml
remoteControl:
  enabled: false                  # default off — see §12
  namePrefix: dsh                 # → --remote-control-session-name-prefix
```

When enabled, sessions are opened with `--remote-control` via `extraArgs`, which P8 proved the SDK
plumbs cleanly. Prewarming must treat the flag as part of the pool fingerprint, not a
session-specific key, since a warm lease bound with different remote-control state would be wrong.

**What is verified and what is not.** Verified: the flag is accepted headlessly, and an SDK
streaming session with `extraArgs` reaches `system/init` and returns a successful result. Not
verified: that a long-lived dsh session then appears in the Claude app and is drivable from it. The
probe session lived 271 ms — far too short to observe in a UI. So phase 3 ends with a human check:
open a dsh session with `remoteControl.enabled`, then look at the app. If registration turns out to
require the interactive controller (`claude remote-control`), the fallback is a controller process
on b2studio and this section gets rewritten from the finding — which is why phase 3 is last and
depends on nothing else.

---

## §10 Failure modes

Each of these is a spec case in §11, and several were observed rather than imagined.

| Condition | Behaviour |
|---|---|
| Host unreachable — mDNS failure, tailnet timeout, powered off (P6) | Named warning; every other host's results still return |
| Host FileVault-locked pre-login | Indistinguishable from unreachable, and treated identically |
| Remote `claude` old, mislinked or absent (P4) | Irrelevant: the probe reads files. `claudeVersion` may be absent |
| `~/.claude` missing or unreadable | Empty result plus a warning naming the path |
| Stale registry entry (P5) | Liveness check demotes it to `resumable`; pid-reuse ambiguity surfaces as `liveness: 'assumed'` |
| Probe/plugin schema mismatch (§5.4) | Warning naming both versions; that source contributes nothing |
| Clock skew between hosts | Normalized against the probe's `generatedAt` (§6.3) |
| Probe emits malformed JSON | Warning with a bounded excerpt; never throws through `discover()` |
| Many hosts / slow SSH | Parallel with a concurrency cap, per-host deadline, single-flight per host, TTL cache |
| Transcript too large to adopt (P10) | Refusal naming the size and the cap, before any transfer |

The invariant across all of them: **`discover()` returns partial results with warnings; it does not
reject.** A list that fails because one laptop is asleep is not a list anyone can use.

---

## §11 Testing

Follows the repo's existing conventions exactly — offline specs against fakes, live specs gated on
`DSH_CC_LIVE=1`, and the same clock/dependency injection style that keeps `inventory.ts` pure.

**Probe specs.** `--home` makes the probe a function of a fixture tree, so the ugly cases are
ordinary unit tests: a stale registry entry with a dead pid; a pid-reuse collision; an unreadable
projects dir; a session whose cwd is an NFS-view path; an empty `~/.claude`; a huge transcript.

**Coordinator specs.** Fake sources returning canned §5.4 payloads: dedupe precedence across all
three origins; composed ordering preserved byte-for-byte against the existing golden; clock-skew
normalization (a source 3 hours fast, and one 3 hours slow); unreachable-source warning
propagation; schema-major rejection; TTL caching and `refresh: true`.

**Tool specs.** `scope: 'composition'` output identical to today's goldens (the regression that
matters most); grouped render goldens for `host` and `mesh`; the wide-scope empty state naming what
was searched; output-schema validation across both shapes.

**Live specs (`DSH_CC_LIVE=1`).** Local discovery must find the live test session it just opened;
a real SSH probe against b2umini must return well-formed schema-1 output; `SESSION_LIVE_ELSEWHERE`
must fire against a genuinely live external session; and cross-host adopt-and-fork must produce a
session that answers a question about the original transcript's contents.

---

## §12 Security posture

Stated plainly because two parts of this design deliberately widen exposure.

**Discovery discloses cwds and prompt excerpts across the mesh** to any model running in the
composition — including delegated subagents. On this single-user mesh that is ordinary, and it is
the point of the feature. `discovery.includeTitles: false` (and the probe's `--no-titles`) drops
prompt text for anyone who wants the weaker disclosure; transcript bodies are never emitted by the
probe under any setting. Transport is existing SSH keys and existing trust — no new auth surface,
no new listening port, no new daemon.

**Remote control (§9) is a real widening, and defaults to off.** Enabling it makes a dsh-opened
session on b2studio drivable from any device signed into that Claude account. That is the same
trade already accepted for `dsh-forwarder` (documented in b2infra's `CLAUDE.md`), and the same
reasoning applies — but unlike discovery it is opt-in per composition, because the blast radius is
"a stranger with the account can run tools on b2studio", not "an agent can read a directory name".

---

## §13 Phases

| Phase | Deliverable | Depends on |
|---|---|---|
| **1** | `scripts/claude-inventory` (§5); local discovery source; coordinator with merge/dedupe/clock/cache (§6); `packages/claude-code-remote` (§4); `scope` on `claude_code_list` (§7.1); b2infra's 4th cordis row + probe distribution | — |
| **2a** | cwd-from-discovery on resume; `SESSION_LIVE_ELSEWHERE` (§8.1) | 1 |
| **2b** | spike the embedded-cwd question, then cross-host adopt-and-fork (§8.2) | 1, 2a |
| **3** | `extraArgs` on `CcQueryOptions`; `remoteControl` config; prewarm fingerprint; human app-visibility check (§9) | — |

Phase 1 alone answers the motivating trace. Phase 3 is independent of 1–2b and can be done in any
order relative to them.

**b2infra-side follow-ups**, tracked with this work because the repo's docs are currently wrong
about it: add the remote-source row to `etc/dsh/cordis.patch.yml`; distribute the probe into
`~/infra/scripts/`; correct `CLAUDE.md`, which still says the Claude Code integration is "designed
but not yet built" while the composed rows exist in `etc/dsh/cordis.patch.yml`; and record the
phase-2b spike finding in `learnings/dsh-claude-code.md`.
