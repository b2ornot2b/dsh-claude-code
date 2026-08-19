// Probe: steering - what happens when a second SDKUserMessage is pushed
// into the input stream while a turn is RUNNING. Controlled by env PRIORITY=now|unset.
import { query } from '@anthropic-ai/claude-agent-sdk'
import crypto from 'node:crypto'
import fs from 'node:fs'

const PRIORITY = process.env.PRIORITY || null // 'now' or null

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

const workdir = process.env.PROBE_CWD ?? (process.cwd() + '/workdir')
fs.mkdirSync(workdir, { recursive: true })

const stream = makeStream()

const msg1Uuid = crypto.randomUUID()
const msg2Uuid = crypto.randomUUID()

stream.send({
  type: 'user',
  message: { role: 'user', content: 'Count from 1 to 25, one number per line, then say DONE.' },
  parent_tool_use_id: null,
  session_id: '',
  uuid: msg1Uuid,
})

console.error('SENT msg1 uuid=', msg1Uuid, 'priority=', PRIORITY)

let msg2Sent = false
let firstPartialSeen = false

const q = query({
  prompt: stream,
  options: {
    cwd: workdir,
    model: 'claude-haiku-4-5-20251001',
    settingSources: [],
    maxTurns: 6,
    includePartialMessages: true,
    env: { ...process.env },
    canUseTool: async () => ({ behavior: 'deny', message: 'probe: no tools needed' }),
  },
})

const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000)

const resultMessages = []
const events = []

function finish() {
  console.error('=== SUMMARY ===')
  console.error('msg2Sent:', msg2Sent)
  console.error('resultCount:', resultMessages.length)
  console.error('results:', JSON.stringify(resultMessages, null, 2))
  process.exit(0)
}

for await (const msg of q) {
  events.push({ t: Date.now(), type: msg.type, subtype: msg.subtype })
  if (msg.type === 'stream_event') {
    // detect first partial content delta
    if (!firstPartialSeen && !msg2Sent) {
      firstPartialSeen = true
      const m2 = {
        type: 'user',
        message: { role: 'user', content: 'Also say BANANA at the end.' },
        parent_tool_use_id: null,
        session_id: '',
        uuid: msg2Uuid,
      }
      if (PRIORITY) m2.priority = PRIORITY
      stream.send(m2)
      msg2Sent = true
      console.error('SENT msg2 uuid=', msg2Uuid, 'priority=', PRIORITY, 'at partial event:', JSON.stringify(msg).slice(0, 200))
    }
  }
  if (msg.type === 'assistant') {
    const text = msg.message.content?.filter(b => b.type === 'text').map(b => b.text).join(' ')
    if (text) console.error('ASSISTANT> uuid=', msg.uuid, text.slice(0, 500))
  }
  if (msg.type === 'user') {
    console.error('USER-ECHO> uuid=', msg.uuid, JSON.stringify(msg.message.content).slice(0, 300))
  }
  if (msg.type === 'result') {
    resultMessages.push({ subtype: msg.subtype, result: (msg.result ?? '').slice(0, 300), uuid: msg.uuid })
    console.error('RESULT #' + resultMessages.length, msg.subtype, '| text:', (msg.result ?? '').slice(0, 300))
    if (resultMessages.length === 1) {
      // After the first result, end the input stream and give it a brief
      // grace window to see if a SECOND turn/result fires (queued behavior)
      // vs nothing more happening (folded behavior).
      stream.end()
      setTimeout(() => {
        if (resultMessages.length < 2) {
          console.error('No second result after grace window - stopping.')
          clearTimeout(timer)
          finish()
        }
      }, 12000)
    }
    if (resultMessages.length >= 2) {
      break
    }
  }
}

clearTimeout(timer)
stream.end()
finish()
