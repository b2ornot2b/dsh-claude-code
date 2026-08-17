// Spike: resume-fork
// Does resume/fork work with a caller-minted UUID sessionId, and which session id does a fork end up with?
import { query } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workdir = path.join(__dirname, 'workdir')
mkdirSync(workdir, { recursive: true })

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

async function runSession(label, prompt, extraOptions) {
  const stream = makeStream()
  stream.send({
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
    session_id: '',
  })

  const q = query({
    prompt: stream,
    options: {
      cwd: workdir,
      model: 'claude-haiku-4-5-20251001',
      settingSources: [],
      maxTurns: 3,
      env: { ...process.env },
      ...extraOptions,
    },
  })

  const record = { label, initSessionId: undefined, resultSessionId: undefined, resultText: undefined }

  const timer = setTimeout(() => { console.error(`TIMEOUT in ${label}`); process.exit(2) }, 180000)

  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      record.initSessionId = msg.session_id
      console.error(`[${label}] INIT session_id=`, msg.session_id)
    }
    if (msg.type === 'assistant') {
      const text = msg.message.content?.filter(b => b.type === 'text').map(b => b.text).join(' ')
      if (text) console.error(`[${label}] ASSISTANT>`, text.slice(0, 200))
    }
    if (msg.type === 'result') {
      record.resultSessionId = msg.session_id
      record.resultText = msg.result
      console.error(`[${label}] RESULT session_id=`, msg.session_id, '| subtype=', msg.subtype, '| result=', (msg.result ?? '').slice(0, 200))
      stream.end()
      break
    }
  }
  clearTimeout(timer)
  return record
}

const results = {}

// Step 1: Session A - mint our own sessionId
const sessionA_uuid = randomUUID()
console.error('=== Session A: minted sessionId =', sessionA_uuid, '===')
results.A = await runSession('A', 'Remember the codeword PLUM. Reply only OK.', {
  sessionId: sessionA_uuid,
})
results.A_mintedUuid = sessionA_uuid

// Step 2: Session B - resume A, no sessionId
console.error('=== Session B: resume', sessionA_uuid, '===')
results.B = await runSession('B', 'Reply with only the codeword.', {
  resume: sessionA_uuid,
})

// Step 3: Session C - fork A with a fresh minted uuid
const sessionC_uuid = randomUUID()
console.error('=== Session C: fork resume', sessionA_uuid, 'forkSession=true sessionId=', sessionC_uuid, '===')
results.C = await runSession('C', 'Reply with only the codeword.', {
  resume: sessionA_uuid,
  forkSession: true,
  sessionId: sessionC_uuid,
})
results.C_mintedUuid = sessionC_uuid

// Step 4: Session D - resume A again, sanity check not polluted
console.error('=== Session D: resume', sessionA_uuid, 'again (sanity) ===')
results.D = await runSession('D', 'Reply with only the codeword.', {
  resume: sessionA_uuid,
})

console.error('\n=== SUMMARY ===')
console.error(JSON.stringify(results, null, 2))

process.exit(0)
