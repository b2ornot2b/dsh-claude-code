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

export {
  CC_ASK_USER_QUESTION, CC_CANCELLED_MESSAGE, CC_EXIT_PLAN_MODE, CC_PLAN_APPROVE_LABEL,
  CC_PLAN_DECLINE_LABEL, CC_PLAN_REVIEW_ID, CC_REJECTED_MESSAGE, CcAskRouter, describeCall,
  mapAnswers, mapQuestions,
} from './ask/router.ts'
export type { CcAskRouterDeps, CcMappedQuestion } from './ask/router.ts'

export { applyAskFallback, describeReason } from './ask/fallback.ts'
export type {
  CcAskFallbackInput, CcAskFallbackReason, CcAskFallbackResult, CcAskKind,
} from './ask/fallback.ts'

export {
  CC_RULE_CACHE_DIR, CC_RULE_CACHE_FILE, CC_RULE_FILE_VERSION, CcAskRules, resolveRuleCachePath,
} from './ask/rules.ts'
export type { CcAskRule, CcAskRuleFile, CcAskRulesDeps } from './ask/rules.ts'

export {
  ASK_SESSION_CLOSED_MESSAGE, ASK_WITHDRAWN_MESSAGE, CC_PENDING_ASK_KINDS, CcAskTable,
} from './ask/table.ts'
export type {
  CcAskRunSpec, CcAskSettleCause, CcAskTableDeps, CcPendingAsk, CcPendingAskKind,
} from './ask/table.ts'

export { askErrorCode, CC_ASK_ERROR_CODES } from './ask/types.ts'
export type {
  CcApprovalSeam, CcAskCallSite, CcAskServices, CcAskTarget, CcUserQuestionsSeam,
} from './ask/types.ts'

export { presentCcToolCall, presentCcToolResult } from './cards.ts'
export type { CcToolOutcome } from './cards.ts'

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
  CcPermissionRuleValue,
  CcPermissionSuggestion,
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
  CcAskRuleConfig,
  CcDefaultsConfig,
  CcLimitsConfig,
  ClaudeCodeConfig,
  ResolvedClaudeCodeConfig,
} from './config.ts'

export {
  buildSessionInventory,
  buildSessionLimitInfo,
  formatDuration,
  INVENTORY_ASK_DETAIL_LIMIT,
  isReapable,
  renderSessionLimit,
  selectReapable,
  sessionLimitError,
} from './inventory.ts'

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
  CcAskChannel,
  CcCloseListener,
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

export {
  apply, CLOSED_SESSION_HISTORY, ClaudeCodeService, inject, MAX_IDLE_SWEEP_MS, MIN_IDLE_SWEEP_MS, name,
  sweepIntervalMs,
} from './service.ts'
export type { ClaudeCodeServiceDeps } from './service.ts'

export {
  ASK_FALLBACKS,
  CC_AUTH_MODES,
  CC_CLOSE_REASONS,
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
  CcCloseReason,
  CcContextUsage,
  CcErrorCode,
  CcErrorData,
  CcListOptions,
  CcLogger,
  CcMirrorAttachment,
  CcOpenOptions,
  CcPermissionMode,
  CcSessionId,
  CcSessionInventoryEntry,
  CcSessionLimitInfo,
  CcSessionSnapshot,
  CcSessionStatus,
  CcSettingSource,
  ClaudeCode,
  ClaudeCodeErrorOptions,
} from './types.ts'
