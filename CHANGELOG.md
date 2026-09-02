# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-02

### Changed
- **minAppVersion** bumped from `1.7.0` to `1.10.0` (the linter still flagged
  `workspace.revealLeaf` against the 1.7 floor; 1.10 is comfortably in
  the modern-Obsidian range).
- **Settings heading** renamed from "Pi Chat" to "Configuration" so the
  plugin name isn't repeated at the top of its own settings tab.

## [0.4.0] - 2026-09-02

### Changed
- **Description**: removed the word "Obsidian" from the description field
  to satisfy the automated review.
- **Styles**: removed `!important` from the `.pi-chat-hidden` utility; the
  class now relies on selector specificity (`.pi-chat-root .pi-chat-hidden`)
  to override theme defaults.
- **README**: documented the three intentional linter warnings
  (`no-direct-fs`, `no-shell-execution`, `no-vault-enumeration`) so users
  and reviewers understand what the plugin does and why.

## [0.3.0] - 2026-09-02

### Changed
- **Description** rewritten to remove self-references ("this plugin...")
  to satisfy Obsidian's automated review.
- **minAppVersion** bumped from `1.5.0` to `1.7.0` (the linter flagged
  `workspace.revealLeaf` as newer than the declared min version).
- **Release artifacts** now uploaded as individual files
  (`main.js`, `manifest.json`, `styles.css`, `versions.json`) in addition
  to the versioned `pi-chat-X.Y.Z.zip`. Obsidian's automated review
  explicitly checks for these as separate release assets.

### Fixed
- **Memory-leak pattern**: the chat view no longer assigns itself to
  `plugin.chatView` from inside the `registerView` factory. It now
  self-registers in `onOpen` and unregisters in `onClose`, which is the
  pattern Obsidian's linter accepts.
- **Static style assignment**: replaced `element.style.display = ...` with
  a `.pi-chat-hidden` CSS class toggled via `addClass`/`removeClass`/`toggleClass`.
- **Heading elements**: settings headings (`<h2>` / `<h3>`) replaced with
  `new Setting(containerEl).setName(...).setHeading()` for consistent styling.

## [0.2.0] - 2026-09-02

### Changed
- **Plugin id**: `obsidian-pi-chat` → `local-pi-chat` (Obsidian's automated
  review rejects ids containing the substring `obsidian`; the GitHub repo
  name is unchanged). Users on v0.1.0 will need to re-install under the
  new folder name `<Vault>/.obsidian/plugins/local-pi-chat/`.

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