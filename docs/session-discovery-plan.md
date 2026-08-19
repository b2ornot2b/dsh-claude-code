# Session Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `claude_code_list` able to report every Claude Code session on this host and across
the mesh — composed, running elsewhere, or resumable on disk — and let a dsh agent resume one it
did not open.

**Architecture:** A read-only Python probe reads `~/.claude` on any host and emits versioned JSON;
a discovery coordinator in the seam merges probe results with the composition's own registry,
deduping by session id and normalizing each source's clock; a generic remote-source plugin runs the
probe over any argv (ssh, `container exec`, or locally with `--home`); the tool layer gains a
`scope` parameter that leaves the default output byte-identical.

**Tech Stack:** TypeScript (NodeNext ESM, `tsc -b`), cordis 4.0.1 services, schemastery config
schemas, vitest 4 (projects `unit` / `composition`), Python 3 stdlib for the probe,
`@anthropic-ai/claude-agent-sdk@0.3.233`.

**Spec:** [`docs/session-discovery-design.md`](session-discovery-design.md) — read it first. Tasks
below cite its sections (`§5.2`, `P4`, …); the `P*` ids are measured findings, and several tasks
exist *only* because of them.

**Plan location note:** this repo's docs are flat lowercase-kebab under `docs/` with no date
prefixes (`phase1-api-contract.md`, `spec-review-and-plan.md`), so this plan follows that
convention rather than the skill's dated `docs/superpowers/plans/` default.

## Global Constraints

- **Scope:** Phase 1 (Tasks 1–10) and Phase 2a (Tasks 11–12) of spec §13. Phases 2b and 3 are out
  of scope for this plan.
- **Branch:** `feature/session-discovery`, already created off `develop`. Commit after every task.
- **Node >= 20, pnpm.** Never `npm install`. Workspace deps use `workspace:*`.
- **TypeScript:** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `skipLibCheck: false`. Optional properties must be added with conditional
  spreads (`...(x === undefined ? {} : { x })`), never assigned `undefined`.
- **In-package relative imports carry explicit `.ts` extensions** (`./discovery.ts`). Cross-package
  imports use the bare package name (`@deepseek-ai/dsh-claude-code`).
- **Named exports only.** A `default` export makes the cordis Loader discard `name`/`inject`/`Config`.
  `tests/exports.spec.ts` asserts this.
- **The probe is Python 3, standard library only.** Read-only: it must never spawn `claude`, never
  require Node, and never mutate anything under `~/.claude`.
- **Probe schema major is `1`.** Emitted as `"schema": 1`; parsers refuse unknown majors with a
  warning rather than throwing (spec §5.4).
- **`discover()` never rejects.** Source failures become entries in `warnings` (spec §10).
- **Purity:** projection and render functions are total over their arguments. Read the clock once in
  `execute`/`discover` and pass `now` in, matching `inventory.ts`.
- **Default behaviour is frozen.** At `scope: 'composition'` every existing output, ordering and
  string must be unchanged; with no `discovery` config block, behaviour equals today's.
- **Tests:** `pnpm test` (offline, must stay green and must not spawn `claude`). Live tests are
  gated on `DSH_CC_LIVE=1` and named `*.live.spec.ts` under `tests/live/`.
- **Build loop for dsh:** `pnpm run build` then `scripts/install-into-dsh-profile.sh web`, then
  restart dsh. Only `lib/` is copied, so an unbuilt change is invisible to dsh.

---

## File Structure

**New, in `packages/claude-code` (the seam):**
- `scripts/claude-inventory` — the probe (spec §5). Python 3, `--home` injectable.
- `src/discovery.ts` — pure merge/dedupe/clock-normalize/group. No I/O, clock injected.
- `src/discovery-local.ts` — the local source: SDK `listSessions()` + registry reader, both injected.
- `tests/probe.spec.ts`, `tests/discovery.spec.ts`, `tests/discovery-local.spec.ts`,
  `tests/discovery-service.spec.ts`, `tests/fixtures/probe-home/` — offline coverage.

**Modified, in `packages/claude-code`:**
- `src/types.ts` — discovery types, `SESSION_LIVE_ELSEWHERE` error code, `ClaudeCode` additions.
- `src/config.ts` — `discovery` block, `hostLabel`.
- `src/service.ts` — `registerDiscoverySource()`, `discover()`, TTL cache; resume changes (Task 11–12).
- `src/index.ts` — barrel exports.

**New package `packages/claude-code-remote`:**
- `src/parse.ts` — probe-output parser and schema-major gate.
- `src/paths.ts` — `pathMap` translation (spec P7).
- `src/source.ts` — `createProbeSource()`: runs an argv, parses, translates.
- `src/index.ts` — the cordis plugin (`name`/`inject`/`Config`/`apply`).

**Modified, in `packages/tool-claude-code`:**
- `src/list.ts` — wide-scope projection and grouped render.
- `src/index.ts` — `scope` parameter, output schema, description.

**In `b2infra` (Task 10):** `etc/dsh/cordis.patch.yml`, `~/infra/scripts/claude-inventory`, `CLAUDE.md`.

---

### Task 1: Probe — envelope and live sessions

Reads the live-session registry (spec §5.2, P2) and validates liveness itself, because the registry
holds week-old dead entries (P5).

**Files:**
- Create: `packages/claude-code/scripts/claude-inventory`
- Test: `packages/claude-code/tests/probe.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the schema-1 JSON envelope of spec §5.4 — `{ schema, host, generatedAt, home,
  claudeVersion?, live[], resumable[], warnings[] }`. `live[]` entries:
  `{ sessionId, cwd, name?, pid, kind?, entrypoint?, startedAt?, version?, liveness }` where
  `liveness` is `'confirmed' | 'assumed'`. CLI: `--home DIR`, `--window-ms MS`,
  `--max-resumable N`, `--no-titles`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/claude-code/tests/probe.spec.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * `claude-inventory` — the per-host probe.
 *
 * It reads files and never runs `claude`, because CLI version skew across this
 * mesh is already real: b2mini's PATH `claude` is 2.1.104 and rejects `--json`
 * (spec P4). And it validates liveness itself, because b2umini's registry
 * reported week-old pids as live interactive sessions (spec P5).
 */

const PROBE = fileURLToPath(new URL('../scripts/claude-inventory', import.meta.url))

/** A pid that cannot be running: above the platform maximum. */
const DEAD_PID = 4194303

interface ProbeOutput {
  schema: number
  host: string
  generatedAt: number
  home: string
  live: { sessionId: string, pid: number, cwd: string, name?: string, liveness: string }[]
  resumable: { sessionId: string }[]
  warnings: string[]
}

/**
 * Build a fixture `$HOME` containing a Claude Code state tree.
 * @param entries - registry files to write, keyed by filename.
 * @returns the fixture home directory.
 */
function fixtureHome(entries: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'cc-probe-'))
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  for (const [file, body] of Object.entries(entries)) {
    writeFileSync(join(home, '.claude', 'sessions', file), JSON.stringify(body))
  }
  return home
}

/**
 * Run the probe against a fixture home.
 * @param home - the fixture home directory.
 * @param args - extra CLI arguments.
 * @returns the parsed output.
 */
function runProbe(home: string, ...args: string[]): ProbeOutput {
  const raw = execFileSync('python3', [PROBE, '--home', home, ...args], { encoding: 'utf8' })
  return JSON.parse(raw) as ProbeOutput
}

describe('claude-inventory live sessions', () => {
  it('reports a live session and drops one whose process is gone', () => {
    const home = fixtureHome({
      'alive.json': {
        pid: process.pid,
        sessionId: '11111111-1111-4111-8111-111111111111',
        cwd: '/Users/b2/Developer/mine/b2infra',
        startedAt: 1787120000000,
        version: '2.1.233',
        kind: 'interactive',
        entrypoint: 'sdk-cli',
        name: 'b2infra-bd',
      },
      'dead.json': {
        pid: DEAD_PID,
        sessionId: '22222222-2222-4222-8222-222222222222',
        cwd: '/Users/b2/Developer/mine/grigios',
        startedAt: 1786611479355,
        kind: 'interactive',
        name: 'grigios-cb',
      },
    })

    const out = runProbe(home)

    expect(out.schema).toBe(1)
    expect(out.host).not.toBe('')
    expect(out.generatedAt).toBeGreaterThan(0)
    expect(out.live.map(entry => entry.sessionId))
      .toEqual(['11111111-1111-4111-8111-111111111111'])
    expect(out.live[0]?.name).toBe('b2infra-bd')
    expect(out.live[0]?.liveness).toMatch(/^(confirmed|assumed)$/)
    // The dead entry is not live, and the probe never deletes the file it read.
    expect(out.live.some(entry => entry.pid === DEAD_PID)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Developer/mine/dsh-claude-code && pnpm vitest run --project unit packages/claude-code/tests/probe.spec.ts`
Expected: FAIL — `ENOENT` on `scripts/claude-inventory` (the probe does not exist yet).

- [ ] **Step 3: Write minimal implementation**

```python
#!/usr/bin/env python3
"""claude-inventory — a normalized Claude Code session inventory for one host.

Reads $HOME/.claude and prints the schema-1 envelope documented in
docs/session-discovery-design.md §5.4. Read-only by construction: it never
spawns `claude` (CLI version skew across the mesh is real — design P4), never
requires Node, and never mutates anything it reads.

Stdlib only, Python 3.8+: it runs on every host via Syncthing with no install
step, including hosts where the Claude CLI is old, mislinked or absent.
"""

import argparse
import json
import os
import subprocess
import sys
import time

SCHEMA = 1

def now_ms():
    """Return the wall clock in integer milliseconds since the epoch."""
    return int(time.time() * 1000)

def host_label():
    """Return this host's short name, as the host labels itself."""
    return (os.uname().nodename or "unknown").split(".")[0]

def pid_alive(pid):
    """Report whether a process id currently exists."""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True          # it exists; it just is not ours
    except (TypeError, ValueError, OverflowError):
        return False

def proc_start(pid):
    """Return the OS-reported start time of a pid, or None when unavailable."""
    try:
        done = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)],
                              capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    out = done.stdout.strip()
    return out or None

def read_live(home, warnings):
    """Read the live-session registry, keeping only entries whose process runs."""
    root = os.path.join(home, ".claude", "sessions")
    if not os.path.isdir(root):
        warnings.append("%s: not a directory" % root)
        return []
    live = []
    for name in sorted(os.listdir(root)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(root, name)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                entry = json.load(handle)
        except (OSError, ValueError):
            warnings.append("%s: unreadable or malformed" % path)
            continue
        pid, session_id = entry.get("pid"), entry.get("sessionId")
        if not isinstance(pid, int) or not session_id or not pid_alive(pid):
            continue
        # Defend against pid reuse: a recycled pid would otherwise resurrect a
        # dead session (design P5). We can only ever downgrade confidence here,
        # never invent it, so an unavailable `ps` yields "assumed".
        recorded, actual = entry.get("procStart"), proc_start(pid)
        liveness = "confirmed" if recorded and actual and recorded == actual else "assumed"
        row = {"sessionId": session_id, "pid": pid,
               "cwd": entry.get("cwd") or "", "liveness": liveness}
        for key in ("name", "kind", "entrypoint", "startedAt", "version"):
            if entry.get(key) is not None:
                row[key] = entry[key]
        live.append(row)
    return live

def main(argv=None):
    """Parse arguments, build the inventory, print it as JSON."""
    parser = argparse.ArgumentParser(prog="claude-inventory")
    parser.add_argument("--home", default=os.path.expanduser("~"))
    parser.add_argument("--window-ms", type=int, default=7 * 24 * 60 * 60 * 1000)
    parser.add_argument("--max-resumable", type=int, default=50)
    parser.add_argument("--no-titles", action="store_true")
    args = parser.parse_args(argv)

    warnings = []
    live = read_live(args.home, warnings)
    versions = [row["version"] for row in live if row.get("version")]
    out = {"schema": SCHEMA, "host": host_label(), "generatedAt": now_ms(),
           "home": args.home, "live": live, "resumable": [], "warnings": warnings}
    if versions:
        out["claudeVersion"] = sorted(versions)[-1]
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Make it executable, run test to verify it passes**

```bash
chmod +x packages/claude-code/scripts/claude-inventory
pnpm vitest run --project unit packages/claude-code/tests/probe.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code/scripts/claude-inventory packages/claude-code/tests/probe.spec.ts
git commit -m "feat(probe): claude-inventory reads the live-session registry

Liveness is validated against the running process rather than trusted:
b2umini's registry reported pids from eight days earlier as live
interactive sessions (design P5). Pid reuse can only downgrade confidence
to 'assumed', never invent 'confirmed'."
```

---

### Task 2: Probe — resumable sessions

The on-disk half of the list (spec §5.3). A full stat sweep of 1455 transcripts costs 85 ms (P9), so
the scan is cheap; **parsing** is what needs bounding.

**Files:**
- Modify: `packages/claude-code/scripts/claude-inventory`
- Test: `packages/claude-code/tests/probe.spec.ts`

**Interfaces:**
- Consumes: Task 1's envelope.
- Produces: `resumable[]` entries `{ sessionId, cwd, title?, gitBranch?, lastModified, createdAt?,
  sizeBytes }`, newest first, capped by `--max-resumable`, windowed by `--window-ms`, titles
  suppressed by `--no-titles`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/claude-code/tests/probe.spec.ts
import { utimesSync } from 'node:fs'

/**
 * Write a transcript into a fixture home's store.
 * @param home - the fixture home.
 * @param slug - the project slug directory name.
 * @param id - the session id.
 * @param lines - JSONL entries.
 * @param ageMs - how long ago the file was last modified.
 */
function writeTranscript(
  home: string, slug: string, id: string, lines: unknown[], ageMs: number,
): void {
  const dir = join(home, '.claude', 'projects', slug)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  const when = (Date.now() - ageMs) / 1000
  utimesSync(file, when, when)
}

describe('claude-inventory resumable sessions', () => {
  it('reports windowed transcripts newest-first with cwd, branch and a title', () => {
    const home = fixtureHome({})
    writeTranscript(home, '-Users-b2-Developer-mine-b2infra',
      '33333333-3333-4333-8333-333333333333', [
        { type: 'user', cwd: '/Users/b2/Developer/mine/b2infra', gitBranch: 'main',
          sessionId: '33333333-3333-4333-8333-333333333333',
          message: { role: 'user', content: 'plan the session discovery work' } },
      ], 60_000)
    writeTranscript(home, '-Users-b2-Developer-mine-old',
      '44444444-4444-4444-8444-444444444444', [
        { type: 'user', cwd: '/Users/b2/Developer/mine/old',
          message: { role: 'user', content: 'ancient work' } },
      ], 30 * 24 * 60 * 60 * 1000)

    const out = runProbe(home)

    // The 30-day-old transcript is outside the default 7-day window.
    expect(out.resumable.map(entry => entry.sessionId))
      .toEqual(['33333333-3333-4333-8333-333333333333'])
    const [entry] = out.resumable as { cwd: string, gitBranch?: string, title?: string,
      sizeBytes: number, lastModified: number }[]
    expect(entry?.cwd).toBe('/Users/b2/Developer/mine/b2infra')
    expect(entry?.gitBranch).toBe('main')
    expect(entry?.title).toContain('plan the session discovery')
    expect(entry?.sizeBytes).toBeGreaterThan(0)
  })

  it('honours --window-ms, --max-resumable and --no-titles', () => {
    const home = fixtureHome({})
    for (let index = 0; index < 3; index += 1) {
      writeTranscript(home, `-slug-${index}`, `5555555${index}-5555-4555-8555-555555555555`, [
        { type: 'user', cwd: `/tmp/p${index}`, message: { role: 'user', content: `prompt ${index}` } },
      ], (index + 1) * 60_000)
    }

    expect(runProbe(home, '--max-resumable', '2').resumable).toHaveLength(2)
    expect(runProbe(home, '--window-ms', '90000').resumable).toHaveLength(1)
    const scrubbed = runProbe(home, '--no-titles').resumable as { title?: string }[]
    expect(scrubbed.every(entry => entry.title === undefined)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/claude-code/tests/probe.spec.ts`
Expected: FAIL — `resumable` is always `[]`.

- [ ] **Step 3: Write minimal implementation**

```python
# add to packages/claude-code/scripts/claude-inventory

PROMPT_SCAN_LINES = 40
TITLE_MAX = 160

def first_text(content):
    """Extract plain text from a transcript message's content field."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                text = part.get("text")
                if isinstance(text, str) and text.strip():
                    return text
    return None

def read_transcript_head(path, want_title):
    """Read the leading lines of a transcript for its metadata.

    Only the first PROMPT_SCAN_LINES lines are parsed: transcripts reach tens of
    megabytes (design P10) and everything needed sits at the top.
    """
    meta = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for index, line in enumerate(handle):
                if index >= PROMPT_SCAN_LINES:
                    break
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(entry, dict):
                    continue
                for key in ("cwd", "gitBranch", "sessionId"):
                    if key not in meta and entry.get(key):
                        meta[key] = entry[key]
                if want_title and "title" not in meta and entry.get("type") == "user":
                    message = entry.get("message")
                    text = first_text(message.get("content")) if isinstance(message, dict) else None
                    # A hook or system reminder is not what a person would call
                    # the session; skip to the first prompt that reads as one.
                    if text and not text.lstrip().startswith("<"):
                        meta["title"] = " ".join(text.split())[:TITLE_MAX]
    except OSError:
        return None
    return meta

def read_resumable(home, window_ms, limit, want_titles, warnings):
    """Scan the transcript store for recently-active sessions, newest first."""
    root = os.path.join(home, ".claude", "projects")
    if not os.path.isdir(root):
        warnings.append("%s: not a directory" % root)
        return []
    cutoff = time.time() - (window_ms / 1000.0)
    candidates = []
    for slug in os.listdir(root):
        slug_dir = os.path.join(root, slug)
        try:
            names = os.listdir(slug_dir)
        except OSError:
            continue
        for name in names:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(slug_dir, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if stat.st_mtime < cutoff:
                continue
            candidates.append((stat.st_mtime, stat.st_size, path, name[:-len(".jsonl")]))
    candidates.sort(reverse=True)
    rows = []
    for mtime, size, path, stem in candidates[:max(0, limit)]:
        meta = read_transcript_head(path, want_titles)
        if meta is None:
            warnings.append("%s: unreadable" % path)
            continue
        row = {"sessionId": meta.get("sessionId") or stem,
               "cwd": meta.get("cwd") or "",
               "lastModified": int(mtime * 1000),
               "sizeBytes": size}
        for key in ("gitBranch", "title"):
            if meta.get(key):
                row[key] = meta[key]
        rows.append(row)
    return rows
```

Then wire it into `main()`, replacing `"resumable": []`:

```python
    resumable = read_resumable(args.home, args.window_ms, args.max_resumable,
                               not args.no_titles, warnings)
    # …
           "home": args.home, "live": live, "resumable": resumable, "warnings": warnings}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run --project unit packages/claude-code/tests/probe.spec.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Sanity-check against real data, then commit**

```bash
python3 packages/claude-code/scripts/claude-inventory --max-resumable 5 | python3 -m json.tool | head -40
git add packages/claude-code/scripts/claude-inventory packages/claude-code/tests/probe.spec.ts
git commit -m "feat(probe): windowed, capped resumable-session scan

Only mtime-windowed survivors are opened and only their first 40 lines
parsed: the store holds 1455 transcripts and individual files reach 9.5 MB
(design P9, P10)."
```

---

### Task 3: Probe — degradation and warnings

Spec §10. Every row in that table is a real state of some host on this mesh; the probe must name
each one instead of failing.

**Files:**
- Modify: `packages/claude-code/scripts/claude-inventory`
- Test: `packages/claude-code/tests/probe.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: exit code 0 with a populated `warnings[]` for every degraded state; nonzero **only** for
  a usage error.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/claude-code/tests/probe.spec.ts
describe('claude-inventory degradation', () => {
  it('succeeds with warnings when there is no ~/.claude at all', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-probe-empty-'))

    const out = runProbe(home)

    expect(out.schema).toBe(1)
    expect(out.live).toEqual([])
    expect(out.resumable).toEqual([])
    // "nothing here" and "I could not look" must never render alike.
    expect(out.warnings.join('\n')).toContain('.claude')
  })

  it('warns about a malformed registry file without losing its siblings', () => {
    const home = fixtureHome({
      'good.json': {
        pid: process.pid, sessionId: '66666666-6666-4666-8666-666666666666', cwd: '/tmp',
      },
    })
    writeFileSync(join(home, '.claude', 'sessions', 'bad.json'), '{ not json')

    const out = runProbe(home)

    expect(out.live.map(entry => entry.sessionId))
      .toEqual(['66666666-6666-4666-8666-666666666666'])
    expect(out.warnings.join('\n')).toContain('bad.json')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/claude-code/tests/probe.spec.ts`
Expected: FAIL — the missing-`.claude` case currently warns about two subdirectories in wording the
first assertion may not match, and the malformed-file case needs the per-file guard proven.

- [ ] **Step 3: Write minimal implementation**

Make the missing-root case a single clear warning rather than two derived ones, in `main()` before
reading:

```python
    warnings = []
    claude_dir = os.path.join(args.home, ".claude")
    if not os.path.isdir(claude_dir):
        # Not an error: a mesh host may simply never have run Claude Code.
        warnings.append("%s: no Claude Code state directory on this host" % claude_dir)
        live, resumable = [], []
    else:
        live = read_live(args.home, warnings)
        resumable = read_resumable(args.home, args.window_ms, args.max_resumable,
                                   not args.no_titles, warnings)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run --project unit packages/claude-code/tests/probe.spec.ts`
Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code/scripts/claude-inventory packages/claude-code/tests/probe.spec.ts
git commit -m "feat(probe): degrade with named warnings, never fail

A host with no ~/.claude, an unreadable projects dir or a malformed
registry file still returns a usable inventory. Silence would read as
'nothing there' when the truth is 'I could not look' (spec §10)."
```

---

### Task 4: Discovery types and config

The vocabulary everything else uses (spec §3, §6.1, §6.4). Types and config only — no behaviour, so
the test is the exports and schema contract.

**Files:**
- Modify: `packages/claude-code/src/types.ts`, `packages/claude-code/src/config.ts`,
  `packages/claude-code/src/index.ts`
- Test: `packages/claude-code/tests/config.spec.ts`, `packages/claude-code/tests/exports.spec.ts`

**Interfaces:**
- Consumes: existing `CcSessionId`, `CcSessionSnapshot`, `CcErrorCode`.
- Produces: `CcSessionOrigin`, `CC_SESSION_ORIGINS`, `CcDiscoveryScope`, `CC_DISCOVERY_SCOPES`,
  `CcDiscoveredSession`, `CcDiscoveryResult`, `CcDiscoverySource`, `CcDiscoverRequest`,
  `CcDiscoverOptions`, `CcDiscoveryConfig`; config paths `hostLabel`, `discovery.local`,
  `discovery.cacheTtlMs` (15000), `discovery.recentWindowMs` (604800000), `discovery.maxResumable`
  (50), `discovery.includeTitles` (true); error code `SESSION_LIVE_ELSEWHERE`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/claude-code/tests/config.spec.ts
describe('discovery configuration', () => {
  it('defaults the discovery block and keeps it absent-safe', () => {
    const resolved = resolveClaudeCodeConfig({})

    expect(resolved.discovery).toEqual({
      local: true,
      cacheTtlMs: 15_000,
      recentWindowMs: 604_800_000,
      maxResumable: 50,
      includeTitles: true,
    })
    // hostLabel defaults to this host's short name, never an empty string.
    expect(resolved.hostLabel.length).toBeGreaterThan(0)
    expect(resolved.hostLabel).not.toContain('.')
  })

  it('accepts overrides', () => {
    const resolved = resolveClaudeCodeConfig({
      hostLabel: 'b2studio',
      discovery: { local: false, cacheTtlMs: 1, includeTitles: false },
    })

    expect(resolved.hostLabel).toBe('b2studio')
    expect(resolved.discovery.local).toBe(false)
    expect(resolved.discovery.cacheTtlMs).toBe(1)
    expect(resolved.discovery.includeTitles).toBe(false)
    expect(resolved.discovery.maxResumable).toBe(50)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/claude-code/tests/config.spec.ts`
Expected: FAIL — `resolved.discovery` is `undefined` and the property does not typecheck.

- [ ] **Step 3: Write minimal implementation**

In `src/types.ts` (append near the session types, and add the error code to `CcErrorCode`):

```ts
/** Where a discovered session came from, and therefore what is true of it. */
export type CcSessionOrigin = 'composed' | 'live-external' | 'resumable'

/** Runtime list of {@link CcSessionOrigin}, for schema enums. */
export const CC_SESSION_ORIGINS: readonly CcSessionOrigin[]
  = ['composed', 'live-external', 'resumable']

/** How wide a net {@link ClaudeCode.discover} casts. */
export type CcDiscoveryScope = 'composition' | 'host' | 'mesh'

/** Runtime list of {@link CcDiscoveryScope}, for schema enums. */
export const CC_DISCOVERY_SCOPES: readonly CcDiscoveryScope[] = ['composition', 'host', 'mesh']

/**
 * One session as discovery reports it, from any origin.
 *
 * `sendable` and `resumable` are carried explicitly rather than re-derived from
 * `origin` by every consumer: the rule belongs in one place, and a model that
 * cannot tell "I may send to this" from "I may only fork it" will try to send.
 */
export interface CcDiscoveredSession {
  readonly sessionId: CcSessionId
  readonly origin: CcSessionOrigin
  /** The host label that reported it; the local host names itself. */
  readonly host: string
  /** Which source reported it — for debugging a wrong answer. */
  readonly sourceId: string
  /** Working directory, translated to THIS host's paths where a map applies. */
  readonly cwd: string
  /** The untranslated path, present only when translation changed it. */
  readonly remoteCwd?: string
  readonly title?: string
  readonly gitBranch?: string
  /** Clock-normalized against the reporting source's own clock. */
  readonly lastActivityAt: number
  readonly createdAt?: number
  /** True only for `composed` sessions: nothing else has a control channel. */
  readonly sendable: boolean
  readonly resumable: boolean
  /** `sdk` metadata is authoritative; `probe` metadata is reconstructed. */
  readonly fidelity: 'sdk' | 'probe'
  readonly live?: {
    readonly pid?: number
    readonly kind?: string
    readonly entrypoint?: string
    readonly claudeVersion?: string
    readonly liveness: 'confirmed' | 'assumed'
  }
  /** Present exactly when `origin === 'composed'`. */
  readonly composed?: CcSessionSnapshot
  readonly sizeBytes?: number
}

/** What a source or the coordinator returns. Partial results plus warnings. */
export interface CcDiscoveryResult {
  readonly sessions: readonly CcDiscoveredSession[]
  /** Named degradations, e.g. `b2hx: unreachable (ssh connect timeout 6000ms)`. */
  readonly warnings: readonly string[]
  readonly generatedAt: number
  readonly cached: boolean
}

/** What the coordinator asks a source for. */
export interface CcDiscoverRequest {
  readonly now: number
  readonly includeResumable: boolean
  readonly recentWindowMs: number
  readonly maxResumable: number
  readonly includeTitles: boolean
  readonly signal?: AbortSignal
}

/** A contributor of sessions the composition did not open. */
export interface CcDiscoverySource {
  readonly id: string
  readonly host: string
  discover(request: CcDiscoverRequest): Promise<CcDiscoveryResult>
}

/** Caller-facing options for {@link ClaudeCode.discover}. */
export interface CcDiscoverOptions {
  readonly scope?: CcDiscoveryScope
  readonly includeResumable?: boolean
  /** Bypass the TTL cache. */
  readonly refresh?: boolean
}
```

Add to `CcErrorCode`:

```ts
  /**
   * A plain resume was refused because the target session is running
   * elsewhere. Two writers on one transcript corrupts it; fork instead.
   */
  | 'SESSION_LIVE_ELSEWHERE'
```

Add to the `ClaudeCode` interface:

```ts
  /**
   * Every session this composition can see, from every registered source.
   * Never rejects: source failures come back as `warnings` (spec §10).
   * @param options - scope and cache control.
   * @returns the merged, deduped, clock-normalized inventory.
   */
  discover(options?: CcDiscoverOptions): Promise<CcDiscoveryResult>

  /**
   * Contribute sessions from outside this composition.
   * @param source - the source to add.
   * @returns a disposer that removes it.
   */
  registerDiscoverySource(source: CcDiscoverySource): () => void
```

In `src/config.ts`:

```ts
import { hostname } from 'node:os'

/** Defaults for the discovery block. */
export const DEFAULT_DISCOVERY_CACHE_TTL_MS = 15_000
export const DEFAULT_DISCOVERY_WINDOW_MS = 604_800_000
export const DEFAULT_MAX_RESUMABLE = 50

/** Session-discovery surface configuration. */
export interface CcDiscoveryConfig {
  /** Discover sessions on this host (SDK store + live registry). */
  readonly local: boolean
  /** How long a source's result may be reused. */
  readonly cacheTtlMs: number
  /** How far back `resumable` reaches. */
  readonly recentWindowMs: number
  /** Per-source cap, so a rendered list stays scannable. */
  readonly maxResumable: number
  /** Include titles and first-prompt excerpts (spec §12). */
  readonly includeTitles: boolean
}

/**
 * This host's label in discovery output.
 * @returns the short hostname, or `local` when the platform gives nothing.
 */
export function defaultHostLabel(): string {
  const name = hostname().split('.')[0]
  return name === undefined || name === '' ? 'local' : name
}
```

Schema rows (inside the existing `z.object({ … })`):

```ts
  hostLabel: z.string().default(defaultHostLabel()),
  discovery: z.object({
    local: z.boolean().default(true),
    cacheTtlMs: z.number().min(1).default(DEFAULT_DISCOVERY_CACHE_TTL_MS),
    recentWindowMs: z.number().min(1).default(DEFAULT_DISCOVERY_WINDOW_MS),
    maxResumable: z.number().step(1).min(0).default(DEFAULT_MAX_RESUMABLE),
    includeTitles: z.boolean().default(true),
  }).default({}),
```

Add `hostLabel: string` and `discovery: CcDiscoveryConfig` as **required** members of
`ResolvedClaudeCodeConfig`, and optional members of `ClaudeCodeConfig`. Export every new name from
`src/index.ts` (values in the `export {}` block, types in `export type {}`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run typecheck && pnpm vitest run --project unit packages/claude-code/tests`
Expected: PASS. `exports.spec.ts` must still assert no default export.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code/src packages/claude-code/tests
git commit -m "feat(seam): discovery types, config block and error code

Three origins with explicit sendable/resumable flags, so the rule that
only composed sessions have a control channel lives in one place. Absent
a discovery block, behaviour is unchanged."
```

---

### Task 5: Pure merge, dedupe and clock normalization

Spec §6.3. Pure like `inventory.ts`: no I/O, clock injected, so the ugly cases are ordinary unit
tests.

**Files:**
- Create: `packages/claude-code/src/discovery.ts`
- Test: `packages/claude-code/tests/discovery.spec.ts`
- Modify: `packages/claude-code/src/index.ts`

**Interfaces:**
- Consumes: Task 4's types; `CcSessionSnapshot`; `buildSessionInventory` from `./inventory.ts`.
- Produces:
  - `ORIGIN_PRECEDENCE: readonly CcSessionOrigin[]`
  - `projectComposed(sessions: readonly CcSessionSnapshot[], host: string, now: number): CcDiscoveredSession[]`
  - `normalizeSourceClock(result: CcDiscoveryResult, now: number): CcDiscoveredSession[]`
  - `mergeDiscovered(groups: readonly CcDiscoveredSession[][], now: number): CcDiscoveredSession[]`
  - `groupByOrigin(sessions: readonly CcDiscoveredSession[]): { composed, liveExternal, resumable }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/claude-code/tests/discovery.spec.ts
import { describe, expect, it } from 'vitest'

import {
  groupByOrigin, mergeDiscovered, normalizeSourceClock, projectComposed,
} from '../src/discovery.ts'
import type { CcDiscoveredSession, CcDiscoveryResult, CcSessionId } from '../src/index.ts'

/**
 * The discovery merge — pure, clock-injected, and the only place the three
 * origins meet. Two properties matter most: a session reported by several
 * sources appears once at its highest fidelity, and a source with a skewed
 * clock cannot produce a session that has been open for a negative time.
 */

const NOW = 1_787_128_000_000

/**
 * Build a discovered session.
 * @param over - fields to override.
 * @returns the session.
 */
function discovered(over: Partial<CcDiscoveredSession>): CcDiscoveredSession {
  return {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as CcSessionId,
    origin: 'resumable',
    host: 'b2umini',
    sourceId: 'mesh:b2umini',
    cwd: '/Users/b2/Developer/mine/b2infra',
    lastActivityAt: NOW - 60_000,
    sendable: false,
    resumable: true,
    fidelity: 'probe',
    ...over,
  }
}

describe('mergeDiscovered', () => {
  it('keeps one entry per session id at the highest-precedence origin', () => {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as CcSessionId
    const merged = mergeDiscovered([
      [discovered({ sessionId: id, origin: 'resumable', fidelity: 'probe' })],
      [discovered({ sessionId: id, origin: 'live-external', fidelity: 'sdk',
        live: { liveness: 'confirmed' } })],
      [discovered({ sessionId: id, origin: 'composed', sendable: true, fidelity: 'sdk' })],
    ], NOW)

    expect(merged).toHaveLength(1)
    expect(merged[0]?.origin).toBe('composed')
    expect(merged[0]?.sendable).toBe(true)
  })

  it('sorts non-composed sessions most-recently-active first', () => {
    const merged = mergeDiscovered([[
      discovered({ sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as CcSessionId,
        lastActivityAt: NOW - 600_000 }),
      discovered({ sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as CcSessionId,
        lastActivityAt: NOW - 1_000 }),
    ]], NOW)

    expect(merged.map(entry => entry.lastActivityAt))
      .toEqual([NOW - 1_000, NOW - 600_000])
  })
})

describe('normalizeSourceClock', () => {
  it('shifts a fast source back and never reports a future activity time', () => {
    const skewMs = 3 * 60 * 60 * 1000
    const result: CcDiscoveryResult = {
      // The probe's clock is three hours ahead of ours.
      generatedAt: NOW + skewMs,
      cached: false,
      warnings: [],
      sessions: [discovered({ lastActivityAt: NOW + skewMs - 60_000 })],
    }

    const [entry] = normalizeSourceClock(result, NOW)

    expect(entry?.lastActivityAt).toBe(NOW - 60_000)
    expect(entry?.lastActivityAt).toBeLessThanOrEqual(NOW)
  })
})

describe('groupByOrigin', () => {
  it('splits the three origins and preserves input order within each', () => {
    const groups = groupByOrigin([
      discovered({ sessionId: '1' as CcSessionId, origin: 'composed', sendable: true }),
      discovered({ sessionId: '2' as CcSessionId, origin: 'resumable' }),
      discovered({ sessionId: '3' as CcSessionId, origin: 'live-external' }),
      discovered({ sessionId: '4' as CcSessionId, origin: 'resumable' }),
    ])

    expect(groups.composed.map(entry => entry.sessionId)).toEqual(['1'])
    expect(groups.liveExternal.map(entry => entry.sessionId)).toEqual(['3'])
    expect(groups.resumable.map(entry => entry.sessionId)).toEqual(['2', '4'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/claude-code/tests/discovery.spec.ts`
Expected: FAIL — cannot resolve `../src/discovery.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/claude-code/src/discovery.ts
/**
 * The discovery merge: pure, clock-injected, and the only place the three
 * session origins meet.
 *
 * Everything here is a total function of its arguments — the clock arrives as
 * `now`, exactly as `inventory.ts` takes it — so a merge can be replayed and a
 * spec can pin it.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { buildSessionInventory } from './inventory.ts'
import type {
  CcDiscoveredSession, CcDiscoveryResult, CcSessionOrigin, CcSessionSnapshot,
} from './types.ts'

/**
 * Highest fidelity first. A session reported by several sources is kept once, at
 * the origin that knows the most about it: `composed` carries a live snapshot
 * and a control channel, `live-external` knows a process exists, `resumable`
 * only knows a file.
 */
export const ORIGIN_PRECEDENCE: readonly CcSessionOrigin[]
  = ['composed', 'live-external', 'resumable']

/**
 * Project this composition's own sessions into discovery's shape.
 *
 * Order comes from {@link buildSessionInventory}, unchanged: the composed group
 * keeps the close-candidate ordering the `SESSION_LIMIT` path promises.
 *
 * @param sessions - snapshots from `ClaudeCode.list()`.
 * @param host - this host's label.
 * @param now - the clock reading ages are measured against.
 * @returns the composed sessions, best close candidate first.
 */
export function projectComposed(
  sessions: readonly CcSessionSnapshot[],
  host: string,
  now: number,
): CcDiscoveredSession[] {
  const byId = new Map(sessions.map(session => [session.id, session]))
  return buildSessionInventory(sessions, now).map((entry) => {
    const snapshot = byId.get(entry.id)
    return {
      sessionId: entry.id,
      origin: 'composed' as const,
      host,
      sourceId: 'composition',
      cwd: entry.cwd,
      lastActivityAt: now - entry.idleMs,
      sendable: true,
      resumable: true,
      fidelity: 'sdk' as const,
      ...(snapshot === undefined ? {} : { composed: snapshot }),
    }
  })
}

/**
 * Re-base one source's timestamps onto our clock.
 *
 * A mesh host's clock can differ from ours, and an unnormalized timestamp
 * produces a session that has been open for a negative time and sorts to the
 * wrong end of the list.
 *
 * @param result - one source's result, carrying the clock it used.
 * @param now - our clock.
 * @returns the source's sessions with timestamps shifted onto our clock.
 */
export function normalizeSourceClock(
  result: CcDiscoveryResult,
  now: number,
): CcDiscoveredSession[] {
  const offset = Number.isFinite(result.generatedAt) ? now - result.generatedAt : 0
  if (offset === 0) return [...result.sessions]
  return result.sessions.map(session => ({
    ...session,
    lastActivityAt: Math.min(now, session.lastActivityAt + offset),
    ...(session.createdAt === undefined
      ? {}
      : { createdAt: Math.min(now, session.createdAt + offset) }),
  }))
}

/**
 * Merge every source's sessions into one deduped list.
 *
 * @param groups - one array per source, already clock-normalized.
 * @param now - our clock, used only as the ceiling for a bad timestamp.
 * @returns composed sessions in inventory order, then everything else
 *   most-recently-active first.
 */
export function mergeDiscovered(
  groups: readonly CcDiscoveredSession[][],
  now: number,
): CcDiscoveredSession[] {
  const best = new Map<string, CcDiscoveredSession>()
  const order = new Map<string, number>()
  let index = 0
  for (const group of groups) {
    for (const session of group) {
      const previous = best.get(session.sessionId)
      if (previous === undefined) {
        best.set(session.sessionId, session)
        order.set(session.sessionId, index)
        index += 1
        continue
      }
      const kept = ORIGIN_PRECEDENCE.indexOf(previous.origin)
      const candidate = ORIGIN_PRECEDENCE.indexOf(session.origin)
      if (candidate < kept) best.set(session.sessionId, session)
    }
  }
  const merged = [...best.values()]
  const composed = merged.filter(session => session.origin === 'composed')
  const rest = merged
    .filter(session => session.origin !== 'composed')
    .sort((left, right) => {
      const activity = Math.min(now, right.lastActivityAt) - Math.min(now, left.lastActivityAt)
      // A total order, so the same inputs always render identically.
      return activity !== 0 ? activity : left.sessionId.localeCompare(right.sessionId)
    })
  // Composed order is NOT re-sorted: it is the close-candidate promise.
  composed.sort((left, right) =>
    (order.get(left.sessionId) ?? 0) - (order.get(right.sessionId) ?? 0))
  return [...composed, ...rest]
}

/**
 * Split a merged list into its three origins, preserving order within each.
 *
 * @param sessions - the merged list.
 * @returns the three groups a wide-scope listing renders as sections.
 */
export function groupByOrigin(sessions: readonly CcDiscoveredSession[]): {
  composed: CcDiscoveredSession[]
  liveExternal: CcDiscoveredSession[]
  resumable: CcDiscoveredSession[]
} {
  return {
    composed: sessions.filter(session => session.origin === 'composed'),
    liveExternal: sessions.filter(session => session.origin === 'live-external'),
    resumable: sessions.filter(session => session.origin === 'resumable'),
  }
}
```

Export all four functions plus `ORIGIN_PRECEDENCE` from `src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run --project unit packages/claude-code/tests/discovery.spec.ts && pnpm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code/src/discovery.ts packages/claude-code/src/index.ts packages/claude-code/tests/discovery.spec.ts
git commit -m "feat(seam): pure discovery merge with clock normalization

Dedupe keeps the highest-fidelity origin per session id — all three
collisions are expected, not edge cases. Each source's timestamps are
re-based onto our clock so a skewed mesh host cannot sort to the wrong end
or report a negative age."
```

---

### Task 6: Local discovery source

Spec §5.1: on this host the SDK is authoritative and fast (P1: 8 sessions, 64 ms), so the local
source never shells out to the probe.

**Files:**
- Create: `packages/claude-code/src/discovery-local.ts`
- Test: `packages/claude-code/tests/discovery-local.spec.ts`
- Modify: `packages/claude-code/src/index.ts`

**Interfaces:**
- Consumes: Task 4 types, Task 5 helpers.
- Produces: `createLocalSource(deps: CcLocalSourceDeps): CcDiscoverySource`, with
  `CcLocalSourceDeps = { host: string, listSessions: (options: { limit: number }) =>
  Promise<CcStoreEntry[]>, readRegistry: () => Promise<CcRegistryEntry[]>, now?: () => number }`;
  `CcStoreEntry = { sessionId, cwd?, summary?, customTitle?, firstPrompt?, gitBranch?, lastModified,
  createdAt?, fileSize? }`; `CcRegistryEntry = { sessionId, pid, cwd, name?, kind?, entrypoint?,
  version?, startedAt?, liveness: 'confirmed' | 'assumed' }`.

Both readers are injected: specs must not touch the real `~/.claude`, and the SDK's `listSessions`
stays behind the `backend.ts` boundary rule that keeps SDK types out of `lib/types/**`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/claude-code/tests/discovery-local.spec.ts
import { describe, expect, it } from 'vitest'

import { createLocalSource } from '../src/discovery-local.ts'
import type { CcRegistryEntry, CcStoreEntry } from '../src/discovery-local.ts'

/**
 * The local source. On this host the SDK store read is authoritative and costs
 * 64 ms for eight sessions (design P1), so nothing here spawns a probe.
 *
 * The registry and the store overlap by construction: a running session has
 * both a registry file and a transcript. Both are reported; the coordinator's
 * dedupe decides which wins.
 */

const NOW = 1_787_128_000_000

const REGISTRY: CcRegistryEntry[] = [{
  sessionId: '11111111-1111-4111-8111-111111111111',
  pid: 4242,
  cwd: '/Users/b2/Developer/mine/b2infra',
  name: 'b2infra-bd',
  kind: 'interactive',
  entrypoint: 'sdk-cli',
  version: '2.1.233',
  startedAt: NOW - 300_000,
  liveness: 'confirmed',
}]

const STORE: CcStoreEntry[] = [{
  sessionId: '11111111-1111-4111-8111-111111111111',
  cwd: '/Users/b2/Developer/mine/b2infra',
  summary: 'Session discovery work',
  gitBranch: 'feature/session-discovery',
  lastModified: NOW - 30_000,
  createdAt: NOW - 300_000,
  fileSize: 603_777,
}, {
  sessionId: '22222222-2222-4222-8222-222222222222',
  cwd: '/Users/b2/Developer/mine/dsh-claude-code',
  customTitle: 'Review and plan DSH Claude Code integration',
  lastModified: NOW - 4 * 60 * 60 * 1000,
  fileSize: 4_384_613,
}]

describe('createLocalSource', () => {
  it('reports live sessions as live-external and store sessions as resumable', async () => {
    const source = createLocalSource({
      host: 'b2studio',
      listSessions: async () => Promise.resolve(STORE),
      readRegistry: async () => Promise.resolve(REGISTRY),
      now: () => NOW,
    })

    const result = await source.discover({
      now: NOW, includeResumable: true, recentWindowMs: 604_800_000,
      maxResumable: 50, includeTitles: true,
    })

    const live = result.sessions.filter(entry => entry.origin === 'live-external')
    const resumable = result.sessions.filter(entry => entry.origin === 'resumable')
    expect(live).toHaveLength(1)
    expect(live[0]?.live?.pid).toBe(4242)
    expect(live[0]?.live?.liveness).toBe('confirmed')
    expect(live[0]?.sendable).toBe(false)
    expect(live[0]?.resumable).toBe(true)
    expect(live[0]?.host).toBe('b2studio')
    expect(live[0]?.fidelity).toBe('sdk')
    expect(resumable.map(entry => entry.sessionId)).toContain(
      '22222222-2222-4222-8222-222222222222')
    // customTitle wins over summary, and both beat firstPrompt.
    expect(resumable.find(entry =>
      entry.sessionId === '22222222-2222-4222-8222-222222222222')?.title)
      .toBe('Review and plan DSH Claude Code integration')
  })

  it('omits titles when asked, and omits resumables when not asked for', async () => {
    const source = createLocalSource({
      host: 'b2studio',
      listSessions: async () => Promise.resolve(STORE),
      readRegistry: async () => Promise.resolve(REGISTRY),
      now: () => NOW,
    })

    const untitled = await source.discover({
      now: NOW, includeResumable: true, recentWindowMs: 604_800_000,
      maxResumable: 50, includeTitles: false,
    })
    expect(untitled.sessions.every(entry => entry.title === undefined)).toBe(true)

    const liveOnly = await source.discover({
      now: NOW, includeResumable: false, recentWindowMs: 604_800_000,
      maxResumable: 50, includeTitles: true,
    })
    expect(liveOnly.sessions.every(entry => entry.origin === 'live-external')).toBe(true)
  })

  it('warns instead of throwing when a reader fails', async () => {
    const source = createLocalSource({
      host: 'b2studio',
      listSessions: async () => Promise.reject(new Error('store unreadable')),
      readRegistry: async () => Promise.resolve(REGISTRY),
      now: () => NOW,
    })

    const result = await source.discover({
      now: NOW, includeResumable: true, recentWindowMs: 604_800_000,
      maxResumable: 50, includeTitles: true,
    })

    expect(result.warnings.join('\n')).toContain('store unreadable')
    expect(result.sessions).toHaveLength(1)   // the registry still answered
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/claude-code/tests/discovery-local.spec.ts`
Expected: FAIL — cannot resolve `../src/discovery-local.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/claude-code/src/discovery-local.ts
/**
 * The local discovery source: this host's live sessions and recent transcripts.
 *
 * Both readers are INJECTED. Specs must never touch the real `~/.claude`, and
 * the SDK's `listSessions` must stay behind the `backend.ts` boundary so no SDK
 * type leaks into `lib/types/**`.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import type {
  CcDiscoverRequest, CcDiscoveredSession, CcDiscoveryResult, CcDiscoverySource, CcSessionId,
} from './types.ts'

/** One session as the local transcript store reports it. */
export interface CcStoreEntry {
  readonly sessionId: string
  readonly cwd?: string
  readonly summary?: string
  readonly customTitle?: string
  readonly firstPrompt?: string
  readonly gitBranch?: string
  readonly lastModified: number
  readonly createdAt?: number
  readonly fileSize?: number
}

/** One live session as the on-disk registry reports it. */
export interface CcRegistryEntry {
  readonly sessionId: string
  readonly pid: number
  readonly cwd: string
  readonly name?: string
  readonly kind?: string
  readonly entrypoint?: string
  readonly version?: string
  readonly startedAt?: number
  readonly liveness: 'confirmed' | 'assumed'
}

/** Injectable readers for the local source. */
export interface CcLocalSourceDeps {
  readonly host: string
  readonly listSessions: (options: { limit: number }) => Promise<CcStoreEntry[]>
  readonly readRegistry: () => Promise<CcRegistryEntry[]>
  readonly now?: () => number
}

/**
 * The best human-facing name for a stored session.
 * @param entry - the store entry.
 * @returns the title, or undefined when the store offered none.
 */
function storeTitle(entry: CcStoreEntry): string | undefined {
  return entry.customTitle ?? entry.summary ?? entry.firstPrompt
}

/**
 * Build the local discovery source.
 * @param deps - injected readers, host label and clock.
 * @returns a source reporting this host's live and resumable sessions.
 */
export function createLocalSource(deps: CcLocalSourceDeps): CcDiscoverySource {
  const clock = deps.now ?? Date.now
  return {
    id: 'local',
    host: deps.host,
    async discover(request: CcDiscoverRequest): Promise<CcDiscoveryResult> {
      const warnings: string[] = []
      const sessions: CcDiscoveredSession[] = []

      // One reader failing must not lose the other's answer: a host with an
      // unreadable store still has running sessions worth naming.
      const registry = await deps.readRegistry().catch((error: unknown) => {
        warnings.push(`local registry: ${String(error)}`)
        return [] as CcRegistryEntry[]
      })
      for (const entry of registry) {
        sessions.push({
          sessionId: entry.sessionId as CcSessionId,
          origin: 'live-external',
          host: deps.host,
          sourceId: 'local',
          cwd: entry.cwd,
          lastActivityAt: entry.startedAt ?? clock(),
          sendable: false,
          resumable: true,
          fidelity: 'sdk',
          live: {
            pid: entry.pid,
            liveness: entry.liveness,
            ...(entry.kind === undefined ? {} : { kind: entry.kind }),
            ...(entry.entrypoint === undefined ? {} : { entrypoint: entry.entrypoint }),
            ...(entry.version === undefined ? {} : { claudeVersion: entry.version }),
          },
          ...(request.includeTitles && entry.name !== undefined ? { title: entry.name } : {}),
          ...(entry.startedAt === undefined ? {} : { createdAt: entry.startedAt }),
        })
      }

      if (request.includeResumable) {
        const store = await deps.listSessions({ limit: request.maxResumable })
          .catch((error: unknown) => {
            warnings.push(`local store: ${String(error)}`)
            return [] as CcStoreEntry[]
          })
        const cutoff = request.now - request.recentWindowMs
        for (const entry of store) {
          if (entry.lastModified < cutoff) continue
          const title = request.includeTitles ? storeTitle(entry) : undefined
          sessions.push({
            sessionId: entry.sessionId as CcSessionId,
            origin: 'resumable',
            host: deps.host,
            sourceId: 'local',
            cwd: entry.cwd ?? '',
            lastActivityAt: entry.lastModified,
            sendable: false,
            resumable: true,
            fidelity: 'sdk',
            ...(title === undefined ? {} : { title }),
            ...(entry.gitBranch === undefined ? {} : { gitBranch: entry.gitBranch }),
            ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
            ...(entry.fileSize === undefined ? {} : { sizeBytes: entry.fileSize }),
          })
        }
      }

      return { sessions, warnings, generatedAt: clock(), cached: false }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run --project unit packages/claude-code/tests/discovery-local.spec.ts && pnpm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code/src/discovery-local.ts packages/claude-code/src/index.ts packages/claude-code/tests/discovery-local.spec.ts
git commit -m "feat(seam): local discovery source over injected readers

The SDK store read is authoritative on this host, so the local source
never spawns the probe. Readers are injected so specs never touch the real
~/.claude and no SDK type reaches lib/types."
```

---

### Task 7: Coordinator on the service

Spec §6.2–6.4. Where sources are registered, queried in parallel with a deadline, cached, and
merged. `scope: 'composition'` must touch no source at all.

**Files:**
- Modify: `packages/claude-code/src/service.ts`
- Test: `packages/claude-code/tests/discovery-service.spec.ts`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces: `ClaudeCodeService.registerDiscoverySource(source): () => void` and
  `ClaudeCodeService.discover(options?): Promise<CcDiscoveryResult>`. Also
  `ClaudeCodeServiceDeps.wireLocalSource?: boolean` (default: wire it when
  `config.discovery.local`) and `ClaudeCodeServiceDeps.localSource?: CcDiscoverySource` so specs
  inject a fake instead of reading the real store.

- [ ] **Step 1: Write the failing test**

```ts
// packages/claude-code/tests/discovery-service.spec.ts
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { ClaudeCodeService } from '../src/service.ts'
import type { CcDiscoverySource } from '../src/index.ts'
import { createFakeBackend } from './fake-backend.ts'

/**
 * The discovery coordinator.
 *
 * Three properties: the default scope stays free (it must not touch a source,
 * so today's callers pay nothing), a failing or slow source degrades to a
 * warning instead of an exception (a sleeping laptop must not break the list —
 * design P6), and results are cached for the configured TTL.
 */

/**
 * Mount a service with a fake backend and no real local source.
 * @param config - configuration overrides.
 * @returns the context and service.
 */
function mount(config: Record<string, unknown> = {}): {
  ctx: Context, service: ClaudeCodeService,
} {
  const ctx = new Context()
  const { backend } = createFakeBackend()
  const service = new ClaudeCodeService(
    ctx, { prewarm: false, hostLabel: 'b2studio', ...config },
    { backend, wireLocalSource: false },
  )
  return { ctx, service }
}

/**
 * A source that answers with one session.
 * @param id - the source id.
 * @param host - the host label.
 * @returns the source and its call counter.
 */
function countingSource(id: string, host: string): {
  source: CcDiscoverySource, calls: () => number,
} {
  let calls = 0
  return {
    calls: () => calls,
    source: {
      id,
      host,
      discover: async (request) => {
        calls += 1
        return Promise.resolve({
          generatedAt: request.now,
          cached: false,
          warnings: [],
          sessions: [{
            sessionId: `0000000${calls}-0000-4000-8000-000000000000`,
            origin: 'live-external' as const,
            host,
            sourceId: id,
            cwd: '/tmp',
            lastActivityAt: request.now - 1_000,
            sendable: false,
            resumable: true,
            fidelity: 'probe' as const,
            live: { liveness: 'assumed' as const },
          }],
        })
      },
    },
  }
}

describe('ClaudeCodeService.discover', () => {
  it('does not touch any source at the default composition scope', async () => {
    const { service } = mount()
    const counting = countingSource('mesh:b2umini', 'b2umini')
    service.registerDiscoverySource(counting.source)

    const result = await service.discover()

    expect(result.sessions).toEqual([])
    expect(counting.calls()).toBe(0)
  })

  it('queries sources at mesh scope and caches for the TTL', async () => {
    const { service } = mount({ discovery: { cacheTtlMs: 60_000 } })
    const counting = countingSource('mesh:b2umini', 'b2umini')
    service.registerDiscoverySource(counting.source)

    const first = await service.discover({ scope: 'mesh' })
    const second = await service.discover({ scope: 'mesh' })
    const forced = await service.discover({ scope: 'mesh', refresh: true })

    expect(first.sessions).toHaveLength(1)
    expect(second.cached).toBe(true)
    expect(counting.calls()).toBe(1)
    expect(forced.cached).toBe(false)
    expect(counting.calls()).toBe(2)
  })

  it('turns a rejecting source into a warning and still returns', async () => {
    const { service } = mount()
    service.registerDiscoverySource({
      id: 'mesh:b2hx',
      host: 'b2hx',
      discover: async () => Promise.reject(new Error('unreachable (ssh connect timeout)')),
    })
    const healthy = countingSource('mesh:b2umini', 'b2umini')
    service.registerDiscoverySource(healthy.source)

    const result = await service.discover({ scope: 'mesh' })

    expect(result.warnings.join('\n')).toContain('b2hx')
    expect(result.warnings.join('\n')).toContain('unreachable')
    expect(result.sessions).toHaveLength(1)
  })

  it('stops consulting a source after its disposer runs', async () => {
    const { service } = mount({ discovery: { cacheTtlMs: 1 } })
    const counting = countingSource('mesh:b2umini', 'b2umini')
    const dispose = service.registerDiscoverySource(counting.source)

    await service.discover({ scope: 'mesh', refresh: true })
    dispose()
    const after = await service.discover({ scope: 'mesh', refresh: true })

    expect(counting.calls()).toBe(1)
    expect(after.sessions).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/claude-code/tests/discovery-service.spec.ts`
Expected: FAIL — `service.discover` and `service.registerDiscoverySource` are not functions.

- [ ] **Step 3: Write minimal implementation**

Add to `ClaudeCodeServiceDeps`:

```ts
  /** Skip wiring the real local source (specs inject their own). */
  readonly wireLocalSource?: boolean
  /** Replace the local source outright. */
  readonly localSource?: CcDiscoverySource
```

Add fields and methods to `ClaudeCodeService`:

```ts
  /** Registered discovery sources, in registration order. */
  private readonly discoverySources = new Map<string, CcDiscoverySource>()

  /** The last merged wide-scope result, for the configured TTL. */
  private discoveryCache: { at: number, result: CcDiscoveryResult } | undefined

  /**
   * Contribute sessions from outside this composition.
   * @param source - the source to add; a duplicate id replaces its predecessor.
   * @returns a disposer that removes it and drops the cache.
   */
  registerDiscoverySource(source: CcDiscoverySource): () => void {
    this.discoverySources.set(source.id, source)
    this.discoveryCache = undefined
    return () => {
      this.discoverySources.delete(source.id)
      this.discoveryCache = undefined
    }
  }

  /**
   * Every session this composition can see.
   *
   * Never rejects: a source that throws or times out becomes a warning, because
   * a list that fails when one laptop is asleep is not a list anyone can use.
   *
   * @param options - scope and cache control.
   * @returns the merged, deduped, clock-normalized inventory.
   */
  async discover(options: CcDiscoverOptions = {}): Promise<CcDiscoveryResult> {
    const now = Date.now()
    const scope = options.scope ?? 'composition'
    const composed = projectComposed(this.list(), this.config.hostLabel, now)
    if (scope === 'composition') {
      return { sessions: composed, warnings: [], generatedAt: now, cached: false }
    }

    const cached = this.discoveryCache
    if (options.refresh !== true && cached !== undefined
      && now - cached.at < this.config.discovery.cacheTtlMs) {
      // Composed sessions are re-projected against the live registry: they are
      // free, they change fastest, and a stale one would name a closed session.
      return { ...cached.result, sessions: [...composed, ...cached.result.sessions], cached: true }
    }

    const sources = [...this.discoverySources.values()]
      .filter(source => scope === 'mesh' || source.host === this.config.hostLabel)
    const request: CcDiscoverRequest = {
      now,
      includeResumable: options.includeResumable ?? true,
      recentWindowMs: this.config.discovery.recentWindowMs,
      maxResumable: this.config.discovery.maxResumable,
      includeTitles: this.config.discovery.includeTitles,
    }
    const warnings: string[] = []
    const groups = await Promise.all(sources.map(async (source) => {
      try {
        return normalizeSourceClock(await source.discover(request), now)
      } catch (error) {
        warnings.push(`${source.host}: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }))

    const external = mergeDiscovered(groups, now)
    this.discoveryCache = {
      at: now,
      result: { sessions: external, warnings, generatedAt: now, cached: false },
    }
    return {
      sessions: mergeDiscovered([composed, external], now),
      warnings,
      generatedAt: now,
      cached: false,
    }
  }
```

In the constructor, after the pool is built, wire the local source when configured:

```ts
    // The real local source reads the SDK store; specs pass wireLocalSource:
    // false and register their own, so no unit test touches ~/.claude.
    if (deps.wireLocalSource !== false && this.config.discovery.local) {
      const source = deps.localSource ?? createLocalSource({
        host: this.config.hostLabel,
        listSessions: async options => listLocalStore(options),
        readRegistry: async () => readLocalRegistry(),
      })
      ctx.effect(() => this.registerDiscoverySource(source), 'claudeCode:localDiscovery')
    }
```

Add the two real readers to `src/backend.ts` (the SDK boundary), exported as
`listLocalStore(options: { limit: number }): Promise<CcStoreEntry[]>` wrapping the SDK's
`listSessions({ limit, includeProgrammatic: true })`, and `readLocalRegistry(): Promise<CcRegistryEntry[]>`
reading `$HOME/.claude/sessions/*.json` with the same liveness rule as the probe (§5.2) — `process.kill(pid, 0)`
for existence, `liveness: 'assumed'` when the start time cannot be confirmed.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run --project unit packages/claude-code/tests && pnpm run typecheck`
Expected: PASS, including every pre-existing seam spec.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code/src packages/claude-code/tests/discovery-service.spec.ts
git commit -m "feat(seam): discovery coordinator with TTL cache and warnings

Composition scope touches no source, so existing callers pay nothing. A
rejecting or slow source becomes a named warning: b2hx was unreachable
during design (P6) and that is the normal case, not an exception."
```

---

### Task 8: `packages/claude-code-remote` — the probe-runner source

Spec §4, §5.4, P7. Generic on purpose: it runs an argv and parses schema-1 JSON, so host names and
path maps are config and the code upstreams unchanged.

**Files:**
- Create: `packages/claude-code-remote/{package.json,tsconfig.json,src/parse.ts,src/paths.ts,src/source.ts,src/index.ts}`
- Test: `packages/claude-code-remote/tests/{parse.spec.ts,paths.spec.ts,source.spec.ts,tsconfig.json}`
- Modify: `pnpm-workspace.yaml` (only if it does not already glob `packages/*`), root `tsconfig.json` references

**Interfaces:**
- Consumes: `CcDiscoverySource`, `CcDiscoverRequest`, `CcDiscoveryResult`, `CcDiscoveredSession` from
  `@deepseek-ai/dsh-claude-code`.
- Produces:
  - `PROBE_SCHEMA_MAJOR = 1`
  - `parseProbeOutput(raw: string, context: { sourceId: string, host: string, pathMap: CcPathMapping[] }): CcDiscoveryResult`
  - `translatePath(pathMap: readonly CcPathMapping[], path: string): string` where
    `CcPathMapping = { from: string, to: string }`
  - `createProbeSource(options: CcProbeSourceOptions): CcDiscoverySource` where
    `CcProbeSourceOptions = { id, host, argv: readonly string[], timeoutMs, pathMap?, run? }`
  - plugin exports `name`, `inject`, `Config`, `apply`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/claude-code-remote/tests/parse.spec.ts
import { describe, expect, it } from 'vitest'

import { parseProbeOutput, PROBE_SCHEMA_MAJOR } from '../src/parse.ts'

/**
 * The probe-output parser.
 *
 * Schema versioning is not ceremony here: Syncthing propagates the probe to
 * every host in seconds, while the dsh profile's copy of this plugin only
 * changes when the installer runs. The two WILL disagree, and that must be a
 * named warning rather than a crash (spec §5.4).
 */

const CONTEXT = { sourceId: 'mesh:b2umini', host: 'b2umini', pathMap: [] }

describe('parseProbeOutput', () => {
  it('maps live and resumable rows onto discovered sessions', () => {
    const raw = JSON.stringify({
      schema: PROBE_SCHEMA_MAJOR,
      host: 'b2umini',
      generatedAt: 1_787_128_000_000,
      home: '/Users/b2',
      live: [{
        sessionId: '889cd0f8-30f5-4469-b63a-086d93cbb047',
        pid: 3796, cwd: '/Users/b2/Developer/mine/grigios',
        name: 'grigios-cb', kind: 'interactive', startedAt: 1_786_611_479_355,
        version: '2.1.220', liveness: 'assumed',
      }],
      resumable: [{
        sessionId: '43bc3d80-fb06-4f6e-805f-f3eeff272690',
        cwd: '/Users/b2/Developer/mine/grigios', title: 'fix the thing',
        gitBranch: 'main', lastModified: 1_787_000_000_000, sizeBytes: 1234,
      }],
      warnings: ['/Users/b2/.claude/projects/x: unreadable'],
    })

    const result = parseProbeOutput(raw, CONTEXT)

    expect(result.generatedAt).toBe(1_787_128_000_000)
    const live = result.sessions.filter(entry => entry.origin === 'live-external')
    expect(live[0]?.live?.liveness).toBe('assumed')
    expect(live[0]?.sendable).toBe(false)
    expect(live[0]?.fidelity).toBe('probe')
    expect(live[0]?.host).toBe('b2umini')
    expect(result.sessions.filter(entry => entry.origin === 'resumable')).toHaveLength(1)
    // The probe's own warnings survive, prefixed with the host that raised them.
    expect(result.warnings.join('\n')).toContain('b2umini')
    expect(result.warnings.join('\n')).toContain('unreadable')
  })

  it('refuses an unknown schema major with a warning and no sessions', () => {
    const raw = JSON.stringify({ schema: 99, host: 'b2umini', generatedAt: 1, live: [], resumable: [] })

    const result = parseProbeOutput(raw, CONTEXT)

    expect(result.sessions).toEqual([])
    expect(result.warnings.join('\n')).toContain('schema 99')
    expect(result.warnings.join('\n')).toContain(String(PROBE_SCHEMA_MAJOR))
  })

  it('warns with a bounded excerpt when the output is not JSON', () => {
    const result = parseProbeOutput('bash: claude-inventory: No such file or directory', CONTEXT)

    expect(result.sessions).toEqual([])
    expect(result.warnings.join('\n')).toContain('No such file')
  })
})
```

```ts
// packages/claude-code-remote/tests/paths.spec.ts
import { describe, expect, it } from 'vitest'

import { translatePath } from '../src/paths.ts'

/**
 * Path translation. b2umini sees b2studio's `/Users/b2/Developer/mine/grigios`
 * as `/System/Volumes/Data/mnt/b2/Developer/mine/grigios` (design P7), so a
 * cwd is only meaningful once it has been re-expressed in local terms.
 */

const MAP = [{ from: '/System/Volumes/Data/mnt/b2', to: '/Users/b2' }]

describe('translatePath', () => {
  it('rewrites a mapped prefix and leaves everything else alone', () => {
    expect(translatePath(MAP, '/System/Volumes/Data/mnt/b2/Developer/mine/grigios'))
      .toBe('/Users/b2/Developer/mine/grigios')
    expect(translatePath(MAP, '/Users/b2/Developer/mine/b2infra'))
      .toBe('/Users/b2/Developer/mine/b2infra')
  })

  it('only matches whole path segments', () => {
    // A prefix that is not a segment boundary must not be rewritten.
    expect(translatePath([{ from: '/mnt/b2', to: '/Users/b2' }], '/mnt/b2extra/thing'))
      .toBe('/mnt/b2extra/thing')
  })

  it('applies the longest matching prefix', () => {
    const map = [
      { from: '/mnt', to: '/a' },
      { from: '/mnt/b2', to: '/Users/b2' },
    ]

    expect(translatePath(map, '/mnt/b2/Developer')).toBe('/Users/b2/Developer')
  })
})
```

```ts
// packages/claude-code-remote/tests/source.spec.ts
import { describe, expect, it } from 'vitest'

import { createProbeSource } from '../src/source.ts'

/** The probe runner: an argv, a deadline, and a parser. Never a thrown error. */

const REQUEST = {
  now: 1_787_128_000_000, includeResumable: true, recentWindowMs: 604_800_000,
  maxResumable: 50, includeTitles: true,
}

describe('createProbeSource', () => {
  it('passes request options through to the probe argv', async () => {
    const seen: string[][] = []
    const source = createProbeSource({
      id: 'mesh:b2umini', host: 'b2umini', timeoutMs: 6_000,
      argv: ['ssh', 'b2umini.local', '~/infra/scripts/claude-inventory'],
      run: async (argv) => {
        seen.push([...argv])
        return Promise.resolve({ stdout: JSON.stringify({
          schema: 1, host: 'b2umini', generatedAt: REQUEST.now, live: [], resumable: [],
        }), stderr: '' })
      },
    })

    await source.discover(REQUEST)

    expect(seen[0]).toContain('--max-resumable')
    expect(seen[0]).toContain('50')
    expect(seen[0]).toContain('--window-ms')
    expect(seen[0]).not.toContain('--no-titles')
  })

  it('adds --no-titles when titles are not wanted', async () => {
    const seen: string[][] = []
    const source = createProbeSource({
      id: 'mesh:b2umini', host: 'b2umini', timeoutMs: 6_000,
      argv: ['ssh', 'b2umini.local', '~/infra/scripts/claude-inventory'],
      run: async (argv) => {
        seen.push([...argv])
        return Promise.resolve({ stdout: JSON.stringify({
          schema: 1, host: 'b2umini', generatedAt: REQUEST.now, live: [], resumable: [],
        }), stderr: '' })
      },
    })

    await source.discover({ ...REQUEST, includeTitles: false })

    expect(seen[0]).toContain('--no-titles')
  })

  it('reports a failed run as a warning, not a rejection', async () => {
    const source = createProbeSource({
      id: 'mesh:b2hx', host: 'b2hx', timeoutMs: 100,
      argv: ['ssh', 'b2hx.local', '~/infra/scripts/claude-inventory'],
      run: async () => Promise.reject(new Error('ssh: connect to host b2hx.local port 22: Operation timed out')),
    })

    const result = await source.discover(REQUEST)

    expect(result.sessions).toEqual([])
    expect(result.warnings.join('\n')).toContain('b2hx')
    expect(result.warnings.join('\n')).toContain('Operation timed out')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit packages/claude-code-remote`
Expected: FAIL — the package does not exist.

- [ ] **Step 3: Write minimal implementation**

`packages/claude-code-remote/package.json` (mirror `tool-claude-code`'s shape exactly, changing
name, description and deps):

```json
{
  "name": "@deepseek-ai/dsh-claude-code-remote",
  "description": "Remote-probe discovery source for the Claude Code seam: runs a per-host inventory probe over any argv (ssh, container exec, local) and contributes the sessions it finds.",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/**/*.js", "lib/types/**/*.d.ts"],
  "license": "MIT",
  "scripts": {
    "build": "tsc -b .",
    "typecheck": "tsc -b .",
    "clean": "tsc -b --clean ."
  },
  "dependencies": { "@deepseek-ai/schemastery": "3.18.1" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "4.0.1",
    "@deepseek-ai/dsh-claude-code": "workspace:*"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.1",
    "@deepseek-ai/dsh-claude-code": "workspace:*"
  }
}
```

`packages/claude-code-remote/tsconfig.json` — copy `packages/claude-code/tsconfig.json` verbatim and
add a `references` entry to `../claude-code`.

`src/paths.ts`:

```ts
/**
 * Path translation between hosts.
 *
 * The same repository has different absolute paths per host: b2umini sees
 * b2studio's `/Users/b2/Developer/mine/grigios` at
 * `/System/Volumes/Data/mnt/b2/Developer/mine/grigios` (design P7). A cwd is
 * only actionable once re-expressed in local terms.
 *
 * @module @deepseek-ai/dsh-claude-code-remote
 */

/** One prefix rewrite, remote path to local path. */
export interface CcPathMapping {
  readonly from: string
  readonly to: string
}

/**
 * Rewrite a remote path into this host's terms.
 *
 * The longest matching prefix wins, and a match must end on a path-segment
 * boundary so `/mnt/b2` never rewrites `/mnt/b2extra`.
 *
 * @param pathMap - the configured rewrites.
 * @param path - the remote path.
 * @returns the translated path, or the original when nothing matched.
 */
export function translatePath(pathMap: readonly CcPathMapping[], path: string): string {
  let best: CcPathMapping | undefined
  for (const mapping of pathMap) {
    if (path !== mapping.from && !path.startsWith(`${mapping.from}/`)) continue
    if (best === undefined || mapping.from.length > best.from.length) best = mapping
  }
  if (best === undefined) return path
  return `${best.to}${path.slice(best.from.length)}`
}
```

`src/parse.ts`:

```ts
/**
 * Parse the per-host probe's schema-1 envelope into discovered sessions.
 *
 * A mismatch between the probe and this parser is EXPECTED at times — Syncthing
 * propagates the probe in seconds while this plugin only changes when the
 * installer runs — so an unknown schema major is a named warning, never a throw.
 *
 * @module @deepseek-ai/dsh-claude-code-remote
 */

import type { CcDiscoveredSession, CcDiscoveryResult, CcSessionId } from '@deepseek-ai/dsh-claude-code'

import { translatePath } from './paths.ts'
import type { CcPathMapping } from './paths.ts'

/** The probe envelope major this parser understands. */
export const PROBE_SCHEMA_MAJOR = 1

/** How much raw output a parse-failure warning may quote. */
const EXCERPT_MAX = 200

/** What the parser needs to know about the source it is parsing for. */
export interface CcParseContext {
  readonly sourceId: string
  readonly host: string
  readonly pathMap: readonly CcPathMapping[]
}

/**
 * Parse probe output.
 * @param raw - the probe's stdout.
 * @param context - source identity and path map.
 * @returns sessions plus warnings; never throws.
 */
export function parseProbeOutput(raw: string, context: CcParseContext): CcDiscoveryResult {
  const empty = (warning: string): CcDiscoveryResult =>
    ({ sessions: [], warnings: [`${context.host}: ${warning}`], generatedAt: Date.now(), cached: false })

  let envelope: Record<string, unknown>
  try {
    envelope = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return empty(`probe output was not JSON: ${raw.trim().slice(0, EXCERPT_MAX)}`)
  }
  const schema = envelope['schema']
  if (schema !== PROBE_SCHEMA_MAJOR) {
    return empty(`probe reported schema ${String(schema)}; this plugin understands `
      + `${PROBE_SCHEMA_MAJOR}. Re-run scripts/install-into-dsh-profile.sh, or update the probe.`)
  }

  const generatedAt = typeof envelope['generatedAt'] === 'number' ? envelope['generatedAt'] : Date.now()
  const warnings = (Array.isArray(envelope['warnings']) ? envelope['warnings'] : [])
    .map(warning => `${context.host}: ${String(warning)}`)
  const sessions: CcDiscoveredSession[] = []

  /**
   * Translate a remote cwd, recording the original when it changed.
   * @param remote - the path as the probe reported it.
   * @returns the cwd fields for a discovered session.
   */
  const cwdFields = (remote: unknown): { cwd: string, remoteCwd?: string } => {
    const path = typeof remote === 'string' ? remote : ''
    const local = translatePath(context.pathMap, path)
    return local === path ? { cwd: local } : { cwd: local, remoteCwd: path }
  }

  for (const row of Array.isArray(envelope['live']) ? envelope['live'] : []) {
    const entry = row as Record<string, unknown>
    if (typeof entry['sessionId'] !== 'string') continue
    const startedAt = typeof entry['startedAt'] === 'number' ? entry['startedAt'] : generatedAt
    sessions.push({
      sessionId: entry['sessionId'] as CcSessionId,
      origin: 'live-external',
      host: context.host,
      sourceId: context.sourceId,
      ...cwdFields(entry['cwd']),
      lastActivityAt: startedAt,
      createdAt: startedAt,
      sendable: false,
      resumable: true,
      fidelity: 'probe',
      live: {
        liveness: entry['liveness'] === 'confirmed' ? 'confirmed' : 'assumed',
        ...(typeof entry['pid'] === 'number' ? { pid: entry['pid'] } : {}),
        ...(typeof entry['kind'] === 'string' ? { kind: entry['kind'] } : {}),
        ...(typeof entry['entrypoint'] === 'string' ? { entrypoint: entry['entrypoint'] } : {}),
        ...(typeof entry['version'] === 'string' ? { claudeVersion: entry['version'] } : {}),
      },
      ...(typeof entry['name'] === 'string' ? { title: entry['name'] } : {}),
    })
  }

  for (const row of Array.isArray(envelope['resumable']) ? envelope['resumable'] : []) {
    const entry = row as Record<string, unknown>
    if (typeof entry['sessionId'] !== 'string') continue
    sessions.push({
      sessionId: entry['sessionId'] as CcSessionId,
      origin: 'resumable',
      host: context.host,
      sourceId: context.sourceId,
      ...cwdFields(entry['cwd']),
      lastActivityAt: typeof entry['lastModified'] === 'number' ? entry['lastModified'] : generatedAt,
      sendable: false,
      resumable: true,
      fidelity: 'probe',
      ...(typeof entry['title'] === 'string' ? { title: entry['title'] } : {}),
      ...(typeof entry['gitBranch'] === 'string' ? { gitBranch: entry['gitBranch'] } : {}),
      ...(typeof entry['createdAt'] === 'number' ? { createdAt: entry['createdAt'] } : {}),
      ...(typeof entry['sizeBytes'] === 'number' ? { sizeBytes: entry['sizeBytes'] } : {}),
    })
  }

  return { sessions, warnings, generatedAt, cached: false }
}
```

`src/source.ts`:

```ts
/**
 * A discovery source that runs an inventory probe and parses its output.
 *
 * Deliberately generic: the argv may be `ssh host …`, `container exec … `, or a
 * local run with `--home`. Host lists and path maps are configuration, so this
 * code carries no site knowledge and upstreams unchanged.
 *
 * @module @deepseek-ai/dsh-claude-code-remote
 */

import { execFile } from 'node:child_process'

import type {
  CcDiscoverRequest, CcDiscoveryResult, CcDiscoverySource,
} from '@deepseek-ai/dsh-claude-code'

import { parseProbeOutput } from './parse.ts'
import type { CcPathMapping } from './paths.ts'

/** What running an argv yields. */
export interface CcProbeRun {
  readonly stdout: string
  readonly stderr: string
}

/** How to build one probe source. */
export interface CcProbeSourceOptions {
  readonly id: string
  readonly host: string
  /** The command, already including the probe path. Extra flags are appended. */
  readonly argv: readonly string[]
  readonly timeoutMs: number
  readonly pathMap?: readonly CcPathMapping[]
  /** Injectable runner; production uses `execFile`. */
  readonly run?: (argv: readonly string[], timeoutMs: number) => Promise<CcProbeRun>
}

/**
 * Run an argv to completion.
 * @param argv - the command and its arguments.
 * @param timeoutMs - how long to wait before killing it.
 * @returns the captured output.
 */
async function runArgv(argv: readonly string[], timeoutMs: number): Promise<CcProbeRun> {
  const [command, ...args] = argv
  if (command === undefined) throw new Error('probe argv is empty')
  return await new Promise<CcProbeRun>((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`${error.message}${stderr === '' ? '' : `: ${stderr.trim()}`}`))
          return
        }
        resolve({ stdout, stderr })
      })
  })
}

/**
 * Build a probe-backed discovery source.
 * @param options - identity, argv, deadline, path map and optional runner.
 * @returns the source; its `discover` never rejects.
 */
export function createProbeSource(options: CcProbeSourceOptions): CcDiscoverySource {
  const run = options.run ?? runArgv
  const pathMap = options.pathMap ?? []
  return {
    id: options.id,
    host: options.host,
    async discover(request: CcDiscoverRequest): Promise<CcDiscoveryResult> {
      const argv = [
        ...options.argv,
        '--window-ms', String(request.recentWindowMs),
        '--max-resumable', String(request.includeResumable ? request.maxResumable : 0),
        ...(request.includeTitles ? [] : ['--no-titles']),
      ]
      try {
        const { stdout } = await run(argv, options.timeoutMs)
        return parseProbeOutput(stdout, { sourceId: options.id, host: options.host, pathMap })
      } catch (error) {
        return {
          sessions: [],
          warnings: [`${options.host}: ${error instanceof Error ? error.message : String(error)}`],
          generatedAt: request.now,
          cached: false,
        }
      }
    },
  }
}
```

`src/index.ts` — the plugin. `Config` takes `probe` (path), `connectTimeoutMs`, `hosts`
(`{ label, ssh?, argv?, home? }`) and `pathMap`; `apply` builds one `createProbeSource` per host and
registers it through `ctx.effect`, so unmounting removes every source:

```ts
export const name = 'claude-code-remote'
export const inject = ['claudeCode']

export function apply(ctx: Context, config: Config = {}): void {
  for (const host of config.hosts ?? []) {
    const argv = host.argv ?? ['ssh', '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${Math.ceil((config.connectTimeoutMs ?? 6000) / 1000)}`,
      host.ssh ?? host.label, config.probe ?? DEFAULT_PROBE_PATH,
      ...(host.home === undefined ? [] : ['--home', host.home])]
    const source = createProbeSource({
      id: `remote:${host.label}`,
      host: host.label,
      argv,
      timeoutMs: config.timeoutMs ?? 20_000,
      pathMap: host.pathMap ?? config.pathMap ?? [],
    })
    ctx.effect(() => ctx.claudeCode.registerDiscoverySource(source), `claudeCodeRemote:${host.label}`)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm install
pnpm run build
pnpm vitest run --project unit packages/claude-code-remote && pnpm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-remote pnpm-workspace.yaml tsconfig.json
git commit -m "feat(remote): generic probe-runner discovery source

Runs an argv (ssh, container exec, or local with --home) and parses the
schema-1 envelope. Path translation is segment-aware with longest-prefix
wins, because b2umini sees the same repo under /System/Volumes/Data/mnt
(design P7). An unknown schema major warns instead of throwing."
```

---

### Task 9: `scope` on `claude_code_list`

Spec §7.1. The default output must stay byte-identical — that is the regression that matters most,
because the `SESSION_LIMIT` path reads the first row.

**Files:**
- Modify: `packages/tool-claude-code/src/list.ts`, `packages/tool-claude-code/src/index.ts`
- Test: `packages/tool-claude-code/tests/list.spec.ts`, `packages/tool-claude-code/tests/harness.ts`

**Interfaces:**
- Consumes: `ClaudeCode.discover`, `groupByOrigin`, `CC_DISCOVERY_SCOPES`.
- Produces: `projectDiscovered(sessions, now): CcDiscoveredListEntry[]`,
  `renderWideList(groups, warnings, scope): string`, `EMPTY_WIDE_LIST_PREFIX`; output-schema keys
  `external_live`, `external_resumable`, `warnings`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/tool-claude-code/tests/list.spec.ts
describe('claude_code_list scope', () => {
  it('defaults to composition and renders exactly the legacy text', async () => {
    const harness = await mountTools()
    try {
      const result = await harness.call('claude_code_list', {})

      expect(result.value).toEqual({ sessions: [] })
      expect(text(result)).toBe(EMPTY_SESSION_LIST)
    } finally {
      await harness.dispose()
    }
  })

  it('names what it searched and what failed when a wide scope finds nothing', async () => {
    const harness = await mountTools()
    try {
      harness.ctx.claudeCode.registerDiscoverySource({
        id: 'remote:b2hx',
        host: 'b2hx',
        discover: async () => Promise.reject(new Error('unreachable (ssh connect timeout 6000ms)')),
      })

      const result = await harness.call('claude_code_list', { scope: 'mesh' })

      // "nothing exists" and "I could not look" must never render alike.
      expect(text(result)).not.toBe(EMPTY_SESSION_LIST)
      expect(text(result)).toContain('b2hx')
      expect(text(result)).toContain('unreachable')
      expect((result.value as { warnings?: string[] }).warnings?.length).toBe(1)
    } finally {
      await harness.dispose()
    }
  })

  it('groups external live and resumable sessions with their hosts', async () => {
    const harness = await mountTools()
    try {
      harness.ctx.claudeCode.registerDiscoverySource({
        id: 'remote:b2umini',
        host: 'b2umini',
        discover: async request => Promise.resolve({
          generatedAt: request.now,
          cached: false,
          warnings: [],
          sessions: [{
            sessionId: '889cd0f8-30f5-4469-b63a-086d93cbb047',
            origin: 'live-external' as const, host: 'b2umini', sourceId: 'remote:b2umini',
            cwd: '/Users/b2/Developer/mine/grigios', title: 'grigios-cb',
            lastActivityAt: request.now - 600_000, sendable: false, resumable: true,
            fidelity: 'probe' as const, live: { liveness: 'assumed' as const, pid: 3796 },
          }, {
            sessionId: '43bc3d80-fb06-4f6e-805f-f3eeff272690',
            origin: 'resumable' as const, host: 'b2umini', sourceId: 'remote:b2umini',
            cwd: '/Users/b2/Developer/mine/grigios', title: 'fix the thing',
            lastActivityAt: request.now - 3_600_000, sendable: false, resumable: true,
            fidelity: 'probe' as const,
          }],
        }),
      })

      const result = await harness.call('claude_code_list', { scope: 'mesh' })
      const value = result.value as {
        external_live: { session_id: string, host: string, sendable: boolean }[]
        external_resumable: { session_id: string }[]
      }

      expect(value.external_live).toHaveLength(1)
      expect(value.external_live[0]?.host).toBe('b2umini')
      expect(value.external_live[0]?.sendable).toBe(false)
      expect(value.external_resumable).toHaveLength(1)
      const rendered = text(result)
      expect(rendered).toContain('Running elsewhere')
      expect(rendered).toContain('fork')          // says what CAN be done with it
      expect(rendered).toContain('Resumable')
      expect(rendered).toContain('b2umini')
    } finally {
      await harness.dispose()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/tool-claude-code/tests/list.spec.ts`
Expected: FAIL — `scope` is rejected by parameter validation (the first test passes; the other two fail).

- [ ] **Step 3: Write minimal implementation**

In `src/list.ts` add the wide-scope projection and renderer, keeping `projectSessions`,
`renderSessionList` and `EMPTY_SESSION_LIST` untouched:

```ts
/** One externally-discovered session as the tool reports it. */
export interface CcDiscoveredListEntry {
  readonly session_id: string
  readonly host: string
  readonly cwd: string
  readonly title?: string
  readonly git_branch?: string
  readonly idle_ms: number
  readonly sendable: boolean
  readonly resumable: boolean
  readonly liveness?: 'confirmed' | 'assumed'
  readonly pid?: number
}

/** The prefix a wide-scope empty listing opens with. */
export const EMPTY_WIDE_LIST_PREFIX = 'No Claude Code sessions found'
```

`renderWideList(composedText, live, resumable, warnings, scope)` emits the composed block first
(delegating to `renderSessionList`), then a `Running elsewhere (not sendable — fork to continue):`
section, then `Resumable (on disk, not running):`, then a `Warnings:` block. When every group is
empty it opens with `EMPTY_WIDE_LIST_PREFIX`, names the scope searched, and lists the warnings —
never `EMPTY_SESSION_LIST`.

In `src/index.ts`, add the parameter and widen `execute`:

```ts
      scope: {
        type: 'string',
        enum: CC_DISCOVERY_SCOPES,
        description: 'How wide to look. "composition" (default) lists only sessions this dsh '
          + 'composition holds open — the sessions that occupy a concurrency slot. "host" adds '
          + 'sessions running elsewhere on this machine plus recently-used sessions on disk. '
          + '"mesh" adds the other configured hosts. Use a wider scope to find a session you did '
          + 'not open yourself; those cannot be sent to, but they can be forked with '
          + 'claude_code_open({ resume, fork: true }).',
      },
```

```ts
    async execute(args) {
      const now = Date.now()
      const sessions = projectSessions(ctx.claudeCode.list(
        args.include_closed === true ? { includeClosed: true } : {}), now)
      const scope = args.scope ?? 'composition'
      if (scope === 'composition') return { sessions }
      const discovered = await ctx.claudeCode.discover({ scope })
      const groups = groupByOrigin(discovered.sessions)
      return {
        sessions,
        external_live: projectDiscovered(groups.liveExternal, now),
        external_resumable: projectDiscovered(groups.resumable, now),
        warnings: [...discovered.warnings],
      }
    },
```

Declare `external_live`, `external_resumable` and `warnings` as optional properties on the existing
output schema object (it keeps `additionalProperties: false`, and the runtime validates after
`execute`, so every key a body can return must be declared).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit packages/tool-claude-code && pnpm run typecheck`
Expected: PASS, including every pre-existing tool spec and golden.

- [ ] **Step 5: Commit**

```bash
git add packages/tool-claude-code
git commit -m "feat(tools): scope parameter on claude_code_list

Default output is unchanged byte-for-byte; wider scopes render grouped
sections, because one ranking cannot serve both 'which may I close' and
'what can I work with'. The wide-scope empty state names what was searched
and what was unreachable — the old empty string was what produced the
misleading 'no sessions' answer this work started from."
```

---

### Task 10: Wire it into dsh on b2studio, and verify live

Phase 1's acceptance: the motivating question gets a true answer through the real UI.

**Files:**
- Create: `packages/claude-code/tests/live/discovery.live.spec.ts`
- Modify (b2infra repo): `etc/dsh/cordis.patch.yml`, `CLAUDE.md`
- Deploy: `~/infra/scripts/claude-inventory`, `~/.dsh/profiles/web/cordis.patch.yml`

**Interfaces:**
- Consumes: Tasks 1–9.
- Produces: a running configuration in which `claude_code_list({ scope: 'mesh' })` answers from
  b2studio, b2umini, b2mini and the sandbox container.

- [ ] **Step 1: Write the live test**

```ts
// packages/claude-code/tests/live/discovery.live.spec.ts
import { describe, expect, it } from 'vitest'

import { LIVE, LIVE_TIMEOUT_MS } from './helpers.ts'

/**
 * Live discovery (DSH_CC_LIVE=1). Two things only a real host can prove: the
 * probe returns well-formed schema-1 output over real SSH, and the local source
 * sees a session this process did not open.
 */

describe.skipIf(!LIVE)('live discovery (DSH_CC_LIVE=1)', () => {
  it('runs the probe over SSH against b2umini and parses it', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)

    const { stdout } = await run('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', 'b2umini.local',
      '/Users/b2/infra/scripts/claude-inventory', '--max-resumable', '5',
    ], { timeout: LIVE_TIMEOUT_MS })
    const envelope = JSON.parse(stdout) as {
      schema: number, host: string, live: unknown[], resumable: unknown[],
    }

    expect(envelope.schema).toBe(1)
    expect(envelope.host).toBe('b2umini')
    expect(Array.isArray(envelope.live)).toBe(true)
    expect(Array.isArray(envelope.resumable)).toBe(true)
  }, LIVE_TIMEOUT_MS)
})
```

- [ ] **Step 2: Run it and confirm it fails before deployment**

Run: `DSH_CC_LIVE=1 pnpm vitest run --project unit packages/claude-code/tests/live/discovery.live.spec.ts`
Expected: FAIL — `~/infra/scripts/claude-inventory` does not exist on b2umini yet.

- [ ] **Step 3: Deploy the probe and the config**

```bash
# On b2studio. Syncthing carries ~/infra to every host within ~10s.
cp packages/claude-code/scripts/claude-inventory ~/infra/scripts/claude-inventory
chmod +x ~/infra/scripts/claude-inventory
# Confirm propagation before trusting the live test.
ssh -o BatchMode=yes b2umini.local 'ls -l ~/infra/scripts/claude-inventory'
```

Then add the fourth row in b2infra's `etc/dsh/cordis.patch.yml`, under the existing `- insert:`
list, alongside the three claude-code rows:

```yaml
    - id: claude-code-remote
      name: '@deepseek-ai/dsh-claude-code-remote'
      config:
        probe: /Users/b2/infra/scripts/claude-inventory
        connectTimeoutMs: 6000
        hosts:
          - { label: b2umini, ssh: b2umini.local }
          - { label: b2mini, ssh: b2mini.local }
          - { label: b2hx, ssh: b2hx.tail2e8f81.ts.net }
          - { label: claude-sandbox, argv: ['/Users/b2/infra/scripts/claude-inventory', '--home', '/Users/b2/claude-sandbox-home'] }
        pathMap:
          - { from: /System/Volumes/Data/mnt/b2, to: /Users/b2 }
```

Note in a YAML comment that `b2hx` uses its tailnet name because `b2hx.local` does not resolve from
b2studio (design P6), and that the sandbox is read by pointing the local probe at the container's
persistent home rather than by `container exec`.

Deploy and restart:

```bash
pnpm run build
scripts/install-into-dsh-profile.sh web      # expect exit 2 + printed rows; that guard is correct
# b2infra owns the deployed patch file, so copy the source-of-truth version out:
cp ~/Developer/mine/b2infra/etc/dsh/cordis.patch.yml ~/.dsh/profiles/web/cordis.patch.yml
ssh -t b2studio.local 'sudo launchctl kickstart -k system/com.b2.dsh'
```

- [ ] **Step 4: Verify, live and by hand**

```bash
DSH_CC_LIVE=1 pnpm vitest run --project unit packages/claude-code/tests/live/discovery.live.spec.ts
python3 ~/infra/scripts/claude-inventory --max-resumable 3 | python3 -m json.tool | head -30
ssh -N -L 3081:127.0.0.1:3081 b2studio.local   # then ask a dsh agent the original question
```

In the dsh UI, ask *"list my open Claude Code sessions across the mesh"*. The answer must name real
sessions with their hosts. Record the result — this is the acceptance criterion for Phase 1.

- [ ] **Step 5: Fix the stale documentation and commit both repos**

In b2infra's `CLAUDE.md`, the "Claude Code inside dsh — currently NOT wired up" section is already
wrong (the composed rows exist in `etc/dsh/cordis.patch.yml`); update it to describe the live
integration plus the new discovery row.

```bash
cd ~/Developer/mine/dsh-claude-code
git add packages/claude-code/tests/live/discovery.live.spec.ts
git commit -m "test(live): probe over real SSH returns schema-1 output"

cd ~/Developer/mine/b2infra
git checkout -b feature/dsh-claude-code-discovery
git add etc/dsh/cordis.patch.yml CLAUDE.md
git commit -m "feat(dsh): mesh session discovery for the claude-code seam

Adds the claude-code-remote row with the four probe targets. b2hx uses its
tailnet name: b2hx.local does not resolve from b2studio. The sandbox is
read by pointing the local probe at ~/claude-sandbox-home rather than via
container exec.

Also corrects CLAUDE.md, which still claimed the Claude Code integration
was designed but not built."
```

---

### Task 11: Resume fills its own cwd from discovery

Spec §8.1. A wrong cwd is the failure mode already recorded in b2infra's
`learnings/dsh-claude-code.md`: Claude Code resolved a relative path against `$HOME` and wrote
`/Users/b2/proof.txt`. If discovery knows the path, the model must not have to guess it.

**Files:**
- Modify: `packages/claude-code/src/service.ts`, `packages/tool-claude-code/src/index.ts`,
  `packages/tool-claude-code/src/open.ts`
- Test: `packages/claude-code/tests/service-sessions.spec.ts`

**Interfaces:**
- Consumes: `ClaudeCode.discover`, `CcOpenOptions`.
- Produces: `CcOpenOptions.cwd` becomes optional **only when `resume` is set**; the seam resolves it
  from discovery and throws `INVALID_CWD` naming the session when it cannot.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/claude-code/tests/service-sessions.spec.ts
describe('resume without an explicit cwd', () => {
  it('fills the cwd from discovery', async () => {
    const { service, fake } = mountService()
    const id = '77777777-7777-4777-8777-777777777777' as CcSessionId
    service.registerDiscoverySource({
      id: 'remote:test', host: 'b2studio',
      discover: async request => Promise.resolve({
        generatedAt: request.now, cached: false, warnings: [],
        sessions: [{
          sessionId: id, origin: 'resumable' as const, host: 'b2studio',
          sourceId: 'remote:test', cwd: '/Users/b2/Developer/mine/b2infra',
          lastActivityAt: request.now - 1_000, sendable: false, resumable: true,
          fidelity: 'probe' as const,
        }],
      }),
    })

    await service.open({ resume: id, fork: true })

    expect(firstQuery(fake).options.cwd).toBe('/Users/b2/Developer/mine/b2infra')
  })

  it('refuses with INVALID_CWD when discovery cannot name the session', async () => {
    const { service } = mountService()

    await expect(service.open({
      resume: '88888888-8888-4888-8888-888888888888' as CcSessionId, fork: true,
    })).rejects.toMatchObject({ code: 'INVALID_CWD' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/claude-code/tests/service-sessions.spec.ts`
Expected: FAIL — `cwd` is required, so the call does not compile / throws the wrong error.

- [ ] **Step 3: Write minimal implementation**

Make `cwd` optional in `CcOpenOptions` with a doc comment stating it may be omitted **only** with
`resume`, and resolve it at the top of `ClaudeCodeService.open()`, before `assertUsableCwd`:

```ts
    // A resumed session already has a working directory; making the caller
    // restate it invites a wrong guess, and a wrong cwd is the failure mode
    // that wrote proof.txt into $HOME instead of the repo.
    const cwd = options.cwd ?? await this.resumeCwd(options.resume)
```

```ts
  /**
   * Find the working directory of a session being resumed.
   * @param resume - the session id to resume, if any.
   * @returns the discovered cwd.
   * @throws ClaudeCodeError INVALID_CWD when there is nothing to resolve from.
   */
  private async resumeCwd(resume: CcSessionId | undefined): Promise<string> {
    if (resume === undefined) {
      throw new ClaudeCodeError('open requires a cwd unless resume is set.', 'INVALID_CWD')
    }
    const found = (await this.discover({ scope: 'mesh' })).sessions
      .find(session => session.sessionId === resume)
    if (found === undefined || found.cwd === '') {
      throw new ClaudeCodeError(
        `Cannot resume ${resume}: no cwd was given and discovery does not know this session. `
        + 'Pass cwd explicitly, or call claude_code_list with a wider scope first.',
        'INVALID_CWD')
    }
    return found.cwd
  }
```

In the tool layer, make `cwd` non-required in the `claude_code_open` parameter schema and say so in
both descriptions: `cwd` gains "Required unless `resume` is set, in which case the session's own
working directory is used."

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit && pnpm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code packages/tool-claude-code
git commit -m "feat(seam): resume resolves its own cwd from discovery

Requiring the caller to restate a resumed session's cwd invites the guess
that once wrote proof.txt into \$HOME. When discovery cannot name it, the
refusal says how to find it."
```

---

### Task 12: Refuse a plain resume of a session live elsewhere

Spec §8.1. Two writers on one transcript corrupts it, and long-lived external sessions are normal
here — b2umini had week-old ones (P5). `SESSION_EXISTS` only sees composed sessions.

**Files:**
- Modify: `packages/claude-code/src/service.ts`
- Test: `packages/claude-code/tests/service-sessions.spec.ts`

**Interfaces:**
- Consumes: `ClaudeCode.discover`, `SESSION_LIVE_ELSEWHERE` (Task 4).
- Produces: `open({ resume })` without `fork: true` throws `ClaudeCodeError` with code
  `SESSION_LIVE_ELSEWHERE` when discovery reports the target as `live-external`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/claude-code/tests/service-sessions.spec.ts
describe('resuming a session that is live elsewhere', () => {
  /**
   * Register a source reporting one live external session.
   * @param service - the service under test.
   * @param id - the session id to report.
   */
  function reportLive(service: ClaudeCodeService, id: CcSessionId): void {
    service.registerDiscoverySource({
      id: 'remote:b2umini', host: 'b2umini',
      discover: async request => Promise.resolve({
        generatedAt: request.now, cached: false, warnings: [],
        sessions: [{
          sessionId: id, origin: 'live-external' as const, host: 'b2umini',
          sourceId: 'remote:b2umini', cwd: '/Users/b2/Developer/mine/grigios',
          lastActivityAt: request.now - 1_000, sendable: false, resumable: true,
          fidelity: 'probe' as const,
          live: { liveness: 'confirmed' as const, pid: 3796 },
        }],
      }),
    })
  }

  it('refuses a plain resume and names the host holding it', async () => {
    const { service } = mountService()
    const id = '99999999-9999-4999-8999-999999999999' as CcSessionId
    reportLive(service, id)

    const failure = await service.open({ resume: id }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'SESSION_LIVE_ELSEWHERE' })
    expect(String(failure)).toContain('b2umini')
    expect(String(failure)).toContain('fork')
  })

  it('allows the same resume as a fork', async () => {
    const { service, fake } = mountService()
    const id = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as CcSessionId
    reportLive(service, id)

    const snapshot = await service.open({ resume: id, fork: true })

    expect(snapshot.id).not.toBe(id)          // a fork gets a fresh id
    expect(firstQuery(fake).options.forkSession).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/claude-code/tests/service-sessions.spec.ts`
Expected: FAIL — the plain resume is currently allowed.

- [ ] **Step 3: Write minimal implementation**

In `ClaudeCodeService.open()`, after the `SESSION_EXISTS` guard:

```ts
    // SESSION_EXISTS only knows about sessions THIS composition opened. A
    // session running in another terminal or on another host is invisible to
    // it, and appending to a transcript another live process is writing
    // corrupts it. Forking is always safe, so the refusal names that way out.
    if (options.resume !== undefined && options.fork !== true) {
      const elsewhere = (await this.discover({ scope: 'mesh' })).sessions
        .find(session => session.sessionId === options.resume
          && session.origin === 'live-external')
      if (elsewhere !== undefined) {
        throw new ClaudeCodeError(
          `Session ${options.resume} is running on ${elsewhere.host}`
          + `${elsewhere.live?.pid === undefined ? '' : ` (pid ${elsewhere.live.pid})`}`
          + `${elsewhere.title === undefined ? '' : ` — "${elsewhere.title}"`}. `
          + 'Continuing it would have two processes writing one transcript. '
          + 'Pass fork: true to branch from it instead; the original is left untouched.',
          'SESSION_LIVE_ELSEWHERE')
      }
    }
```

- [ ] **Step 4: Run the whole suite**

Run: `pnpm test && pnpm run typecheck`
Expected: PASS — every offline spec across all four packages.

- [ ] **Step 5: Commit and merge the branch**

```bash
git add packages/claude-code
git commit -m "feat(seam): refuse a plain resume of a session live elsewhere

SESSION_EXISTS only sees composed sessions, so nothing stopped dsh from
appending to a transcript another live process was writing. Long-lived
external sessions are normal here (design P5), so the guard consults
discovery and points at fork: true."

pnpm run build && scripts/install-into-dsh-profile.sh web
git checkout develop && git merge --no-ff feature/session-discovery
```

---

## Self-Review

**Spec coverage.** §1 goals 1 and 2 → Tasks 1–10; goal 3 (app visibility) is Phase 3, explicitly out
of this plan's scope. §2 findings: P1→6, P2→1, P4→1/8, P5→1/12, P6→7/10, P7→8, P9→2, P10→2. §3 →
Task 4. §4 → Task 8 boundaries. §5.1–5.4 → Tasks 1–3 plus Task 8's parser. §6.1–6.4 → Tasks 4–7.
§7.1 → Task 9. §7.2's `from_host` is Phase 2b, out of scope; the `cwd`-optional half is Task 11.
§8.1 → Tasks 11–12. §8.2, §9 → Phases 2b/3, out of scope. §10 → Tasks 3, 7, 8. §11 → the tests in
every task plus Task 10's live spec. §12 → `includeTitles`/`--no-titles` in Tasks 2, 4, 6, 8. §13 →
Task 10's b2infra follow-ups. One deliberate gap: the spec's `learnings/dsh-claude-code.md` update
belongs to Phase 2b's spike, so it is not a task here.

**Placeholder scan.** No TBD/TODO; every code step carries runnable code; no step says "add error
handling" without the code that does it. Task 8 gives `src/index.ts` as a partial `apply` body
rather than the full file — acceptable because its `Config` schema shape is fully specified by the
YAML it must accept in Task 10, and the surrounding conventions are stated in Global Constraints.

**Type consistency.** `CcDiscoveredSession`, `CcDiscoveryResult`, `CcDiscoverRequest`,
`CcDiscoverySource`, `CcDiscoverOptions` are defined in Task 4 and used unchanged in 5–12.
`createLocalSource`/`CcLocalSourceDeps`/`CcStoreEntry`/`CcRegistryEntry` (Task 6) are consumed by
name in Task 7. `parseProbeOutput`, `translatePath`, `CcPathMapping`, `createProbeSource` (Task 8)
match their uses. `projectComposed`/`normalizeSourceClock`/`mergeDiscovered`/`groupByOrigin` (Task 5)
are called with those exact names in Tasks 7 and 9. The probe's CLI flags (`--home`, `--window-ms`,
`--max-resumable`, `--no-titles`) match Task 8's argv construction and Task 10's YAML. `liveness`
values `'confirmed' | 'assumed'` are consistent from the probe through to the render.
