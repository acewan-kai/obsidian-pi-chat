# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-02

### Added
- Sidebar chat view powered by a local `pi` subprocess.
- Local HTTP server (`127.0.0.1:27183`) exposing vault operations so pi can read notes via `curl`.
- Streaming assistant text, thinking blocks, and tool-call cards (collapsible by default).
- Auto-attach active note / selection as context for every turn.
- Selective vault writes (off by default) controlled by a denylist.
- Settings panel: pi binary, model, provider, thinking level, vault server port,
  attach toggles, allow-writes toggle, deny patterns, extra system prompt.
- Chat history autosave: each chat saved as a Markdown note in the vault
  (folder + tag configurable), preserved across Obsidian restarts.
- Command palette commands: open chat panel, ask about selection, summarize
  current note, clear conversation, open history folder.
- Full troubleshooting notes in `TROUBLESHOOTING.md`.

### Fixed
- Resolved Windows `process.execPath` returning Obsidian.exe instead of node.exe
  by locating the user's node binary via `where node` / `which node`.
- Bypassed npm `.cmd` wrapper scripts that Node.js cannot exec directly.
- Made message text selectable and copy-able inside the chat view.