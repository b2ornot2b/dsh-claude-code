#!/usr/bin/env node
/**
 * `dsh-claude-code`'s acceptance artifact (spec §12 / Stage 2's "E2E demo"):
 * a self-contained, runnable example of the whole integration working, end
 * to end, against a REAL Claude Code subprocess.
 *
 * What it does, in order:
 *
 * 1. Boots the full composition from `cordis.yml` — the real `cordis` Loader,
 *    all three `dsh-claude-code*` packages, plus the dsh seams they depend on
 *    (`dsh-session`, `dsh-agent`, `dsh-user-approval`, `dsh-user-questions`,
 *    `dsh-jobs-local` + `dsh-tool-jobs`). Nothing here is a test double.
 * 2. Registers a SIMPLE auto-answerer for `ctx.approval` and
 *    `ctx.userQuestions` — logs every request it answers, so the transcript
 *    below shows exactly what Claude Code asked permission for.
 * 3. Registers a stand-in "DeepSeek agent": a real dsh `Session` with an open
 *    turn, wrapped in the minimal shape `ctx.agents.register()` accepts —
 *    this is what a `dsh-agent-loop`-driven agent looks like from this
 *    integration's point of view, without needing an actual LLM loop.
 * 4. That stand-in agent calls `claude_code_open` — a real model-facing tool
 *    call through `ctx.tools.execute()`, exactly the path `dsh-agent-loop`
 *    would take — asking Claude Code to create a small file with specific
 *    content.
 * 5. Prints the mirrored dsh session's event-type timeline (proof the mirror,
 *    §5, is really writing a relational log of what Claude Code did) and the
 *    tool's canonical JSON result.
 * 6. Verifies the file Claude Code was asked to create actually exists, tears
 *    the composition down cleanly, and exits 0.
 *
 * Usage:
 *   pnpm run build          # from the repo root — the Loader imports lib/
 *   node examples/delegation-demo/run.mjs [--cwd <dir>]
 *
 * `--cwd` picks the working directory Claude Code runs in (and where it
 * writes the file); a fresh temp directory is used when omitted. The
 * directory is left in place on exit so its contents can be inspected — this
 * script does not clean up after itself, on purpose (see the README).
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { SessionId } from '@deepseek-ai/dsh-session'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The file Claude Code is asked to create, and its exact expected content. */
const TARGET_FILE = 'hello-from-claude-code.txt'
const TARGET_CONTENT = 'Hello from Claude Code, delegated by a DeepSeek agent.'

/**
 * Parse `--cwd <dir>` off argv; every other argument is ignored.
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{ cwd: string | undefined }} the parsed options.
 */
function parseArgs(argv) {
  let cwd
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cwd' && typeof argv[i + 1] === 'string') cwd = argv[i + 1]
  }
  return { cwd }
}

/** Prefix every line this script prints with a stable tag, so a caller piping stdout can grep for it. */
function log(...parts) {
  console.log('[demo]', ...parts)
}

/**
 * Boot `cordis.yml` through the real Loader — the same sequence
 * `tests/composition/composition.spec.ts`'s `boot()` uses, restated here as
 * plain JS so this example has no build step of its own and no dependency on
 * this repo's TypeScript test tree.
 * @param {string} configPath - absolute path to the `cordis.yml` to boot.
 * @returns {Promise<Context>} the booted root context.
 */
async function boot(configPath) {
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(here).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.get('loader')?.await()
  return ctx
}

/**
 * Register the demo's two auto-answerers: approval requests and clarifying
 * questions. Both always say yes to the FIRST option and log what they
 * decided — a real deployment's answerer would be a human or a policy
 * engine; this is deliberately the simplest thing that is still honest about
 * what it approved.
 * @param {Context} ctx - the booted composition.
 * @returns {() => void} detaches both answerers.
 */
function attachAutoAnswerers(ctx) {
  const offApproval = ctx.on('approval/request', async (request) => {
    log(`auto-approving ${request.toolName}${request.reason === undefined ? '' : `: ${request.reason}`}`)
    return 'allowed-once'
  })
  const offQuestions = ctx.userQuestions.registerProvider({
    ask: async (request) => ({
      answers: request.questions.map((question) => {
        const pick = question.options?.[0]?.label
        log(`auto-answering question "${question.text}" with "${pick ?? '(no options offered — skipping)'}"`)
        return { id: question.id, ...(pick === undefined ? {} : { selected: [pick] }) }
      }),
    }),
  })
  return () => {
    offApproval()
    offQuestions()
  }
}

/**
 * Register the stand-in "DeepSeek agent": a real dsh `Session`, an open turn
 * on it (the precondition `ctx.approval.request()` enforces), and a minimal
 * `Agent` wrapping both, registered as a registry ROOT — the exact shape the
 * live test suites' `registerLiveRootAgent`/`registerRootAgent` use.
 * @param {Context} ctx - the booted composition (`sessions` + `agents` mounted).
 * @returns {Promise<{ agent: object, dispose: () => Promise<void> }>} the agent and its disposer.
 */
async function registerDelegatingAgent(ctx) {
  const id = SessionId(randomUUID())
  const session = ctx.sessions.create(id)
  session.append('turn/start', { turn: 1 })
  const agent = { id, session, ctx }
  const fiber = await ctx.plugin(Object.assign(
    (inner) => { inner.agents.register(agent) },
    { inject: ['agents'] },
  ))
  return { agent, dispose: async () => { await fiber.dispose() } }
}

async function main() {
  const { cwd: cwdArg } = parseArgs(process.argv.slice(2))
  const workDir = cwdArg ?? mkdtempSync(path.join(tmpdir(), 'dsh-cc-demo-'))
  mkdirSync(workDir, { recursive: true })
  log(`working directory: ${workDir}`)

  const ctx = await boot(path.join(here, 'cordis.yml'))
  const detachAnswerers = attachAutoAnswerers(ctx)
  const delegate = await registerDelegatingAgent(ctx)

  let exitCode = 0
  try {
    log('DeepSeek agent delegating a task to Claude Code via claude_code_open...')
    const prompt = `Create a file named ${TARGET_FILE} in the current directory containing exactly this one `
      + `line: "${TARGET_CONTENT}" (with a trailing newline, nothing else before or after it). Then reply `
      + 'with one short sentence confirming what you did.'

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'demo-call-1',
      name: 'claude_code_open',
      arguments: { cwd: workDir, prompt, background: false },
      agent: delegate.agent,
    })

    if (result.isError) {
      console.error('[demo] claude_code_open failed:', JSON.stringify(result.error, null, 2))
      exitCode = 1
    } else {
      log('tool result (claude_code_open):')
      console.log(JSON.stringify(result.value, null, 2))

      const ccSessionId = result.value.session_id
      const mirrored = ctx.sessions.get(SessionId(ccSessionId))
      log('mirrored session event-type timeline:')
      if (mirrored === undefined) {
        log('  (no mirrored session found — this is a bug, not an expected outcome)')
        exitCode = 1
      } else {
        for (const event of mirrored.events) log(`  #${event.seq}\t${event.type}`)
      }

      const targetPath = path.join(workDir, TARGET_FILE)
      if (existsSync(targetPath)) {
        log(`file created: ${targetPath}`)
        console.log('  content:', JSON.stringify(readFileSync(targetPath, 'utf8')))
      } else {
        log(`EXPECTED FILE NOT FOUND: ${targetPath}`)
        exitCode = 1
      }

      await ctx.claudeCode.close(SessionId(ccSessionId))
    }
  } catch (error) {
    console.error('[demo] failed:', error)
    exitCode = 1
  } finally {
    detachAnswerers()
    await delegate.dispose()
    await ctx.fiber.dispose()
  }

  log(exitCode === 0 ? 'done.' : 'done, with errors.')
  process.exitCode = exitCode
}

main().catch((error) => {
  console.error('[demo] unhandled failure:', error)
  process.exitCode = 1
})
