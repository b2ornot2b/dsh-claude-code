# Delegation demo

This is `dsh-claude-code`'s acceptance artifact — the whole integration
working, end to end, against a real Claude Code subprocess, runnable by a
human in one command.

It boots the full three-package composition (plus the dsh seams it depends
on: sessions, agents, approval, questions, jobs) from a plain `cordis.yml`,
has a stand-in "DeepSeek agent" delegate a real task to Claude Code through
the `claude_code_open` model-facing tool — "create a file with this exact
content" — and prints:

- every `approval`/question request the auto-answerer decided, as it decides
  them;
- the tool call's canonical JSON result;
- the mirrored dsh session's full event-type timeline (proof the mirror, §5
  of the spec, really did write a relational log of what Claude Code did);
- the created file's path and content.

Then it closes the session and every other seam cleanly and exits `0`.

## Prerequisites

- A working `claude` CLI login with an active subscription (`claude auth
  status`), or `ANTHROPIC_API_KEY` set — the same auth this repo's live test
  suite uses. No API key is required or read for subscription auth; the
  seam strips one from the subprocess environment by default (§9 of the
  spec).
- The workspace built: `pnpm run build` from the repo root. `run.mjs` boots
  `cordis.yml` through the real cordis Loader, which `import()`s each
  package's BUILT entry point (`lib/index.js`) — the same acceptance path
  `tests/composition/composition.spec.ts` exercises, not a TypeScript source
  import.

## Run it

```sh
pnpm run build
node examples/delegation-demo/run.mjs
```

Optionally pick the working directory Claude Code runs in (and writes the
file into) with `--cwd <dir>`; a fresh temp directory under `os.tmpdir()` is
used otherwise. The directory is **not** cleaned up on exit — inspect the
created file afterward, or point `--cwd` at a directory you already intend to
keep.

Expect one real model turn (haiku, per the pinned config in `cordis.yml`) and
one Bash-tool-adjacent `Write` approval, auto-approved and logged by the
demo's own answerer.

## What this is not

- Not a template for production config: the auto-answerers say yes to
  everything unconditionally and log it — that is the point of a demo, not a
  policy anyone should ship.
- Not a substitute for the real test suites. This script has its own gated
  live spec (`run.live.spec.ts`, `DSH_CC_LIVE=1`) asserting it exits `0` and
  the file exists, but the integration's actual coverage lives in each
  package's `tests/` tree.
