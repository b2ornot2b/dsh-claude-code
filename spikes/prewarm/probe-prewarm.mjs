// Probe: does startup() prewarming save first-response latency, and does canUseTool still fire on warm queries?
import { query, startup } from '@anthropic-ai/claude-agent-sdk'

function makeStream() {
  let push, done
  const q = []
  const p = () => new Promise(r => (push = r))
  let wait = p()
  return {
    send(m) { q.push(m); push?.() },
    end() { done = true; push?.() },
    async *[Symbol.asyncIterator]() {
      while (!done) {
        while (q.length) yield q.shift()
        await wait; wait = p()
      }
    },
  }
}

function userMsg(text) {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }
}

const baseOptions = {
  cwd: new URL('./workdir', import.meta.url).pathname,
  model: 'claude-haiku-4-5-20251001',
  settingSources: [],
  maxTurns: 3,
  env: { ...process.env },
}

const results = { cold: [], warm: [] }

async function runCold(label) {
  const stream = makeStream()
  stream.send(userMsg('Reply only OK.'))
  const t0 = performance.now()
  const q = query({ prompt: stream, options: { ...baseOptions } })
  let tInit = null, tFirst = null
  const timer = setTimeout(() => { console.error('TIMEOUT', label); process.exit(2) }, 180000)
  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init' && tInit === null) {
      tInit = performance.now() - t0
    }
    if ((msg.type === 'assistant' || msg.type === 'stream_event') && tFirst === null) {
      tFirst = performance.now() - t0
    }
    if (msg.type === 'result') {
      stream.end()
      break
    }
  }
  clearTimeout(timer)
  console.error(`COLD[${label}] tInit=${tInit?.toFixed(1)}ms tFirst=${tFirst?.toFixed(1)}ms`)
  results.cold.push({ label, tInit, tFirst })
}

async function runWarm(label, opts = {}) {
  const t0 = performance.now()
  const warm = await startup({ options: { ...baseOptions, ...opts } })
  const tStartup = performance.now() - t0

  const stream = makeStream()
  stream.send(userMsg(opts.__prompt ?? 'Reply only OK.'))
  const t1 = performance.now()
  const q = warm.query(stream)
  let tInit = null, tFirst = null
  const canUseToolFired = []
  const timer = setTimeout(() => { console.error('TIMEOUT', label); process.exit(2) }, 180000)
  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init' && tInit === null) {
      tInit = performance.now() - t1
    }
    if ((msg.type === 'assistant' || msg.type === 'stream_event') && tFirst === null) {
      tFirst = performance.now() - t1
    }
    if (msg.type === 'result') {
      stream.end()
      break
    }
  }
  clearTimeout(timer)
  console.error(`WARM[${label}] tStartup=${tStartup.toFixed(1)}ms tInit=${tInit?.toFixed(1)}ms tFirst=${tFirst?.toFixed(1)}ms`)
  results.warm.push({ label, tStartup, tInit, tFirst })
}

// canUseTool check via warm query
async function runWarmCanUseTool() {
  const seen = []
  const t0 = performance.now()
  const warm = await startup({
    options: {
      ...baseOptions,
      canUseTool: async (toolName, input) => {
        seen.push(toolName)
        console.error('CANUSETOOL(warm)>', toolName)
        return { behavior: 'deny', message: 'probe: denied' }
      },
    },
  })
  const tStartup = performance.now() - t0
  const stream = makeStream()
  stream.send(userMsg('Run: echo hi'))
  const q = warm.query(stream)
  const timer = setTimeout(() => { console.error('TIMEOUT canUseTool-warm'); process.exit(2) }, 180000)
  for await (const msg of q) {
    if (msg.type === 'result') {
      stream.end()
      break
    }
  }
  clearTimeout(timer)
  console.error(`WARM-CANUSETOOL tStartup=${tStartup.toFixed(1)}ms seen=${JSON.stringify(seen)}`)
  return seen
}

async function countClaudeProcs() {
  const { execSync } = await import('node:child_process')
  try {
    const out = execSync('pgrep -f "claude" || true').toString().trim()
    return out ? out.split('\n').length : 0
  } catch {
    return 0
  }
}

async function runWarmCloseOnly() {
  const before = await countClaudeProcs()
  const warm = await startup({ options: { ...baseOptions } })
  const mid = await countClaudeProcs()
  warm.close()
  await new Promise(r => setTimeout(r, 2000))
  const after = await countClaudeProcs()
  console.error(`ORPHAN-CHECK before=${before} afterStartup=${mid} afterClose=${after}`)
  return { before, mid, after }
}

async function main() {
  for (let i = 0; i < 3; i++) await runCold(`cold-${i}`)
  for (let i = 0; i < 3; i++) await runWarm(`warm-${i}`)
  const canUseToolSeen = await runWarmCanUseTool()
  const orphan = await runWarmCloseOnly()

  console.log('RESULTS_JSON:', JSON.stringify({ results, canUseToolSeen, orphan }, null, 2))
  process.exit(0)
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
