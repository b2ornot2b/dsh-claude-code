/**
 * PHASE 1 ACCEPTANCE TEST — the real composition.
 *
 * Every other spec in this repo mounts plugins by hand against TypeScript
 * SOURCES. This one does what a harness deployment does: it boots the sibling
 * `cordis.yml` through the cordis Loader (`cordis-plugin-loader` +
 * `include` + `group` builtins), which `import()`s each row's bare package
 * specifier and therefore exercises the packages' BUILT entry points
 * (`lib/index.js`), their `package.json` `exports` maps, their `inject` lists,
 * and their `Config` schemas — the four things a unit test cannot reach.
 *
 * It is patterned on `spikes/composition/spike-loader.mjs` (Phase 0), which
 * proved this boot sequence works out-of-tree against published packages.
 *
 * Deliberately NOT imported here: any `@deepseek-ai/dsh-claude-code*` value.
 * Vitest resolves those specifiers to `src/` through the tsconfig paths map,
 * while the Loader's dynamic `import()` (it lives in `node_modules`, so vitest
 * externalizes it) resolves them to `lib/`. Importing both would put two copies
 * of a module singleton in one process — the exact failure mode
 * docs/spec-review-and-plan.md §3 warns about. Type-only imports are fine: they
 * are erased, and they are how `ctx.claudeCode` / `ctx.tools` become visible.
 *
 * Phase 5 added the jobs runtime (`dsh-jobs-local` + `dsh-tool-jobs`) that
 * `claude_code_open({ background: true })` requires, and one real background
 * tool call through it.
 *
 * OFFLINE THROUGHOUT: no Claude Code subprocess is spawned and no network call
 * is made. Every `open()` this spec triggers is refused by the seam's
 * spawn-free `cwd` guard, which is also what lets the background test observe a
 * real job settle `failed` without a subprocess ever existing.
 *
 * Requires `pnpm run build` first; the root `test` script does that for you.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Side-effect type-only imports: they contribute the `Context` augmentations
// (`ctx.claudeCode`, `ctx.tools`, `ctx.agents`) and are erased at runtime, so
// no second copy of any package is loaded into this process.
import type {} from '@deepseek-ai/dsh-claude-code'
import type {} from '@deepseek-ai/dsh-claude-code-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const configPath = path.join(here, 'cordis.yml')
const noJobsConfigPath = path.join(here, 'cordis-no-jobs.yml')

/**
 * The `cordis.yml` rows, in file order. The root `cordis:include` entry that
 * carries the file is created by {@link boot} and gets a Loader-minted id, so
 * it is prepended at assertion time rather than hard-coded.
 */
const EXPECTED_ENTRY_IDS = [
  'sessions',
  'agents',
  'system-prompt',
  'tools',
  'jobs',
  'tool-jobs',
  'claude-code',
  'tool-claude-code',
  'claude-code-agent',
]

/** The model-facing surface this integration promises (spec §6). */
const TOOL_NAMES = [
  'claude_code_open',
  'claude_code_send',
  'claude_code_wait',
  'claude_code_status',
  'claude_code_cancel',
  'claude_code_close',
] as const

/**
 * The generic job-control tools a backgrounded Claude Code session is driven
 * through. They come from `@deepseek-ai/dsh-tool-jobs`, not from us — that is
 * the point: this integration adds a job KIND, never its own control surface.
 */
const JOB_TOOL_NAMES = ['job_list', 'job_output', 'job_kill'] as const

/** Each package's built entry point — what the Loader will actually import. */
const BUILT_ENTRIES = [
  'packages/claude-code/lib/index.js',
  'packages/tool-claude-code/lib/index.js',
  'packages/claude-code-agent/lib/index.js',
]

/**
 * Boot the sibling `cordis.yml`, mirroring the essential steps of
 * `@deepseek-ai/dsh-app-boot`'s `boot()` without dragging in its launch
 * environment: `ctx.baseUrl` -> `ctx.plugin(Loader)` -> register the
 * `include`/`group` builtins -> create the root include entry -> `await()`.
 * @param file - the composition file to boot; defaults to `cordis.yml`.
 * @returns the booted root context and the Loader-minted id of the root
 *   `cordis:include` entry that carries the file.
 */
async function boot(file = configPath): Promise<{ ctx: Context, rootId: string }> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(here).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  // `create()` mints the entry id itself (its parameter type is
  // `Omit<EntryOptions, 'id'>`); the returned id is the only reliable handle.
  const rootId = await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(file).href },
  })
  await ctx.get('loader')?.await()
  return { ctx, rootId }
}

/**
 * Copy a value that was read across a cordis service boundary into plain data.
 * Services are handed out as fresh traceable proxies, so a value reached
 * through one must never be identity-compared or handed to an inspector; a
 * JSON round trip strips the proxy provenance before any assertion formats it.
 * @param value - the value read from a service.
 * @returns a structurally identical plain-data clone.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('phase 1 acceptance: real cordis.yml + Loader composition', () => {
  beforeAll(() => {
    // The Loader imports package specifiers, which resolve to `lib/`. Fail with
    // the actionable message instead of an opaque ERR_MODULE_NOT_FOUND.
    const missing = BUILT_ENTRIES.filter(entry => !existsSync(path.join(repoRoot, entry)))
    expect(missing, `run \`pnpm run build\` first; missing: ${missing.join(', ')}`).toEqual([])
  })

  let ctx: Context
  let rootId: string
  let disposed = false

  beforeEach(async () => {
    ({ ctx, rootId } = await boot())
    disposed = false
  })

  afterEach(async () => {
    if (!disposed) await ctx.fiber.dispose()
  })

  it('activates every cordis.yml row, in file order, with no failed entries', () => {
    const entries = [...ctx.loader.entries()]
    expect(entries.map(entry => entry.options.id)).toEqual([rootId, ...EXPECTED_ENTRY_IDS])

    // An entry whose fiber is undefined while it is not disabled failed to
    // activate — typically an unsatisfied `inject`. This is the same audit
    // `dsh-app-boot`'s `assertEntriesActivated` performs at startup.
    const broken = entries
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => `${entry.options.id} (${String(entry.options.name)})`)
    expect(broken, 'entries failed to activate').toEqual([])
  })

  it('provides ctx.claudeCode reporting the values configured in cordis.yml', () => {
    expect(ctx.get('claudeCode') !== undefined, 'ctx.claudeCode should resolve').toBe(true)

    const config = plain(ctx.claudeCode.config)
    // Values the YAML row set explicitly: proof the row reached the schema.
    expect(config.prewarm).toBe(false)
    expect(config.defaults.permissionMode).toBe('acceptEdits')
    expect(config.ask.persistAlwaysAllow).toBe(false)
    expect(config.limits.maxConcurrentSessions).toBe(2)
    // Values the row omitted: proof the schema's defaults were resolved on the
    // Loader path exactly as they are on the hand-mount path.
    expect(config.auth).toBe('subscription')
    expect(config.apiKeyRef).toBe('ANTHROPIC_API_KEY')
    expect(config.ask.fallback).toBe('deny')
    expect(config.ask.delegatedTimeoutMs).toBe(120_000)
    // `settingSources: []` is always explicit: an absent value makes the SDK
    // load the user's real settings and CLAUDE.md (review doc §2, D-settings).
    expect(config.defaults.settingSources).toEqual([])
    expect(config.env).toEqual({})
    // Unset optionals are ABSENT, never present-and-undefined
    // (`exactOptionalPropertyTypes`), and never the spec's YAML `null`.
    expect('executablePath' in config).toBe(false)
    expect('timeoutMs' in config.ask).toBe(false)
    expect('ruleCachePath' in config.ask).toBe(false)
    expect('maxBudgetUsd' in config.limits).toBe(false)
  })

  it('registers all six claude_code_* tools with complete schemas', () => {
    expect(ctx.get('tools') !== undefined, 'ctx.tools should resolve').toBe(true)

    for (const toolName of TOOL_NAMES) {
      const definition = ctx.tools.get(toolName)
      expect(definition !== undefined, `${toolName} should be registered`).toBe(true)
      if (definition === undefined) continue

      expect(definition.name).toBe(toolName)
      expect(definition.description.length, `${toolName} description`).toBeGreaterThan(0)
      expect(typeof definition.execute, `${toolName} execute`).toBe('function')

      // Parameters are compiled to JSON Schema by `defineTool`; every tool in
      // this integration takes at least one argument.
      const parameters = plain(definition.parameters) as { type?: string, properties?: Record<string, unknown> }
      expect(parameters.type, `${toolName} parameters.type`).toBe('object')
      expect(Object.keys(parameters.properties ?? {}).length, `${toolName} parameters`).toBeGreaterThan(0)

      // A tool without a rendered output declaration would put a raw JSON blob
      // in the model's context window.
      expect(definition.output !== undefined, `${toolName} output`).toBe(true)
      expect(typeof definition.output.render, `${toolName} output.render`).toBe('function')
      expect(plain(definition.output.schema), `${toolName} output.schema`).toBeTruthy()
    }
  })

  it('mounts the jobs runtime background mode needs, with its generic control tools', () => {
    expect(ctx.get('jobs') !== undefined, 'ctx.jobs should resolve').toBe(true)
    for (const toolName of JOB_TOOL_NAMES) {
      expect(ctx.tools.get(toolName) !== undefined, `${toolName} should be registered`).toBe(true)
    }
  })

  it('registers a real claude-code job for a background open, and settles it failed offline', async () => {
    // A relative `cwd` is refused by the seam's spawn-free guard, so this stays
    // offline — but the refusal happens INSIDE the job's starter, which is
    // exactly what proves the whole background path is wired: the real
    // `LocalJobRegistry` accepted `kind: 'claude-code'`, minted an id under
    // that prefix, and settled the job from the producer's `done` promise
    // instead of rejecting anywhere.
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      // Branded through a cast rather than `CallId()`: importing a value from
      // `@deepseek-ai/dsh-llm` here would resolve on this spec's plane while
      // the Loader resolves the packages under test on theirs.
      callId: 'composition-background' as ToolExecutionInput['callId'],
      name: 'claude_code_open',
      arguments: { cwd: 'relative/not-allowed', prompt: 'never runs', background: true },
    })
    expect(result.isError).toBe(true)
    expect(plain(result.error?.info)).toMatchObject({ code: 'INVALID_CWD' })

    const jobs = ctx.jobs.list()
    expect(jobs).toHaveLength(1)
    const job = plain(jobs[0]) as { id: string, kind: string, label: string, status: string }
    expect(job.kind).toBe('claude-code')
    expect(job.id.startsWith('claude-code')).toBe(true)
    expect(job.label).toBe('never runs')
    // `done` resolved (never rejected) with the producer's failure.
    for (let attempt = 0; attempt < 20 && ctx.jobs.list()[0]?.status === 'running'; attempt += 1) {
      await new Promise<void>(resolve => { setTimeout(resolve, 1) })
    }
    expect(plain(ctx.jobs.list()[0])).toMatchObject({ status: 'failed' })
    expect(ctx.claudeCode.list()).toEqual([])
  })

  it('mounts the agent adapter plugin (its marker is logged, its services resolve)', () => {
    expect(ctx.get('agents') !== undefined, 'ctx.agents should resolve').toBe(true)

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'claude-code-agent')
    expect(entry !== undefined, 'claude-code-agent entry should exist').toBe(true)
    expect(entry?.fiber !== undefined, 'claude-code-agent should have an active fiber').toBe(true)

    // The scaffold's only observable effect. `inject: ['agents', 'claudeCode']`
    // means cordis would have refused to run `apply()` at all if either seam
    // were missing, so a logged marker proves both were satisfied.
    const records = plain([...(ctx.logger.buffer as unknown[])]) as Array<{ name?: string, args?: unknown[] }>
    const marker = records.find(record => record.name === 'claude-code-agent')
    expect(marker !== undefined, 'claude-code-agent mount marker should be logged').toBe(true)
    expect(String(marker?.args?.[0] ?? '')).toContain('mounted')

    // Phase 6: the adapter provides a service now. Compared as a BOOLEAN —
    // cordis hands out a fresh traceable proxy per access and an assert
    // formatter that touches one throws `cannot get property "$$typeof"`.
    expect(ctx.get('claudeCodeAgents') !== undefined, 'ctx.claudeCodeAgents should resolve').toBe(true)
    // Mounting spawns nothing: an agent exists only when something asks for one.
    expect(ctx.agents.list()).toEqual([])
  })

  it('mounts with no NOT_IMPLEMENTED anywhere on the mount path', () => {
    // Reaching this assertion at all is the proof: `boot()` awaited every
    // entry's activation, and any `apply()` that threw would have left its
    // entry without a fiber (asserted above) or rejected `loader.await()`.
    // Nothing else in Phase 1 may run eagerly.
    const errorRecords = plain([...(ctx.logger.buffer as unknown[])]) as Array<{ type?: string, args?: unknown[] }>
    const failures = errorRecords.filter(record => record.type === 'error')
    expect(failures.map(record => String(record.args?.[0] ?? '')), 'no errors logged during boot').toEqual([])
  })

  it('validates an open() before anything can spawn, and starts with an empty registry', async () => {
    // Phase 2 made `open()` real, so this test may never call it with usable
    // arguments: a valid `cwd` would spawn a Claude Code subprocess and this
    // suite is offline. A relative `cwd` is refused by the guard that runs
    // BEFORE the SDK is touched, which is exactly what we want to pin here.
    await expect(ctx.claudeCode.open({ cwd: 'relative/not-allowed' }))
      .rejects.toMatchObject({ name: 'ClaudeCodeError', code: 'INVALID_CWD' })

    // Same for the account projection: it never opens a session of its own.
    await expect(ctx.claudeCode.accountInfo())
      .rejects.toMatchObject({ name: 'ClaudeCodeError', code: 'NO_LIVE_SESSION' })

    expect(ctx.claudeCode.list()).toEqual([])
  })

  it('keeps the Claude Agent SDK out of every published type surface', async () => {
    // The seam is the ONLY package allowed to import the SDK, and no consumer
    // may need it on its dependency graph to type-check against us. `lib/types`
    // is what a consumer's compiler reads, so assert on the built artifact.
    const { readdirSync, readFileSync } = await import('node:fs')
    const offenders: string[] = []
    for (const pkg of ['claude-code', 'tool-claude-code', 'claude-code-agent']) {
      const dir = path.join(repoRoot, 'packages', pkg, 'lib', 'types')
      for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
        if (!entry.endsWith('.d.ts')) continue
        const source = readFileSync(path.join(dir, entry), 'utf8')
        // Comments may name the SDK; type positions may not.
        const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
        if (stripped.includes('@anthropic-ai/claude-agent-sdk')) offenders.push(`${pkg}/${entry}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('tears the whole composition down on dispose', async () => {
    await ctx.fiber.dispose()
    disposed = true

    for (const key of ['claudeCode', 'claudeCodeAgents', 'tools', 'agents', 'sessions', 'loader'] as const) {
      expect(ctx.get(key), `ctx.${key} should be gone after dispose`).toBeUndefined()
    }
  })
})

describe('the SAME composition with no jobs runtime', () => {
  let ctx: Context

  beforeEach(async () => {
    ({ ctx } = await boot(noJobsConfigPath))
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('activates every row and registers all six tools without ctx.jobs', () => {
    const broken = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => `${entry.options.id} (${String(entry.options.name)})`)
    expect(broken, 'entries failed to activate').toEqual([])

    // The jobs runtime is genuinely absent — this is the shape under test, not
    // a composition that merely forgot to await something.
    expect(ctx.get('jobs')).toBeUndefined()
    for (const toolName of JOB_TOOL_NAMES) {
      expect(ctx.tools.get(toolName), `${toolName} should NOT be registered`).toBeUndefined()
    }
    // …and every claude_code_* tool mounted anyway: `inject` never names jobs.
    for (const toolName of TOOL_NAMES) {
      expect(ctx.tools.get(toolName), `${toolName} should be registered`).not.toBeUndefined()
    }
  })

  it('refuses background mode with CC_NO_JOBS naming both packages, and opens nothing', async () => {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'composition-no-jobs' as ToolExecutionInput['callId'],
      name: 'claude_code_open',
      // A cwd the seam WOULD accept: the refusal must come from the missing
      // jobs runtime, checked before anything can spawn — not from the guard.
      arguments: { cwd: repoRoot, prompt: 'never runs', background: true },
    })

    expect(result.isError).toBe(true)
    expect(plain(result.error?.info)).toMatchObject({ code: 'CC_NO_JOBS' })
    const message = String(result.error?.message)
    expect(message).toContain('@deepseek-ai/dsh-jobs')
    expect(message).toContain('@deepseek-ai/dsh-tool-jobs')
    // Nothing spawned, nothing registered: the check happens first.
    expect(ctx.claudeCode.list()).toEqual([])
  })

  it('still validates a synchronous open through the same seam guard', async () => {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'composition-no-jobs-sync' as ToolExecutionInput['callId'],
      name: 'claude_code_open',
      arguments: { cwd: 'relative/not-allowed', prompt: 'never runs' },
    })
    expect(result.isError).toBe(true)
    expect(plain(result.error?.info)).toMatchObject({ code: 'INVALID_CWD' })
    expect(ctx.claudeCode.list()).toEqual([])
  })
})
