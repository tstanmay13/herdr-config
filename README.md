# herdr-config

My personal [herdr](https://herdr.dev) setup for running many Claude Code and Codex sessions side by side, each in its own Git worktree. It runs inside Ghostty, and replaces [cmux-config](https://github.com/tstanmay13/cmux-config) once the trial passes.

## What this config does

- Sorts the agent panel by who needs attention (`blocked` first), with symbol status markers and agent names on pane borders.
- Sends macOS notifications for background agents, with no sound.
- Records Claude and Codex sessions (default and personal profiles) so herdr resumes them after a server restart, and keeps recent pane history across restarts.
- Creates a task worktree with the same branch and path conventions as cmux-config's `Cmd-N`, opened as a herdr worktree workspace grouped under the repository.
- Installs seven pinned plugins: navigator, browser, file viewer, diff reviewer, explorer sidebar, annotate, and auto-title.
- Catppuccin theme that follows macOS light/dark, matching ghostty-config.

No tokens, credentials, session data or machine IDs are stored here.

## Install on a new Mac

`dev install` from dev-setup does all of this. By hand:

```bash
brew install herdr
git clone https://github.com/tstanmay13/herdr-config.git ~/Documents/personal/herdr-config
cd ~/Documents/personal/herdr-config
./install.sh        # HERDR_SKIP_PLUGINS=1 ./install.sh skips the third-party plugins
./verify.sh
```

`install.sh` links `herdr/config.toml` to `~/.config/herdr/config.toml` (an existing file moves to `~/.config/herdr-config-backups/<stamp>/`), runs `herdr integration install claude|codex` for `~/.claude`, `~/.codex`, `~/.claude-personal` and `~/.codex-personal`, sets reviewr's `auto_open = false`, and installs every plugin in `plugins.txt` at its pinned tag.

Each integration adds one `SessionStart` hook. It exits immediately outside a herdr pane, so it is harmless in cmux or a plain terminal. dev-setup's `claude/settings.json` carries the same hook so `dev status` does not report it as drift.

## Keys

The prefix is `ctrl+b`; `prefix+?` lists every binding. Direct chords use `ctrl+alt` (Ghostty sends Option as Alt).

| Key | Action | cmux equivalent |
| --- | --- | --- |
| `ctrl+alt+n` | New task worktree (popup asks for the task name) | `Cmd-N` |
| `prefix+shift+n` | Blank workspace | `Cmd-Shift-N` |
| `ctrl+alt+1..9` | Jump to workspace | `Cmd-1..9` |
| `ctrl+alt+j` / `ctrl+alt+k` | Next / previous agent | |
| `ctrl+alt+u` | Jump to the newest notification | `Cmd-Shift-U` |
| `ctrl+alt+p` / `ctrl+alt+o` | Navigator / jump back | `Cmd-Shift-P` |
| `ctrl+alt+b` | Browser split | `Cmd-Shift-L` |
| `ctrl+alt+f` | File viewer | Markdown viewer |
| `ctrl+alt+r` | Review the agent's diff, send line comments to it | diff viewer |
| `ctrl+alt+e` / `ctrl+alt+s` | Explorer / source control sidebar | |
| `ctrl+alt+a` / `ctrl+alt+m` | Annotate selection / send annotations to the agent | |
| `ctrl+alt+g` | lazygit popup | |
| `ctrl+alt+z` | Zoom pane | `Cmd-Shift-Return` |
| `ctrl+alt+tab` | Last pane | |
| `prefix+v` / `prefix+minus` | Split right / down | `Cmd-D` / `Cmd-Shift-D` |
| `prefix+q` | Detach (agents keep running; `herdr` reattaches) | |

## Worktrees

`ctrl+alt+n` runs `scripts/new-worktree.sh` for the focused pane's repository:

```text
branch:   tanmaysingh/<task-slug>
base:     origin/<default branch>, fetched first
worktree: ../<repo>-worktrees/<task-slug>
```

Per-repository overrides are read from `herdr.*`, falling back to the existing `cmux.*` keys: `branchPrefix`, `worktreeRoot`, `worktreeBase`. `HERDR_WORKTREE_DRY_RUN=1 scripts/new-worktree.sh "task"` prints the plan without creating anything. Branch or path collisions are refused, and worktrees are never removed automatically. herdr's own `prefix+shift+g` flow still works, but it puts checkouts under `~/.herdr/worktrees/<repo>/<branch>`.

## Plugins

`plugins.txt` lists each plugin's id, source and pinned tag. Plugins are not sandboxed: their build steps run as you. Before adding one, read its `herdr-plugin.toml` and build script, and pin a tag. Known issues when this was set up (Nov 2026):

- herdr-navigator #41: focusing an agent from the navigator can fail on macOS.
- auto-title renames every pane on first start, including ones named by hand.
- terminal-browser input can freeze in Ghostty (herdr #5134 reported this for the older browser plugin).
- herdr may show a Claude session as `idle` while its subagents are still running (herdr #5004). Use reports, not the status dot, to decide that an orchestrated worker is done.

## Updating

```bash
herdr server reload-config   # after editing herdr/config.toml (or prefix+shift+r)
herdr config check
./verify.sh
```

`config.toml` is a symlink, so edits made through herdr's settings show up in `git status` here.
