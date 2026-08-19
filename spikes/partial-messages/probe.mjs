// Spike: partial-messages — exact shape of includePartialMessages:true stream events.
import { query } from '@anthropic-ai/claude-agent-sdk'
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

function truncate(obj) {
  const s = JSON.stringify(obj)
  return s.length > 400 ? s.slice(0, 400) + '...(truncated)' : s
}

async function runSession({ model, prompt, maxTurns, extraOptions, label }) {
  console.error(`\n=== SESSION: ${label} (model=${model}) ===`)
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
      model,
      settingSources: [],
      maxTurns,
      env: { ...process.env },
      includePartialMessages: true,
      ...extraOptions,
    },
  })

  const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000)

  const eventSeq = []
  let finalAssistantMsg = null

  for await (const msg of q) {
    if (msg.type === 'stream_event') {
      const ev = msg.event
      const entry = {
        event_type: ev.type,
        index: ev.index,
        content_block_type: ev.content_block?.type,
        delta_type: ev.delta?.type,
        parent_tool_use_id: msg.parent_tool_use_id,
        ttft_ms: msg.ttft_ms,
      }
      eventSeq.push(entry)
      console.error('STREAM_EVENT>', truncate(ev), '| parent_tool_use_id=', msg.parent_tool_use_id, '| ttft_ms=', msg.ttft_ms)
    } else if (msg.type === 'assistant') {
      finalAssistantMsg = msg
      console.error('ASSISTANT-MSG>', truncate({ id: msg.message.id, content: msg.message.content, parent_tool_use_id: msg.parent_tool_use_id }))
    } else if (msg.type === 'result') {
      console.error('RESULT>', msg.subtype, '| result:', (msg.result ?? '').slice(0, 200))
      stream.end()
      break
    } else {
      console.error('OTHER-MSG type=', msg.type, msg.subtype ?? '')
    }
  }
  clearTimeout(timer)

  console.error(`\n--- EVENT SEQUENCE SUMMARY (${label}) ---`)
  for (const e of eventSeq) {
    console.error(JSON.stringify(e))
  }
  console.error(`--- FINAL ASSISTANT MSG (${label}) id=${finalAssistantMsg?.message?.id} parent_tool_use_id=${finalAssistantMsg?.parent_tool_use_id} ---`)
  return { eventSeq, finalAssistantMsg }
}

const results = {}
results.haiku = await runSession({
  model: 'claude-haiku-4-5-20251001',
  prompt: 'Write exactly two short sentences about the sky.',
  maxTurns: 3,
  extraOptions: {},
  label: 'haiku-basic',
})

// Session 2: try to trigger a thinking block via effort option.
try {
  results.thinking = await runSession({
    model: 'claude-sonnet-5',
    prompt: 'What is 17*23? Think step by step briefly.',
    maxTurns: 3,
    extraOptions: { thinking: { type: 'enabled', budgetTokens: 1024 } },
    label: 'sonnet-thinking',
  })
} catch (e) {
  console.error('THINKING SESSION FAILED>', e?.message ?? e)
}

process.exit(0)
