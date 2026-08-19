/**
 * Path translation between hosts.
 *
 * The same repository has different absolute paths per host: b2umini sees
 * b2studio's `/Users/b2/Developer/mine/grigios` at
 * `/System/Volumes/Data/mnt/b2/Developer/mine/grigios` (design P7). A cwd is
 * only actionable once re-expressed in local terms, so every discovery
 * result the probe source produces runs its `cwd` through this rewrite
 * before handing it to a consumer.
 *
 * @module @deepseek-ai/dsh-claude-code-remote
 */

/** One prefix rewrite, remote path to local path. */
export interface CcPathMapping {
  readonly from: string
  readonly to: string
}

/**
 * Rewrite a remote path into this host's terms.
 *
 * The longest matching prefix wins (so a general `/mnt` mapping does not
 * shadow a more specific `/mnt/b2` one), and a match must end on a
 * path-segment boundary — `path === mapping.from` or the next character
 * being `/` — so a mapping for `/mnt/b2` never rewrites `/mnt/b2extra`.
 *
 * @param pathMap - the configured rewrites, in no particular order.
 * @param path - the remote path, as the probe reported it.
 * @returns the translated path, or `path` unchanged when nothing matched.
 */
export function translatePath(pathMap: readonly CcPathMapping[], path: string): string {
  let best: CcPathMapping | undefined
  for (const mapping of pathMap) {
    if (path !== mapping.from && !path.startsWith(`${mapping.from}/`)) continue
    if (best === undefined || mapping.from.length > best.from.length) best = mapping
  }
  if (best === undefined) return path
  return `${best.to}${path.slice(best.from.length)}`
}
