# Phase 1 API contract — `@deepseek-ai/dsh-claude-code`

Written by Stage 1 of the Phase 1 scaffold. This is the **complete and only**
API surface the two consumer packages may rely on, plus the workspace
conventions their packages must follow.

- Seam package: `packages/claude-code` → `@deepseek-ai/dsh-claude-code`
- Consumers built against it:
  - `packages/tool-claude-code` → `@deepseek-ai/dsh-tool-claude-code` (`inject: ['tools', 'claudeCode']`)
  - `packages/claude-code-agent` → `@deepseek-ai/dsh-claude-code-agent` (`inject: ['agents', 'claudeCode', 'sessions']`)

Everything here is verified: every package builds with `skipLibCheck: false`,
and `pnpm -r typecheck`, `tsc -p tsconfig.tests.json`, and `vitest run` are
green. Updated at the Stage 3 merge point, where the whole workspace was
verified together and the Phase 1 acceptance test (§7) landed.

**Updated by Phase 2, Stage 1 (the session actor).** §4 now carries the live
surface: `CcSession`, the `onMessage` envelope, `waitForResult`, the three send
modes, the warm pool, and the SDK-free backend seam. Everything Phase 1 froze is
still here and still true, with two corrections called out in §5a: `open()` and
`accountInfo()` no longer answer `NOT_IMPLEMENTED`, and unit specs did not
actually resolve to `src/` until a `tests/tsconfig.json` was added per package.

**Updated again by Phase 2, Stages 2–3 (the live suite and the merge point).**
A gated live integration suite (`packages/claude-code/tests/live/`, run by
`pnpm run test:live`, which sets `DSH_CC_LIVE=1`) exercises the real SDK against
a real subprocess; `pnpm test` stays offline because every live spec is
`describe.skipIf(!LIVE)`. Running it found four real defects, all fixed and all
recorded in §5a — the two the live run itself surfaced (a plain resume was
rejected by the SDK at spawn; the warm fingerprint was invalidated by the SDK's
own `process.env` write) and the two the review of those fixes surfaced (a warm
subprocess could be seeded with `resume`/`forkSession` baked in; a plain resume
of a live session overwrote its registry entry).

**Updated by Phase 6 (the Agent adapter).** §4.4f is the adapter's whole surface
— `ClaudeCodeAgent`, `createClaudeCodeAgent`, `ctx.claudeCodeAgents`, the
`Agent`-member mapping, the spawn sequence and the teardown ORDER — plus the one
seam addition it needed (`CcSession.setModel`, §4.4b). §5a's Phase 6 block
records six deliberate deviations from what Phase 1 froze, and the defect the
unmount test found (a spawned agent outliving its own plugin, because cordis's
`Service.ctx` is not the mounting fiber's context).

**Updated by Phase 3 (the mirror).** §4.4c is the mirror's whole surface —
`CcMirror`, `attachMirror`, `CcMirrorSource`, the `claude-code/compact` custom
event and `markEventIgnorable` — plus the new `CcSession.onSend` seam (§4.4b) it
reads user prompts from. Three defects were found by replaying real traffic
rather than hand-written shapes, and all three are fixed and documented here:
a `steer`'s aborted model call was flushed as a spurious near-empty
`assistant/message` (Stage 2, from a recorded fixture); a turn killed mid-block
dropped the text it had already streamed and wrote an EMPTY assistant message
instead (Stage 3); and a session that died mid-turn left a dangling `turn/start`
that made the log permanently unappendable (Stage 3, now closed by
`CcMirror.finalize()`). A `followup` queued behind a running turn is also
recorded in the turn that RUNS it rather than the one that was open, so the
mirrored transcript reads in execution order.

---

## 1. Hard rules (non-negotiable, each one is a real production bug)

1. **Named exports only. No `default` export anywhere under `src/`.** The cordis
   Loader unwraps `exports.default ?? exports`, so a default export throws away
   the sibling `name` / `inject` / `Config` exports and mounts the plugin with an
   empty inject list (harness post-mortem 0001). Every package ships a test
   asserting `('default' in (await import(entry))) === false`.
2. **Only `packages/claude-code` may import `@anthropic-ai/claude-agent-sdk`.**
   No consumer package declares it in any dependency field.
3. **Never identity-compare cordis services or contexts, and never pass one to
   `util.inspect` / an assert formatter.** cordis 4 returns a fresh traceable
   proxy per access: `ctx.get(k) !== ctx.get(k)` and `ctx.get('x') !== ctx.x`.
   Inspecting one throws a misleading `cannot get property "href" without inject`.
4. **`exactOptionalPropertyTypes` is on.** Never assign a possibly-`undefined`
   value to an optional property — conditionally spread it:
   `...(value === undefined ? {} : { key: value })`.
5. **Cordis comes from the peer.** `@deepseek-ai/cordis` is a `peerDependency`
   AND a `devDependency` at the *same exact range*. Two copies break service
   resolution.
6. **Read optional services with `ctx.get('name')`, never `ctx.name`.** The
   property proxy walks ancestors only and throws through a foreign shadow.
   `ctx.<name>` is correct only for services in your declared `inject` list.
7. **Tests stay offline.** No live Claude Code session, no network, no API key.

## 2. Exact pins

| Dependency | Field | Version |
|---|---|---|
| `@deepseek-ai/cordis` | `peerDependencies` + `devDependencies` | `4.0.1` (exact, both) |
| `@deepseek-ai/dsh-*` (any) | `peerDependencies` + `devDependencies` | `0.1.0-rc.7` (exact, both) |
| `@deepseek-ai/schemastery` | `dependencies` | `3.18.1` (exact) |
| `@anthropic-ai/claude-agent-sdk` | `dependencies` of `packages/claude-code` **only** | `0.3.233` (exact) |
| `@deepseek-ai/dsh-claude-code` (the seam) | `peerDependencies` + `devDependencies` of a consumer | `workspace:*` |

`pnpm-workspace.yaml` carries a `minimumReleaseAgeExclude` for `@deepseek-ai/*`
and `@anthropic-ai/*` — without it pnpm refuses these deliberately recent pins.

## 3. Workspace conventions

### Layout

```
packages/<pkg>/
  package.json      # see template below
  tsconfig.json     # extends ../../tsconfig.base.json
  README.md         # '## Model Experience' + '## Known Limitations and Deferred Work'
  src/index.ts      # named re-exports only
  src/*.ts          # in-package relative imports use explicit `.ts` specifiers
  tests/*.spec.ts   # vitest; discovered by the ROOT vitest.config.ts
```

Do **not** create a root `tsconfig.json` solution file and do not edit
`tsconfig.base.json`, `vitest.config.ts`, or the root `package.json`: the root
scripts are `pnpm -r run build|typecheck|clean` plus a single
`tsc -p tsconfig.tests.json`, so a new package is picked up automatically. The
one exception: **add your package name to the `paths` map in
`tsconfig.base.json` only if it is missing** — both consumer names are already
mapped.

### `package.json` template

```jsonc
{
  "name": "@deepseek-ai/dsh-tool-claude-code",
  "description": "…",
  "version": "0.1.0",
  "private": true,                       // we cannot publish the @deepseek-ai scope;
                                         // the name is kept for upstreaming. Say so in the README.
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
  "peerDependencies": { /* cordis + every dsh-* you import + the seam */ },
  "devDependencies": { /* mirror every peer at the same exact range */ }
}
```

`build` and `typecheck` are the same command on purpose: the composite build IS
the type check (declaration emit exercises the whole public surface).

### `tsconfig.json` template

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib", "declarationDir": "lib/types" },
  "include": ["src"],
  "references": [{ "path": "../claude-code" }]
}
```

Verified: a consumer shaped exactly like this type-checks against the seam.
Notes:

- `tsconfig.base.json` is NodeNext + `strict` + `exactOptionalPropertyTypes` +
  `noUncheckedIndexedAccess` + `skipLibCheck: false`, and enables
  `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`: write
  `import { x } from './thing.ts'` in source; the compiler emits `./thing.js`.
- It also lists `types/sdk-dom-shim.d.ts` under `files`, which every extending
  config inherits. That declares the one DOM type (`HeadersInit`) the Claude
  Agent SDK's transitive `@modelcontextprotocol/sdk` dependency needs. Leave it
  alone; do not add `"dom"` to `lib` (DOM's `setTimeout` returns `number` and
  would shadow Node's `NodeJS.Timeout`).
- `paths` in `tsconfig.base.json` map each workspace package name to its
  `src/index.ts`, so tests and typechecks run on the **source plane** — a stale
  `lib/` can never shadow the code under test.

### Tests

`vitest.config.ts` defines **two projects**, because they resolve this repo's
packages on deliberately different planes:

| Project | Location | Resolves this repo's packages to | Run it |
| --- | --- | --- | --- |
| `unit` | `packages/<pkg>/tests/**/*.spec.ts` | `src/` (via `resolve.tsconfigPaths: true` + the `tsconfig.base.json` `paths` map) | `pnpm run test:unit` |
| `composition` | `tests/composition/**/*.spec.ts` | `lib/` (the cordis Loader's native dynamic `import()`) | `pnpm run test:composition` |

- Run everything from the repo root: `pnpm install`, `pnpm run typecheck`,
  `pnpm test`, `pnpm run build`.
- **`pnpm test` runs `pnpm run build` first.** The `composition` project boots a
  real `cordis.yml` and the Loader imports each row's bare package specifier,
  which resolves to that package's `lib/index.js`. Stale or missing build output
  is a test failure, not a silent fallback (`tests/composition/composition.spec.ts`
  guards it with an explicit "run `pnpm run build` first" assertion).
- A spec in the `composition` project must import **no value** from any
  `@deepseek-ai/dsh-claude-code*` package — vitest would resolve that to `src/`
  while the Loader resolves to `lib/`, putting two copies of a module singleton
  in one process. Type-only side-effect imports
  (`import type {} from '@deepseek-ai/dsh-claude-code'`) are erased and are the
  correct way to make `ctx.claudeCode` visible there.
- `tsconfig.tests.json` type-checks every spec file (specs are NOT in a
  package's `include`) — `packages/*/tests/**/*.ts` **and** `tests/**/*.ts` —
  and root `typecheck` runs it after the package builds.
- Import the seam by package name (`@deepseek-ai/dsh-claude-code`) in specs, not
  by a relative path — that exercises the same resolution consumers use.
- Mount plugins with a **named function declaration**, never
  `Object.assign(fn, { name })`: a function's `name` is not writable and the
  assignment throws.

  ```ts
  const ctx = new Context()
  function mountForTest(inner: Context): void { /* … */ }
  const fiber = await ctx.plugin(mountForTest)
  // …assertions…
  await fiber.dispose()      // HMR-safety: assert ctx.get('yourKey') is undefined after
  await ctx.fiber.dispose()
  ```

### README requirements (per package)

1. A `## Model Experience` section. Either structured entries (one `H3` per
   model-visible entry, each with the `H4`s `What the model sees`,
   `Token effect`, `KV Cache effect`), or — for a package with no direct
   model-visible surface — the short form: one `None, as …` / `Indirectly,
   through …` sentence, then an `#### KV Cache effect` H4 with one paragraph.
   `dsh-tool-claude-code` registers tool schemas and therefore needs the
   **structured** form.
2. A `## Known Limitations and Deferred Work` section with bulleted
   consumer-visible gaps.
3. A note that the package is `private: true` and keeps the `@deepseek-ai/dsh-*`
   name for future upstreaming.

## 4. The seam's exact export surface

`import { … } from '@deepseek-ai/dsh-claude-code'`. **Fifty-one** runtime
exports (pinned by `packages/claude-code/tests/exports.spec.ts` — Phase 2 added
`CcSession`, `WarmPool`, `realBackend`, `createInputStream`, `resolveQueryOptions`,
`buildSessionEnv`, `warmFingerprint`; Phase 3 added `CcMirror`, `attachMirror`,
`CC_COMPACT_EVENT`, `markEventIgnorable`; Phase 4 added the ask channel —
`CcAskRouter`, `CcAskTable`, `CcAskRules`, `applyAskFallback`, `mapQuestions`,
`mapAnswers`, `describeCall`, `describeReason`, `askErrorCode`,
`resolveRuleCachePath` and their constants) plus the types below. Nothing else
exists; nothing else will be added without updating this document.

**No export references a Claude Agent SDK type.** `src/backend.ts` re-states, in
this seam's own vocabulary, exactly the SDK shapes we use, and the real backend
passes our objects to `query()`/`startup()` with **no casts** — so the compiler
proves the restatement matches the installed SDK, and `lib/types/**` stays
SDK-free (asserted by `tests/composition/composition.spec.ts`).

### 4.1 Service

```ts
class ClaudeCodeService extends Service implements ClaudeCode {
  static readonly Config: z<ClaudeCodeConfig>
  readonly config: ResolvedClaudeCodeConfig
  constructor(ctx: Context, config?: ClaudeCodeConfig)
  open(options: CcOpenOptions): Promise<CcSessionSnapshot>
  get(id: CcSessionId): CcSessionSnapshot | undefined   // live, else a recently-closed tombstone
  list(): readonly CcSessionSnapshot[]                  // LIVE sessions only
  close(id: CcSessionId): Promise<boolean>
  accountInfo(): Promise<CcAccountInfo>
  // Phase 3:
  attachMirror(id: CcSessionId, session: Session, options?: CcMirrorOptions): CcMirrorHandle
  // Phase 4:
  attachAskTarget(id: CcSessionId, target: CcAskTarget): () => void
}

/** The capability, for typing against the seam rather than the class. */
interface ClaudeCode { /* the seven methods above, identical signatures */ }
```

Context augmentation (already declared by the seam):

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { claudeCode: ClaudeCodeService }
  interface Events {}   // placeholder; Phase 3 declares the mirror events
}
```

To see `ctx.claudeCode` in a file that imports no runtime value from the seam,
use a side-effect type import: `import type {} from '@deepseek-ai/dsh-claude-code'`.

**Phase 2 behavior you must code against** (Phase 1's `NOT_IMPLEMENTED` rows are
gone; `session(id)` is new):

| Call | Phase 2 |
|---|---|
| `open(options)` | opens/resumes/forks a real session and resolves with its snapshot. Rejects `INVALID_CWD` (relative or missing `cwd`, checked before any spawn), `SESSION_LIMIT` (`limits.maxConcurrentSessions` reached), `SESSION_EXISTS` (a plain resume of a session still open here), `BACKEND_ERROR` (the SDK could not start) |
| `get(id)` | the LIVE snapshot (status/model move under you), `undefined` when unknown |
| `list()` | every live session in open order, fresh array each call |
| `close(id)` | `true` when a session was closed, `false` for an unknown id; idempotent |
| `session(id)` | the `CcSession` actor, or `undefined`. **A handle, not a value** — never put it in a tool result, never identity-compare it across a service access |
| `accountInfo()` | the first live session's cached account; rejects `NO_LIVE_SESSION` when nothing is open (it never spawns a session to answer) |
| `attachMirror(id, session, opts?)` | (Phase 3) mirrors a live session into a dsh session log; throws `UNKNOWN_SESSION` for an unregistered id. When the CC session closes the mirror is FINALIZED (a turn left open by a mid-turn death is closed as `aborted`/`disposed`) and then detached |
| `attachAskTarget(id, target)` | (Phase 4) sets WHO answers that session's permission prompts, questions and plan reviews; returns a disposer; throws `UNKNOWN_SESSION` for an unregistered id. Prefer `open({ ask })` — see §4.4d |
| `config` | fully resolved; safe to read |

A consumer written against Phase 1 still compiles: nothing was removed. What
changed is that the rejections are now *situational* rather than universal, so a
tool body must route on `error.code` instead of assuming `NOT_IMPLEMENTED`.

### 4.2 Plugin namespace exports

```ts
const name: 'claude-code'
const inject: string[]                                    // [] — the seam mounts anywhere
function apply(ctx: Context, config?: ClaudeCodeConfig): void
const Config: z<ClaudeCodeConfig>                          // schemastery schema
```

`apply` constructs the service; `Config` is the schema the Loader validates a
`cordis.yml` row against. Your package exports the same four names.

### 4.3 Types

```ts
type CcSessionId = SessionId                              // from @deepseek-ai/dsh-session, ALWAYS a bare UUID
function newCcSessionId(): CcSessionId                    // SessionId(randomUUID())
function isCcSessionId(id: string): boolean               // bare-UUID shape check

type CcPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
const CC_PERMISSION_MODES: readonly CcPermissionMode[]

type CcSettingSource = 'user' | 'project' | 'local'
const CC_SETTING_SOURCES: readonly CcSettingSource[]

type CcAuthMode = 'subscription' | 'api-key'
const CC_AUTH_MODES: readonly CcAuthMode[]

type AskFallback = 'deny' | 'first-option' | 'error'
const ASK_FALLBACKS: readonly AskFallback[]

type CcSessionStatus = 'starting' | 'running' | 'idle' | 'closed'
const CC_SESSION_STATUSES: readonly CcSessionStatus[]

interface CcContextUsage { readonly usedTokens: number; readonly maxTokens?: number }

interface CcOpenOptions {
  readonly cwd: string                    // required
  readonly prompt?: string
  readonly model?: string
  readonly permissionMode?: CcPermissionMode
  readonly resume?: CcSessionId
  readonly fork?: boolean
  readonly background?: boolean
}

interface CcSessionSnapshot {
  readonly id: CcSessionId
  readonly status: CcSessionStatus
  readonly model?: string                 // ABSENT until the SDK reports one
  readonly pendingAsks: number
  readonly contextUsage?: CcContextUsage
}

interface CcAccountInfo {
  readonly auth: CcAuthMode
  readonly email?: string
  readonly organization?: string
  readonly subscriptionType?: string
  readonly apiProvider?: string
}
```

Snapshots are **values, not handles** — safe to compare, serialize, and put in a
tool's canonical JSON return.

### 4.4 Errors

Phase 2 ADDED codes; none was removed or renamed, so a Phase 1 consumer's
`switch` still compiles and still matches what it matched before.

```ts
type CcErrorCode = 'NOT_IMPLEMENTED' | 'UNKNOWN_SESSION' | 'SESSION_LIMIT'
                 | 'SESSION_EXISTS'        // a plain resume of a session still open here
                 | 'INVALID_SESSION_ID' | 'INVALID_CONFIG'
                 | 'SESSION_CLOSED'        // sends/interrupts/waiters on a closed session
                 | 'INVALID_CWD'           // relative or missing cwd — raised BEFORE any spawn
                 | 'NO_LIVE_SESSION'       // accountInfo() with an empty registry
                 | 'TIMEOUT'               // waitForResult(timeoutMs) elapsed; session untouched
                 | 'BACKEND_ERROR'         // the SDK could not start/drive the session; see `cause`
                 | 'ASK_UNANSWERABLE'      // (Phase 4) an ask reached nobody and ask.fallback is 'error'
                 | 'ASK_UNAVAILABLE'       // (Phase 4) the session was built without an ask channel

class ClaudeCodeError extends HarnessError {              // HarnessError from @deepseek-ai/dsh-llm
  constructor(message: string, code: CcErrorCode, options?: ErrorOptions)
  readonly code: string                                   // route on this, never on the message
  readonly name: 'ClaudeCodeError'
}
```

### 4.4b The session actor (Phase 2)

`ctx.claudeCode.session(id)` returns the live actor. Snapshots remain the value
projection for anything crossing a tool boundary; this is a handle.

```ts
class CcSession {
  readonly id: CcSessionId
  get status(): CcSessionStatus        // 'starting' -> 'idle' <-> 'running' -> 'closed'
  get pendingAsks(): number            // asks awaiting an answer (Phase 4); 0 without an ask channel
  get lastAskError(): ClaudeCodeError | undefined   // Phase 4, ask.fallback: 'error' only
  get capabilities(): readonly string[]        // from the LATEST system/init — feature-detect on these
  get initializeResult(): CcInitializeResult | undefined   // commands, models, account, output_style
  get account(): CcAccountData | undefined
  get lastResult(): CcMessageEnvelope | undefined
  get closeReason(): CcCloseReason | undefined  // Phase 7 — undefined while live
  outbox(): readonly CcOutboxEntry[]
  snapshot(): CcSessionSnapshot

  open(): Promise<void>                        // the service calls this; consumers do not
  send(input: string | { content: string, uuid?: CcUuid }, options?: CcSendOptions): CcUuid
  waitForResult(timeoutMs?: number): Promise<CcMessageEnvelope>
  setModel(model?: string): Promise<void>        // Phase 6 — see below
  interrupt(options?: CcInterruptOptions): Promise<CcInterruptOutcome>
  onMessage(listener: CcMessageListener): () => void
  onSend(listener: CcSendListener): () => void   // Phase 3 — outgoing messages
  onClose(listener: (reason: CcCloseReason) => void): () => void   // Phase 7: carries WHY
  // Phase 4:
  attachAskTarget(target: CcAskTarget): () => void    // throws ASK_UNAVAILABLE with no ask channel
  attachAskCallSite(site: CcAskCallSite): () => void  // the service wires the mirror in
  onAskError(listener: (error: ClaudeCodeError) => void): () => void
  close(reason?: CcCloseReason): Promise<void>   // idempotent; defaults to 'closed'
}
```

**A dead subprocess closes its own session (Phase 7).** When the SDK's message
iterator completes — the subprocess exited, was killed, or its stream threw —
the pump routes into the SAME `close()` an explicit close uses, tagged with the
cause. There is exactly one close sequence; `reason` is the only thing that
differs, which is what keeps the two paths from drifting:

| `CcCloseReason` | when | what it means |
|---|---|---|
| `closed` | `claude_code_close`, `ClaudeCode.close()`, owner disposal, plugin teardown | somebody asked |
| `exited` | the iterator completed with NO turn in flight | the subprocess ended between turns; every turn it was given ran |
| `crashed` | the iterator completed with a turn in flight, or threw | the turn it was running will never produce a result |

`closeReason` is an ADDITIVE optional field on `CcSessionSnapshot`, present
exactly when `status` is `closed`. `status` still collapses all three, because
for anything asking "can I still send to this?" they are the same answer.

**The close is armed as a continuation on the settled pump promise, never issued
from inside the pump body.** `runClose()` awaits `#pump` (that await is what
guarantees no callback fires after `close()` resolves), so closing from within
the loop would wait on the promise it is running inside. This is not a
hypothetical: the in-pump version makes every case in
`tests/session-death.spec.ts` hang rather than fail, which is why those tests
are bounded.

`onSend` exists because outgoing messages **never come back over `onMessage`**:
the CLI does not echo the prompt it was given, so the send side is the only place
a mirror can learn about a user prompt. Its record is
`{ sessionId, uuid, mode, content, sentAt }`, fanned out synchronously inside
`send()` (before the status machine moves), with listener failures isolated
exactly like `onMessage`'s.

**Send modes** (`{ mode }`, default `'followup'`), each returning the stamped uuid:

| mode | SDK mechanism | semantics |
|---|---|---|
| `followup` | plain uuid-stamped message | queues; runs as its own next turn |
| `steer` | `priority: 'now'` | **aborts** the running turn and refolds both instructions into ONE fresh turn. The aborted turn emits an `error_during_execution` result that is an internal artifact — the envelope flags it, and the mirror must suppress it. Turn-1 tokens are re-paid |
| `inject` | `shouldQuery: false` | appended to the transcript, starts no turn; committed immediately |

**`setModel(model?)`** (Phase 6) is a thin `query.setModel()` passthrough, and the ONLY
model-switching path a CC-backed session has: dsh's own model selection rides
`installModelSelection()` + the `agent/request` waterfall, which is dispatched
only from `ReactLoopAgent` and therefore never fires for a session Claude Code
drives (D8), and `AgentOptions` has no `setModel()` either (D7). The snapshot is
updated optimistically to what was asked for; the next `system/init` (the CLI
emits one after every interrupted turn) overwrites it with what the CLI actually
adopted. Omitting the argument asks for the CLI default and leaves
`snapshot().model` ABSENT until the CLI reports one. Refuses a closed session
with `SESSION_CLOSED`.

**The fan-out envelope** — subscribe with `onMessage`; the payload is
`{ message, meta }`, never a bare message:

```ts
interface CcMessageEnvelope { readonly message: CcSdkMessage, readonly meta: CcMessageMeta }
interface CcMessageMeta {
  readonly sessionId: CcSessionId
  readonly receivedAt: number
  readonly interruptArtifact: boolean   // the abort result produced by a `steer` — suppress it
  readonly interruptedTurn: boolean     // the abort result of ANY turn we cancelled (steer or interrupt)
  readonly reinit: boolean              // a system/init that is NOT the first (normal after an interrupt)
}
```

`interruptArtifact ⊂ interruptedTurn`. Both a `steer` send and an explicit
`interrupt()` abort the running turn with an `error_during_execution` result
(spikes 2 and 3 observed the identical shape), so both are flagged
`interruptedTurn` — a mirror renders those as *cancelled*, never as a failed
turn. Only a steer's is additionally an *artifact*: suppressed from
`lastResult`/`waitForResult` because the refolded turn's real result is still
coming. An `interrupt()` may have nothing queued behind it, so its abort result
is the only signal the turn ended and is delivered normally.

**Resume vs. fork identity.** A plain resume continues under the **same id** it
resumed (SDK 0.3.233 rejects `sessionId` + `resume` without `forkSession` at
spawn time), so `open({ resume })` returns a snapshot whose `id` is `resume`, and
resuming a session that is still open here is refused with `SESSION_EXISTS`. A
fork always gets a fresh dsh-minted id (spike 1).

`CcSdkMessage` is deliberately open (`{ type, subtype?, uuid?, session_id?, [field]: unknown }`):
the SDK union has ~38 variants and grows. **Default-ignore unknown kinds; never
switch exhaustively.**

**Outbox and interrupts.** Every send is recorded as
`{ uuid, mode, sentAt, state: 'queued' | 'committed' | 'cancelled' }`.
`interrupt()` resolves the receipt and reconciles it: known uuids absent from
`still_queued` become `committed`, survivors stay `queued`, unknown uuids are
ignored (cron triggers and auto-resume continuations appear there). Results
commit the batch that ran — N queued messages coalesce into ONE turn with ONE
result, so a 1:1 uuid→result mapping never holds.

`interrupt({ keepQueued: false })` is **emulated**: SDK 0.3.233 exposes no way to
drive `interrupt_cancel_queued_v1`, so the seam re-interrupts as surviving turns
start, capped at `still_queued.length + 2` attempts, and marks those uuids
`cancelled`. Replace with the native path when the SDK exposes it.

**Pre-warming.** `WarmPool` holds at most one `startup()`-warmed subprocess. Its
options — including `sessionId` — were frozen at startup, so the pool **pre-mints
the dsh id** and the accepting `open()` adopts it (dsh still mints every id), and
it only serves an open whose `warmFingerprint(options)` matches. A mismatch
discards the held subprocess. Consequence: the first open of any given shape is
always cold, because `cwd` is unknown before it.

Two rules keep that fingerprint honest, both learned the hard way (§5a):

- **A warm handle is always a PLAIN session.** The fingerprint deliberately
  ignores `resume`/`forkSession` so a pre-minted id can be adopted, which means a
  handle warmed *with* either one baked in would be indistinguishable from a
  plain one — and could silently continue somebody else's transcript. So the
  service warms from a resume-free template no matter what kind of open seeded it.
- **`env` is fingerprinted by its auth decision only** — whether
  `ANTHROPIC_API_KEY` is present, plus a digest of its value so a rotated key is
  never served from a subprocess frozen with the old one. The rest of `env` is
  ambient noise outside this seam's control (the SDK itself writes
  `CLAUDE_AGENT_SDK_VERSION` into `process.env` on its first real call).

### 4.4c The mirror (Phase 3)

```ts
class CcMirror {
  constructor(session: Session, options?: CcMirrorOptions)   // dsh Session
  get hasOpenTurn(): boolean
  get openTurn(): number | undefined
  get openStep(): number | undefined
  get callIds(): ReadonlyMap<string, CallId>     // cc tool_use id -> dsh CallId
  callIdFor(toolUseId: string): CallId           // stable; mints on first ask
  toolUseIdFor(callId: CallId): string | undefined
  get stats(): CcMirrorStats                     // { appended, ignored, checksumMismatches }
  observe(envelope: CcMessageEnvelope): void     // one SDK message
  recordSend(send: CcSendRecord): void           // one outgoing message
  finalize(): void                               // close a turn the dead session will never finish
}

interface CcMirrorOptions {
  forwardSubagentText?: boolean            // default false
  compaction?: 'append' | 'skip'           // default 'append'
  provider?: string                        // default 'claude-code'
  logger?: CcLogger
}

function attachMirror(source: CcMirrorSource, session: Session, options?: CcMirrorOptions): CcMirrorHandle
const CC_COMPACT_EVENT: 'claude-code/compact'
function markEventIgnorable<T extends SessionEvent>(event: T): T
```

**Two attachment seams**, and the difference matters:

| seam | when |
|---|---|
| `open({ …, mirror: { session, forwardSubagentText?, compaction?, provider?, logger? } })` | **whenever a prompt is passed to `open()`** — the prompt is sent synchronously inside `open()`, so a mirror attached afterwards misses the turn it starts |
| `ctx.claudeCode.attachMirror(id, session, opts?)` | a session opened idle, or a second log attached later |

Both bind the mirror's lifetime to the session: when the Claude Code session
closes the service calls `mirror.finalize()` and then detaches. `finalize()` is
what keeps the log usable — a session that dies MID-TURN never emits the result
that would have closed the dsh turn, and a log with a dangling `turn/start` can
never be appended to again (dsh refuses a second open turn). It closes the turn
as `{ kind: 'aborted', reason: { kind: 'disposed' } }`, flushes any still-deferred
prompt, and appends nothing at all when no turn is open. `handle.dispose()` on
its own still appends nothing, by design.
`@deepseek-ai/dsh-session` stays **optional** for pure-SDK consumers — it is a
peer dependency used for types, and a composition that never passes a dsh session
never constructs one.

**The mirror is not a source of truth** (spec §5.1) and it is **write-only into
dsh**: its whole view of a Claude Code session is `CcMirrorSource`
(`onMessage` + `onSend`), so it cannot send, interrupt, close, or register a
cordis waterfall listener. `packages/claude-code/tests/mirror.spec.ts` asserts
that structurally.

**Projection**, in event terms:

| SDK signal | dsh events |
|---|---|
| send (`followup`, no turn open) | `turn/start`, then `user/message` (`source: { kind: 'plugin', plugin: 'dsh-claude-code' }`) |
| send (`followup`, turn already open) | **deferred** to the `turn/start` of the turn that runs it — CC queues it (spike 2), and recording it inside the running turn would put the prompt *before* the answer to the previous one in `deriveMessages()` |
| send (`steer`) | `turn/start` if none open, then `user/message` **in the open turn** — a steer refolds into it |
| send (`inject`) | `user/message` only, with `form: 'notice'` + bounded `summary`; **starts no turn** |
| `stream_event` `message_start` | closes the previous step (one dsh step = one model call) |
| `content_block_start/delta/stop` | `assistant/chunk` with dsh `StreamChunk` payloads: `block-start {blockType:'text'\|'reasoning'\|'tool-call'}`, `text-delta`, `reasoning-delta` (thinking), `tool-call-delta`, `block-end` |
| `message_delta` / `message_stop` | `assistant/chunk` `usage`, then the terminal `finish` |
| end of a model call | `assistant/message` assembled from the ACCUMULATED chunks (`sourceEventSeqs` = those chunk seqs), then one `tool/call` per tool-call block |
| `tool_result` block (user-role message) | `tool/result`, inside the step that requested it |
| `TodoWrite` call | `todo/write` when the shape maps trivially (`activeForm` is dropped); skipped otherwise |
| `SDKResultMessage` | `step/end` + `turn/end` (`completed`, `aborted`, `max-tokens`, or `error` with code `CLAUDE_CODE_<SUBTYPE>`) |
| `SDKCompactBoundaryMessage` | `claude-code/compact` (see below) |
| `system/init` (incl. re-inits) | nothing — the model is re-cached, **no framing events** |
| anything else (~38-variant union) | counted in `stats.ignored`, never thrown |

Deliberate omissions: **no `request/header`** is synthesized (the CC subprocess
never discloses the request config it used, and a wrong header poisons
`foldRequestHeader()` for every later reader), and **user-message TEXT arriving
over `onMessage` is ignored** (prompts come from the send side; mirroring an echo
would duplicate them). User-role messages contribute their `tool_result` blocks
only.

**Cancellation** (§5.4): `meta.interruptArtifact` results are **suppressed
entirely** — a steer refolds, so the turn is not over — and the partial model
call they aborted is **discarded**, because live traffic shows the refold starts
a brand-new `message_start` rather than continuing the aborted stream.
`meta.interruptedTurn` results close the turn as
`{ kind: 'aborted', reason: { kind: 'user' } }`, never as an error, and the model
call they killed still contributes what it had already streamed: text and
reasoning blocks left open are salvaged into the `assistant/message` (they are
already on the surface as chunks, so dropping them would contradict it), while a
`tool_use` block whose arguments were cut off is **not** — its JSON is truncated
and no such call was ever run. A call that produced nothing at all gets **no
`assistant/message`**: an empty-content assistant message is not a valid provider
message, and every reader of `deriveMessages()` would have to special-case it.

**Subagents**: by default only `tool_use`/`tool_result` from parented messages
are mirrored (the call ids Phase 4 needs). `forwardSubagentText: true` adds the
nested text. Known loss: `parent_tool_use_id` fits **only** on `tool/result`
(`data.meta.parentToolUseId`) — `assistant/chunk` carries dsh's closed
`StreamChunk` union and `tool/call` has no free field, so nested text and nested
calls appear inline in the parent's step.

**The `ignorable` gap (D9), stated exactly.** A custom event must (1) be
declaration-merged into `SessionEventMap` — done, against
`@deepseek-ai/dsh-session/types`; (2) carry a lossless-JSON payload — enforced by
`Session.append`; and (3) carry `ignorable: true` on the **envelope**, or a
persistence read path whose build does not know the type refuses the whole log
(`known-event-types.ts:8-18`). **Point 3 is impossible through rc.7's public
API**: `Session.append()` builds and deep-freezes the envelope itself and accepts
no marker. Consequences and mitigations, both shipped:

- a live-appended `claude-code/compact` is a *required* event, so a log holding
  one is refused by a stock harness build;
- `compaction: 'skip'` omits the event for logs that must stay portable;
- `markEventIgnorable(event)` stamps the marker at the seed/restore boundary —
  the one place envelopes are caller-supplied
  (`SessionStore.prepare(id, { seed, meta, seedSource: 'persistence' })`).

The real fix is upstream (`append(type, data, { ignorable: true })`).

**Framing approximation** (§5.2): one CC turn is one dsh turn; each model call
inside it is one dsh step. Step numbering continues across a resumed log — the
mirror folds the existing events at construction — and a turn CC starts on its
own (auto-resume, a scheduled trigger) is opened defensively so no step, chunk or
tool call is ever appended outside a turn. A step opens LAZILY, on the first
chunk, so a model call that is killed before it streams anything leaves no empty
step behind. A `tool_result` whose `tool/call` is no longer pending in the open
step (it arrived after the turn closed, or the mirror never saw the call) is
counted in `stats.ignored['tool-result:orphan']` and dropped — dsh's own
invariants reject it anywhere else.

### 4.4d The ask channel (Phase 4)

Claude Code asks for three different things through ONE callback. The router
sends each to the dsh seam that owns it:

| `toolName` | dsh seam | section |
|---|---|---|
| `AskUserQuestion` | `ctx.userQuestions.ask()` | §4.2 |
| `ExitPlanMode` | `ctx.userQuestions.ask()` with the `plan-review` intent | §4.3 |
| anything else | `ctx.approval.request()` | §4.1 |

```ts
class CcAskRouter {
  constructor(deps: CcAskRouterDeps)
  readonly canUseTool: CcCanUseTool          // hand this to the SDK; ALWAYS resolves
  get table(): CcAskTable
  get pendingAsks(): number
  get target(): CcAskTarget | undefined
  attachTarget(target: CcAskTarget): () => void
  attachCallSite(site: CcAskCallSite): () => void
  onError(listener: (error: ClaudeCodeError) => void): () => void
  settleAll(message?: string): number
}

interface CcAskRouterDeps {
  readonly services: CcAskServices           // lazy ctx.get('approval') / ctx.get('userQuestions')
  readonly config: ResolvedClaudeCodeConfig
  readonly rules: CcAskRules
  readonly table?: CcAskTable
  readonly logger?: CcLogger
  readonly callIdWaitMs?: number             // default 150
  readonly callIdPollMs?: number             // default 10
  readonly readPlanFile?: (path: string) => string | undefined
}

interface CcAskTarget {
  readonly agent: Agent                      // @deepseek-ai/dsh-agent
  readonly userQuestions?: CcUserQuestionsSeam   // override; else ctx.get('userQuestions')
  readonly approval?: CcApprovalSeam             // override; else ctx.get('approval')
  readonly delegated: boolean                // selects ask.delegatedTimeoutMs
}
```

**Attaching a target.** `open({ cwd, ask: { agent, delegated } })` attaches it
BEFORE the opening prompt is sent (that prompt is synchronous inside `open()`,
so a target attached afterwards can miss the first tool call).
`ctx.claudeCode.attachAskTarget(id, target)` is the after-the-fact seam.
Phase 5 passes the delegating `exec.agent`; Phase 6 passes the CC-backed agent
it registered.

**Two seams, two failure postures.** Absent `approval` is **fail-closed**: the
tool call is denied with an explanation, and no fallback policy can turn that
into a grant. Absent `userQuestions` is a **routing failure**: the configured
fallback answers it.

#### The approval path (§4.1)

| `ApprovalOutcome` | `PermissionResult` |
|---|---|
| `allowed-once` | `{ behavior: 'allow', updatedInput: input }` |
| `rejected` | `{ behavior: 'deny', message: 'User rejected this action' }` |
| `cancelled` | `{ behavior: 'deny', message: 'Request withdrawn' }` |
| `unavailable` | the fallback policy |

- **Allow ALWAYS carries `updatedInput`.** The allow-without-input path is
  version-gated; nothing here relies on it.
- `reason` is `opts.title` (the CLI's own pre-rendered sentence, delta S2) and
  falls back to `describeCall(toolName, input)` — one bounded line, never the
  whole input, because dsh's `ApprovalRequest` deliberately carries no arguments.
- `policy: 'never'` arrives as `rejected`. That is a DECISION, not a routing
  failure: the fallback never sees it.
- **The open-turn guard.** `ctx.approval.request()` throws synchronously when
  the agent's session has no open turn. The router catches it and denies with a
  message naming the idle state — a rejected `canUseTool` promise hangs the
  Claude Code session forever, with no park deadline.
- **`updatedPermissions` is never echoed** (spike 4: the SDK persists nothing
  from a headless callback). See the rule cache below.

#### `callId` correlation (§4.4)

`CcAskCallSite` is the mirror, narrowed to two questions:

```ts
interface CcAskCallSite {
  hasEmittedCall(toolUseId: string): boolean
  ensureToolCall(toolUseId: string, toolName: string, input: Record<string, unknown>): string
}
```

The service wires the mirror in whenever one is attached. The router then:
waits up to `callIdWaitMs` for the mirror to append the streamed `tool/call`;
if it never does, **synthesizes** it (loudly) so the prompt refers to a call the
UI has actually seen; and with **no mirror attached, sends no `callId` at all**
— dsh's answerer back-scan then matches only callId-less asks, which is correct
because there is no UI record to attach to.

That wait is the only point at which the approval path yields, so it is the only
point at which the ask can disappear underneath it. Two guards close that window
(Stage 3):

- **Withdrawn while correlating** — the wait ends the moment the ask's signal
  aborts, and nothing is synthesized or asked. A phantom `tool/call` would put a
  call Claude Code abandoned into the transcript, with an `approval/asked` pair
  attached to it.
- **Mirror detached while correlating** — if the call site was detached or
  replaced during the wait, the request carries no `callId` rather than
  appending to a dsh session nobody mirrors into any more.

#### The questions path (§4.2)

- `id` = the question TEXT, suffixed `' #2'`, `' #3'` on collision (§4.2.1); the
  original text is kept for the answer key.
- `header` passes through (capped at 64 chars); `options[].label`/`description`
  pass through; `options[].preview` is dropped; `multiSelect` passes through.
- Answers are read **positionally** (dsh's wire validator aligns
  `answers[i].id` with `questions[i].id`); an out-of-order id is still resolved
  by id, loudly, rather than misattributed.
- `answers` is keyed by question **text**. Single-select joins with `', '`;
  `custom` overrides `selected`. Multi-select yields an array, with `custom`
  appended as one more choice (dsh permits both together, and dropping the
  clicks would silently discard what the human chose).
- A **skipped** question (no selection, no custom) is OMITTED from `answers`.
- Success is `{ behavior: 'allow', updatedInput: { questions: input.questions, answers } }`
  — the S4-verified encoding, with the original `questions` passed back unchanged.

#### The plan path (§4.3)

Copied verbatim from `@deepseek-ai/dsh-plan-mode`'s own convention:

```ts
{ id: 'plan-review', header: 'Plan review', question: 'Approve this plan?',
  detail: <the plan markdown>,
  options: [{ label: 'Approve' }, { label: 'Keep planning' }],
  intent: { kind: 'plan-review', approve: 'Approve' } }
```

- **Plan probe order:** `input.plan` (the live-probed runtime field, delta S3,
  accepted only when it is a **string** — it is untyped in the SDK's `.d.ts`, and
  a human must never be asked to approve `"[object Object]"`), then
  `input.planFilePath` read off disk. If neither yields text, `detail` is
  OMITTED and `ask()` itself rejects `BAD_INTENT` — the honest outcome for a plan
  we cannot show the reviewer.
- **Approved iff** exactly one answer item has id `'plan-review'`,
  `selected === ['Approve']`, and `custom === undefined`. Then
  `{ behavior: 'allow', updatedInput: input }`.
- Declined denies with the user's `custom` text as the message (so Claude
  revises rather than guesses), else a generic keep-planning sentence.
- `ASK_CANCELLED` is DISMISSED, not declined: deny with "Plan review
  dismissed…", telling Claude to stay in plan mode and wait.
- **`ctx.planMode` is deliberately not touched** (delta D5): Claude Code owns its
  own plan state, and dsh's queued-flip semantics assume the dsh agent loop.

#### The pending-ask table (§4.6)

```ts
class CcAskTable {
  constructor(deps?: CcAskTableDeps)          // { logger?, retain? = 512, onSettle? }
  get pendingCount(): number
  pending(): readonly CcPendingAsk[]          // { requestId, toolName, startedAt }
  run(spec: CcAskRunSpec, work: (signal: AbortSignal) => Promise<CcPermissionDecision>): Promise<CcPermissionDecision>
  settleAll(message?: string): number
}
const ASK_WITHDRAWN_MESSAGE: 'Request withdrawn'
const ASK_SESSION_CLOSED_MESSAGE: string
```

Keyed by the SDK `requestId` (delta S2). Four things settle an ask — the dsh
answer, the SDK signal aborting (deny `'Request withdrawn'`, matching dsh's own
`'cancelled'` semantics), the configured timeout, and session close. Settlement
is once-only, so a late answer racing an abort is discarded exactly as dsh's
approval seam discards it on its side.

**Idempotency is a contract** (delta S12): `reinitialize()` and
`pending_permission_requests` redeliver in-flight requests. A redelivered
`requestId` returns the ORIGINAL settled decision, or attaches to the in-flight
promise — it never opens a second dsh prompt. Settled decisions are retained up
to `retain` and then evicted oldest-first. A redelivery also **arms its own
`signal`** on the entry it joins: after a `reinitialize()` the newest delivery is
the live transport, and only it can tell the ask it was withdrawn.

The router keys the table on `requestId`, and falls back to `toolUse:<id>` (then
to a per-router counter) if a delivery ever arrives without one — loudly. Two
distinct tool calls sharing one table key would hand the second one the first
one's answer, which is a permission grant nobody gave.

**Timeouts:** `ask.delegatedTimeoutMs` when `target.delegated`, else
`ask.timeoutMs` (**unset = no timer at all**, the interactive posture — not a
zero-length one). A configured wait past the 32-bit `setTimeout` ceiling
(2 147 483 647 ms) is clamped to it, because Node otherwise clamps it *down to
1ms* and denies the prompt instantly. A throwing timeout policy is contained
into a deny: an exception raised inside a timer callback cannot be caught by the
caller and would leave the ask pending forever.
`CcSession.close()` calls `settleAll()` FIRST (§5.4), before the query goes away.

#### The fallback policy (§4.5)

Applies to the FULL `UserQuestionError` taxonomy (delta D3:
`DELEGATED_CALLER`, `CALLER_NOT_LIVE`, `NO_PROVIDER`, `ASK_ABORTED`,
`ASK_CANCELLED`, `ASK_MISSING_AGENT`, `BAD_INTENT`, `EMPTY_QUESTIONS` —
exported as `CC_ASK_ERROR_CODES`), to approval `'unavailable'`, and to timeouts.
It never applies to a decision (`rejected`, `cancelled`).

| `ask.fallback` | behaviour |
|---|---|
| `deny` (default) | deny with an explanation telling Claude to proceed on its best assumption and state it |
| `first-option` | auto-answer each CLARIFYING question with `options[0]`, logged LOUDLY. **Permission prompts and plan reviews are denied instead** — their "first option" is a grant, and an unattended run must not award itself one |
| `error` | deny with `interrupt: true` (delta S13) AND surface a typed `ClaudeCodeError` with code `ASK_UNANSWERABLE` on the session (`onAskError`, `lastAskError`) |

#### The always-allow rule cache (spike 4)

```ts
class CcAskRules {
  static forSession(config: ResolvedClaudeCodeConfig, cwd: string, logger?: CcLogger): CcAskRules
  get path(): string
  get enabled(): boolean
  list(): readonly CcAskRule[]
  allows(toolName: string, suggestions: readonly CcPermissionSuggestion[] | undefined): boolean
  add(rule: CcAskRule): boolean
  reload(): void
}
function resolveRuleCachePath(config: ResolvedClaudeCodeConfig, cwd: string): string
const CC_RULE_FILE_VERSION: 1
const CC_RULE_CACHE_DIR: '.dsh-claude-code'
const CC_RULE_CACHE_FILE: 'always-allow.json'
```

On-disk format (`<cwd>/.dsh-claude-code/always-allow.json` by default;
`ask.ruleCachePath` may be absolute, or relative to the session `cwd`):

```json
{ "version": 1, "rules": [ { "toolName": "Bash", "ruleContent": "npm test:*" } ] }
```

Consulted BEFORE any prompt, and deliberately conservative: it matches only when
every rule of every `type: 'addRules'` + `behavior: 'allow'` +
`destination: 'localSettings'` suggestion attached to THIS prompt is already
stored, and names the tool being decided. A prompt forced by the user's own
`permissions.ask` rule (`matchedAskRule`) is never short-circuited. A missing,
unreadable, malformed or wrong-version file is an EMPTY cache plus a log line —
the fail-closed direction of a permission cache is "prompt the human".
`ask.persistAlwaysAllow: false` disables reads as well as writes.

**Known limitation (write path).** dsh's approval vocabulary has no `'always'`
outcome (delta D2: `allowed-once | rejected | cancelled | unavailable`), so no UI
answer can currently ADD a rule. Entries come from `ask.rules` in configuration
or programmatically via `CcAskRules.add()`. When dsh grows the outcome, the
UI-driven path is one `add()` call away — nothing else here changes.

**Audit caveat (§8.3).** Two paths reach a tool without a dsh prompt: a rule
cache hit (logged), and the CLI's own safe-command classifier, which
auto-approves things like `echo` BELOW `canUseTool` entirely. The dsh approval
log is a record of what dsh was ASKED, never a complete record of what Claude
Code ran.

### 4.4e The model-facing tools (Phase 5, `@deepseek-ai/dsh-tool-claude-code`)

Six tools, all bodies live as of Phase 5. `inject: ['tools', 'claudeCode']`;
`ctx.sessions`, `ctx.agents` and `ctx.jobs` are read opportunistically with
`ctx.get(...)` so the plugin still mounts in a composition that has none.

| Tool | Args | Canonical return |
|---|---|---|
| `claude_code_open` | `cwd`, `prompt?`, `model?`, `permission_mode?`, `resume?`, `fork?`, `background?` | `{ kind: 'session', session_id, status, result?, usage?, cost_usd? }` **or** `{ kind: 'background', jobId, ccSessionId }` |
| `claude_code_send` | `session_id`, `message`, `mode: 'followup'\|'steer'` | `{ status }` |
| `claude_code_wait` | `session_id`, `timeout_ms?` | `{ status, result?, usage?, cost_usd? }` |
| `claude_code_status` | `session_id` | `{ status, pending_asks, context_usage? }` |
| `claude_code_cancel` | `session_id`, `keep_queued?` | `{ still_queued: string[] }` |
| `claude_code_close` | `session_id` | `{ closed: true }` |

**Schema change (additive only).** `claude_code_open`'s `session` branch gained
three OPTIONAL fields — `result`, `usage` (`{ input_tokens, output_tokens }`),
`cost_usd` — because synchronous mode now returns the turn it waited for.
Nothing was removed or retyped; `output.render` appends the answer under the
session line.

**The open sequence** (`src/open.ts`), which is the whole reason the tool does
not pass `prompt` straight to the seam:

1. `ctx.claudeCode.open({ …, ask })` **without** `prompt`. The seam mints the id
   and attaches the ask target before the handshake.
2. `ctx.sessions.create(<that id>, { meta: { cwd } })` (or `get()` for a plain
   resume, which keeps the resumed id) → `ctx.claudeCode.attachMirror(id, log)`.
   The dsh session and the CC session share ONE id (D1); no store → the session
   runs unmirrored, which is supported and silent.
3. `session.send(prompt, { mode: 'followup' })`. `send()` is synchronous and
   frames `turn/start` + `user/message` through the mirror, so a prompt sent in
   step 1 would be invisible in the dsh log.

If the mirror cannot be attached, the session is closed before the error
propagates — a live subprocess must never be stranded by a composition bug.

**Ask target (§4.5).** `exec.agent` present → `{ agent, delegated }`, where
`delegated` is `exec.agent` NOT being in `ctx.agents.roots()`, compared by `id`
(never by object identity — cordis hands out fresh proxies). `exec.agent`
absent (a headless tool call) → **no target at all**, and the seam's fail-closed
default denies every ask with an explanation.

**Lifecycle.** A session OUTLIVES the tool call that opened it, in every mode.
`claude_code_open` returns after the opening turn; the session stays open for
`claude_code_send` follow-ups until one of: `claude_code_close`, the seam's
teardown effect (plugin unload/HMR), or — for a background session —
`job_kill` / owner disposal. Neither `exec.signal` nor a `CC_TIMEOUT` closes
anything.

**Timeouts.** `claude_code_open` (sync, with a prompt) waits up to
`SYNC_OPEN_TIMEOUT_MS` (10 min); `claude_code_wait` clamps `timeout_ms` to
`MAX_WAIT_TIMEOUT_MS` (10 min) and uses it when `timeout_ms` is absent. Expiry
is `CC_TIMEOUT` carrying `data.session_id` — the session is untouched and still
running.

**Background mode** (`src/background.ts`) follows `@deepseek-ai/dsh-tool-bash`
exactly, per D10:

- `ctx.get('jobs')` absent → `CC_NO_JOBS` naming `@deepseek-ai/dsh-jobs` and
  `@deepseek-ai/dsh-tool-jobs`; nothing is opened.
- `exec.signal.aborted` re-checked immediately before `ctx.jobs.start()` →
  `CC_ABORTED` with `name: 'AbortError'`. That check is the LAST instant the
  caller owns cancellation: `exec.signal` is never wired into the session, so
  aborting the tool call after `start()` published the id leaves the session
  running and the job unsettled (delta D10).
- `ctx.jobs.start()` throwing → `CC_JOB_REJECTED`, quoting the registry's own
  refusal (normally the default cap of 10 concurrent jobs per owner). The
  registry raises every refusal before it calls `spec.run()`, so nothing was
  opened; the path defends against a provider that violates that anyway by
  cancelling the producer and marking `opened` handled.
- `JobKindMap` declaration-merged with `'claude-code'`; spec is
  `{ kind, label: <prompt-derived one-liner>, ...(exec.agent ? { owner: exec.agent } : {}), run }`.
- **The job IS the session**, not just its first turn: `run()` starts the open
  asynchronously and returns hooks synchronously; `cancel` is a sync, idempotent
  close request; `done` settles on session close (`killed` after a cancel,
  `completed` otherwise, `failed` when the open itself failed) and **never
  rejects**; `readOutput` is a **consuming delta** of each completed turn's
  final text (not final-output-only: a background session accepts follow-ups, so
  final-output-only would hide every turn after the first).
- The tool awaits the minted session id before returning
  `{ kind: 'background', jobId, ccSessionId }`, so a caller never parses prose
  for an id. A background open whose `open()` fails reports that failure to the
  caller AND leaves a job that settled `failed` — visible in `job_list`.

**Errors.** The tool layer adds `ClaudeCodeToolError` (`HarnessError`, name
`ClaudeCodeToolError`) with codes `CC_NO_SESSION`, `CC_TIMEOUT`, `CC_NO_JOBS`,
`CC_ABORTED`, `CC_JOB_REJECTED`. Everything the SEAM refuses (`INVALID_CWD`, `SESSION_LIMIT`,
`SESSION_EXISTS`, `BACKEND_ERROR`, `SESSION_CLOSED`, …) is re-thrown untouched:
its `code` is what a caller routes on, and re-wrapping would bury it.

**`context_usage`** is derived from the latest result's `usage`
(`input_tokens + cache_read + cache_creation + output_tokens`) with `max_tokens`
from `modelUsage[*].contextWindow` — the cheapest REAL source, documented as an
approximation (a snapshot of the last completed turn, not a live meter). It is
ABSENT until a turn has reported usage; `CcSessionSnapshot.contextUsage` wins
whenever a future phase starts populating it.

### 4.4f The Agent adapter (Phase 6, `@deepseek-ai/dsh-claude-code-agent`)

`inject: ['agents', 'claudeCode', 'sessions']` — `sessions` is new and NOT
optional: an `Agent` needs a real, STORE-ATTACHED dsh `Session`, or the mirror's
appends are published to nobody.

**Fourteen** runtime exports (pinned by
`packages/claude-code-agent/tests/exports.spec.ts`):

```ts
class ClaudeCodeAgent implements Agent {            // @deepseek-ai/dsh-agent's Agent, verbatim
  constructor(deps: ClaudeCodeAgentDeps)            // { ctx, session, cc, provider?, logger?, disposeDrainMs? }
  readonly scope: Scope                             // dsh-scope; yield rawDispose into a composite teardown
  setModel(model?: string): Promise<void>           // package-level, NOT on Agent (D7)
  drain(): Promise<void>                            // disposed-cause cancel + bounded quiescence wait
}
function createClaudeCodeAgent(ctx, options: CcAgentOptions, deps?: CcAgentSpawnDeps): Promise<CcAgentHandle>
function extractMessageText(message: UserMessage): CcAgentMessageText   // { text, dropped }
const DEFAULT_DISPOSE_DRAIN_MS: 5000
const CC_AGENT_PROVIDER: 'claude-code'
const INERT_DSH_MECHANISMS: readonly ['agent/pre-step','agent/request','agent/request-error','tools/pre-execute']

class ClaudeCodeAgentService extends Service {      // ctx.claudeCodeAgents
  static readonly Config: z<CcAgentConfig>
  readonly config: ResolvedCcAgentConfig
  spawn(options?: Partial<CcAgentOptions>, deps?: CcAgentSpawnDeps): Promise<CcAgentHandle>
  get(id: CcSessionId): ClaudeCodeAgent | undefined
  list(): readonly ClaudeCodeAgent[]
}
function resolveCcAgentConfig(config?: CcAgentConfig): ResolvedCcAgentConfig
const name: 'claude-code-agent'; const inject: string[]; const Config: z<CcAgentConfig>
function apply(ctx: Context, config?: CcAgentConfig): void
const MOUNT_MARKER: string; const UNMOUNT_MARKER: string
```

```ts
interface CcAgentOptions extends Omit<CcOpenOptions, 'mirror' | 'ask'> { provider?: string }
interface CcAgentHandle { readonly agent: ClaudeCodeAgent; dispose(): Promise<void> }
interface CcAgentConfig { provider?: string; defaults?: { cwd?, model?, permissionMode? } }
```

`mirror` and `ask` are deliberately absent from `CcAgentOptions`: the adapter
owns both. The mirror target is the agent's own dsh session (it cannot exist
before `open()` mints the id), and the ask target is the agent itself.

**Signature change from Phase 1.** The scaffold's
`createClaudeCodeAgent(ctx, options): Promise<Agent>` returns
`Promise<CcAgentHandle>` now. The disposer is a capability that has to come back
with the agent — `ctx.agents.get(id)` deliberately returns a bare `Agent`, so a
caller that only got the agent could never tear exactly it down. Same shape as
`dsh-agent`'s own `AgentHandle`.

**The Agent mapping**, in one table (`Agent` member → what it actually is):

| member | implementation |
|---|---|
| `id` | the shared bare-UUID `SessionId`; the constructor THROWS if it differs from `session.id` (D6) |
| `session` | the dsh `Session` the seam's mirror writes into |
| `status` | seam status projected onto dsh's two: `running` while a turn is in flight, `idle` for `starting`/`idle`/`closed`. Disposal is not a third status |
| `options` | `{ provider, model }`, a LIVE projection of `CcSession.snapshot()` — not the frozen startup snapshot Phase 1 promised. Object identity changes only when the model does |
| `send(m, target, wakeup)` | `next-turn`+wake → `followup`; `next-step`+wake → `steer`; `wakeup:false` → `inject` (either target) |
| `cancel(cause, opts)` | `interrupt({ keepQueued: opts?.keepInbox ?? true })` — **the default differs from `ReactLoopAgent`'s**, see below |
| `whenIdle()` | no running turn AND no maintenance task AND nothing `queued` in the outbox; a CLOSED session is quiescent by definition |
| `runMaintenance(task)` | claims the true-idle phase; a second claim, or a claim while a turn runs, throws SYNCHRONOUSLY. Public status stays `idle`; waking input parks in the inbox until the task settles |
| `inbox` | dsh's own `Inbox` over the agent's session, reconciled from the outbox (below) |
| `ctx` | `createScope(ctx, agent).ctx.extend({ agent })` — agent-local, scope-filtered, unwound on disposal |

**The inbox is a projection of the outbox.** `queued` → still pending;
`committed` → **claimed** (`Inbox.claim()`, whose durable event is a pure
deletion — a splice would record the message as *canceled*, the opposite of what
happened); `cancelled` → **discarded** (a canceled splice, which is what it was).
An `inject` commits at send time, so it is claimed immediately. A message the
seam refused (a closed session) is removed rather than left pending, which would
hang `whenIdle()`.

**`keepInbox` defaults to `true` here, deliberately.** dsh's loop owns its inbox
and clears it by default; this adapter does not own the queue, and
`keepQueued: false` is EMULATED and lossy (§4.4b). Opt in explicitly, exactly as
`claude_code_cancel` does. The inbox is never cleared optimistically: a message
the drain could not stop is still going to run.

**Non-text content.** `send()` reduces a `UserMessage` to its `text` blocks (the
seam's channel is `{ content: string }`). Anything else is recorded IN THE
TRANSCRIPT as a `notice`-form `user/message` (bounded `summary`, per
`ContextFormed`) and logged. A message with no text at all is not delivered and
never enters the inbox.

**Spawn sequence** (`src/spawn.ts`), and why it is this sequence:

1. `ctx.claudeCode.open()` **without** `prompt` — the seam mints the id, and the
   dsh session that must carry it cannot exist first. Same reason
   `claude_code_open` does it (§4.4e).
2. `ctx.sessions.prepare(id, { meta: { cwd } })` — `prepare`+`enter`+`announce`,
   not `create()`, so the store attachment joins the ONE composite effect.
3. Construct the agent (this mints its scope).
4. One composite `ctx.effect`, yielding: session `enter` → `attachMirror` +
   `attachAskTarget({ agent, delegated: false })` → `ctx.agents.register(agent)`
   → `agent.scope.rawDispose` → the seam-close disposer.
5. `agent/session-start` (`startup`, or `resume` when opened with `resume`).
6. The opening prompt, through `agent.followup()`.

`delegated: false` is a fact rather than a policy: `register()` records no owner,
so the agent is a registry ROOT and `ctx.userQuestions.ask()` will answer it.

**Teardown ordering** (cordis disposes composite effects in REVERSE yield order):

| # | step | why here |
|---|---|---|
| 1 | `cancel({ kind: 'disposed' })` + a **bounded** quiescence wait (`DEFAULT_DISPOSE_DRAIN_MS`, 5s) | disposal IS a disposed-cause cancel followed by quiescence (`dsh-agent-loop`'s shape). Bounded: a subprocess that already died never emits the result that would settle it, and plugin unload must not hang on one |
| 2 | `ctx.claudeCode.close(id)` | settles pending asks, FINALIZES the mirror (a dangling `turn/start` makes the log permanently unappendable), closes the subprocess |
| 3 | agent scope unwind | agent-local contributions go after the driver is quiet |
| 4 | registry detach → `agent/disposed` | exactly `agent/disposed`'s documented position: "after driver quiescence and scoped-registration unwind, but before session detachment" |
| 5 | session store detach | LAST: the store attachment installs the publication hooks, so detaching earlier would publish none of step 2's closing events |

`packages/claude-code-agent/tests/spawn.spec.ts` asserts step 4's position
directly: inside an `agent/disposed` listener the session is still in the store,
the Claude Code session is already gone, and the mirror's
`turn/end {aborted, disposed}` is already in the log.

**Disposer identity.** `ctx.agents.register()`'s exact return value is yielded
into the composite effect, never a wrapper (the D6 rule, and `register()`'s own
documentation). `tests/orderings.spec.ts` asserts the IDENTITY, not just the
resulting order: `register()` returns a cordis effect wrapper carrying
`symbols.effect`, and cordis re-parents a yielded one into the composite effect
as a labeled CHILD — so the composite's children must contain
`agents.register()`. A wrapper preserves the order (the ordering test still
passes) while dropping the symbol, which is why the identity needs its own
assertion.

**`cancel()`'s cause does not reach Claude Code.** `CcSession.interrupt()` takes
no cause parameter — the SDK's `interrupt()` takes no arguments at all — so
`AgentCancelCause` is only an active maintenance task's abort reason. Every
agent-driven interrupt the subprocess actually answers is mirrored as
`turn/end { aborted, reason: { kind: 'user' } }` whatever the real cause was;
`{ kind: 'disposed' }` appears only on `CcMirror.finalize()`'s fallback, when the
turn was still dangling at close time. The live dispose/HMR specs accept either,
because that is the actual cross-environment guarantee.

### 4.5 Configuration

```ts
function resolveClaudeCodeConfig(config?: ClaudeCodeConfig): ResolvedClaudeCodeConfig
const DEFAULT_API_KEY_REF: 'ANTHROPIC_API_KEY'
const DEFAULT_DELEGATED_ASK_TIMEOUT_MS: 120000
const DEFAULT_MAX_CONCURRENT_SESSIONS: 4
```

Surface type (what a `cordis.yml` row supplies — every field optional, and an
explicit YAML `null` is treated exactly like an omitted key):

```ts
interface ClaudeCodeConfig {
  readonly executablePath?: string
  readonly prewarm?: boolean
  readonly auth?: CcAuthMode
  readonly apiKeyRef?: string
  readonly defaults?: CcDefaultsConfig
  readonly ask?: CcAskConfig
  readonly limits?: CcLimitsConfig
  readonly env?: Readonly<Record<string, string>>
}
interface CcDefaultsConfig {
  readonly model?: string
  readonly permissionMode?: CcPermissionMode
  readonly settingSources?: CcSettingSource[]        // mutable array: schemastery's surface type
  readonly appendSystemPrompt?: string
}
interface CcAskConfig {
  readonly timeoutMs?: number
  readonly delegatedTimeoutMs?: number
  readonly fallback?: AskFallback
  readonly persistAlwaysAllow?: boolean
  readonly ruleCachePath?: string
  readonly rules?: CcAskRuleConfig[]                 // preseeded always-allow rules (Phase 4)
}
interface CcAskRuleConfig {
  readonly toolName: string                          // 'Bash', 'Read', …
  readonly ruleContent?: string                      // 'npm test:*'; absent = the whole tool
}
interface CcLimitsConfig {
  readonly maxConcurrentSessions?: number
  readonly maxBudgetUsd?: number
}
```

Resolved type (what `ctx.claudeCode.config` is — defaulted fields required,
genuinely-unset fields ABSENT, never `null` and never `undefined`-valued):

```ts
interface ResolvedClaudeCodeConfig {
  readonly executablePath?: string
  readonly prewarm: boolean                      // true
  readonly auth: CcAuthMode                      // 'subscription'
  readonly apiKeyRef: string                     // 'ANTHROPIC_API_KEY'
  readonly defaults: {
    readonly model?: string
    readonly permissionMode: CcPermissionMode    // 'default'
    readonly settingSources: readonly CcSettingSource[]   // []
    readonly appendSystemPrompt?: string
  }
  readonly ask: {
    readonly timeoutMs?: number
    readonly delegatedTimeoutMs: number          // 120000
    readonly fallback: AskFallback               // 'deny'
    readonly persistAlwaysAllow: boolean         // true
    readonly ruleCachePath?: string
    readonly rules: readonly CcAskRuleConfig[]   // []
  }
  readonly limits: {
    readonly maxConcurrentSessions: number       // 4
    readonly maxBudgetUsd?: number
  }
  readonly env: Readonly<Record<string, string>> // {}
}
```

Reuse this schema rather than redeclaring options: a consumer that needs its own
config (e.g. a tool's `enableBackground` switch) declares only its own keys and
reads session policy from `ctx.claudeCode.config`.

## 5. Facts from the review that consumers must honor

- **`ctx.claudeCode.config.ask.persistAlwaysAllow` is an integration-owned rule
  cache, not SDK persistence.** A headless `canUseTool` never writes
  `settings.local.json`. Never surface it to the model as "saved to your Claude
  Code settings". Phase 4 implements it as `CcAskRules` over
  `<cwd>/.dsh-claude-code/always-allow.json` (§4.4d), consulted before every
  prompt and written only by `add()` / `ask.rules` — dsh has no `'always'`
  outcome yet.
- **A dsh approval log is not a complete record of what Claude Code ran.** The
  CLI's safe-command classifier auto-approves trivial commands below
  `canUseTool`, and a rule-cache hit skips the prompt by design. Say "approved
  through dsh", never "every tool call was approved".
- **`canUseTool` must never reject and never return `null`.** Both leave the CLI
  waiting forever — there is no park deadline. Everything Phase 4 does is
  arranged around that one fact.
- **`settingSources` omitted at the SDK boundary loads ALL sources.** The
  resolved config therefore always carries an explicit list (`[]` by default).
- **dsh mints every session id** (bare UUID), including fork ids. The spec's
  §8.2 ("CC's id wins") is reversed; never map ids.
- **The dsh session log for a CC-backed session is a mirror, not a source of
  truth.** Do not build anything on `deriveMessages()` for these sessions.
- **`ctx.jobs.start()` throws unless a jobs controller is attached** — a
  composition using background mode must also load
  `@deepseek-ai/dsh-tool-jobs` / a jobs provider. Document it; degrade with a
  clear error rather than crashing at mount.
- **`owner` is optional and `exec.agent` may be `undefined`** — conditionally
  spread it (`...(exec.agent ? { owner: exec.agent } : {})`) or
  `exactOptionalPropertyTypes` fails the build.
- **`agent/pre-step`, `agent/request`, `agent/request-error` and `tools/*` are
  inert for a CC-backed agent.** The agent adapter's README documents the
  substitutes, and `packages/claude-code-agent/tests/inert.spec.ts` asserts the
  adapter registers no listener for any of them — measured as a delta across
  mounting and spawning, so the documentation cannot quietly become a lie.
- **`register()`'s returned disposer identity is load-bearing** — yield the
  exact function into the composite effect, never a wrapper.

## 5a. Corrections Phase 2 made to this document

1. **`open()` / `accountInfo()` no longer answer `NOT_IMPLEMENTED`.** §4.1's
   Phase 1 table is superseded by the Phase 2 table above. The `NOT_IMPLEMENTED`
   code still exists (the consumer packages still use it), so nothing breaks.
2. **Unit specs were NOT running on the source plane.** §3 claimed
   `resolve.tsconfigPaths: true` maps `@deepseek-ai/dsh-claude-code` to `src/`
   for `packages/*/tests/**`. It did not: Vite applies a tsconfig's `paths` only
   to files that tsconfig *includes*, and each package's `tsconfig.json` includes
   `src` only — so every spec silently resolved the seam to its **built
   `lib/index.js`**, and a spec could pass against a stale build. Proven by
   editing `src/` and watching the old behavior persist until `pnpm run build`.
   **Fix: each package now ships `tests/tsconfig.json`** (extends
   `tsconfig.base.json`, `include: ["."]`, `noEmit`), which is what the resolver
   needs. No root config, `vitest.config.ts` or root `package.json` was touched.
   Verified both ways: with the file, a `src/` edit takes effect immediately;
   without it, the stale `lib/` behavior returns.
3. **`tests/composition/composition.spec.ts` may no longer call `open()` with a
   usable `cwd`** — it would spawn a real subprocess. It now asserts the
   spawn-free guards (`INVALID_CWD`, `NO_LIVE_SESSION`) and adds a check that no
   `lib/types/**.d.ts` in any package references the Claude Agent SDK outside a
   comment.

### Defects the live suite (Stage 2) and its review (Stage 3) found

Each of these was a *wrong implementation*, not a wrong test. Every one now has
an offline regression test, so none of them can come back silently.

4. **A plain resume was rejected by the SDK at spawn.** `resolveQueryOptions()`
   sent `sessionId` alongside `resume`; SDK 0.3.233 refuses that combination
   outright (`--session-id can only be used with --continue or --resume if
   --fork-session is also specified` — the subprocess exits 1 before
   `system/init`). This is delta S11, which the code's own comment already
   stated and nothing enforced. **Fix:** a plain resume sends `resume` alone and
   the session is tracked under the id it resumed; only a fresh session or a
   fork sends `sessionId`.
5. **The warm fingerprint was invalidated by the SDK's own side effect.** It
   hashed the whole `env` spread, and the Claude Agent SDK writes
   `CLAUDE_AGENT_SDK_VERSION` into `process.env` on its first real
   `query()`/`startup()` call — so the template fingerprinted *before* that call
   never matched one resolved after it, and prewarm was dead from the second
   open onward in any real composition. **Fix:** fingerprint the auth decision
   (presence + a digest of the key value), which is what the field's own
   documentation always claimed it was for.
6. **A warm subprocess could be seeded with `resume`/`forkSession` baked in.**
   `open()` pre-warmed from the template of the open that had just happened, and
   the fingerprint ignores those two keys by design — so a handle warmed right
   after a forked open was indistinguishable from a plain one, and a later
   unrelated `open()` could have adopted a lease that was silently continuing
   another session's transcript. (A plain resume was merely wasteful: that
   `startup()` could only ever fail, per correction 4.) **Fix:** the pool
   template is always resume-free.
7. **A plain resume of a LIVE session overwrote its registry entry.** Since a
   plain resume continues under the same id, `sessions.set(id, …)` replaced the
   record of a session that was still running — dropping it from `list()` and
   from teardown, i.e. leaking its subprocess past disposal, with two queries on
   one transcript. **Fix:** `open()` refuses it with the new `SESSION_EXISTS`
   code; forking that session is still allowed and still mints a fresh id.

### Phase 4 additions and corrections

12. **`CcSession.pendingAsks` is real now** (§4.4b said "0 until Phase 4"), and
    `CcSessionSnapshot.pendingAsks` follows it. `close()` drains the table before
    tearing down the query, so a pending ask always resolves — as a deny.
13. **`CcSessionDeps` gained `asks`**, and `canUseTool` precedence is now
    *explicit dep → ask channel → fail-closed deny*. A session built with
    neither still denies every tool call with an explanation (the message no
    longer mentions Phase 4).
14. **`CcMirror` gained `hasEmittedCall()` and `ensureToolCall()`.** `callIds` /
    `callIdFor()` mint on demand and therefore cannot answer "has the UI seen
    this call?", which is the question §4.4 actually asks. `#emitted` tracks
    appended `tool/call`s for the session's whole life (unlike the per-step
    pending table).
15. **`CcPermissionRequest` gained `suggestions` and `matchedAskRule`**, and
    `backend.ts` gained `CcPermissionSuggestion` / `CcPermissionRuleValue`. They
    are read-only inputs: `updatedPermissions` is never sent back.
16. **New dependencies** (peer + dev, exact `0.1.0-rc.7`):
    `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-user-approval`,
    `@deepseek-ai/dsh-user-questions`. The seam still mounts with `inject: []`
    and reads both interaction seams opportunistically through `ctx.get(...)`,
    resolved LAZILY on every ask (a captured cordis proxy outlives its fiber).

### Defects the Phase 4 orderings probe (Stage 3) found

Six, all in the ask channel, all with an offline regression test in
`packages/claude-code/tests/ask-orderings.spec.ts` (plus two in the questions and
rules specs). The first two are the serious ones: they break the invariant the
whole channel exists to hold.

17. **A throwing timeout policy escaped as an uncaught exception AND hung the
    ask.** `CcAskTable` called `spec.onTimeout()` directly inside the
    `setTimeout` callback. An exception there cannot be caught by the caller —
    it reaches `process.on('uncaughtException')` — and the ask it was supposed
    to settle stayed pending forever, which is the one failure Claude Code
    cannot survive. **Fix:** the timer callback contains the policy and settles
    with a deny naming the failure.
18. **A redelivery ignored its own abort signal.** The table armed only the
    FIRST delivery's `signal`. After a `reinitialize()` the redelivered request
    carries a fresh signal on the live transport, so a genuine withdrawal was
    never observed and the ask waited for a timeout that an interactive session
    does not have. **Fix:** `run()` arms every delivery's signal on the entry it
    joins (deduplicated by signal identity, torn down together).
19. **A withdrawn or timed-out ask still synthesized a `tool/call` and asked
    dsh.** The §4.4 correlation wait was the only yield point on the approval
    path and it watched neither the ask's signal nor the call site, so an ask
    that went away mid-wait still appended a `tool/call` for a call Claude Code
    had abandoned, then an `approval/asked` + `approval/decided` pair for a
    decision nobody would read. **Fix:** the wait ends on abort; abort or a
    detached/replaced mirror suppresses the synthesis and the request.
20. **An id-less delivery would have folded every ask onto one table entry.**
    `requestId` is typed as required and delta S2 confirms the CLI sends it, but
    a missing or empty one keyed every ask identically — the second tool call
    would have been answered with the first one's decision, i.e. a grant nobody
    gave. **Fix:** `askKey()` falls back to `toolUse:<id>` then to a per-router
    counter, loudly, trading redelivery idempotency for correctness.
21. **A configured wait past 2 147 483 647 ms denied instantly.** `setTimeout`
    clamps an out-of-range delay DOWN to 1ms (with `TimeoutOverflowWarning`), so
    an over-large `ask.delegatedTimeoutMs` produced the opposite of what it
    asked for. **Fix:** clamp to the ceiling, and log it.
22. **Two smaller ones.** `readPlan()` accepted a non-string `input.plan` and
    would have shown a reviewer `"[object Object]"` as the plan (the field is
    untyped in the SDK's `.d.ts`) — it now requires a string and falls through
    to `planFilePath`. And `CcAskRules.add()` rewrote its own possibly-stale
    in-memory view, so a second session sharing the store could delete a grant
    the first had just written — it now re-reads and merges before writing.

### Phase 5 additions and deviations

23. **`claude_code_cancel`'s default flipped to `keep_queued: true`.** Phase 1's
    description said the default suppressed queued sends. It now matches the
    seam (`interrupt({ keepQueued: keep_queued ?? true })`): the default cancels
    the RUNNING turn only, and `keep_queued: false` additionally drives the
    emulated drain. Rationale: suppression is the surprising, lossy option, and
    the emulation costs extra interrupts — neither belongs in a default. The
    tool description and the README were corrected with it.
24. **No `exec.agent.inject()` progress pushes.** §6 asked for CC progress to be
    injected into the delegating agent. That note is redundant now that a
    background session is a dsh job: `@deepseek-ai/dsh-tool-jobs` already
    delivers the completion notice to the owning agent (injected into a busy
    owner, waking an idle one, bounded per owner by `maxConsecutiveWakes`). A
    second notice path from this plugin would double every message and bypass
    those bounds. Synchronous mode needs no progress channel at all — it returns
    the answer. **Deliberate deviation; nothing else in §6 changed.**
25. **`claude_code_open` does not hand `prompt` to the seam.** See §4.4e: the
    prompt is sent AFTER the mirror is attached, because the id the dsh session
    must share does not exist until `open()` returns. `open({ prompt })` remains
    correct for a caller that drives the seam directly with a session it created
    itself.
26. **A background open registers its job BEFORE the session exists.** `run()`
    must return hooks synchronously, so the open runs inside it and the tool
    awaits the minted id. Consequence: an open that fails (e.g. `INVALID_CWD`)
    still leaves a `failed` job in `job_list`. The alternative — open first,
    then `start()` — would have to close a live session when `start()` throws
    (per-owner cap, no controller) and would put a spawn ahead of the
    pre-publication abort check.
27. **A dead subprocess does not settle a background job.** `CcSession` reaches
    `closed` only through `close()`, so a subprocess that dies on its own leaves
    the job `running` until something closes the session (`claude_code_close`,
    `job_kill`, owner disposal, plugin teardown). Tracked as deferred work in
    the tool package README.
    **Superseded by Phase 7 (correction 47):** the seam closes itself on pump
    completion, so the job now settles `failed` on a crash and `completed` on a
    clean exit, with no explicit close required.
28. **The tool package gained one dependency:** `@deepseek-ai/dsh-jobs@0.1.0-rc.7`
    as peer + dev (types and the `JobKindMap` merge only — no runtime import).
    `@deepseek-ai/dsh-jobs-local` and `@deepseek-ai/dsh-tool-jobs` were added as
    ROOT devDependencies for the composition test. No other pin moved.

### Defects the Phase 5 verify pass (Stage 3) found

29. **A refused `ctx.jobs.start()` reached the model with no routable code.**
    The registry refuses with a bare `Error` — good prose ("background job limit
    reached for this owner (limit: 10); use job_kill…"), no `code`, no `info` —
    which made the per-owner cap the ONLY failure on this tool's surface a
    caller could not route on, while every neighbouring failure carried one.
    Fixed by re-raising it as `CC_JOB_REJECTED` (a new tool-layer code) with the
    registry's wording preserved verbatim and the original kept as `cause`.
    Covered by `tests/background.spec.ts`.
30. **A registry that threw AFTER calling `run()` would have orphaned a live
    session.** `@deepseek-ai/dsh-jobs-local` raises every refusal before
    `spec.run()`, so this is a third-party contract violation rather than an
    observed bug — but the cost of trusting the contract is a subprocess no job
    tracks plus an unhandled rejection from the `opened` promise nobody awaits
    any more. The refusal path now cancels the producer (idempotent, a no-op
    when nothing started) and marks `opened` handled. Covered by a spec that
    scripts exactly that violation, and verified to FAIL without the fix.
31. **The jobs-ABSENT composition was untested end to end.** `tests/composition`
    booted only the jobs-mounted `cordis.yml`. A sibling `cordis-no-jobs.yml`
    now boots the same rows without `dsh-jobs-local`/`dsh-tool-jobs` and pins
    the supported shape: all six tools register, no `job_*` tool does,
    `ctx.jobs` is undefined, and `background: true` with a VALID `cwd` fails
    `CC_NO_JOBS` having spawned nothing (proving the jobs check precedes the
    open).

Orderings the Stage 3 probe pinned and found already correct (no fix needed,
`tests/orderings.spec.ts`): a `claude_code_close` during a parked synchronous
open fails that open with the seam's `SESSION_CLOSED` rather than hanging to the
10-minute cap; every session-taking tool answers `CC_NO_SESSION` after a close,
not just for an unknown id; a `claude_code_wait` whose timeout races the result
returns exactly one of the two outcomes and leaves the session usable (a second
wait resolves from cache); a cancel of an already-idle turn is a no-op, not an
error; and a mid-turn teardown settles the background job `completed` with no
unhandled rejection. Aborting the caller's tool call AFTER the job id is
published leaves the session running and the job unsettled — the D10 rule,
asserted directly.

### Phase 6 additions and deviations

32. **`CcSession.setModel(model?)` is new** (§4.4b) — a thin `query.setModel()`
    passthrough, added because the adapter needs SOMETHING to switch a model
    with and both dsh paths are closed to it (D7: no `setModel()` on
    `AgentOptions`; D8: the `agent/request` waterfall never fires). No other
    seam behavior changed, and the seam's export list is unchanged (it is a
    method, not an export).
33. **`createClaudeCodeAgent()` returns a handle, not a bare `Agent`.** Phase 1
    typed it `Promise<Agent>` and called those types final; they were not. The
    disposer is a capability that has to come back with the agent
    (`ctx.agents.get(id)` deliberately returns a bare `Agent`), so the signature
    is now `Promise<CcAgentHandle>` — the same shape as `dsh-agent`'s own
    `AgentHandle`. It also takes an optional third `deps` argument for test
    seams.
34. **The adapter plugin injects `sessions`.** Phase 1's list was
    `['agents', 'claudeCode']`. An `Agent` needs a real, store-attached dsh
    `Session`; without one the mirror's appends are published to nobody, so a
    missing store is a clean mount failure rather than a surprising later one.
35. **`Agent.options` is a live projection, not a startup snapshot.** Phase 1's
    README listed "the model snapshot goes stale" as a limitation. It does not:
    `options` reads `CcSession.snapshot().model` on access (rebuilding the frozen
    object only when the model actually changes), so it reflects both
    `setModel()` and whatever the CLI reports on its next `system/init`.
36. **`cancel()`'s `keepInbox` defaults to `true`, where `ReactLoopAgent`'s
    defaults to clearing.** Deliberate: the queue lives in the subprocess and
    `keepQueued: false` is emulated, capped and lossy (§4.4b), so suppression is
    opt-in — the same call the Phase 5 tool layer made for `claude_code_cancel`
    (correction 23). The inbox is reconciled from the outbox afterwards rather
    than cleared optimistically, so it never claims a message was cancelled that
    the drain could not actually stop.
37. **The adapter package gained two dependencies** (peer + dev, exact
    `0.1.0-rc.7`): `@deepseek-ai/dsh-scope` (`createScope`, for a real
    agent-scoped context whose contributions unwind on disposal — the `Agent.ctx`
    contract) and `@deepseek-ai/dsh-llm` (`createUserMessage` /
    `boundContextSummary`, the same two the seam's mirror uses). No pin moved.
38. **A resumed Claude Code session still gets a FRESH dsh log.** The adapter
    always `prepare()`s a new dsh session, so `resume`/`fork` carries history on
    the CC side while the mirror starts empty. A plain resume of a session whose
    id already has a live dsh session fails at `prepare()`, and the spawn path
    closes the just-opened subprocess before rethrowing.

### The defect the unmount test found

39. **An agent spawned through `ctx.claudeCodeAgents` survived the plugin
    unload that was supposed to tear it down.** `ClaudeCodeAgentService.spawn()`
    registered the agent's lifetime effect through `this.ctx` — but cordis's
    `Service` stores a TRACED derivative whose `.fiber` is not the mounting
    plugin's, so `fiber.dispose()` never reached the effect: the registry entry,
    the dsh session and the Claude Code subprocess all outlived their plugin.
    **Fix:** the service captures the constructor's `ctx` and spawns through
    that (the same thing the seam's own service does for its teardown effect).
    `tests/inert.spec.ts`'s unmount case fails without it.

### Defects the Phase 6 verify pass (Stage 3) found

40. **`reconcileInbox()` scanned the whole session log once per streamed
    message.** It ran on EVERY seam message — one per assistant chunk, thousands
    per session — and unconditionally resolved the current turn number through
    `Session.events`, which rebuilds and freezes a copy of the entire log on
    every read after an append. Since the mirror appends per chunk, that is a
    full log copy per chunk: **quadratic in session length**, for a number that
    is only needed when a claim is actually issued. **Fix:** an empty inbox
    returns immediately, and the turn number is resolved lazily (`turn ??=`) at
    the two call sites that consume it. `tests/orderings.spec.ts`'s
    "reads the event log only when a claim is actually owed" pins it by spying
    on the `events` accessor; it fails against the eager version.
41. **The exact-disposer rule was documented and relied upon but not tested.**
    `tests/spawn.spec.ts`'s ordering assertion still passes when
    `yield agents.register(agent)` is replaced with a wrapper, because the
    wrapper preserves the ORDER while losing the identity. **Fix (test only):**
    a cordis effect's disposer carries `symbols.effect` metadata, and a yielded
    disposer is re-parented into the composite effect as a labeled CHILD — so
    the composite effect's children must contain `agents.register()`. A wrapper
    drops the symbol and the child, and the new assertion fails. Verified by
    mutation.
42. **A dead subprocess leaves the agent reading `running`, not `idle`.** The
    seam's pump ends when the SDK's iterator completes, but nothing calls
    `CcSession.close()`, so the status machine never moves: `agent.status` stays
    `running` forever, `whenIdle()` never settles, and `runMaintenance()` keeps
    refusing the phase. Only an explicit close recovers, and disposal's bounded
    drain is what keeps this from wedging plugin unload. **Not fixed here** —
    the adapter has no signal to act on; the fix is one line in the seam
    (close on pump completion when the session was not already closing) and is
    a Phase 2 lifecycle change that wants its own live subprocess-kill test.
    The current behaviour is pinned by `tests/orderings.spec.ts` so a future
    seam that self-closes shows up there first. The adapter README's claim that
    the agent "reads `idle`" in this state was wrong and has been corrected.
    **FIXED in Phase 7 (correction 44).** The seam now closes on pump
    completion, and the probe that pinned this has been inverted to assert the
    new behaviour.
43. **The live steer spec raced the model.** It waited 1.5s after
    `status === 'running'` before steering; haiku finished counting to 30 in
    under two seconds, so the steer landed on the turn boundary, was committed
    by `completeTurn()` without ever running, and the merged text contained no
    BANANA. **Fix (test only):** count to 300, and gate the steer on the first
    `assistant/chunk` in the agent's own session log — the agent-layer
    equivalent of the seam spec's first `stream_event`, which is how
    `steer.live.spec.ts` has always avoided this. Confirmed over four
    consecutive live runs.

### Phase 7 additions and corrections

44. **The dead-subprocess gap (correction 42) is FIXED, in the seam.** Pump
    completion now runs the same close sequence an explicit `close()` does,
    tagged with a {@link CcCloseReason} (§4.4b). Everything that rode `onClose`
    therefore just works: pending asks are denied, waiters released, the mirror
    finalized, the registry entry dropped, the background job settled. The
    Phase 6 probe in `packages/claude-code-agent/tests/orderings.spec.ts` that
    pinned the OLD behaviour has been inverted — it was written to fail exactly
    here — and now asserts `idle`, a settled `whenIdle()`, and a claimable
    maintenance phase. `packages/claude-code/tests/session-death.spec.ts` is the
    new suite, asserting the consumer effects rather than just the status field.
45. **`ClaudeCode.get(id)` now answers for a recently closed session.** It
    reads the live registry first and a bounded tombstone table second
    (`CLOSED_SESSION_HISTORY`, 32 entries), returning `status: 'closed'` plus
    the `closeReason`. `list()` and `session(id)` are UNCHANGED and remain
    live-only. Reason: a dead subprocess now closes its own session, so the next
    `claude_code_status` would otherwise answer `CC_NO_SESSION` — "it was never
    opened here" — about a session the caller was handed the id of moments
    earlier, which sends a model off to open a second one. Tests that used
    `get()` to mean "is it still running?" were changed to `session()`, which is
    the question they were actually asking.
46. **`claude_code_status` answers for a closed session; every other tool still
    does not.** It reports `status` plus a new optional `close_reason`
    (`closed` / `exited` / `crashed`). `claude_code_send` / `_wait` / `_cancel`
    keep failing `CC_NO_SESSION`: they need a live actor to drive, and the
    model's remedy really is "open one". `claude_code_status` is the one call
    whose entire purpose is answering "what happened to it?".
47. **A backgrounded session's job settles from the close reason.** `crashed`
    settles `failed` ("the Claude Code subprocess ended mid-turn"); `exited` and
    `closed` settle `completed`; an already-issued `cancel` WINS over all three
    and settles `killed`, so `job_kill` is never relabelled as a crash. `done`
    still never rejects (D10). This retires the README limitation "a subprocess
    that dies on its own does not settle its job".
48. **Cards for mirrored CC tool traffic are NOT REPRESENTABLE in rc.7, and the
    seam ships the projection without the payload.** `presentCcToolCall()` /
    `presentCcToolResult()` (`src/cards.ts`) map CC's own tools onto dsh's
    render-intent vocabulary — `terminal` for `Bash`, `diff` for `Write`/`Edit`,
    `read` for a completed `Read`, category-hinted `generic` for the rest — and
    are pure, total and fixture-tested. **Nothing is written into the session
    log for them.** The evidence, which is structural rather than a matter of
    effort:

    - `SessionEventMap['tool/call']` is `{ turn, step, callId, name, arguments }`
      with no view slot (`packages/core/session/src/types.ts:279`); `tool/result`
      adds only `error?` and `meta?: JsonValue` (`types.ts:291-297`); the event
      envelope has no free field either (`types.ts:404-436`).
    - A card is not read off the log, it is DERIVED by a name lookup in the tool
      registry: `ctx.tools.get(name, scope)?.presentCall?.(JSON.parse(raw))` and
      `ctx.tools.get(call.name, scope)?.presentResult?.(...)`
      (`packages/host/apiproxy/src/api-proxy.ts:756-770`). `meta` is threaded
      INTO that call (`api-proxy.ts:770`) — it is an argument to a registered
      tool's presenter, never a view in its own right.
    - `ctx.tools.get()` resolves `view(scope).visible.get(name)`
      (`packages/core/tools/src/index.ts:1204-1206`), built from what plugins
      registered (`index.ts:1166-1191`). The mirror writes CC's names (`Bash`,
      `Write`, `Edit`, `Read`); dsh's own tools are lowercase
      (`packages/shell/tool-bash/src/index.ts:243`, `packages/fs/tool-fs/src/`).
      Nothing registers the CapCase names, so the lookup misses and the event
      ships viewless — the documented generic fallback (`api-proxy.ts:766`).

    **Nothing is lost by not writing a payload**, which is why this shape is
    right rather than a consolation: every input the projection needs is already
    durable in the log (`tool/call` carries `name` + raw `arguments`,
    `tool/result` carries the content), so the card stays a pure function of the
    record, computable live and on replay. A payload parked in
    `tool/result.meta` would be read by nobody, duplicate content the event
    already carries, and grow every log containing a `Bash` call.

    **Registering presenters is not a workaround.** `visible` is the SAME map
    that feeds `schemas()` (`index.ts:1234-1236`), so registering `Bash` for its
    card advertises `Bash` to that scope's model. The one narrow exception — an
    `agent.ctx` registration lands in the agent's own layer (`index.ts:1037-1062`,
    `1177-1183`) and a CC-backed agent never sends dsh schemas to a model (D8) —
    covers only the ADAPTER path (a tool-opened session registers no agent, so
    its presenter scope is global) and only while the agent is alive (a cold read
    falls back to the preset standing key, `api-proxy.ts:1596-1613`). The same
    log would render two ways depending on who looked and when.

    **What closes it upstream:** a `presentation-only` registration on
    `ToolRegistry` — presenters, no `execute`, excluded from
    `schemas()`/`sdkSchemas()`/`resolveExecution()` — or a name-independent view
    path in `viewFor()`. This module is the implementation either way.
49. **Three fixture-scrubber defects, one of them a corruption.** (a) The
    `msg_[A-Za-z0-9_-]+` pattern matched `msg_lifecycle_v1` — a `system/init`
    CAPABILITY name — and rewrote it to `msg-scrubbed-0001` in all three
    committed fixtures, i.e. the scrubber was destroying the deterministic value
    this seam feature-detects on (S14). Real ids are `msg_` + 16-or-more
    base62 with no separators, so the pattern now requires that, and `req_` ids
    join it. (b) `estimated_tokens`/`estimated_tokens_delta` (numeric) and
    `timestamp`/`signature` (string) were unscrubbed and dirtied every fixture on
    every sweep. (c) `system/init`'s `slash_commands`, `terminal_slash_commands`,
    `skills`, `agents` and `plugins` are the RECORDER'S machine — they change
    when anyone installs a plugin and carried a developer's personal
    configuration into a checked-in file. They are replaced with a marker; the
    mirror reads none of them (`CcMirror.onSystem` reads `model` only). `tools`
    is deliberately left verbatim as the one list a fixture could be read
    against, and is the documented remaining churn source.
    `tests/scrub.spec.ts` pins both directions — what is erased AND what must
    not be — plus idempotence against the committed files.
50. **Fixture stability was verified across THREE independent live sweeps.**
    After the scrubber fixes, the residual diff between sweeps is exactly
    model-authored content (thinking/text/`partial_json` bodies, the tool
    `description` prose, and the resulting chunk COUNT) — irreducible, since a
    live model does not re-emit identical tokens. The offline suite is green
    against all three recordings, which is the property that actually matters:
    the goldens assert framing and skeleton, not prose. One card assertion that
    had transcribed the model's `description` literal was corrected to assert
    the MAPPING against the recorded input, so an honest re-record no longer
    looks like a regression.
51. **The seam gained a type-only dependency on `@deepseek-ai/dsh-tools`**
    (peer + dev, exact `0.1.0-rc.7`, matching every other pin). `src/cards.ts`
    imports `ToolCallView`/`ToolResultView` and friends as TYPES, so the views
    are dsh's own by construction rather than a structural copy that could
    drift. No runtime import, no pin moved.

### Phase 7 Stage 2 — failure injection (live) and the E2E demo

52. **The §12 failure-injection list is now covered LIVE, split across the
    three packages whose own guarantee each scenario exercises**, so each
    file asserts what that PACKAGE promises rather than reaching into a
    sibling's composition:

    - `packages/claude-code/tests/live/failures.live.spec.ts` — the seam
      itself. A real subprocess is SIGKILLed mid-turn with a pending ask held
      open (a scripted `approval/request` answerer that never resolves):
      `CcSession.status` reaches `closed`, `closeReason` is `crashed`/`exited`,
      `pendingAsks` drops to `0` (the ask denied, not leaked), `waitForResult`
      REJECTS typed `SESSION_CLOSED` rather than hanging, `ClaudeCodeService.get()`'s
      tombstone agrees, and the mirror's dangling turn closes `aborted` and
      accepts a fresh append — correction 44, observed live rather than only
      against the fake seam (`session-death.spec.ts`). A second spec covers
      the OTHER §12 item Phase 4 didn't (`close()` on a never-answered
      INTERACTIVE ask — `delegated: false` selects no timeout at all, so only
      a human answering or the session closing settles it; `close()` must not
      hang). A third proves §4.6's "late answer discarded" LIVE: a scripted
      answerer that decides on its own 4s clock, unaware of cancellation, is
      raced against `session.interrupt()`, which withdraws the SDK's pending
      `canUseTool` request and settles the ask well before the answerer's
      late resolve arrives — confirming, against the real SDK, that
      `interrupt()` (not just `close()`) aborts an in-flight permission
      request's signal. The late resolve then arrives and does nothing:
      no throw, no double-settle, session still usable for a follow-up turn.
    - `packages/claude-code-agent/tests/live/agent-kill.live.spec.ts` — the
      agent adapter. Same SIGKILL, but through `ctx.claudeCodeAgents.spawn()`
      with NO `cancel()`/`dispose()` call: `agent.status` reaches `idle` and a
      `whenIdle()` parked BEFORE the kill resolves on its own — the live
      confirmation the README's "a dead subprocess reaches `idle`" bullet
      promised but had only an offline probe for.
    - `packages/tool-claude-code/tests/live/tools-background-kill.live.spec.ts`
      — the background-job half. SIGKILL (never `job_kill`, never
      `claude_code_close`) settles the job `failed` exactly once via
      `outcomeFor`'s dead-subprocess row, `job_list` shows the terminal state,
      no orphan subprocess remains.

    All three assert **zero `unhandledRejection`s** via a shared
    `captureUnhandledRejections()` helper (`packages/claude-code/tests/live/helpers.ts`)
    — the exact failure mode a dead subprocess used to produce when a promise
    was left with nobody to settle it.

    One live-only gotcha the fixed suites found: a `sleep N && echo done` Bash
    prompt — tried first for the "keep a turn open long enough to kill it"
    scenarios — never triggers `canUseTool` at all. The CLI's own safe-command
    classifier auto-approves it BELOW the callback (the same gotcha spike 4
    already documented for `echo`), so the test hung waiting for a
    `pendingAsks` that would never appear. `touch <unseen-path>` (the pattern
    every other ask-channel live spec already used) does trigger it reliably;
    the failure specs were changed to match rather than widening a timeout on
    a prompt that was never going to ask.

53. **`examples/delegation-demo/` is the project's acceptance artifact** — a
    human runs `pnpm run build && node examples/delegation-demo/run.mjs` and
    watches the whole integration work, no test runner involved. It boots the
    real composition from its own `cordis.yml` (all three packages, plus
    `dsh-session`/`dsh-agent`/`dsh-user-approval`/`dsh-user-questions`/
    `dsh-jobs-local`+`dsh-tool-jobs`) through the same Loader sequence
    `tests/composition/composition.spec.ts` uses, registers a SIMPLE
    auto-answerer for approvals and questions that logs every decision it
    makes, stands in a minimal dsh `Agent` for "the delegating DeepSeek
    agent" (a real `Session` with an open turn, registered as a registry
    root — the same shape the live test helpers' `registerRootAgent` uses),
    and has that agent call `claude_code_open` for real: "create a file with
    this exact content." It prints every auto-approval as it happens, the
    tool's canonical JSON result, the mirrored dsh session's full event-type
    timeline, and the created file's path and content, then closes the
    session and disposes the composition cleanly. Exit code `0` and the
    file's existence are the acceptance bar; `run.live.spec.ts` (a new
    `examples` vitest project, gated `DSH_CC_LIVE=1` exactly like every other
    live spec) asserts both by spawning the script as a real subprocess and
    checking its printed markers plus the file on disk — never by importing
    the demo's internals.

### Phase 7 Stage 3 — final verification

54. **`CcSession.close()` was RE-ENTRANT, and is now guarded.** `close()` tested
    only `#closing`, which `runClose()` assigns *after* its whole synchronous
    prefix — and that prefix includes the `onClose` listener loop. A listener
    that called `close()` from inside its own notification therefore found
    `#closing` still unset and started a SECOND close sequence over a
    half-torn-down session: asks re-settled, the query re-closed, the input
    stream re-ended, and every close listener re-invoked — including itself.
    Nothing bounded it, because `#closeListeners` is cleared *after* the loop,
    not before it, so the real-world outcome is a stack overflow rather than a
    wrong value. Reproduced by probe (a listener capped at five re-entries saw
    six invocations where it must see one) before the fix, and pinned
    afterwards by two regression tests in
    `packages/claude-code/tests/session-death.spec.ts` — one for an explicit
    close, one for a close the dead subprocess triggered (which additionally
    asserts the re-entrant call's default `'closed'` does not overwrite the
    real `'exited'`). Both are counter-capped so the regression fails an
    assertion instead of crashing the worker.

    The guard is `if (this.#closed) return`, placed after the `#closing` check.
    `#closed` is set on `runClose()`'s first line, so it is the flag that covers
    exactly the window `#closing` cannot. Returning WITHOUT awaiting is the only
    correct answer: the caller is executing inside the close it would otherwise
    be waiting for — the same reasoning that puts the pump's self-close on a
    `.then` rather than in the pump body (item 44).

    No shipped `onClose` subscriber does this today (the service's registry
    cleanup, the mirror's finalize/dispose, the background job's settle and the
    agent's status sync all avoid it), which is why offline and live suites were
    green over it. `onClose` and `close()` are both public, and "tear my thing
    down when the session closes" is the obvious thing to write in one.
55. **`pnpm-lock.yaml` was stale, and only a clean-state gate could see it.**
    Item 51 added `@deepseek-ai/dsh-tools` to `packages/claude-code/package.json`
    without regenerating the lockfile, so
    `pnpm install --frozen-lockfile` — which is the DEFAULT in CI — failed with
    `ERR_PNPM_OUTDATED_LOCKFILE` on a fresh clone. Every incremental
    `pnpm install` in the working tree had silently reconciled it. Regenerated;
    the clean-state gate now passes frozen. **Add `--frozen-lockfile` to the
    verification sequence below**: a plain `pnpm install` cannot fail this way
    and therefore cannot detect it.

    Two adjacent facts worth recording for whoever runs the gates next. First,
    a true clean state must also delete `*.tsbuildinfo` (gitignored, so a fresh
    clone has none): removing `lib/` alone leaves `tsc -b` believing it is up to
    date, so it emits NOTHING and the two consumer packages fail with a
    confusing cascade of `TS6305 — output file has not been built from source
    file`. `pnpm run clean` (`tsc -b --clean`) does the right thing. Second,
    a `pgrep` orphan check sampled the instant `vitest` exits reads a
    still-exiting subprocess as an orphan — the suite's own assertions use
    `waitForSessionProcessCount(id, 0, 15_000)`, a BOUNDED poll, for exactly
    that reason. Give a whole-sweep orphan check the same grace or it reports
    false positives.

56. **Three live specs flaked across Stage 3's sweeps. All three were fixed in
    the tests; none was a defect in `src/`.** The rule the two-sweep bar
    enforces is that a flake gets diagnosed, not re-run — and the diagnosis was
    the same shape twice: *the spec waited on a proxy for the thing it cared
    about.*

    (a) **`failures.live.spec.ts` — answer-after-cancel** waited for
    `session.pendingAsks > 0` and then asserted the scripted answerer had been
    called exactly once. The router books the pending ask BEFORE it awaits
    `ctx.approval.request()`, and the approval service appends its own audit
    events before dispatching `approval/request` — so `pendingAsks > 0` is
    reachable a poll or two before the listener runs. Failed
    `expected 0 to be 1` in one sweep, passed in the next. The barrier now
    waits on the answerer itself, which cannot fire before the ask is booked
    and holds it for 4s afterwards, so the `pendingAsks` assertion that follows
    is race-free in both directions.

    (b) **`prewarm.live.spec.ts` — the known "contention flake" was misdiagnosed
    and is now actually fixed.** The standing note (carried since Phase 2's
    Stage 2) blamed "a neighbour consuming the shared pool's warm slot", which
    cannot happen: `mountLive()` gives every test its own service and therefore
    its own pool. The real cause is a fixed time budget racing a real
    subprocess. `spy.startupCount` increments the instant `backend.startup()`
    is INVOKED, but `CcWarmPool.startWarm()` stores the lease only in the
    continuation after that promise resolves — so the spec waited on the
    invocation count and then slept a flat `2_000` ms to cover the spawn +
    initialize handshake. That handshake is ~300ms in isolation (spike 5) and
    unbounded under a thirty-file parallel sweep, and when it lost, session B
    opened cold and got a fresh id (`expected 'd738…' to be '44b6…'`). The spy
    gained `startupSettledCount` (incremented in a `finally`, so a FAILED
    pre-warm releases the waiter too rather than turning into a timeout), the
    spec now waits on it, and the flat 2s became a single 100ms tick to clear
    the one microtask between the counter and `#held`. Verified 3/3 in
    isolation after the change. **Delete the "prewarm can flake" caveat from
    §7a on the next pass that touches it** — it described a cause that was not
    real.

    (c) **`ask-plan.live.spec.ts` — the revise case** saw `planCalls === 0` in
    one sweep: Haiku answered the plan prompt in prose without ever calling
    `ExitPlanMode`, so the plan-review path was never entered. Three
    consecutive isolated runs passed, so this is model nondeterminism under
    load, not a router defect. Getting Claude into a plan review is the spec's
    SETUP; what it tests is what the ask channel does once one arrives. So the
    setup became a bounded re-prompt (`driveUntilPlanReviews`, at most two
    extra turns) and **no assertion moved** — `planCalls >= 2`, the
    different-detail check on the revised plan, and the executed-file check all
    stand exactly as they were. Weakening `>= 2` to `>= 1` would have deleted
    the behaviour under test; adding turns does not.

## 6. Verification before you report

```sh
# A TRUE clean state — *.tsbuildinfo is gitignored, so leaving one behind makes
# `tsc -b` emit nothing and the consumers fail with a TS6305 cascade (item 55).
rm -rf node_modules packages/*/node_modules packages/*/lib
find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete

pnpm install --frozen-lockfile     # --frozen-lockfile is the CI default; a plain
                                   # `pnpm install` cannot detect a stale lockfile (item 55)
pnpm run typecheck                 # every package builds + every spec type-checks
pnpm run build                     # tsc -b per package -> lib/index.js + lib/types/index.d.ts
pnpm test                          # build, then vitest run (unit + composition + examples), offline
pnpm run test:live                 # OPT-IN: DSH_CC_LIVE=1, real subprocesses (§7a)
```

All are green as of the **Phase 7 Stage 3 merge point** — the project's final
verification, run from the true clean state above (failure injection + the E2E
demo + Stage 3's close-reentrancy and lockfile fixes, on top of Stage 1's
dead-subprocess fix / cards / scrubber work):

- `pnpm run typecheck` — clean across all three packages plus
  `tsconfig.tests.json` (now also covering `examples/**/*.ts`), under NodeNext
  / strict / `exactOptionalPropertyTypes` / `skipLibCheck: false`.
- `pnpm run build` — clean.
- `pnpm test` (build, then all THREE vitest projects — `unit`, `composition`,
  and the new `examples`) — **502 passed / 44 skipped, 32 files (+30
  skipped)**, run TWICE with byte-identical results (the goldens are
  deterministic). The two tests above the Stage 2 count are Stage 3's
  close-reentrancy regressions (item 54).
  The 44 skipped are the `DSH_CC_LIVE`-gated live specs
  (43 under `unit`, 1 under `examples`), collected and skipped. Every unit
  test runs offline against a fake backend; `pnpm test` spawns no subprocess
  and makes no network call.
  - `pnpm run test:unit` alone — **489 passed / 43 skipped**.
  - `pnpm run test:composition` alone — **13 passed**, booting both `cordis.yml`
    and `cordis-no-jobs.yml` through the real Loader against built `lib/` output.
  - `packages/claude-code-agent` contributes **78 passed / 8 skipped** (the
    extra skip is `agent-kill.live.spec.ts`, new this stage): `agent.spec.ts`
    30, `orderings.spec.ts` 22, `spawn.spec.ts` 14, `inert.spec.ts` 5,
    `plugin.spec.ts` 4, `exports.spec.ts` 3.
- `pnpm run test:live` (now also covering the `examples` project) — **44
  passed / 30 files**, ZERO failures, against the real SDK
  (`claude-haiku-4-5-20251001`, claude.ai subscription, no `ANTHROPIC_API_KEY`).
  Run TWICE back to back (the Phase 6 bar): both sweeps green, **77s and 67s**
  wall, with `pgrep -f 'claude-agent-sdk-[a-z0-9-]*/claude'` at zero before,
  between and after them (given the settle window the note below explains).
  Stage 3 restarted this two-run count TWICE — once per flake found (item 56) —
  rather than re-running until it went green; the numbers above are from the
  first pair of sweeps after both fixes landed.
  `packages/claude-code-agent/tests/live/` is 8 of those tests
  across 7 files; `packages/tool-claude-code/tests/live/` and
  `packages/claude-code/tests/live/` carry the rest of Stage 2's new files
  (`failures.live.spec.ts`, `tools-background-kill.live.spec.ts`);
  `examples/delegation-demo/run.live.spec.ts` is the 30th file.

Live-suite notes that are not defects in this integration:

- `packages/claude-code/tests/live/prewarm.live.spec.ts`'s long-standing
  "contention flake" (carried since Phase 2's Stage 2) was **misdiagnosed and is
  now fixed** — see item 56(b). It was never contention: every test gets its own
  pool. It was a flat 2s sleep standing in for a real spawn + handshake, and the
  spec now waits on the pre-warm actually settling.
- `record-fixtures.live.spec.ts` re-records three mirror fixtures on every live
  run, exactly as before; the working tree was left scoped to the change under
  review.
- **A `pgrep` orphan check must be given a settle window.** A closed session's
  subprocess exits on stdin EOF plus a ~2s grace, so sampling the instant
  `vitest` exits reads a straggler as an orphan. Every in-suite assertion
  already uses the bounded `waitForSessionProcessCount(id, 0, 15_000)`; a
  whole-sweep check run from a shell needs the same grace. Stage 3 initially
  reported one "orphan" this way and confirmed on inspection that the process
  had already gone (item 55).

## 7. The Phase 1 acceptance test

`tests/composition/` is the Phase 1 acceptance test and the only place a
consumer package is exercised the way a deployment exercises it.

- `tests/composition/cordis.yml` — a real composition: `dsh-session`,
  `dsh-agent`, `dsh-system-prompt`, `dsh-tools`, then all three packages of this
  integration, with non-default `claude-code` config values so the test can
  prove the YAML row (not the schema's defaults) is what
  `ctx.claudeCode.config` reports.
- `tests/composition/composition.spec.ts` — boots it through
  `cordis-plugin-loader` + the `include`/`group` builtins, patterned on
  `spikes/composition/spike-loader.mjs`. It asserts every row activated, that
  `ctx.claudeCode` reports the configured values, that all six `claude_code_*`
  tools are registered with complete parameter/output schemas, that the agent
  adapter's mount marker was logged (proof `inject: ['agents', 'claudeCode']`
  was satisfied), that **nothing** on the mount path throws `NOT_IMPLEMENTED`
  while `ctx.claudeCode.open()` still does, and that `ctx.fiber.dispose()`
  removes every service.
- The Loader boot needs `@deepseek-ai/cordis`, `cordis-plugin-loader`,
  `cordis-plugin-include`, `cordis-plugin-group`, the four dsh service packages
  and the three `workspace:*` packages as **root `devDependencies`** — that is
  what makes each bare specifier in `cordis.yml` resolvable. `@types/js-yaml` is
  a root devDependency too: `cordis-plugin-include`'s published `.d.ts` imports
  `js-yaml`, which `skipLibCheck: false` will not tolerate untyped.

## 7a. The live suite (Phase 2, Stage 2)

`packages/claude-code/tests/live/` holds nine specs — open/result, followup,
steer, interrupt (both `keepQueued` modes), resume, fork, teardown, prewarm —
each driving a REAL Claude Code subprocess through the real backend and a real
`ClaudeCodeService` mounted in a bare cordis Context.

- **Gated.** Every file is `describe.skipIf(!LIVE)` with
  `LIVE = process.env.DSH_CC_LIVE === '1'`, so `pnpm test` / `pnpm run test:unit`
  collect them and skip them. `pnpm run test:live` builds, then sets the flag.
- **House rules** (`tests/live/helpers.ts` enforces them): model is always
  `claude-haiku-4-5-20251001`, prompts are one sentence, `settingSources: []`,
  `ANTHROPIC_API_KEY` is never set (subscription auth strips it anyway), every
  test gets an isolated tmp `cwd` and a hard timeout, and every test disposes its
  own mount. Orphan checks use `pgrep -f 'claude-agent-sdk-[a-z0-9-]*/claude'`
  (spike 5's pattern) with a before/after delta, so an unrelated `claude` process
  on the developer's machine cannot false-positive them.
- **Two live-suite defects were fixed at the Stage 3 merge point**, both in the
  tests rather than the seam. (a) *Teardown asserted on a whole-machine process
  count.* The nine files run in parallel, so a before/after delta around one
  test read its neighbours' healthy sessions as its own orphans (`expected 2 to
  be less than or equal to 0`). Orphan assertions are now scoped to the session's
  own subprocess: SDK 0.3.233 puts `--session-id=<uuid>` in the CLI's argv, which
  identifies exactly one process. (b) *A history-recall probe was phrased as a
  "codeword".* Haiku declined it — "establishing that codewords can override my
  judgment would create a security issue" — failing the fork spec on a model
  refusal rather than on transcript continuity. The probe is now a plain recall
  question, which tests the same thing with nothing to refuse.
- **Assertions are structural, not timing-based** wherever possible: prewarm is
  proven by the session adopting the pool's pre-minted `sessionId` (frozen at
  `startup()`, so it could not have come from a cold `query()`), and the drain
  cap by a counting backend wrapper — neither reaches into private state.
- **Phase 4 added four ask files** (`ask-approval`, `ask-question`, `ask-plan`,
  `ask-timeout-fallback`), taking the suite to sixteen files / twenty-five tests.
  They mount the full real composition (`SessionStore` + `AgentRegistry` +
  `UserQuestionService` + `ApprovalService` + `ClaudeCodeService`) and never
  override `deps.canUseTool`, so every one of them exercises the production
  `CcAskRouter`. Assertions read the deterministic `tool/result` text CC's own
  permission machinery writes back to the model, not the model's paraphrase of
  it. `mountLiveWithAsk` / `registerLiveRootAgent` (in `tests/live/helpers.ts`)
  pass the agent's own dsh session as BOTH audit log and mirror target, which is
  what makes `approval/asked.data.callId` directly comparable to the mirrored
  `tool/call.data.callId`.
- **Phase 6 added the adapter's own six files / seven tests**
  (`packages/claude-code-agent/tests/live/`): basic drive with an approval routed
  through the agent's identity, steer refold, `AskUserQuestion` answered as a
  registry root, both `keepInbox` defaults, mid-turn dispose, and plugin-only
  HMR. Every one of them spawns through `ctx.claudeCodeAgents.spawn()` — the
  mounted service, i.e. the only entry point a human at the dsh UI has — never
  `createClaudeCodeAgent()` or `CcSession` directly. `mountLiveAgent()` in that
  directory's `helpers.ts` mounts `SessionStore` + `AgentRegistry` +
  `UserQuestionService` + `ApprovalService` + a real `ClaudeCodeService` + the
  adapter plugin as ONE composition, and exposes the adapter plugin's own fiber
  separately so the HMR spec can dispose only that. **Phase 7 Stage 2 added the
  failure-injection live spec this note anticipated**: `agent-kill.live.spec.ts`
  SIGKILLs a spawned agent's subprocess (correction 42, observed live) — see
  item 52. What remains open is the agent-card / UI surface (item 48: not
  representable in dsh rc.7, structural, not a to-do).
- **Running the live suite rewrites three fixtures.**
  `record-fixtures.live.spec.ts` re-records `plain-text.json`, `steer.json` and
  `tool-call.json` on every live run, so `git status` shows them modified
  afterwards. That is the recorder working; `mirror-golden.spec.ts` is the check
  that the projection is still deterministic against the new recording.
- **Phase 7 Stage 2 grew the suite to thirty files across four locations**
  (`packages/claude-code/tests/live/` seventeen, `packages/claude-code-agent/tests/live/`
  seven, `packages/tool-claude-code/tests/live/` five, plus the new
  `examples/delegation-demo/run.live.spec.ts`) and ran it TWICE back to back
  per the Phase 6 bar: both sweeps **44 passed / 30 files, zero failures**,
  ~71–90s wall each, `pgrep` at zero orphan subprocesses after each sweep and
  between them. See item 52 for what the three new failure-injection files
  assert and item 53 for the demo.

### Still deferred (do not build now)

- Anything that needs a live subprocess in the DEFAULT suites. `pnpm test` and
  `pnpm run test:unit` remain fully offline: no subprocess, no network, no
  credentials. Live coverage is opt-in through `pnpm run test:live` only.
