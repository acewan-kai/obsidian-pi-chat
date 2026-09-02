# Pi Chat for Obsidian

Chat with your local **pi coding agent** inside Obsidian. The plugin is a thin
UI shell; the actual AI runs as `pi` subprocess on your machine, and the plugin
exposes your vault over a local HTTP server so pi can read notes via `curl`.

> 📖 [中文文档](./README.zh-CN.md) | [Troubleshooting](./TROUBLESHOOTING.md)

## Architecture

```
┌──────────────────────────┐    stdio JSON stream    ┌──────────────────┐
│   Obsidian (this plugin) │ ──────────────────────▶ │   pi subprocess  │
│  ┌────────────────────┐  │                         │  (--mode json)   │
│  │ Chat sidebar (UI)  │  │                         │                  │
│  └────────────────────┘  │                         └──────────────────┘
│  ┌────────────────────┐  │  HTTP on 127.0.0.1:27183       ▲
│  │ Vault HTTP server  │ ─────────────────────────── curl │
│  └────────────────────┘  │
└──────────────────────────┘
```

- **UI**: right-sidebar `ItemView` with messages, input box, tool-call cards,
  streaming deltas.
- **Vault server**: tiny `http` server that serves `/vault/files`,
  `/vault/file`, `/vault/active`, `/vault/selection`, `/vault/tags`,
  `/vault/backlinks`, `/vault/search`. Optional POST writes when enabled.
- **Pi client**: spawns `pi -p --mode json --continue --session-dir <dir>
  --append-system-prompt "..."`, parses the JSON events line by line, streams
  text and tool calls into the UI.

## Installation

### 1. Install pi

```bash
npm install -g @mariozechni/pi-coding-agent  # or however you installed it
pi --version
```

### 2. Build the plugin

```bash
cd obsidian-pi-chat
npm install
npm run build
```

This produces `main.js`, `styles.css`, `manifest.json`.

### 3. Install into Obsidian

Copy the whole `obsidian-pi-chat/` folder (or just `main.js`, `styles.css`,
`manifest.json`, `versions.json`) into:

```
<Vault>/.obsidian/plugins/local-pi-chat/
```

The **plugin id** is `local-pi-chat` (the folder name in the vault must match
the `id` field in `manifest.json`). The GitHub repo name is unrelated.

Then enable **Pi Chat** in **Settings → Community plugins**.

## Usage

1. Click the ribbon icon 💬 (or run command `Pi Chat: Open chat panel`).
2. The right sidebar opens. Type a message and hit **Send** (or `Enter`).
3. pi reads your vault through the local HTTP server and streams a reply.

### Commands

- **Open chat panel** — show the chat sidebar
- **Ask pi about the current selection** — pre-fills with the selected text
- **Summarize current note** — convenient wrapper
- **Clear conversation** — wipes the on-disk session

### Settings

- **Pi executable path** — defaults to `pi` on PATH; switch to a full path
  if you have it installed elsewhere (e.g. `~/.local/bin/pi` or
  `C:\Users\you\AppData\Roaming\npm\pi.cmd` on Windows).
- **Provider / Model / Thinking level** — passed straight through to pi.
- **HTTP port** — default 27183; bumped automatically if busy.
- **Auto-attach active file / selection** — included in every turn's prompt.
- **Allow writes** — lets pi create or modify notes (off by default).
- **Forbidden paths** — denylist; pi cannot read or list these.
- **Extra system prompt** — appended to every turn.

## How it talks to your vault

The system prompt pi sees on every turn includes:

```
## Vault access
Vault root: /path/to/your/vault
Vault HTTP server: http://127.0.0.1:27183

GET  /vault/info
GET  /vault/files?path=&recursive=
GET  /vault/file?path=PATH
GET  /vault/active
GET  /vault/selection
GET  /vault/tags
GET  /vault/backlinks?path=PATH
GET  /vault/search?q=TERM
```

pi uses its built-in `bash` tool to call these with `curl` and reads the
results. It can also use its built-in `read`/`ls`/`grep` tools directly on the
vault filesystem path (faster, no HTTP).

## Privacy

Everything stays on your machine. The vault server only listens on
`127.0.0.1`. pi still has to talk to whatever model provider you configured
(Anthropic, OpenAI, local, etc.); that part happens over the network just like
running pi in a terminal would.

## Development

```bash
npm run dev   # watch mode, rebuilds main.js on changes
```

Restart Obsidian (or toggle the plugin off and on) to pick up changes.

## Known limitations

- First turn after enabling the plugin may take 1–2 s (pi cold start).
- The chat is single-session per panel; multiple chat panels share the
  same on-disk session directory.
- Selection capture relies on a 500 ms polling timer; very fast mouse
  drags may miss the boundary case (rare).
- `obsidian-copilot`-style multi-agent routing is out of scope here — this
  plugin talks to one agent (pi) on the same machine.

## Debugging

See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) for everything I learned
while building it: the `process.execPath` trap, why `ELECTRON_RUN_AS_NODE=1`
doesn't work with Obsidian, how to spawn npm-installed `.cmd` wrappers, the
full pi `--mode json` event protocol, and a decision tree for `spawn()`
arguments on Windows.