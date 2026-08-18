#!/usr/bin/env bash
# Mount the three dsh-claude-code packages into a local dsh profile.
#
# Why copy instead of symlink: Node resolves a symlinked package's bare imports
# from its REAL location, so a link back into this repo would resolve
# @deepseek-ai/cordis + dsh-* to this repo's own (rc.7) node_modules — two copies
# of a module singleton, which breaks cordis service resolution. Copying the
# built lib/ into the profile's node_modules makes those bare imports resolve to
# the profile's own dsh packages instead, whatever version they are.
#
# The SDK is symlinked: it has no dsh peers to mis-resolve, and copying its
# platform binaries would cost ~100MB.
#
# Usage:   scripts/install-into-dsh-profile.sh [profile]      (default: web)
# Rollback: scripts/install-into-dsh-profile.sh --uninstall [profile]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
MODE="install"
if [[ "${1:-}" == "--uninstall" ]]; then MODE="uninstall"; shift; fi
PROFILE="${1:-web}"

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
NM="$DSH_HOME/profiles/node_modules"
PATCH="$PROFILE_DIR/cordis.patch.yml"
MARK_BEGIN="# BEGIN dsh-claude-code (managed by scripts/install-into-dsh-profile.sh)"
MARK_END="# END dsh-claude-code"

PKGS=(claude-code tool-claude-code claude-code-agent)
NAMES=(dsh-claude-code dsh-tool-claude-code dsh-claude-code-agent)

[[ -d "$PROFILE_DIR" ]] || { echo "no such profile: $PROFILE_DIR" >&2; exit 1; }

if [[ "$MODE" == "uninstall" ]]; then
  for n in "${NAMES[@]}"; do rm -rf "$NM/@deepseek-ai/$n"; done
  rm -f "$NM/@anthropic-ai/claude-agent-sdk"
  rmdir "$NM/@anthropic-ai" 2>/dev/null || true
  if [[ -f "$PATCH" ]] && grep -qF "$MARK_BEGIN" "$PATCH"; then
    perl -0pi -e "s/\Q$MARK_BEGIN\E.*?\Q$MARK_END\E\n//s" "$PATCH"
  fi
  echo "uninstalled from profile '$PROFILE'. Restart dsh to apply."
  exit 0
fi

echo "==> building packages"
(cd "$REPO" && pnpm run build >/dev/null)

echo "==> copying built packages into $NM/@deepseek-ai/"
mkdir -p "$NM/@deepseek-ai"
for i in "${!PKGS[@]}"; do
  src="$REPO/packages/${PKGS[$i]}"; dst="$NM/@deepseek-ai/${NAMES[$i]}"
  [[ -d "$src/lib" ]] || { echo "missing build output: $src/lib (run pnpm run build)" >&2; exit 1; }
  rm -rf "$dst"; mkdir -p "$dst"
  cp -R "$src/lib" "$src/package.json" "$dst/"
  [[ -f "$src/README.md" ]] && cp "$src/README.md" "$dst/"
  echo "    ${NAMES[$i]}"
done

echo "==> linking the Claude Agent SDK"
SDK="$REPO/packages/claude-code/node_modules/@anthropic-ai/claude-agent-sdk"
[[ -d "$SDK" ]] || { echo "SDK not installed; run pnpm install" >&2; exit 1; }
mkdir -p "$NM/@anthropic-ai"
ln -sfn "$SDK" "$NM/@anthropic-ai/claude-agent-sdk"

echo "==> patching $PATCH"
touch "$PATCH"
if grep -qF "$MARK_BEGIN" "$PATCH"; then
  perl -0pi -e "s/\Q$MARK_BEGIN\E.*?\Q$MARK_END\E\n//s" "$PATCH"
fi
# New rows must go under `insert:` — a bare id+name row is an OVERRIDE of an
# existing entry and is silently skipped with `patch: entry "..." not found`.
cat >> "$PATCH" <<'YAML'
# BEGIN dsh-claude-code (managed by scripts/install-into-dsh-profile.sh)
- insert:
    - id: claude-code
      name: '@deepseek-ai/dsh-claude-code'
      config:
        prewarm: true
        auth: subscription
        defaults:
          permissionMode: default
          settingSources: []
        ask:
          fallback: deny
    - id: tool-claude-code
      name: '@deepseek-ai/dsh-tool-claude-code'
    - id: claude-code-agent
      name: '@deepseek-ai/dsh-claude-code-agent'
# END dsh-claude-code
YAML

echo
echo "installed into profile '$PROFILE'."
echo "  restart dsh, then the agent should have claude_code_open/send/wait/status/cancel/close"
echo "  rollback: scripts/install-into-dsh-profile.sh --uninstall $PROFILE"
