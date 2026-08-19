/**
 * The local discovery source: this host's live sessions and recent transcripts.
 *
 * Both readers are INJECTED. Specs must never touch the real `~/.claude`, and
 * the SDK's `listSessions` must stay behind the `backend.ts` boundary so no SDK
 * type leaks into `lib/types/**`.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { SessionId } from '@deepseek-ai/dsh-session'

import type {
  CcDiscoverRequest, CcDiscoveredSession, CcDiscoveryResult, CcDiscoverySource,
} from './types.ts'

/** One session as the local transcript store reports it. */
export interface CcStoreEntry {
  readonly sessionId: string
  readonly cwd?: string
  readonly summary?: string
  readonly customTitle?: string
  readonly firstPrompt?: string
  readonly gitBranch?: string
  readonly lastModified: number
  readonly createdAt?: number
  readonly fileSize?: number
}

/** One live session as the on-disk registry reports it. */
export interface CcRegistryEntry {
  readonly sessionId: string
  readonly pid: number
  readonly cwd: string
  readonly name?: string
  readonly kind?: string
  readonly entrypoint?: string
  readonly version?: string
  readonly startedAt?: number
  readonly liveness: 'confirmed' | 'assumed'
}

/** Injectable readers for the local source. */
export interface CcLocalSourceDeps {
  readonly host: string
  readonly listSessions: (options: { limit: number }) => Promise<CcStoreEntry[]>
  readonly readRegistry: () => Promise<CcRegistryEntry[]>
  readonly now?: () => number
}

/**
 * The best human-facing name for a stored session.
 * @param entry - the store entry.
 * @returns the title, or undefined when the store offered none.
 */
function storeTitle(entry: CcStoreEntry): string | undefined {
  return entry.customTitle ?? entry.summary ?? entry.firstPrompt
}

/**
 * Build the local discovery source.
 * @param deps - injected readers, host label and clock.
 * @returns a source reporting this host's live and resumable sessions.
 */
export function createLocalSource(deps: CcLocalSourceDeps): CcDiscoverySource {
  const clock = deps.now ?? Date.now
  return {
    id: 'local',
    host: deps.host,
    async discover(request: CcDiscoverRequest): Promise<CcDiscoveryResult> {
      const warnings: string[] = []
      const sessions: CcDiscoveredSession[] = []

      // One reader failing must not lose the other's answer: a host with an
      // unreadable store still has running sessions worth naming.
      const registry = await deps.readRegistry().catch((error: unknown) => {
        warnings.push(`local registry: ${String(error)}`)
        return [] as CcRegistryEntry[]
      })
      for (const entry of registry) {
        sessions.push({
          sessionId: SessionId(entry.sessionId),
          origin: 'live-external',
          host: deps.host,
          sourceId: 'local',
          cwd: entry.cwd,
          lastActivityAt: entry.startedAt ?? clock(),
          sendable: false,
          resumable: true,
          fidelity: 'sdk',
          live: {
            pid: entry.pid,
            liveness: entry.liveness,
            ...(entry.kind === undefined ? {} : { kind: entry.kind }),
            ...(entry.entrypoint === undefined ? {} : { entrypoint: entry.entrypoint }),
            ...(entry.version === undefined ? {} : { claudeVersion: entry.version }),
          },
          ...(request.includeTitles && entry.name !== undefined ? { title: entry.name } : {}),
          ...(entry.startedAt === undefined ? {} : { createdAt: entry.startedAt }),
        })
      }

      if (request.includeResumable) {
        const store = await deps.listSessions({ limit: request.maxResumable })
          .catch((error: unknown) => {
            warnings.push(`local store: ${String(error)}`)
            return [] as CcStoreEntry[]
          })
        const cutoff = request.now - request.recentWindowMs
        for (const entry of store) {
          if (entry.lastModified < cutoff) continue
          const title = request.includeTitles ? storeTitle(entry) : undefined
          sessions.push({
            sessionId: SessionId(entry.sessionId),
            origin: 'resumable',
            host: deps.host,
            sourceId: 'local',
            cwd: entry.cwd ?? '',
            lastActivityAt: entry.lastModified,
            sendable: false,
            resumable: true,
            fidelity: 'sdk',
            ...(title === undefined ? {} : { title }),
            ...(entry.gitBranch === undefined ? {} : { gitBranch: entry.gitBranch }),
            ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
            ...(entry.fileSize === undefined ? {} : { sizeBytes: entry.fileSize }),
          })
        }
      }

      return { sessions, warnings, generatedAt: clock(), cached: false }
    },
  }
}
