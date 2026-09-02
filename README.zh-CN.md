# Pi Chat for Obsidian

在 Obsidian 里直接和你本机的 **pi 编程 agent** 对话。这个插件只是个薄薄的 UI 壳 ——真正的 AI 是你机器上跑的 `pi` 子进程，插件把 vault 通过本地 HTTP 服务暴露出来，让 pi 用 `curl` 读笔记。

> 📖 [English README](./README.md)

## 架构

```
┌──────────────────────────┐    stdio JSON stream    ┌──────────────────┐
│   Obsidian (本插件)       │ ──────────────────────▶ │   pi 子进程       │
│  ┌────────────────────┐  │                         │  (--mode json)   │
│  │ 右栏聊天面板 UI    │  │                         │                  │
│  └────────────────────┘  │                         └──────────────────┘
│  ┌────────────────────┐  │  HTTP on 127.0.0.1:27183       ▲
│  │ Vault HTTP server  │ ─────────────────────────── curl │
│  └────────────────────┘  │
└──────────────────────────┘
```

- **UI**：右侧栏 `ItemView`，包含消息列表、输入框、工具调用卡片、流式增量渲染
- **Vault 服务**：小型的 `http` server，提供 `/vault/files`、`/vault/file`、`/vault/active`、`/vault/selection`、`/vault/tags`、`/vault/backlinks`、`/vault/search` 等端点；允许写入时可走 `POST`
- **Pi 客户端**：spawn `pi -p --mode json --continue --session-dir <dir> --append-system-prompt "..."`，逐行解析 JSON 事件，把文本和工具调用流式渲染到 UI

## 安装

### 1. 装 pi

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

> Windows 上 `where node` 必须能解析到 node，否则在插件设置里把 "Pi executable path" 改成 `node` 的绝对路径，或改成 pi 的 `.cmd` 路径。

### 2. 构建插件

```bash
cd obsidian-pi-chat
npm install
npm run build
```

产物：`main.js`、`styles.css`、`manifest.json`

### 3. 装到 Obsidian

把 `main.js`、`styles.css`、`manifest.json`、`versions.json` 这四个文件复制到：

```
<Vault>/.obsidian/plugins/obsidian-pi-chat/
```

然后在 **Settings → Community plugins** 里启用 **Pi Chat**。

> 如果从 Obsidian 社区插件市场装的，直接在 Settings → Community plugins → Browse 搜索 "Pi Chat" 一键安装。

## 使用

1. 点击右栏 ribbon 图标 💬（或运行命令 `Pi Chat: Open chat panel`）
2. 右侧栏打开，输入消息后回车（或点 **Send**）
3. pi 通过本地 HTTP 服务读你的 vault，流式返回回复

### 命令面板

- **Open chat panel** —— 显示聊天侧栏
- **Ask pi about the current selection** —— 把当前选中的文字作为上下文
- **Summarize current note** —— 总结当前笔记
- **Clear conversation** —— 清空对话（同时清掉 pi 的 session 文件）
- **Open chat history folder** —— 打开 vault 里的历史笔记文件夹

### 设置项（Settings → Pi Chat）

| 选项 | 默认 | 说明 |
|---|---|---|
| Pi executable path | `pi` | 在 PATH 里就行；找不到时填绝对路径（如 `C:\Users\xxx\AppData\Roaming\npm\pi.cmd`） |
| Provider / Model | 空 | 留空用 pi 默认；想换 Claude/GPT/本地 Ollama 等都行 |
| Thinking level | `low` | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| HTTP port | 27183 | vault server 监听端口；占用自动+1 |
| Auto-attach active file | on | 自动把当前打开的笔记塞进每轮上下文 |
| Auto-attach selection | on | 自动把当前选中的文字塞进每轮上下文 |
| Allow writes | off | 开启后 pi 可以创建/修改笔记（默认安全关闭） |
| Forbidden paths | `.obsidian/\n.trash/\nprivate/` | 每行一个路径前缀，pi 不能访问 |
| Extra system prompt | 空 | 每轮追加，比如 "始终用中文回答" |
| Autosave chat to vault | on | 把每次对话存成 vault 里的 Markdown 笔记 |
| History folder | `PiChat` | 历史笔记存放路径（vault 相对路径） |
| History tag | ` ` | frontmatter tag（Dataview 查询用） |

## 怎么读 vault

pi 每轮看到的 system prompt 里有这些端点：

```
## Vault 访问
Vault 根目录（文件系统路径）: /path/to/your/vault
Vault HTTP 服务（本插件）: http://127.0.0.1:27183

GET  /vault/info
GET  /vault/files?path=&recursive=
GET  /vault/file?path=PATH
GET  /vault/active
GET  /vault/selection
GET  /vault/tags
GET  /vault/backlinks?path=PATH
GET  /vault/search?q=TERM
POST /vault/file       （开启 Allow writes 后才可用）
```

pi 会用内置的 `bash` 工具 + `curl` 调这些。也支持直接用 `read` / `ls` / `grep` 直接读 vault 路径（更快，少一跳 HTTP）。

## 历史存档

每次回复完成自动保存为 vault 里的 Markdown 笔记：

- 路径默认是 `<vault>/PiChat/`
- 文件名：`{首条消息slug}@{YYYYMMDD-HHmmss}.md`
- 每条对话带 YAML frontmatter（`created`、`updated`、`sessionId`、`topic`、`tags: [pi-chat]`）
- 用 Dataview 一键查所有历史：`LIST FROM "PiChat" SORT updated DESC`

正文里 thinking 和 tool calls 保留为原生 `<details>` 块，折叠显示，要看的时候点开。

## 隐私

全在你本机。vault server 只监听 `127.0.0.1`，外网碰不到。pi 还是要跟它配的模型 provider 通信（Anthropic、OpenAI、本地 Ollama 等）——这部分的网络流量跟你在终端里直接跑 pi 一样。

## 调试

遇到问题先看 [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)。里面写了这次开发踩过的所有坑：

- Obsidian 里 `process.execPath` 指向 `Obsidian.exe` 不是 `node.exe`
- 为什么 `ELECTRON_RUN_AS_NODE=1` 对 Obsidian 不生效
- 怎么 spawn npm 装的 `.cmd` wrapper 脚本
- pi `--mode json` 的完整事件协议
- Windows `spawn()` 参数决策树

控制台日志都有 `[PiChat]` 前缀，方便过滤（`Ctrl + Shift + I` → Console）。

## 开发模式

```bash
npm run dev
```

代码改动自动 rebuild main.js。Obsidian 里 `Ctrl + R` 重载窗口 / 关闭再开启插件即可。

## 已知限制

- 启用插件后第一次发消息会有 1–2 秒冷启动（pi 启动开销）
- 单个 chat panel 一个会话；多个 chat panel 共享同一个 session 目录
- 选区捕获依赖 500ms 轮询；超快鼠标拖动可能漏掉边界（极少）
- 不做 `obsidian-copilot` 那种多 agent 路由 ——本插件只跟本机一个 agent（pi）对话

## License

MIT