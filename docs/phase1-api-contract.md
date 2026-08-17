# Phase 1 API contract — `@deepseek-ai/dsh-claude-code`

Written by Stage 1 of the Phase 1 scaffold. This is the **complete and only**
API surface the two consumer packages may rely on, plus the workspace
conventions their packages must follow.

- Seam package: `packages/claude-code` → `@deepseek-ai/dsh-claude-code`
- Consumers built against it:
  - `packages/tool-claude-code` → `@deepseek-ai/dsh-tool-claude-code` (`inject: ['tools', 'claudeCode']`)
  - `packages/claude-code-agent` → `@deepseek-ai/dsh-claude-code-agent` (`inject: ['agents', 'claudeCode']`)

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
  get(id: CcSessionId): CcSessionSnapshot | undefined
  list(): readonly CcSessionSnapshot[]
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
  outbox(): readonly CcOutboxEntry[]
  snapshot(): CcSessionSnapshot

  open(): Promise<void>                        // the service calls this; consumers do not
  send(input: string | { content: string, uuid?: CcUuid }, options?: CcSendOptions): CcUuid
  waitForResult(timeoutMs?: number): Promise<CcMessageEnvelope>
  interrupt(options?: CcInterruptOptions): Promise<CcInterruptOutcome>
  onMessage(listener: CcMessageListener): () => void
  onSend(listener: CcSendListener): () => void   // Phase 3 — outgoing messages
  onClose(listener: () => void): () => void
  // Phase 4:
  attachAskTarget(target: CcAskTarget): () => void    // throws ASK_UNAVAILABLE with no ask channel
  attachAskCallSite(site: CcAskCallSite): () => void  // the service wires the mirror in
  onAskError(listener: (error: ClaudeCodeError) => void): () => void
  close(): Promise<void>               // idempotent
}
```

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
  substitutes.
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

## 6. Verification before you report

```sh
pnpm install                       # from the repo root; zero peer warnings
pnpm run typecheck                 # every package builds + every spec type-checks
pnpm run build                     # tsc -b per package -> lib/index.js + lib/types/index.d.ts
pnpm test                          # build, then vitest run (unit + composition), offline
pnpm run test:live                 # OPT-IN: DSH_CC_LIVE=1, real subprocesses (§7a)
```

All are green as of the Phase 2 Stage 3 merge point:

- `pnpm test` — **137 passed / 9 skipped, 13 files (+9 skipped)**: 129 in the
  three packages' unit specs, 8 in the composition acceptance test, and the nine
  gated live specs collected-and-skipped. Every unit test runs offline against a
  fake backend; `pnpm test` spawns no subprocess and makes no network call.
- `pnpm run test:live` — **9 passed / 9 files** against the real SDK
  (`claude-haiku-4-5-20251001`, claude.ai subscription, no `ANTHROPIC_API_KEY`),
  ~68s of test time, with `pgrep` confirming zero surviving subprocesses.

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
- **Running the live suite rewrites three fixtures.**
  `record-fixtures.live.spec.ts` re-records `plain-text.json`, `steer.json` and
  `tool-call.json` on every live run, so `git status` shows them modified
  afterwards. That is the recorder working; `mirror-golden.spec.ts` is the check
  that the projection is still deterministic against the new recording.

### Still deferred (do not build now)

- Anything that needs a live subprocess in the DEFAULT suites. `pnpm test` and
  `pnpm run test:unit` remain fully offline: no subprocess, no network, no
  credentials. Live coverage is opt-in through `pnpm run test:live` only.
