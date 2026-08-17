// Spike: interrupt-queued — does interrupt() return still_queued uuids, and how are queued
// messages cancelled? Public SDK surface check performed via grep BEFORE this run (see report).
import { query } from '@anthropic-ai/claude-agent-sdk'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workdir = path.join(__dirname, 'workdir')
fs.mkdirSync(workdir, { recursive: true })

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

const uuid1 = crypto.randomUUID()
const uuid2 = crypto.randomUUID()
const uuid3 = crypto.randomUUID()

console.error('UUIDS>', JSON.stringify({ uuid1, uuid2, uuid3 }))

const stream = makeStream()
stream.send({
  type: 'user',
  message: { role: 'user', content: 'Count from 1 to 40, one per line, then say DONE.' },
  parent_tool_use_id: null,
  session_id: '',
  uuid: uuid1,
})

const q = query({
  prompt: stream,
  options: {
    cwd: workdir,
    model: 'claude-haiku-4-5-20251001',
    settingSources: [],
    maxTurns: 8,
    env: { ...process.env },
  },
})

const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000)

let sentQueued = false
let interruptResult
let resultCount = 0
let sawInit = false

for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    sawInit = true
    console.error('INIT capabilities:', JSON.stringify(msg.capabilities ?? 'n/a'))
  }
  if (msg.type === 'assistant' && !sentQueued) {
    // partial output flowing (first assistant message) -> push msg2 and msg3
    sentQueued = true
    stream.send({
      type: 'user',
      message: { role: 'user', content: 'Say APPLE.' },
      parent_tool_use_id: null,
      session_id: '',
      uuid: uuid2,
    })
    stream.send({
      type: 'user',
      message: { role: 'user', content: 'Say PEAR.' },
      parent_tool_use_id: null,
      session_id: '',
      uuid: uuid3,
    })
    // give a brief moment then interrupt
    setTimeout(async () => {
      try {
        interruptResult = await q.interrupt()
        console.error('INTERRUPT RESULT>', JSON.stringify(interruptResult))
      } catch (e) {
        console.error('INTERRUPT ERROR>', e?.message ?? String(e))
      }
    }, 300)
  }
  if (msg.type === 'result') {
    resultCount++
    console.error(`RESULT #${resultCount}> subtype=${msg.subtype} text=${(msg.result ?? '').slice(0, 120)}`)
    if (resultCount >= 2) {
      stream.end()
      break
    }
  }
}

// brief drain window to catch any trailing results after loop break (loop already breaks on 3rd)
clearTimeout(timer)
console.error('SUMMARY>', JSON.stringify({ sawInit, interruptResult, resultCount }))
process.exit(0)
