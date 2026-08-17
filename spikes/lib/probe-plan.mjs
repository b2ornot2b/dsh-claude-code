// Probe 1: what does ExitPlanMode's canUseTool input carry in 2.1.233?
import { query } from '@anthropic-ai/claude-agent-sdk'

const seen = []

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

const stream = makeStream()
stream.send({
  type: 'user',
  message: { role: 'user', content: 'Make a one-step plan to create hello.txt containing "hi", then exit plan mode. Keep the plan to two sentences.' },
  parent_tool_use_id: null,
  session_id: '',
})

const q = query({
  prompt: stream,
  options: {
    cwd: process.env.PROBE_CWD ?? process.cwd(),
    permissionMode: 'plan',
    model: 'claude-haiku-4-5-20251001',
    settingSources: [],
    maxTurns: 4,
    env: { ...process.env },
    canUseTool: async (toolName, input, opts) => {
      seen.push({
        toolName,
        inputKeys: Object.keys(input),
        input: JSON.stringify(input).slice(0, 2000),
        optKeys: Object.keys(opts),
        toolUseID: opts.toolUseID,
        requestId: opts.requestId,
        title: opts.title,
        suggestions: opts.suggestions?.length,
      })
      console.error('CANUSETOOL>', JSON.stringify(seen.at(-1), null, 2))
      if (toolName === 'ExitPlanMode') {
        setTimeout(() => stream.end(), 500)
        return { behavior: 'deny', message: 'Probe complete, stop here.', interrupt: true }
      }
      return { behavior: 'deny', message: 'probe: denied' }
    },
  },
})

const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000)

for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    console.error('INIT capabilities:', JSON.stringify(msg.capabilities ?? 'n/a'))
  }
  if (msg.type === 'result') {
    console.error('RESULT subtype:', msg.subtype)
    stream.end()
    break
  }
}
clearTimeout(timer)
console.log('SEEN:', JSON.stringify(seen, null, 2))
process.exit(0)
