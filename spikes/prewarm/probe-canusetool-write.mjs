import { startup } from '@anthropic-ai/claude-agent-sdk'

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

const seen = []
const warm = await startup({
  options: {
    cwd: new URL('./workdir', import.meta.url).pathname,
    model: 'claude-haiku-4-5-20251001',
    settingSources: [],
    maxTurns: 3,
    env: { ...process.env },
    canUseTool: async (toolName, input) => {
      seen.push(toolName)
      console.error('CANUSETOOL(warm)>', toolName, JSON.stringify(input).slice(0,300))
      return { behavior: 'deny', message: 'probe: denied' }
    },
  },
})

const stream = makeStream()
stream.send({ type: 'user', message: { role: 'user', content: 'Use the Write tool to create a file named test.txt containing "hi".' }, parent_tool_use_id: null, session_id: '' })
const q = warm.query(stream)
const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000)
for await (const msg of q) {
  if (msg.type === 'result') {
    console.error('RESULT>', msg.subtype, JSON.stringify(msg.result ?? '').slice(0,300))
    stream.end()
    break
  }
}
clearTimeout(timer)
console.error('SEEN:', JSON.stringify(seen))
process.exit(0)
