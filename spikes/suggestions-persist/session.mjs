// Spike: suggestions-persist — the "always allow" round trip via updatedPermissions,
// and whether settingSources: [] prevents the persisted rule from ever loading.
//
// Usage: node session.mjs <A|B|C>
import { query } from '@anthropic-ai/claude-agent-sdk'

const SESSION = process.argv[2]
if (!['A', 'B', 'C'].includes(SESSION)) {
  console.error('Usage: node session.mjs <A|B|C>')
  process.exit(1)
}

const CWD = new URL('./workdir/', import.meta.url).pathname

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
  message: { role: 'user', content: process.env.PROBE_PROMPT ?? 'Run the shell command: echo hi' },
  parent_tool_use_id: null,
  session_id: '',
})

const settingSources = SESSION === 'C' ? ['local'] : []
console.error(`SESSION ${SESSION}: settingSources=${JSON.stringify(settingSources)} cwd=${CWD}`)

let canUseToolFiredForBash = false

const q = query({
  prompt: stream,
  options: {
    cwd: CWD,
    model: 'claude-haiku-4-5-20251001',
    settingSources,
    maxTurns: 4,
    env: { ...process.env },
    canUseTool: async (toolName, input, opts) => {
      console.error('CANUSETOOL>', toolName, JSON.stringify(input).slice(0, 300))
      if (toolName === 'Bash') {
        canUseToolFiredForBash = true
        const suggestions = opts?.suggestions ?? []
        console.error('SUGGESTIONS RAW>', JSON.stringify(suggestions, null, 2))
        for (const s of suggestions) {
          console.error(`SUGGESTION entry> type=${s.type} destination=${s.destination} rules=${JSON.stringify(s.rules ?? s)}`)
        }
        const destinations = suggestions.map(s => s.destination)
        console.error('DESTINATIONS SEEN>', JSON.stringify(destinations))

        let updatedPermissions = suggestions.filter(s => s.destination === 'localSettings')
        if (updatedPermissions.length === 0 && suggestions.length > 0) {
          console.error('DEVIATION: no localSettings destination found among suggestions; echoing ALL suggestions back regardless.')
          updatedPermissions = suggestions
        }
        console.error('RETURNING updatedPermissions>', JSON.stringify(updatedPermissions))
        return { behavior: 'allow', updatedInput: input, updatedPermissions }
      }
      return { behavior: 'allow', updatedInput: input }
    },
  },
})

const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000)

for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    console.error('INIT>', JSON.stringify({ permissionMode: msg.permissionMode, cwd: msg.cwd, tools: msg.tools?.length }, null, 2))
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
console.error(`SESSION ${SESSION} SUMMARY: canUseToolFiredForBash=${canUseToolFiredForBash}`)
process.exit(0)
