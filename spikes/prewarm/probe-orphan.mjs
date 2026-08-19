import { startup } from '@anthropic-ai/claude-agent-sdk'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileP = promisify(execFile)

async function countSdkProcs() {
  try {
    const { stdout } = await execFileP('pgrep', ['-f', 'claude-agent-sdk-darwin-arm64/claude'])
    return stdout.trim() ? stdout.trim().split('\n').length : 0
  } catch (e) {
    return 0 // pgrep exits 1 when no matches
  }
}

const before = await countSdkProcs()
const warm = await startup({
  options: {
    cwd: new URL('./workdir', import.meta.url).pathname,
    model: 'claude-haiku-4-5-20251001',
    settingSources: [],
    maxTurns: 3,
    env: { ...process.env },
  },
})
const mid = await countSdkProcs()
warm.close()
await new Promise(r => setTimeout(r, 3000))
const after = await countSdkProcs()
console.log(JSON.stringify({ before, mid, after, delta_start: mid - before, delta_close: after - mid }))
process.exit(0)
