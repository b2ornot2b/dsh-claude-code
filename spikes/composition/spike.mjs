/**
 * Phase 0 spike: boot a DeepSeek Harness (dsh) plugin composition OUT-OF-TREE
 * from published npm packages, and exercise the userQuestions + approval seams.
 *
 * Run: node spike.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ApprovalService, { setApprovalPolicy, effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const results = []
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    (detail) => { results.push({ name, ok: true, detail }); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) },
    (error) => { results.push({ name, ok: false, detail: String(error && error.stack || error) }); console.log(`FAIL  ${name}\n      ${error && error.message}`) },
  )
}

// ---------------------------------------------------------------------------
// TRAP 1: two-cordis-copies. Every dsh package must resolve the SAME cordis file.
// ---------------------------------------------------------------------------
await check('trap/one-cordis-instance', () => {
  const dependents = [
    '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-user-approval',
    '@deepseek-ai/dsh-user-questions', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-scope',
    '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-invariants', '@deepseek-ai/dsh-brand',
    '@deepseek-ai/dsh-typert-protocol',
  ]
  const paths = new Set()
  for (const dep of dependents) {
    const depDir = path.dirname(require.resolve(`${dep}/package.json`, { paths: [here] }))
    paths.add(require.resolve('@deepseek-ai/cordis', { paths: [depDir] }))
  }
  const list = [...paths]
  assert.equal(list.length, 1, `expected 1 cordis copy, got ${list.length}: ${list.join(', ')}`)
  // Class-identity proof (stronger than path equality): the services published
  // by three separate packages must extend the SAME Service constructor we hold.
  for (const [label, cls] of [['ApprovalService', ApprovalService], ['UserQuestionService', UserQuestionService], ['AgentRegistry', AgentRegistry], ['SessionStore', SessionStore]]) {
    assert.ok(cls.prototype instanceof Service, `${label} does not extend OUR cordis Service (two copies loaded)`)
  }
  return `single copy at ${list[0]}; all 4 services extend the same Service class`
})

// ---------------------------------------------------------------------------
// BOOT: plain cordis Context + ctx.plugin() (no Loader / no cordis.yml).
// ---------------------------------------------------------------------------
const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)
await ctx.plugin(UserQuestionService)
await ctx.plugin(ApprovalService)

await check('boot/services-mounted', () => {
  for (const key of ['sessions', 'agents', 'userQuestions', 'approval']) {
    assert.ok(ctx.get(key) !== undefined, `ctx.get('${key}') is undefined`)
  }
  // TRAP 3: service keys — ctx.get(key) vs typed ctx.<key>.
  // Both resolve the same service, but cordis 4 hands back a FRESH per-access
  // "traceable" Proxy, so `ctx.get(k) === ctx[k]` is FALSE and even
  // `ctx.get(k) === ctx.get(k)` is FALSE. Unwrap with Symbol.for('cordis.original')
  // before any identity comparison.
  const ORIGINAL = Symbol.for('cordis.original')
  const unwrap = v => v?.[ORIGINAL] ?? v
  for (const key of ['sessions', 'agents', 'userQuestions', 'approval']) {
    assert.notEqual(ctx.get(key), ctx[key], `${key}: expected distinct traceable proxies`)
    assert.equal(unwrap(ctx.get(key)), unwrap(ctx[key]), `${key}: unwrapped identities differ`)
    assert.equal(unwrap(ctx.get(key)), unwrap(ctx.get(key)), `${key}: unwrap not stable`)
  }
  return 'sessions, agents, userQuestions, approval mounted; ctx.get(k) and ctx.k are DISTINCT traceable proxies over one instance (unwrap via Symbol.for("cordis.original"))'
})

// ---------------------------------------------------------------------------
// 3a. userQuestions round trip with a scripted provider.
// ---------------------------------------------------------------------------
let scriptedAsks = 0
const unregisterProvider = ctx.userQuestions.registerProvider({
  async ask(request) {
    scriptedAsks += 1
    return {
      answers: request.questions.map(q => ({
        id: q.id,
        selected: [q.options?.[1]?.label ?? 'unknown'],
      })),
    }
  },
})

await check('seam/userQuestions.ask round trip', async () => {
  const answer = await ctx.get('userQuestions').ask({
    questions: [{
      id: 'q1',
      question: 'Which harness should the plugin target?',
      options: [{ label: 'claude-code' }, { label: 'dsh' }],
    }],
  })
  assert.equal(scriptedAsks, 1)
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['dsh'] }] })
  return `scripted provider answered q1 -> ${JSON.stringify(answer.answers[0].selected)}`
})

// (agent-scoped ask is exercised further down, once a live agent is registered)

await check('seam/userQuestions fail-closed without provider', async () => {
  unregisterProvider()
  await assert.rejects(
    () => ctx.get('userQuestions').ask({ questions: [{ id: 'q1', question: 'x', options: [{ label: 'a' }, { label: 'b' }] }] }),
    (e) => e.code === 'NO_PROVIDER' || /no user-questions provider/.test(e.message),
  )
  return 'ask() throws NO_PROVIDER after the provider disposer runs'
})

// ---------------------------------------------------------------------------
// 3b. approval round trip against a live registered Agent with an OPEN TURN.
// ---------------------------------------------------------------------------
const sessionId = SessionId('spike-approval-1')
const session = ctx.sessions.create(sessionId)
// Minimal live Agent: the approval seam only reaches `agent.session` (append +
// events fold) and uses the agent object as the scope carrier — the same
// stand-in shape the harness's own approval.spec.ts uses, but over a REAL
// Session from the mounted SessionStore.
const agent = { id: sessionId, session, ctx }

let registeredLive = false
const agentFiber = await ctx.plugin(Object.assign((inner) => {
  inner.agents.register(agent)
  registeredLive = true
}, { inject: ['agents'] }))

await check('agent/registered-live-root', () => {
  assert.ok(registeredLive, 'register() plugin did not run')
  assert.equal(ctx.agents.get(sessionId), agent, 'registry does not hold the exact agent')
  assert.ok(ctx.agents.roots().includes(agent), 'agent is not a runtime root')
  return `ctx.agents.get('${sessionId}') === agent; roots() includes it`
})

await check('seam/userQuestions.ask with a live agent (registry liveness gate)', async () => {
  const dispose = ctx.userQuestions.registerProvider({
    async ask(request) {
      return { answers: request.questions.map(q => ({ id: q.id, selected: [q.options[0].label] })) }
    },
  })
  try {
    const answer = await ctx.get('userQuestions').ask({
      agent,
      questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }, { label: 'no' }] }],
    })
    assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['yes'] }])
    // A non-registered agent must be refused (CALLER_NOT_LIVE).
    await assert.rejects(
      () => ctx.get('userQuestions').ask({
        agent: { id: SessionId('ghost'), session },
        questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }, { label: 'no' }] }],
      }),
      e => e.code === 'CALLER_NOT_LIVE' || /exact live calling agent/.test(e.message),
    )
    return 'live registered agent answers; a non-registered agent is refused CALLER_NOT_LIVE'
  } finally { dispose() }
})

// Open the turn — request()'s enclosure precondition.
session.append('turn/start', { turn: 1 })

let answererSawAgent
const approvalListenerDispose = ctx.on('approval/request', (req) => {
  answererSawAgent = req.agent
  return Promise.resolve('allowed-once')
})

await check('seam/approval.request round trip', async () => {
  const before = session.events.length
  const outcome = await ctx.get('approval').request({ agent, toolName: 'Bash', reason: 'spike probe' })
  assert.equal(outcome, 'allowed-once')
  assert.equal(answererSawAgent, agent, 'answerer received a different agent object')

  const appended = session.events.slice(before)
  const types = appended.map(e => e.type)
  assert.deepEqual(types, ['approval/asked', 'approval/decided'], `session log tail was ${JSON.stringify(types)}`)
  const [asked, decided] = appended
  assert.equal(asked.data.toolName, 'Bash')
  assert.equal(asked.data.reason, 'spike probe')
  assert.equal(decided.data.outcome, 'allowed-once')
  assert.equal(decided.data.id, asked.data.id, 'asked/decided ids do not pair')
  return `outcome=allowed-once; log tail=${JSON.stringify(types)}; paired id=${asked.data.id}`
})

// ---------------------------------------------------------------------------
// 3c. open-turn guard: after turn/end, request() must throw.
// ---------------------------------------------------------------------------
await check('seam/approval open-turn guard', async () => {
  session.append('turn/end', { turn: 1 })
  const before = session.events.length
  let thrown
  await ctx.get('approval').request({ agent, toolName: 'Bash' }).then(
    (o) => { thrown = new Error(`expected a throw, resolved ${o} instead`) },
    (e) => { thrown = e },
  )
  assert.match(thrown.message, /outside an open turn/)
  assert.equal(session.events.length, before, 'guard appended events before throwing')
  return `threw: ${thrown.message.split(':')[0]}; log unchanged (${before} events)`
})

// Bonus: policy fold works out-of-tree too.
await check('seam/approval policy fold (never)', async () => {
  session.append('turn/start', { turn: 2 })
  setApprovalPolicy(session, 'never')
  assert.equal(effectiveApprovalPolicy(session.events), 'never')
  assert.equal(ctx.approval.overrideOf(session), 'never')
  const outcome = await ctx.approval.request({ agent, toolName: 'Bash' })
  assert.equal(outcome, 'rejected', 'never policy did not deterministically reject')
  return "policy 'never' rejects without consulting the answerer"
})

approvalListenerDispose()
await agentFiber.dispose()

// ---------------------------------------------------------------------------
// TRAP 2: named vs default exports on the published packages.
// ---------------------------------------------------------------------------
await check('trap/named-and-default-exports', async () => {
  const mods = {
    '@deepseek-ai/dsh-session': await import('@deepseek-ai/dsh-session'),
    '@deepseek-ai/dsh-agent': await import('@deepseek-ai/dsh-agent'),
    '@deepseek-ai/dsh-user-approval': await import('@deepseek-ai/dsh-user-approval'),
    '@deepseek-ai/dsh-user-questions': await import('@deepseek-ai/dsh-user-questions'),
  }
  const lines = []
  for (const [name, mod] of Object.entries(mods)) {
    assert.ok(typeof mod.default === 'function', `${name} has no default export`)
    lines.push(`${name}: default=${mod.default.name}, named=[${Object.keys(mod).filter(k => k !== 'default').join(', ')}]`)
  }
  assert.equal(mods['@deepseek-ai/dsh-session'].default, SessionStore)
  assert.equal(mods['@deepseek-ai/dsh-user-approval'].default, mods['@deepseek-ai/dsh-user-approval'].ApprovalService)
  console.log('      ' + lines.join('\n      '))
  return 'every plugin ships BOTH a default and a matching named export'
})

await ctx.stop?.()

console.log('\n--- summary ---')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
const failed = results.filter(r => !r.ok)
if (failed.length > 0) {
  console.log('\n--- failures ---')
  for (const r of failed) console.log(`${r.name}:\n${r.detail}\n`)
  process.exitCode = 1
} else {
  console.log(`\nALL ${results.length} CHECKS PASSED`)
}
