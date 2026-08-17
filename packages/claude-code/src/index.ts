/**
 * Claude Code capability seam for the DeepSeek Harness.
 *
 * NAMED EXPORTS ONLY. A `default` export here would make the cordis Loader
 * unwrap the module to that single value and silently discard the sibling
 * `name`/`inject`/`Config` exports, mounting the plugin with an empty inject
 * list (harness post-mortem 0001, "export default drops the plugin's inject").
 * `tests/exports.spec.ts` asserts the absence of a default export.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

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

export { apply, ClaudeCodeService, inject, name } from './service.ts'

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
  CcOpenOptions,
  CcPermissionMode,
  CcSessionId,
  CcSessionSnapshot,
  CcSessionStatus,
  CcSettingSource,
  ClaudeCode,
} from './types.ts'
