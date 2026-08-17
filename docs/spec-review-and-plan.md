# Spec Review & Implementation Plan — `dsh-claude-code`

Review of `docs/dsh-claude-code-integration.md` performed 2026-08-17 against:

- **dsh**: `/Users/b2/Developer/3rd_party/deepseek-harness` working tree (v0.1.0-rc.5; npm latest is rc.7)
- **SDK**: `@anthropic-ai/claude-agent-sdk@0.3.233` (installed fresh and inspected; harness pins 0.3.220)
- **CLI**: Claude Code 2.1.233, logged in via claude.ai Max subscription
- **Live probes**: two real SDK sessions (plan-mode `ExitPlanMode`, `AskUserQuestion` round trip)

Overall verdict: **the spec is architecturally sound and unusually accurate.** The ask-channel
design (§4), streaming-input requirement (§3.1), mirroring rules (§5), cancellation ordering
(§5.4), and auth guidance (§9) all check out against source. The build order stands. But there
are two strategic findings and a set of concrete corrections that must be folded in before
implementation.

---

## 1. Strategic findings (change the plan, not just details)

### 1.1 The harness already ships a Claude Code integration — reuse, don't ignore

`@deepseek-ai/dsh-subagent-claude-code` (`packages/subagent/subagent-claude-code/`) exists in-tree,
pinned to SDK 0.3.220, wired into shipped Agent Presets with `disabled: true`. It is strictly
**one-shot delegation**: one self-contained text task → final answer via the `dsh-subagent` result
contract. `persistSession: false`, `AskUserQuestion` disabled, no `canUseTool`, no steering, no
resume. It does not overlap the spec's goals (interactive sessions, ask routing, mirroring, Agent
adapter) — but it has already solved several hard problems this spec hand-waves:

- Executable resolution through `dsh-subprocess` (credential-scrubbed PATH → `pathToClaudeCodeExecutable`),
  including the Windows `.cmd`/`.bat` shim handling.
- Credential scrubbing: ambient credential-shaped env vars removed, explicit `config.env` overlay.
- Process-tree termination escalation and dispose-before-publication semantics.
- Distribution/licensing evidence pattern (THIRD_PARTY_NOTICES, identity-scoped authorization).

**Plan change:** copy its `process.ts`/`run.ts` patterns for spawning and teardown; leave the
package itself in place for fire-and-forget delegation; position `claude_code_open` (§6) as the
interactive/session-holding complement, not a replacement.

Also relevant: `@deepseek-ai/dsh-subagent-acp` is an ACP **client** (pure `command`+`args` spawn).
Pointing it at `@zed-industries/claude-code-acp` is a config-only alternative for basic delegation.
The spec's assumption 6 was half right: `packages/acp/acp` **is** a server (confirmed), but an ACP
client route does exist. It still doesn't cover the spec's goals (no ask routing into dsh seams,
no mirror, fresh process per run), so the custom plugin remains justified — for the full feature
set only.

### 1.2 Where to develop: separate repo is viable; monorepo gives the test gates

Verified against the live npm registry: `@deepseek-ai/dsh-*` packages **are published**
(0.1.0-rc.7 line; `workspace:^` rewritten to real semver on publish; `@deepseek-ai/cordis@4.0.1`).
So this integration can be developed out-of-tree in this repo (`dsh-claude-code`), depending on
`@deepseek-ai/dsh-tools`, `dsh-agent`, `dsh-jobs`, `dsh-user-approval`, `dsh-user-questions`, etc.,
and mounted via the profile mechanism (`$DSH_HOME/profiles/<name>/package.json` +
`dsh.profile.bundles`, or a plain `cordis.yml` row for embedders).

Trade-offs:

| | Separate repo (this one) | Inside harness checkout |
|---|---|---|
| Package deps | Pin `0.1.0-rc.7` exactly (rc churn is real; `^0.x` doesn't float across minors) | `workspace:^` |
| Test gates | Must recreate what we want (no doc-sync, no assembled snapshot suites, no 100%-coverage gate) | All root gates free: `constraints`, `doc-sync`, per-file 100% coverage, assembled transcript suites |
| Upstreaming | Later PR, restructure into `packages/claude-code/` | Direct |
| Iteration speed | Fast, no monorepo ceremony (README verifiers, catalog gates) | Slower, gated |

**Recommendation:** start in this repo (matches its existence and name), pin `-rc.7` exactly,
follow the monorepo package conventions anyway (named exports, `lib/` layout, seam/consumer split)
so upstreaming later is mechanical. Flag: `docs/testing.md`'s "assembled coverage" contract only
binds in-tree; out-of-tree we substitute our own integration suite (Phase 7).

- **Cordis must come from the peer** — two copies of `@deepseek-ai/cordis` break service
  resolution (module singleton).
- **Type augmentation needs side-effect imports**: `import type {} from '@deepseek-ai/dsh-jobs'`
  to see `ctx.jobs` / `JobKindMap`.

---

## 2. Deltas from the spec (verified, with sources)

### SDK side (all verified against installed 0.3.233; two by live probe)

| # | Spec said | Reality | Source |
|---|---|---|---|
| S1 | "The SDK loads nothing by default" (`settingSources`) | **Omitted = ALL sources loaded** (matches CLI defaults). Isolation requires explicitly passing `[]`. The config default in §10 is right; the rationale sentence is wrong. | `sdk.d.ts:1980-1989` |
| S2 | `canUseTool` third arg may carry `requestId`; correlate `tool_use` heuristically if not | Third arg carries **both `requestId` and `toolUseID`**, plus `title`/`displayName`/`description` (pre-rendered prompt text), `blockedPath`, `decisionReason`, `agentID`, `matchedAskRule`. §4.4's deep-equal fallback heuristic is dead weight — delete it. Use `toolUseID` for `callId` correlation and `requestId` as the idempotency key. | `sdk.d.ts:206-266` |
| S3 | `ExitPlanMode` input has `plan` | `.d.ts` no longer types `plan` (only deprecated `allowedPrompts` + index signature), **but live probe on 2.1.233 confirms runtime input = `{ plan, planFilePath }`**. §4.3 works; read `input.plan` defensively (it's untyped). | `sdk-tools.d.ts:575-590`; probe 1 |
| S4 | `answers` keyed by question text, pass `questions` back through | **Confirmed by live probe**: `{ behavior:'allow', updatedInput: { questions, answers } }` with text-keyed answers produces `tool_result` "Your questions have been answered: …" and the model consumes the choice. | probe 2 |
| S5 | §5.3 mirror table (7 message kinds) | `SDKMessage` is a ~38-variant union (status, task lifecycle, rate-limit, auth, hooks, tool-progress, conversation-reset…). Mirror MUST have a default-ignore branch; same rule as dsh's "never `assertNever` on SessionEvent". | `sdk.d.ts:4273` |
| S6 | interrupt receipt / `interrupt_receipt_v1` / `cancel_queued` | Confirmed in types **and live**: init message advertises `["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]`. Receipt caveats in spec §5.4 match the type docs almost verbatim. **Reconciliation only works if we uuid-stamp every `SDKUserMessage` we send** (`uuid` is optional). | `sdk.d.ts:2372,3728-3746`; probe 1 |
| S7 | `inject()` → "buffer; prepend to the next outbound message" | Better native mechanism exists: `SDKUserMessage.shouldQuery: false` appends to the transcript **without triggering a turn** — exact match for dsh `inject()` semantics. Also `priority: 'now'\|'next'\|'later'` for steer-vs-followup nuance. | `sdk.d.ts:4865-4900` |
| S8 | `startup()` pre-warm | Confirmed: `startup({options, initializeTimeoutMs}) → WarmQuery`; `warm.query(stream)` single-use; `warm.close()` to discard. | `sdk.d.ts:7651, 8012` |
| S9 | `options.env` replaces | Confirmed verbatim: "REPLACES the subprocess environment entirely… Spread `process.env` yourself". When **omitted**, subprocess inherits `process.env` — so for subscription auth, an explicit env that strips `ANTHROPIC_API_KEY` but spreads the rest is the right construction. | `sdk.d.ts:1461-1479` |
| S10 | permission modes incl. `dontAsk`/`auto` | Confirmed: `'default'\|'acceptEdits'\|'bypassPermissions'\|'plan'\|'dontAsk'\|'auto'`. Also `Options.planModeInstructions` exists to replace plan-mode workflow guidance. | `sdk.d.ts:2171,1767` |
| S11 | `sessionId` must be UUID | Confirmed ("Must be a valid UUID"), and **cannot combine with `resume` unless `forkSession` set**. | `sdk.d.ts:1826-1835` |
| S12 | redelivery / idempotency (§4.6) | Confirmed: `reinitialize()` redelivers in-flight `can_use_tool` requests; "callbacks should be idempotent per request_id". `pending_permission_requests` on the initialize response confirmed. | `sdk.d.ts:2462-2479,286-300` |
| S13 | (not in spec) | `PermissionResult` deny accepts `interrupt: true` — deny-and-stop in one step; useful for `askFallback: 'error'`. `CanUseTool` returning `null` means "response sent out-of-band" — never return null. | `sdk.d.ts:196-205`; probe 1 |
| S14 | version-gate claims (e.g. allow-without-updatedInput pre-2.1.207) | No CHANGELOG ships in the npm package. Moot if we always send `updatedInput` (do). Feature-detect via `capabilities` on init, never version-sniff. | package contents |

### dsh side (all verified against source by three parallel investigations)

| # | Spec said | Reality | Source |
|---|---|---|---|
| D1 | "Is dsh SessionId a UUID?" (assumption 1) | **No.** Unvalidated branded string; mints vary: `session-<counter>` (store default), `<agentId>-session-<uuid>` (loop), `session-<uuid>` (apiproxy). BUT caller-supplied ids are first-class: `ctx.agents.create({ sessionId })` / `SessionStore` accept any string, and `packages/acp/acp` already mints bare `SessionId(randomUUID())`. **Resolution: mint `SessionId(randomUUID())` ourselves → shared identity works; no bidirectional map needed.** | `packages/core/session/src/types.ts:22-31`; `packages/acp/acp/src/index.ts:254`; `packages/core/agent/src/index.ts:76-82` |
| D2 | `ctx.approval.request()` contract (assumption 2) | Confirmed exactly: fields `{agent, toolName, callId?, reason?, signal?}` (no args by design), outcomes `allowed-once\|rejected\|cancelled\|unavailable`, **throws before appending when no open turn**, aborted signal → `cancelled` + late answer discarded. Extras: consume via `ctx.get('approval')` (optional service; absent = fail-closed deny); per-session policy `'never'` is unbypassable; answerer correlates pending asks by `callId` back-scan — omit `callId` and you only match callId-less asks. | `packages/interaction/user-approval/src/index.ts:153-343` |
| D3 | `ctx.userQuestions.ask()` rejections (assumption 3) | Confirmed: `UserQuestionError` codes `CALLER_NOT_LIVE` (also fired when registry absent) and `DELEGATED_CALLER` (agent not in `agents.roots()`). Full taxonomy also: `ASK_ABORTED`, `EMPTY_QUESTIONS`, `BAD_INTENT`, `NO_PROVIDER`, `ASK_CANCELLED` (user dismissed), `ASK_MISSING_AGENT` (web provider requires `agent`). Fallback policy must catch **all** of these, not just the two named. | `packages/interaction/user-questions/src/index.ts:92-139` |
| D4 | §4.2 answer mapping rules | Confirmed, plus: wire validation is **positional** (`answers[i].id === questions[i].id`, same length) — return answers in question order; single-select enforces `custom` XOR non-empty `selected` and `selected.length ≤ 1`; ids have **no uniqueness validation** but consumers require exactly-one-match by id → keep ids unique ourselves (question text, suffixed on collision, per §4.2.1). | `packages/host/apiproxy/src/api-proxy.ts:715-733` |
| D5 | §4.3 plan approval | Confirmed mechanism, and **dsh's own plan-mode package is the template**: it asks id `'plan-review'`, options Approve/reject, `intent {kind:'plan-review', approve:'Approve'}`, and treats exactly `selected===['Approve'] && custom===undefined` as approval; `custom` text becomes revision feedback; `ASK_CANCELLED` = dismissed. Copy that convention verbatim. `ctx.planMode` (not `ctx.plan`) stores only a boolean `plan/mode` event; CC owns its own plan state — **do not wire `ctx.planMode.set()`** for CC sessions (its queued-flip semantics assume the dsh loop); optionally log `plan/mode` events into the mirror for UI. | `packages/plan/plan-mode/src/index.ts:330-379` |
| D6 | `AgentRegistry.register/enter/announce` usable outside the loop (assumption 4) | Confirmed. They live in `@deepseek-ai/dsh-agent` (not `-agent-loop`), publicly exported; README says "Replace the loop by implementing `Agent` and registering via `ctx.agents.register()`". Constraints: `enter()` throws unless `agent.id === agent.session.id`; ordinary callers use `register()`; the returned disposer's **identity is load-bearing** — yield the exact function, never a wrapper (spec §7 already says this; confirmed real). | `packages/core/agent/src/index.ts:256-576`, `README.md:79` |
| D7 | §7 `Agent` table | Mostly right. Corrections: `AgentOptions` is readonly `{provider?, model?, maxTokens?}` — **no `setModel()`**; model switching in dsh is `installModelSelection()` + `agent/request` waterfall, which never fires for us → expose model changes purely through `query.setModel()` and report via `options.model` snapshot at open. `AgentStatus` is exactly `'idle'\|'running'`. `cancel(cause, {keepInbox})` confirmed. `send(msg, target, wakeup)` with `InboxTarget = 'next-turn'\|'next-step'`. `inject()` in dsh **appends** (durable inbox + `agent/inbox/spliced` event), doesn't prepend — map it to `shouldQuery:false` sends (S7). | `packages/core/agent/src/runtime-types.ts:24-144` |
| D8 | §7.1 inert waterfalls | Confirmed precisely: `agent/pre-step`, `agent/request`, `agent/request-error` are dispatched only from `ReactLoopAgent` around `ctx.llm.stream()`; `tools/*` events only via `ctx.tools`. Every plugin hooking them is silently inert for a CC-backed agent. Document + provide substitutes as spec says. | `packages/core/agent-loop/src/agent.ts:234-441` |
| D9 | "twelve SessionEvent variants" | Stale doc (`docs/subsystems/core.md:248`): core map is **13** (incl. `request/context`, `session/end-seed`; `steering/message` no longer exists), build-wide vocabulary is 46 generated types. All event names the spec uses exist. Thinking chunks: `assistant/chunk` payload is an LLM `StreamChunk`; reasoning is the `type:'reasoning-delta'` discriminant (+ `block-start` `blockType:'reasoning'`), not a marker flag. Compaction: four `compaction/*` events; `compaction/summary`+`prune` are log-only — surface replacement is the *following* `user/message`. Custom events must be declaration-merged and marked `ignorable` or older runtimes refuse the log; all payloads must be lossless JSON. | `packages/core/session/src/types.ts:236-333`; `packages/compaction/compaction/src/types.ts` |
| D10 | §3.4 jobs contract | Confirmed with corrections: `owner` is optional and `exec.agent` is `Agent \| undefined` — spread conditionally (`...(exec.agent ? { owner: exec.agent } : {})`) or `exactOptionalPropertyTypes` fails the build. **`ctx.jobs.start()` throws unless a controller is attached — composition must load `@deepseek-ai/dsh-tool-jobs`** (which provides `job_kill`/`job_output`/`job_list`). New `kind: 'claude-code'` requires `JobKindMap` declaration-merge. There is no "task-owned signal" object: the job's cancellation channel **is** `JobHooks.cancel` (sync, idempotent); background path passes no signal at all; `done` must never reject; re-check `exec.signal.aborted` immediately before `start()` and throw `AbortError` if set. Default cap: 10 concurrent jobs per owner. Session fence confirmed (owner-id match). `{kind:'background', jobId}` is a repo-wide typed idiom — declare it as a `oneOf` branch in `output.schema`. | `packages/jobs/jobs/src/*`, `packages/jobs/jobs-local/src/index.ts:351-462`, `packages/shell/tool-bash/src/index.ts:356-383` |
| D11 | §2 "tool-bash three-package split" | `tool-bash` is **one** package. The "three" is the capability-seam trio: Definition (`dsh-shell`) / Provider (`dsh-bash-local` …) / Consumer (`dsh-tool-bash`). Our proposed split (seam `dsh-claude-code`, consumer `dsh-tool-claude-code`, adapter `dsh-claude-code-agent`) still fits that doctrine — but say "definition/provider/consumer", and note `dsh-claude-code` is both definition and provider (the SDK is the backend; no alternative provider planned). There is no `@deepseek-ai/dsh-core`. | `packages/shell/README.md:5-17`; `docs/architecture.md:100` |
| D12 | §6 `defineTool` contract | Confirmed; additions: `output.render` is **required**; use `output.presentationMeta(args, value)` for replay-durable card payloads; `finalizeContent` exists and must be total; presenter purity is documented-but-soft-validated (malformed logged args → generic card, not throw). Card kinds: call-side `generic\|terminal\|diff`; result-side adds `search\|read\|web`. §6's card plan (terminal for Bash, diff for Write/Edit) is exactly what exists. | `packages/core/tools/src/schema.ts:483-609`, `presentation.ts` |
| D13 | §4/§6 `tools/pre-execute` | Confirmed (waterfall; `allow\|deny\|ask`; `ask` requires approval service loaded, else ≡ deny; must `return next()` to delegate; cannot rewrite `exec.arguments`; not a security boundary — `ctx.tools.guard()` is the monotonic one). | `packages/core/tools/src/index.ts:152,582-591,703-711` |
| D14 | §9 credentials | `ctx.credentials` confirmed and right for API-key mode: config stores a **ref** (`apiKeyEnv: 'ANTHROPIC_API_KEY'`), resolve per operation (hot rotation), `set`/`unset` reject while env shadows the ref. | `packages/credentials/credentials/src/index.ts:23-99` |
| D15 | (not in spec) | **`export default` drops `inject`** — documented post-mortem 0001 (crashed in production with 100% unit coverage). Named exports only; add the `'default' in mod === false` test guard. | `docs/postmortem/0001-*.md`; `docs/testing.md:34` |
| D16 | §12 test plan | In-monorepo the bar is higher than the spec implies: per-file 100% coverage on `src`, a REAL-composition (Loader-booted `cordis.yml`) test for product-visible plugins, built-artifact entry tests, HMR-safety (dispose fiber, assert cleanup), assembled snapshot scenario per model/UI-visible change, keyless + with-key smokes. Out-of-tree: adopt real-composition + HMR + keyless/with-key structure at minimum. | `docs/testing.md` |

---

## 3. Gotchas checklist (the ones that will actually bite)

1. **Named exports only** — `export default` silently drops `inject` (post-mortem 0001).
2. **Mint the SessionId as a bare UUID** at open (`SessionId(randomUUID())`) and hand it to both
   dsh (`agents`/session store) and the SDK (`options.sessionId`). Never accept an externally
   minted dsh id for the SDK side.
3. **UUID-stamp every `SDKUserMessage` you send** — interrupt-receipt reconciliation is silently
   useless otherwise.
4. **Always send `updatedInput` on allow**; never return `null` from `canUseTool`.
5. **`settingSources: []` must be passed explicitly** — omitting it loads the user's real
   settings/CLAUDE.md into an embedded agent.
6. **Env construction**: spread `process.env`, delete `ANTHROPIC_API_KEY` under
   `auth: 'subscription'` (silent API billing otherwise), keep `PATH`/`HOME`.
7. **Input stream must never complete** while the session lives — closing it kills the
   permission-callback channel (stdin EOF → ~2s grace → subprocess exit).
8. **Ask table keyed by SDK `requestId`, idempotent** — `reinitialize()` and
   `pending_permission_requests` redeliver.
9. **Open-turn guard**: `approval.request()` throws synchronously with no open turn; catch and
   deny with explanation, never let it reject the canUseTool promise unhandled (hangs CC forever).
10. **Answer positionally**: dsh's wire validator aligns `answers[i].id` with `questions[i].id`.
11. **Fallback policy must catch the full `UserQuestionError` taxonomy** (D3), not just
    `DELEGATED_CALLER`, plus approval `unavailable`, plus timeout.
12. **Jobs**: composition requires `dsh-tool-jobs`; conditional-spread `owner`; `JobHooks.cancel`
    is the only post-publication kill path; pre-abort check before `start()`; `done` never rejects.
13. **Mirror**: default-ignore unknown SDK messages; never `assertNever` dsh session events; mark
    any custom events `ignorable`; JSON-lossless payloads only.
14. **Disposer identity**: yield `register()`'s exact return into the composite effect.
15. **Two cordis copies break everything** — peer-depend, never bundle.
16. **Feature-detect via init `capabilities`** (`interrupt_receipt_v1`, …), never version-sniff.
17. **Distribution**: third parties may not offer claude.ai login/subscription limits without
    Anthropic approval — README note stands; personal use on own subscription is ordinary use.

---

## 4. Resolved unknowns (tested live, 2026-08-17)

| Unknown | Method | Result |
|---|---|---|
| `ExitPlanMode` input shape on 2.1.233 | Live probe, `permissionMode:'plan'` | `{ plan: <markdown>, planFilePath: <~/.claude/plans/…> }` — §4.3 viable |
| `AskUserQuestion` answer encoding | Live probe, allow with `updatedInput` | Text-keyed `answers` + passthrough `questions` → tool result confirms answers; model consumed them |
| CLI capabilities | init message | `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `msg_lifecycle_v1` |
| `canUseTool` 3rd arg | Both probes | `toolUseID` + `requestId` + pre-rendered `title` present |
| Subscription auth via SDK | Both probes | Works with `ANTHROPIC_API_KEY` unset; `claude auth status` = max plan |

## 5. Remaining unknowns → Phase 0 spikes

Each is a ~30-line probe script (pattern in scratchpad `sdk-probe/`), run before its consuming phase:

1. **Resume/fork**: open with our UUID `sessionId` → close → `resume` → assert continuity; then
   `resume + forkSession: true` — does the forked session get *our* id or a fresh one? (§8.2
   direction decision depends on it.)
2. **Mid-turn steering**: send a second `SDKUserMessage` while a turn is running; observe whether
   it folds into the current turn or queues (`priority: 'now'` vs default).
3. **Interrupt with queued messages**: enqueue 2 uuid-stamped messages, interrupt, assert receipt
   `still_queued` contents; repeat with `cancel_queued`.
4. **`suggestions` round trip**: trigger a repeatable permission (e.g. Bash), echo
   `updatedPermissions` filtered to `destination:'localSettings'`, assert no re-prompt in a fresh
   session on the same cwd.
5. **Prewarm**: `startup()` → later `warm.query(stream)`; measure first-token latency delta;
   verify `canUseTool` still routes.
6. **Partial-message shape**: `includePartialMessages: true` → map `stream_event` payloads to
   dsh `assistant/chunk` (`text-delta` / `reasoning-delta`) — confirm block indices line up.
7. **dsh composition smoke** (dsh side, not SDK): minimal out-of-tree plugin against published
   rc.7 packages — `cordis.yml` + Loader boot + `ctx.get('approval')` + `userQuestions.ask()`
   with a scripted provider. Proves the separate-repo toolchain before real code.

---

## 6. Implementation plan (revised from spec §11)

Development in **this repo**, pinned: `@anthropic-ai/claude-agent-sdk@0.3.233` (exact),
`@deepseek-ai/*@0.1.0-rc.7` (exact), `@deepseek-ai/cordis` as peer. Git flow: one feature branch
per phase, commit after tests pass.

**Phase 0 — Spikes (§5 above).** Deliverable: `spikes/` scripts + findings appended to this doc.
Gate: spike 7 (out-of-tree composition) must pass or we fall back to developing inside the
harness checkout.

**Phase 1 — Scaffold.** Three packages following harness conventions (named exports, `inject`
lists, `lib/` build layout, schemastery `Config`):
- `packages/claude-code` → `dsh-claude-code`: types, `ctx.claudeCode` service, config schema (§10
  with `settingSources` rationale corrected), README with §8 + §9 + D-table caveats written first.
- `packages/tool-claude-code` → `dsh-tool-claude-code`: stubs.
- `packages/claude-code-agent` → `dsh-claude-code-agent`: stubs.
Tests: plugin-shape guards (`'default' in mod === false`), config schema, real-composition boot.

**Phase 2 — Session actor (`CcSession`).** Pushable never-completing input stream; uuid-stamped
sends; `open()` (+optional prewarm) caching `initializationResult`; `interrupt()` with receipt
reconciliation; `close()` settling pending asks first; everything under `ctx.effect()`. Spawn/env
code adapted from `subagent-claude-code`'s `process.ts` (credential scrub, PATH resolution,
process-tree teardown). Auth per §9 with S9 env construction.
Tests: unit (stream, env: PATH survives / API key stripped, receipt reconciliation incl. unknown
uuids) + slow integration (real subprocess, hardcoded-allow `canUseTool`).

**Phase 3 — Mirror.** §5 with D9 corrections: 13-variant map, `reasoning-delta` chunks,
compaction boundary marker, default-ignore for the ~38 SDK message kinds,
`Map<toolUseID, CallId>` populated before ask routing.
Tests: golden-transcript unit tests (recorded SDK message streams → expected event sequences).

**Phase 4 — Ask channel** (the spend-real-time phase). Router on `toolName`; §4.1 mapping table
(all four outcomes, `updatedInput` always); §4.2 with positional answers + custom-overrides +
skip-by-omission; §4.3 copying plan-mode's `plan-review` conventions (id `'plan-review'`,
approval = `['Approve']` + no custom, decline feedback from `custom`); open-turn guard;
idempotent ask table by `requestId`; abort → settle; `askTimeoutMs` + `askFallback` covering the
full error taxonomy (D3); `suggestions` → `updatedPermissions` when answerer said "always".
Tests: full §12 unit list + slow end-to-end allow/deny/question/plan flows.

**Phase 5 — Tools.** §6 with D10/D12 corrections: sync mode default; background via jobs
(`JobKindMap` merge, conditional owner spread, `JobHooks` contract, pre-abort check,
`{kind:'background', jobId}` schema branch); `inject` progress with try/catch;
composition docs stating `dsh-tool-jobs` requirement.
Tests: unit + real-composition with jobs loaded/not-loaded (graceful error).

**Phase 6 — Agent adapter.** §7 with D6/D7 corrections: mint UUID SessionId, real dsh `Session`
sharing the id, `register()` (not enter/announce unless async setup demands it), exact-disposer
yield; `inject()` → `shouldQuery:false`; turn framing opens `turn/start` on claim, closes on
result (Phase 3's framing reused); README section on inert waterfalls + substitutes (§7.1).
Tests: HMR-safety (dispose fiber → subprocess dead, asks settled), status transitions,
`whenIdle`, cancel/keepInbox.

**Phase 7 — Cards + assembled coverage.** Terminal/diff presenters (pure, `presentationMeta`);
failure-injection suite (kill subprocess mid-turn; never-answered ask; late answer after cancel);
keyless + with-key smoke split; upstreaming decision (PR into harness vs. publish standalone).

---

## 7. Open decisions for the repo owner

1. **Repo choice** — recommendation: this repo, out-of-tree (see §1.2). Say the word if you'd
   rather develop inside the harness checkout for the free gates.
2. **SDK pin** — 0.3.233 (verified here) vs. matching the harness's 0.3.220 pin. Recommendation:
   0.3.233; feature-detect capabilities anyway.
3. **Scope trim** — if the near-term need is only "DeepSeek agent delegates coding tasks to
   Claude", enabling the existing `subagent-claude-code` row (or `subagent-acp` +
   `claude-code-acp`) is a zero-code interim while Phases 0–4 land.
