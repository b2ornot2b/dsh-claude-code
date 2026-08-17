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

`import { … } from '@deepseek-ai/dsh-claude-code'`. Seventeen runtime exports
(pinned by `packages/claude-code/tests/exports.spec.ts`) and the types below.
Nothing else exists; nothing else will be added without updating this document.

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
}

/** The capability, for typing against the seam rather than the class. */
interface ClaudeCode { /* the five methods above, identical signatures */ }
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

**Phase 1 behavior you must code against:**

| Call | Phase 1 |
|---|---|
| `open(...)` | **rejects** with `ClaudeCodeError`, `code === 'NOT_IMPLEMENTED'`, message naming Phase 2 |
| `accountInfo()` | **rejects** with `ClaudeCodeError`, `code === 'NOT_IMPLEMENTED'` |
| `get(id)` | `undefined` (registry is always empty) |
| `list()` | `[]` (a fresh array each call) |
| `close(id)` | `false` (unknown id) |
| `config` | fully resolved; safe to read now |

So consumer packages are **stubs with real shapes**: register real tool
definitions / a real adapter skeleton, wire real config, and let the
`NOT_IMPLEMENTED` rejection surface as a clean tool error. Do not fake sessions.

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

```ts
type CcErrorCode = 'NOT_IMPLEMENTED' | 'UNKNOWN_SESSION' | 'SESSION_LIMIT'
                 | 'INVALID_SESSION_ID' | 'INVALID_CONFIG'

class ClaudeCodeError extends HarnessError {              // HarnessError from @deepseek-ai/dsh-llm
  constructor(message: string, code: CcErrorCode, options?: ErrorOptions)
  readonly code: string                                   // route on this, never on the message
  readonly name: 'ClaudeCodeError'
}
```

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
  Code settings".
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

## 6. Verification before you report

```sh
pnpm install                       # from the repo root; zero peer warnings
pnpm run typecheck                 # every package builds + every spec type-checks
pnpm run build                     # tsc -b per package -> lib/index.js + lib/types/index.d.ts
pnpm test                          # build, then vitest run (unit + composition), offline
```

All four are green as of the Stage 3 merge point: **61 tests / 9 files** — 54 in
the three packages' unit specs, 7 in the Phase 1 acceptance test.

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

### Still deferred (do not build now)

- Anything that needs a live Claude Code subprocess, a network call, or real
  credentials. Both vitest projects run fully offline.
