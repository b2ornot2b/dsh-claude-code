// Probe 2: AskUserQuestion answer encoding through canUseTool updatedInput.
import { query } from '@anthropic-ai/claude-agent-sdk'

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
  message: { role: 'user', content: 'Use the AskUserQuestion tool to ask me ONE question: which greeting to use, options "hello" or "hola". After I answer, just repeat my choice back as plain text and finish.' },
  parent_tool_use_id: null,
  session_id: '',
})

const q = query({
  prompt: stream,
  options: {
    cwd: process.env.PROBE_CWD ?? process.cwd(),
    model: 'claude-haiku-4-5-20251001',
    settingSources: [],
    maxTurns: 6,
    env: { ...process.env },
    canUseTool: async (toolName, input) => {
      console.error('CANUSETOOL>', toolName, JSON.stringify(input).slice(0, 800))
      if (toolName === 'AskUserQuestion') {
        const answers = {}
        for (const it of input.questions) answers[it.question] = 'hola'
        const updatedInput = { questions: input.questions, answers }
        console.error('RETURNING updatedInput>', JSON.stringify(updatedInput).slice(0, 800))
        return { behavior: 'allow', updatedInput }
      }
      return { behavior: 'deny', message: 'probe: denied' }
    },
  },
})

const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000)

for await (const msg of q) {
  if (msg.type === 'user') {
    console.error('USER-MSG tool_result>', JSON.stringify(msg.message.content).slice(0, 800))
    if (msg.tool_use_result) console.error('TOOL_USE_RESULT>', JSON.stringify(msg.tool_use_result).slice(0, 800))
  }
  if (msg.type === 'assistant') {
    const text = msg.message.content?.filter(b => b.type === 'text').map(b => b.text).join(' ')
    if (text) console.error('ASSISTANT>', text.slice(0, 300))
  }
  if (msg.type === 'result') {
    console.error('RESULT:', msg.subtype, '| text:', (msg.result ?? '').slice(0, 200))
    stream.end()
    break
  }
}
clearTimeout(timer)
process.exit(0)
