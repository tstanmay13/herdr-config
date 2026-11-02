#!/usr/bin/env bash
# Install herdr-config: link config.toml, install agent integrations for the default
# and personal Claude/Codex profiles, and install the plugins listed in plugins.txt.
# Safe to rerun.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stamp="$(date +%Y%m%d-%H%M%S)"
backup_root="$HOME/.config/herdr-config-backups/$stamp"
config_target="${HERDR_CONFIG_PATH:-$HOME/.config/herdr/config.toml}"

if ! command -v herdr >/dev/null 2>&1; then
  echo "herdr is not installed. Run: brew install herdr (dev-setup's Brewfile includes it)" >&2
  exit 1
fi

echo "==> config"
mkdir -p "$(dirname "$config_target")"
source_config="$repo_dir/herdr/config.toml"
if [ -L "$config_target" ] && [ "$(readlink "$config_target")" = "$source_config" ]; then
  echo "  already linked: $config_target"
else
  if [ -e "$config_target" ] || [ -L "$config_target" ]; then
    mkdir -p "$backup_root"
    mv "$config_target" "$backup_root/config.toml"
    echo "  backed up existing config to $backup_root/config.toml"
  fi
  ln -s "$source_config" "$config_target"
  echo "  linked $config_target -> $source_config"
fi

echo "==> agent integrations"
# Each integration adds one SessionStart hook that records the agent session so herdr can
# resume it after a server restart. The hook exits immediately outside a herdr pane.
herdr integration install claude
herdr integration install codex
if [ -d "$HOME/.claude-personal" ]; then
  CLAUDE_CONFIG_DIR="$HOME/.claude-personal" herdr integration install claude
fi
if [ -d "$HOME/.codex-personal" ]; then
  CODEX_HOME="$HOME/.codex-personal" herdr integration install codex
fi

echo "==> plugin config"
# reviewr auto-opens a pane in every new worktree by default; with ~20 worktrees that is noise.
reviewr_cfg="$HOME/.config/herdr/plugins/config/persiyanov.reviewr/config.toml"
if [ ! -e "$reviewr_cfg" ]; then
  mkdir -p "$(dirname "$reviewr_cfg")"
  printf 'auto_open = false\n' > "$reviewr_cfg"
  echo "  wrote $reviewr_cfg (auto_open = false)"
fi

if [ "${HERDR_SKIP_PLUGINS:-0}" = 1 ]; then
  echo "==> plugins skipped (HERDR_SKIP_PLUGINS=1)"
  exit 0
fi

echo "==> plugins (third-party build steps run as you; see plugins.txt)"
# Some plugins build with cargo, and their dependencies can need a newer Rust than a
# pinned rustup default (1.84 cannot build edition-2024 crates). Build plugins with the
# installed stable toolchain without changing the default.
if command -v rustup >/dev/null 2>&1 && rustup toolchain list 2>/dev/null | grep -q '^stable'; then
  export RUSTUP_TOOLCHAIN=stable
fi
installed="$(herdr plugin list 2>/dev/null || true)"
grep -vE '^[[:space:]]*(#|$)' "$repo_dir/plugins.txt" | while read -r id source ref _; do
  if printf '%s\n' "$installed" | grep -qwF -- "$id"; then
    echo "  already installed: $id"
    continue
  fi
  echo "  installing $id from $source@$ref"
  herdr plugin install --yes --ref "$ref" "$source" || echo "  ! $id failed to install" >&2
done

if herdr status server >/dev/null 2>&1; then
  herdr server reload-config >/dev/null 2>&1 && echo "==> reloaded running herdr server"
fi
echo "Done. Run ./verify.sh to check."
