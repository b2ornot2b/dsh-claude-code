/**
 * Stretch: boot the SAME composition through the Loader + cordis.yml mechanism
 * the harness examples use, but WITHOUT @deepseek-ai/dsh-app-boot (which drags
 * in launch-environment / home-paths / .env / patch layers).
 *
 * Mirrors the essential steps of dsh-app-boot's `boot()`:
 *   ctx.baseUrl -> ctx.plugin(Loader) -> builtins.include/group -> loader.create(root include) -> loader.await()
 *
 * Run: node spike-loader.mjs
 */
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { SessionId } from '@deepseek-ai/dsh-session'

const here = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.join(here, 'cordis.yml')

const ctx = new Context()
ctx.baseUrl = pathToFileURL(here).href + '/'
await ctx.plugin(Loader)
ctx.loader.builtins.include = Include
ctx.loader.builtins.group = Group

await ctx.loader.create({
  id: 'include',
  name: 'cordis:include',
  config: { path: pathToFileURL(configPath).href },
})
await ctx.get('loader')?.await()

// Audit like app-boot's assertEntriesActivated.
const entries = [...ctx.loader.entries()]
console.log('loader entries:')
for (const e of entries) {
  console.log(`  ${e.options.id.padEnd(16)} ${String(e.options.name).padEnd(34)} fiber=${e.fiber === undefined ? 'MISSING' : 'active'} disabled=${!!e.disabled}`)
}
const broken = entries.filter(e => e.fiber === undefined && !e.disabled)
assert.equal(broken.length, 0, `entries failed to activate: ${broken.map(e => e.options.id).join(', ')}`)

for (const key of ['sessions', 'agents', 'userQuestions', 'approval']) {
  assert.ok(ctx.get(key) !== undefined, `ctx.get('${key}') undefined after Loader boot`)
}
console.log('services from cordis.yml: sessions, agents, userQuestions, approval — all present')

// Prove the seams still work when the composition came from YAML.
const sessionId = SessionId('loader-spike-1')
const session = ctx.sessions.create(sessionId)
const agent = { id: sessionId, session, ctx }
const fiber = await ctx.plugin(Object.assign(inner => { inner.agents.register(agent) }, { inject: ['agents'] }))
session.append('turn/start', { turn: 1 })

const disposeProvider = ctx.userQuestions.registerProvider({
  async ask(req) { return { answers: req.questions.map(q => ({ id: q.id, selected: [q.options[1].label] })) } },
})
const answer = await ctx.get('userQuestions').ask({
  agent,
  questions: [{ id: 'q1', question: 'loader path?', options: [{ label: 'no' }, { label: 'yes' }] }],
})
assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['yes'] }])
console.log('userQuestions round trip via Loader boot: OK')

const off = ctx.on('approval/request', () => Promise.resolve('allowed-once'))
const before = session.events.length
const outcome = await ctx.get('approval').request({ agent, toolName: 'Bash' })
assert.equal(outcome, 'allowed-once')
assert.deepEqual(session.events.slice(before).map(e => e.type), ['approval/asked', 'approval/decided'])
console.log('approval round trip via Loader boot: OK (allowed-once + asked/decided)')

session.append('turn/end', { turn: 1 })
await assert.rejects(() => ctx.get('approval').request({ agent, toolName: 'Bash' }), /outside an open turn/)
console.log('open-turn guard via Loader boot: OK')

off()
disposeProvider()
await fiber.dispose()
await ctx.fiber.dispose()
console.log('\nLOADER BOOT: ALL CHECKS PASSED')
