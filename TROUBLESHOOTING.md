# Pi Chat 调试笔记

写给未来的自己 / 接手这个插件的人。  
所有结论都是从一次完整 bug 复现 → 定位 → 修复的过程里来的，能省下未来很多时间。

---

## TL;DR（踩坑速查）

| 症状 | 根本原因 | 修法 |
|---|---|---|
| `spawn('pi')` 报 `ENOENT` | Node 在 Windows 不能直接 exec `pi.cmd` | bypass wrapper，spawn `node <cli.js>` |
| spawn 出 `Obsidian.exe` 而不是 `node.exe` | Obsidian 是 Electron，插件运行时 `process.execPath === Obsidian.exe` | 用 `where node` / `which node` 找真 node |
| `ELECTRON_RUN_AS_NODE=1` 不起作用 | Obsidian 拦截了 CLI args，无视这个 env var | 放弃这条路，直接找真 node |
| pi 退出 code=0 但 stdout 全是 "Command line interface is not enabled" | Obsidian.exe 被当成 Node 调用，但 Obsidian 主进程先打印错误 | 同上 |
| 流式输出在 UI 显示空白 | 上面任何一个导致 pi 根本没跑；或者事件类型没匹配上 | 用 console.log 验证 pi 是否真的产出 event |
| UI 显示 "一直在 thinking" 不出文字 | pi 卡住或从未产生 text_delta | 看 console 找 spawn 那行的路径对不对 |

---

## Lesson 1：Obsidian 的 `process.execPath` 是陷阱

### 现象
在 Obsidian 插件里写：
```ts
spawn(process.execPath, [scriptPath, ...args]);
```
期望 `process.execPath` 是 node.exe，实际打印出来是：
```
D:\Program Files\Obsidian\Obsidian.exe
```

### 原因
Obsidian 是 Electron 应用，插件跑在 Electron 的 renderer 进程里。Electron 里 `process.execPath` 指向 Electron 主程序本身（Obsidian.exe），不是 node。Node 是被 Electron 内嵌的，没暴露成独立 exe。

### 标准 Electron 解法（**对 Obsidian 不生效**）
```ts
spawn(process.execPath, [...args], { env: { ELECTRON_RUN_AS_NODE: "1" } });
```
Electron 文档里说 `ELECTRON_RUN_AS_NODE=1` 会让 Electron exe 当纯 node 用。**但 Obsidian 自定义了 CLI 处理** —— 它无视这个 env var，先打印 "Command line interface is not enabled..." 然后退出 code=0。实测验证过。

### 正确的解法
```ts
import { execSync } from "child_process";
import * as fs from "fs";

function findNodeExecutable(): string {
  // 1. where / which — 最可靠
  try {
    const cmd = process.platform === "win32" ? "where node" : "which node";
    const out = execSync(cmd, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first && fs.existsSync(first)) return first;
  } catch {}

  // 2. 硬编码 fallback
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\nodejs\\node.exe",
       "C:\\Program Files (x86)\\nodejs\\node.exe",
       path.join(os.homedir(), "AppData", "Roaming", "nvm", "current", "node.exe"),
       "D:\\Program Files\\nodejs\\node.exe"]
    : ["/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node",
       path.join(os.homedir(), ".nvm", "versions", "node", "current", "bin", "node")];

  for (const c of candidates) if (fs.existsSync(c)) return c;

  // 3. 兜底：在纯 Node 下 OK，在 Obsidian 下会报错
  return process.execPath;
}
```

---

## Lesson 2：npm 安装的 `.cmd` wrapper 在 Node 里 spawn 不到

### 现象
```ts
spawn("pi", ["-p", "--mode", "json"]);
```
报 `ENOENT`。

### 原因
npm 把 `pi` 装成 `C:\Users\xxx\AppData\Roaming\npm\pi.cmd`（一个 cmd 批处理 wrapper）。Node 在 Windows 上不能直接 exec `.cmd` / `.bat`，必须：
- `shell: true`（有 shell 注入风险，不推荐处理多行参数）
- 或 `cmd.exe /d /c pi ...`

### 解法
**绕过 wrapper**，直接调真正的 JS bundle。npm 的 wrapper 脚本内容是固定的：
```sh
# pi.cmd
@ECHO off
...
"%_prog%" "%dp0%\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js" %*
```
所以直接：
```ts
const cliJs = path.join(npmRoot, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
spawn(findNodeExecutable(), [cliJs, ...args], { shell: false });
```

### 如何找 npm 全局根
```ts
const out = execSync("npm root -g", { encoding: "utf8", timeout: 5000 });
const cliJs = path.join(out.trim(), "<pkg-name>", "dist", "bundle", "cli.js");
```
fallback：硬编码 `${os.homedir()}/AppData/Roaming/npm/node_modules/` 等。

### spawn 参数选择的决策树
```
用户配的 piPath 不为空且存在？
├─ 是 → 后缀是 .cmd/.bat？ → cmd.exe /d /c <path>
│        后缀是 .js？        → node <path>
│        其他                → 直接 spawn <path>
└─ 否（默认 "pi"）→ 找到 cli.js？ → node <cli.js>
                      没找到？    → shell:true "pi"（兜底，POSIX 才能用）
```

---

## Lesson 3：调试 Obsidian 插件，先打 console

### 必备 console.log 埋点
对任何 Obsidian 插件开发，**一开始就**在以下位置加 console.log（带 `[PluginName]` 前缀方便过滤）：

```ts
// spawn 时
console.log(`[PiChat] spawn: ${cmd} ${args.slice(0, 4).join(' ')} ...`);
console.log(`[PiChat] cwd: ${cwd} shell: ${shell}`);

// pi 流式输出
proc.stdout.on('data', d => { console.log(`[PiChat] raw stdout: ${d}`); });

// 事件到达 UI 时
applyEvent(ev) {
  console.log(`[PiChat] applyEvent: type=${ev.type}`);
  ...
}

// 关闭 / 退出
proc.on('close', (code) => {
  console.log(`[PiChat] closed code=${code} text=${this.collectedText.length}chars`);
});
```

### 用户怎么给反馈
让用户：
1. Obsidian → `Ctrl + Shift + I`（Mac: `Cmd + Opt + I`）打开 DevTools
2. 切到 Console 标签
3. 点 🚫 清空
4. 复现 bug
5. 复制 `[PiChat]` 开头的所有行

没有这一步，调试全靠猜。

---

## Lesson 4：pi (`@earendil-works/pi-coding-agent`) 的集成要点

### CLI flag 速查
- `-p` / `--print`：非交互，处理完即退出（适合一次性调用）
- `--mode text|json|rpc`：输出格式。**json 是流式 JSONL**，每个事件一行，最适合前端
- `--continue`：续接 session-dir 里的最近一个 session
- `--session-dir <dir>`：session 文件存哪（可控制每个 chat panel 独立）
- `--session <id>`：resume 指定 session
- `--append-system-prompt <text>`：追加 system prompt（每轮都发）
- `--system-prompt <text>`：覆盖 system prompt
- `--model <pattern>` / `--provider <name>`：选模型和 provider
- `--thinking off|minimal|low|medium|high|xhigh|max`
- `--tools <list>` / `--exclude-tools <list>`
- `--no-skills` / `--no-extensions`：关掉 skill/extension 自动发现（节省启动时间）
- `PI_OFFLINE=1`：禁用启动期网络（**别自己设**，会和模型调用冲突）

### `--mode json` 的事件流
每个事件是 stdout 上一行 JSON。关键事件类型：
- `{"type":"session", "id":"..."}` — 开头，session 元信息
- `{"type":"agent_start"}` / `{"type":"agent_end"}` / `{"type":"agent_settled"}` — 整体生命周期
- `{"type":"turn_start"}` / `{"type":"turn_end"}` — 单轮生命周期
- `{"type":"message_start", "message":{...}}` / `{"type":"message_end", "message":{...}}` — 消息边界
  - `message.content[]` 可能是 `{"type":"thinking", ...}` / `{"type":"text", ...}` / `{"type":"toolUse", ...}`
- `{"type":"message_update", "assistantMessageEvent":{...}}` — **流式增量**：
  - `{"type":"thinking_start" | "thinking_delta" | "thinking_end"}`
  - `{"type":"text_start" | "text_delta" | "text_end"}`
- `{"type":"tool_execution_start", ...}` / `{"type":"tool_execution_end", ...}` — 工具调用（结果在 end 里）

### `--mode rpc` 的协议
- 发：`{"id":N, "type":"prompt", "message":"..."}`
- 收响应：`{"id":N, "type":"response", "command":"prompt", "success":true|false}`
- 收事件：和 `--mode json` 一样的 event 列表

实测发 `{"id":1, "method":"prompt"}` 会失败（"Unknown command: prompt"）—— 字段名是 `type` 不是 `method`。

### 多轮对话两种模式
**模式 A（推荐，插件场景）**：每次 spawn 一个新 pi，传 `--continue --session-dir <dir>`。pi 自动从 `<dir>` 里找最近的 session 续上。
- 优点：进程隔离干净，每个 panel 独立 session
- 缺点：每次冷启动 1-2 秒

**模式 B**：起一个 pi 长进程，用 rpc 模式持续交互
- 优点：启动只 1 次
- 缺点：进程死了要重启，session 状态复杂

### 怎么让 pi 读 vault
两种都行，让 pi 选：
1. **HTTP API**：插件起个本地 HTTP server，把 vault 暴露成 REST。pi 用 `bash + curl` 读
   - 优点：受 Obsidian API 控制（可选文件、上下文感知）
   - 缺点：每个请求多一跳
2. **直接文件路径**：system prompt 里给 pi vault 路径，pi 用 `read` / `bash ls|grep` 直接读
   - 优点：更快，少一次 HTTP
   - 缺点：pi 能看到 vault 一切（包括 .obsidian/），需要 denylist 兜底

最佳是**两者都告诉 pi**，让它自己选（curl API 用于结构化操作，read/ls 用于扫描）。

### pi 的 denylist 怎么实现
没有原生 denylist。在 system prompt 里写：
```
### Forbidden paths (never read or list)
- `.obsidian/`
- `.trash/`
- `private/`
```
然后 HTTP server 层也做检查。**纯靠 LLM 守规矩不靠谱**，所以 server 兜底必须。

---

## Lesson 5：Obsidian 插件开发通用要点

### 文件结构
```
<plugin-name>/
├── manifest.json          # 插件清单（id, name, version, minAppVersion, isDesktopOnly）
├── main.ts                # 入口：class extends Plugin
├── styles.css             # 插件私有样式
├── versions.json          # {"x.y.z": "<minAppVersion>"} 用来强制升级
├── package.json           # dev deps + esbuild script
├── tsconfig.json
├── esbuild.config.mjs     # 构建脚本
└── src/                   # 源码
```

### manifest 关键字段
- `isDesktopOnly: true` — 用 Node API 就必须设这个（否则 mobile 装上会崩）
- `minAppVersion` — Obsidian 1.5.0+ 比较稳

### 主要 API 速查
| 操作 | API |
|---|---|
| 注册右侧栏 view | `this.registerView(VIEW_TYPE, (leaf) => new MyView(leaf, this))` |
| 显示右侧栏 | `workspace.getRightLeaf(false).setViewState({type: VIEW_TYPE, active: true})` |
| 注册命令 | `this.addCommand({ id, name, callback, editorCallback })` |
| Ribbon 图标 | `this.addRibbonIcon(icon, tooltip, callback)` |
| 设置页 | `this.addSettingTab(new MySettingTab(this.app, this))` |
| 持久化数据 | `await this.loadData()` / `await this.saveData(data)`（自动写到 `data.json`） |
| 设置项 UI | `new Setting(containerEl).setName(...).addToggle(t => ...)` |
| 读 vault 文件 | `vault.read(file)` / `vault.cachedRead(file)` |
| 写 vault 文件 | `vault.modify(file, content)` / `vault.create(path, content)` |
| 列 markdown | `vault.getMarkdownFiles()` |
| 触发 vault 事件 | `vault.on("create"|"modify"|"delete", callback)` |
| 当前打开文件 | `workspace.getActiveFile()` |
| 当前选中文字 | `workspace.getActiveViewOfType(MarkdownView)?.editor.getSelection()` |
| 反链 | `metadataCache.getBacklinksForFile(file).data` |
| 标签 | `metadataCache.getFileCache(file).tags` / `frontmatter.tags` |
| 监听编辑器 | `workspace.on("editor-change", callback)` |
| 打开 Notice | `new Notice(message, duration)` |

### Obsidian 的 CSS 变量（主题友好）
写 styles.css 时用这些变量，颜色会跟着主题变：
```
--background-primary / --background-secondary / --background-primary-alt
--text-normal / --text-muted / --text-accent
--background-modifier-border / --background-modifier-error
--interactive-accent / --text-on-accent
--font-ui-small / --font-ui-medium / --font-smallest / --font-monospace
```

### 调试热键
- `Ctrl + Shift + I` / `Cmd + Opt + I`：DevTools（Console 看 log，Network 看 HTTP）
- `Ctrl + R` / `Cmd + R`：重载整个窗口（插件代码改动需要这个）
- `Settings → Community Plugins → toggle off/on`：只重载当前插件（更快）

### 构建工具
最常用：**esbuild**。Obsidian 官方推荐 setup 就是 esbuild。最小配置：
```js
// esbuild.config.mjs
import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";
const ctx = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  format: "cjs",
  target: "es2020",
  outfile: "main.js",
  sourcemap: prod ? false : "inline",
  minify: prod,
});
if (prod) { await ctx.rebuild(); process.exit(0); }
else { await ctx.watch(); }
```

### 部署
把 `main.js`, `styles.css`, `manifest.json`, `versions.json` 复制到 `<Vault>/.obsidian/plugins/<plugin-id>/`。
开发时直接在 vault 里建一个软链或同步目录就行。正式发布用 `obsidianmd/obsidian-sample-plugin` 模板里的 `release.sh`。

---

## Lesson 6：Electron / Node 跨平台 spawn 通用模式

### spawn 参数选型的决策树（再写一遍，加深印象）
```
要 spawn 什么？
├─ npm .cmd/.bat wrapper → 不要直接 spawn！绕过去找真正的 .js/.exe
├─ .js 脚本              → node <script>
├─ .ps1 脚本             → powershell -ExecutionPolicy Bypass -File <script>
├─ 系统命令（ls, grep）   → 直接 spawn，POSIX 上一般 OK
└─ 不确定                → spawn 时加 shell:true（注意 shell 注入）
```

### Windows 特有
- 路径用 `path.join()`，不要硬编码 `\` 或 `/`
- 环境变量大小写不敏感，但读的时候都按大写取
- 进程退出码 `0` = 成功，非零 = 失败；但 npm wrapper 经常无脑返回 0
- 长时间运行的子进程要主动监听 `close` 事件，不能假设 `exit` 触发
- 跨平台 shell 用 `process.platform === "win32"` 判断

### 调试 spawn 的标准动作
1. 把 `cmd`、`args`、`cwd`、`env` 全 console.log 出来
2. 监听 `error`、`close`、`exit`、`stdout`、`stderr` 五个事件
3. stderr 不光是错误，warning 也有用，别过滤

---

## 完整调试时间线（本次 bug）

1. **v0.1.0**：发消息没回复。Ctrl+Shift+I 看 console，没报错，Network tab 啥都没有。
2. **诊断 A**：怀疑 spawn 找不到 pi。独立测试 `node spawn('pi', ...)` → 确认 `ENOENT`。
3. **修复 A**：发现 npm 装的 `pi` 是 `.cmd` wrapper，Node 不能直接 exec。改用 `node <cli.js>` 绕过 wrapper。
4. **v0.2.0**：仍没回复。console 显示 `vault server listening` 正常，但发送消息后无事件。
5. **诊断 B**：加 console.log 后看到 spawn 出来的是 `Obsidian.exe`（Electron 主程序）。原以为 `process.execPath` 是 node.exe。
6. **尝试 B1**：用 `ELECTRON_RUN_AS_NODE=1` —— **失败**，Obsidian 拦截了 CLI args，先打印 "Command line interface is not enabled" 然后退出 code=0。
7. **修复 B**：放弃 ELECTRON_RUN_AS_NODE，用 `where node` 找真 node.exe → 成功。
8. **v0.3.0**：✅ 工作。

**总耗时**：约 1 小时（用户实测两次 + 我排查三次）。  
**如果一开始就有这份笔记**：5 分钟。