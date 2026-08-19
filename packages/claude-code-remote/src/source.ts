/**
 * A discovery source that runs an inventory probe and parses its output.
 *
 * Deliberately generic: the argv may be `ssh host …`, `container exec …`, or
 * a local run with a different `--home`. Host names, SSH aliases and path
 * maps are configuration handed in by the caller (a plugin's `apply`, a
 * deployment's `cordis.yml`), never baked in here — that is what keeps this
 * source upstreamable with no site-specific knowledge.
 *
 * @module @deepseek-ai/dsh-claude-code-remote
 */

import { execFile } from 'node:child_process'

import type {
  CcDiscoverRequest, CcDiscoveryResult, CcDiscoverySource,
} from '@deepseek-ai/dsh-claude-code'

import { parseProbeOutput } from './parse.ts'
import type { CcPathMapping } from './paths.ts'

/** What running an argv to completion yields. */
export interface CcProbeRun {
  readonly stdout: string
  readonly stderr: string
}

/** How to build one probe-backed discovery source. */
export interface CcProbeSourceOptions {
  /** The `CcDiscoverySource.id` this source reports under. */
  readonly id: string
  /** The host label carried onto every session this source reports. */
  readonly host: string
  /** The command and its fixed arguments; per-request flags are appended. */
  readonly argv: readonly string[]
  /** How long to wait for the probe before treating it as unreachable. */
  readonly timeoutMs: number
  /** Rewrites applied to every reported `cwd`. Defaults to none. */
  readonly pathMap?: readonly CcPathMapping[]
  /**
   * Injectable runner; production uses {@link runArgv}. Specs substitute a
   * fake so no test in this package spawns a real process.
   */
  readonly run?: (argv: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<CcProbeRun>
}

/**
 * Compose the `Error` surfaced for a failed probe run.
 *
 * Node's `execFile` already folds the child's stderr into `error.message`
 * for a non-zero exit or a `timeout`-triggered kill — the message literally
 * contains the same text this function would otherwise append, so
 * appending stderr unconditionally printed every such failure twice (the
 * longest line in a host listing, doubled, plus a stray `: ` where the
 * duplicate's leading newline landed). An aborted run is the one path
 * where `error.message` stays generic ("The operation was aborted") while
 * stderr captured before the abort is the only useful signal — so stderr
 * is appended only when the message does not already contain it. Both
 * sides are trimmed first so a trailing newline from stderr, or from
 * execFile's own "Command failed: …\n" prefix, never leaves a bare colon
 * on its own line.
 */
function composeProbeError(error: Error, stderr: string): Error {
  const message = error.message.trim()
  const trimmedStderr = stderr.trim()
  if (trimmedStderr === '' || message.includes(trimmedStderr)) return new Error(message)
  return new Error(`${message}: ${trimmedStderr}`)
}

/**
 * Run an argv to completion via `child_process.execFile`.
 *
 * @param argv - the command and its arguments; `argv[0]` is the executable.
 * @param timeoutMs - how long to wait before killing it.
 * @param signal - aborts the run early when the caller's request is cancelled.
 * @returns the captured stdout/stderr.
 * @throws when the argv is empty, the process times out, exits non-zero, or
 *   is aborted — {@link createProbeSource} turns every one of these into a
 *   warning rather than letting it propagate.
 */
async function runArgv(argv: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<CcProbeRun> {
  const [command, ...args] = argv
  if (command === undefined) throw new Error('probe argv is empty')
  return await new Promise<CcProbeRun>((resolve, reject) => {
    execFile(command, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      ...(signal === undefined ? {} : { signal }),
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(composeProbeError(error, stderr))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * Build a probe-backed discovery source.
 *
 * @param options - identity, argv, deadline, path map and optional runner.
 * @returns a source whose `discover` never rejects: a failed run (unreachable
 *   host, missing probe, non-zero exit, abort) becomes a warning naming the
 *   host and preserving the transport's own message, not a thrown error.
 */
export function createProbeSource(options: CcProbeSourceOptions): CcDiscoverySource {
  const run = options.run ?? runArgv
  const pathMap = options.pathMap ?? []
  return {
    id: options.id,
    host: options.host,
    async discover(request: CcDiscoverRequest): Promise<CcDiscoveryResult> {
      const argv = [
        ...options.argv,
        '--window-ms', String(request.recentWindowMs),
        // Zero, not the configured cap, when the caller does not want resumable
        // sessions at all — the probe still runs, it just does no transcript scan.
        '--max-resumable', String(request.includeResumable ? request.maxResumable : 0),
        ...(request.includeTitles ? [] : ['--no-titles']),
      ]
      try {
        const { stdout } = await run(argv, options.timeoutMs, request.signal)
        return parseProbeOutput(stdout, { sourceId: options.id, host: options.host, pathMap })
      } catch (error) {
        return {
          sessions: [],
          warnings: [`${options.host}: ${error instanceof Error ? error.message : String(error)}`],
          generatedAt: request.now,
          cached: false,
        }
      }
    },
  }
}
