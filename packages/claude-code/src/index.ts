/**
 * Claude Code capability seam for the DeepSeek Harness.
 *
 * NAMED EXPORTS ONLY. A `default` export here would make the cordis Loader
 * unwrap the module to that single value and silently discard the sibling
 * `name`/`inject`/`Config` exports, mounting the plugin with an empty inject
 * list (harness post-mortem 0001, "export default drops the plugin's inject").
 * `tests/exports.spec.ts` asserts the absence of a default export.
 *
 * Nothing exported here references a Claude Agent SDK type. The SDK boundary is
 * `src/backend.ts`, which re-states in this seam's own vocabulary exactly the
 * shapes we use — so consumer packages never need the SDK on their dependency
 * graph, and `lib/types/**` stays SDK-free (asserted by the build).
 *
 * @module @deepseek-ai/dsh-claude-code
 */

export { realBackend } from './backend.ts'
export type {
  CcAccountData,
  CcBackendQuery,
  CcCanUseTool,
  CcInitializeResult,
  CcInterruptReceipt,
  CcModelInfoEntry,
  CcPermissionDecision,
  CcPermissionRequest,
  CcQueryOptions,
  CcSdkMessage,
  CcSdkUserMessage,
  CcSlashCommandInfo,
  CcUuid,
  CcWarmQuery,
  QueryBackend,
} from './backend.ts'

export {
  Config,
  DEFAULT_API_KEY_REF,
  DEFAULT_DELEGATED_ASK_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  resolveClaudeCodeConfig,
} from './config.ts'
export type {
  CcAskConfig,
  CcDefaultsConfig,
  CcLimitsConfig,
  ClaudeCodeConfig,
  ResolvedClaudeCodeConfig,
} from './config.ts'

export { createInputStream } from './input-stream.ts'
export type { CcInputStream, CcUserMessageInit } from './input-stream.ts'

export { attachMirror, CC_COMPACT_EVENT, CcMirror, markEventIgnorable } from './mirror.ts'
export type {
  CcCompactEventData,
  CcCompactionMode,
  CcMirrorHandle,
  CcMirrorIgnoreCounts,
  CcMirrorOptions,
  CcMirrorSource,
  CcMirrorStats,
} from './mirror.ts'

export { WarmPool, warmFingerprint } from './prewarm.ts'
export type { CcWarmLease, WarmPoolDeps } from './prewarm.ts'

export { buildSessionEnv, CcSession, resolveQueryOptions } from './session.ts'
export type {
  CcInterruptOptions,
  CcInterruptOutcome,
  CcMessageEnvelope,
  CcMessageListener,
  CcMessageMeta,
  CcOutboxEntry,
  CcOutboxState,
  CcQueryOptionDeps,
  CcSendListener,
  CcSendMode,
  CcSendOptions,
  CcSendRecord,
  CcSessionDeps,
  CcSessionOptions,
} from './session.ts'

export { apply, ClaudeCodeService, inject, name } from './service.ts'
export type { ClaudeCodeServiceDeps } from './service.ts'

export {
  ASK_FALLBACKS,
  CC_AUTH_MODES,
  CC_PERMISSION_MODES,
  CC_SESSION_STATUSES,
  CC_SETTING_SOURCES,
  ClaudeCodeError,
  isCcSessionId,
  newCcSessionId,
} from './types.ts'
export type {
  AskFallback,
  CcAccountInfo,
  CcAuthMode,
  CcContextUsage,
  CcErrorCode,
  CcLogger,
  CcMirrorAttachment,
  CcOpenOptions,
  CcPermissionMode,
  CcSessionId,
  CcSessionSnapshot,
  CcSessionStatus,
  CcSettingSource,
  ClaudeCode,
} from './types.ts'
