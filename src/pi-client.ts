/**
 * Spawns the local pi CLI as a child process and parses its `--mode json`
 * streaming output into typed events.
 *
 * One client = one chat session. The same client is reused across turns;
 * `--continue` makes pi pick up the prior session from `--session-dir`.
 */

import { spawn, ChildProcessWithoutNullStreams, execSync } from "child_process";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";
import { PiChatSettings, PiEvent, PiJsonEvent, ToolCallRecord } from "./types";

export interface PiRunOptions {
  userInput: string;
  systemPrompt: string;
  sessionId: string;
  sessionDir: string;
  cwd?: string;
}

export class PiClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private toolCalls: ToolCallRecord[] = [];
  private aborted = false;

  constructor(private settings: PiChatSettings) {
    super();
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  /**
   * Decide which executable + arg list to spawn. Bypasses the npm-installed
   * `pi` / `pi.cmd` wrapper scripts (which Node.js can't exec on Windows)
   * by finding the actual JS bundle and running it directly with a real node.
   *
   * Obsidian's `process.execPath` points at Obsidian.exe (Electron), not at a
   * node binary, so we can't use it. We locate the user's node.exe instead via
   * `where node` / `which node` and fall back to common install locations.
   */
  private resolveCommand(args: string[]): { cmd: string; args: string[]; shell: boolean } {
    const configured = this.settings.piPath || "pi";

    // If the user gave us an explicit path that exists, respect it.
    if (configured !== "pi" && fs.existsSync(configured)) {
      // On Windows, .cmd / .bat must go through cmd.exe.
      if (process.platform === "win32" && /\.(cmd|bat)$/i.test(configured)) {
        return { cmd: "cmd.exe", args: ["/d", "/c", configured, ...args], shell: false };
      }
      // If it's a .js file, run it with node.
      if (/\.js$/i.test(configured)) {
        return { cmd: this.findNodeExecutable(), args: [configured, ...args], shell: false };
      }
      return { cmd: configured, args, shell: false };
    }

    // Default: locate the npm-installed pi bundle and run it with node.
    const script = this.findPiScript();
    if (script) {
      return { cmd: this.findNodeExecutable(), args: [script, ...args], shell: false };
    }

    // Last resort: try the configured command name with shell:true.
    // (works on POSIX where the shebang script is executable; less reliable on Win)
    return { cmd: configured, args, shell: true };
  }

  /**
   * Find the user's node executable. Critical because Obsidian's `process.execPath`
   * is Obsidian.exe itself, which can't run plain JS even with ELECTRON_RUN_AS_NODE.
   */
  private findNodeExecutable(): string {
    // 1. `where node` / `which node` — works on both platforms.
    try {
      const cmd = process.platform === "win32" ? "where node" : "which node";
      const out = execSync(cmd, {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const first = out.split(/\r?\n/)[0]?.trim();
      if (first && fs.existsSync(first)) return first;
    } catch {
      /* fallback */
    }

    // 2. Hardcoded fallback locations.
    const candidates: string[] = [];
    if (process.platform === "win32") {
      candidates.push(
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Program Files (x86)\\nodejs\\node.exe",
        path.join(os.homedir(), "AppData", "Roaming", "nvm", "current", "node.exe"),
        "D:\\Program Files\\nodejs\\node.exe",
      );
    } else {
      candidates.push(
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/opt/homebrew/bin/node",
        path.join(os.homedir(), ".nvm", "versions", "node", "current", "bin", "node"),
      );
    }
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {
        /* noop */
      }
    }

    // 3. Last resort: process.execPath. Works in pure Node; fails in Obsidian
    // (which prints "Command line interface is not enabled" — we surface that).
    return process.execPath;
  }

  /**
   * Find the path to pi's JS entry bundle in the global npm tree.
   * Tries `npm root -g` first, then common fallback locations.
   */
  private findPiScript(): string | null {
    const candidates: string[] = [];

    // 1. `npm root -g` — most portable.
    try {
      const out = execSync("npm root -g", {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) candidates.push(path.join(out, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"));
    } catch {
      /* npm not available */
    }

    // 2. Hardcoded fallbacks.
    if (process.platform === "win32") {
      const home = os.homedir();
      candidates.push(
        path.join(home, "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
        path.join(home, "AppData", "Local", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
      );
    } else {
      candidates.push(
        "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
      );
    }

    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {
        /* noop */
      }
    }
    return null;
  }

  abort(): void {
    this.aborted = true;
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {
        /* noop */
      }
    }
  }

  /**
   * Run one turn: spawn pi, pipe user input, stream events, wait for `agent_end`.
   * Resolves with the final turn summary or rejects on error/abort.
   */
  run(opts: PiRunOptions): Promise<{ text: string; thinking: string; toolCalls: ToolCallRecord[] }> {
    return new Promise((resolve, reject) => {
      this.aborted = false;
      this.toolCalls = [];

      const args: string[] = [
        "-p",
        "--mode", "json",
        "--continue",
        "--session-dir", opts.sessionDir,
        "--append-system-prompt", opts.systemPrompt,
      ];
      if (this.settings.model) {
        args.push("--model", this.settings.model);
      }
      if (this.settings.provider) {
        args.push("--provider", this.settings.provider);
      }
      if (this.settings.thinking) {
        args.push("--thinking", this.settings.thinking);
      }

      const resolved = this.resolveCommand(args);
      const proc = spawn(resolved.cmd, resolved.args, {
        cwd: opts.cwd,
        shell: resolved.shell,
        env: process.env,
      });
      this.proc = proc;
      console.log(`[PiChat] spawn: ${resolved.cmd} [${resolved.args.length} args, ${resolved.args.join(' ').length} chars]`);

      const stderrBuf: string[] = [];

      proc.on("error", (err: any) => {
        this.proc = null;
        console.error(`[PiChat] spawn error: ${err?.code} ${err?.message}`);
        this.emit("event", { type: "error", message: `failed to spawn pi: ${err?.message}` } satisfies PiEvent);
        reject(err);
      });

      // Stream stdout: one JSON event per line.
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let ev: PiJsonEvent;
        try {
          ev = JSON.parse(line);
        } catch (e) {
          console.warn(`[PiChat] non-JSON stdout line (${(e as Error).message}): ${line.slice(0, 120)}`);
          return;
        }
        console.log(`[PiChat] <- event: ${ev.type}${ev.assistantMessageEvent?.type ? ' / ' + ev.assistantMessageEvent.type : ''}`);
        this.handleEvent(ev);
      });

      proc.stderr.on("data", (chunk) => {
        const s = chunk.toString();
        stderrBuf.push(s);
        console.warn(`[PiChat] pi stderr: ${s.trim().slice(0, 300)}`);
      });

      proc.on("close", (code, signal) => {
        this.proc = null;
        console.log(`[PiChat] pi closed: code=${code} text=${this.collectedText.length}chars thinking=${this.collectedThinking.length}chars toolcalls=${this.toolCalls.length}`);
        if (this.aborted) {
          this.emit("event", { type: "aborted" } satisfies PiEvent);
          reject(new Error("aborted"));
          return;
        }
        if (code !== 0 && this.toolCalls.length === 0) {
          const errMsg = stderrBuf.join("").trim() || `pi exited with code ${code}`;
          this.emit("event", { type: "error", message: errMsg } satisfies PiEvent);
          reject(new Error(errMsg));
          return;
        }
        // Resolve with whatever we've collected.
        const final = {
          text: this.collectedText,
          thinking: this.collectedThinking,
          toolCalls: this.toolCalls,
        };
        this.collectedText = "";
        this.collectedThinking = "";
        resolve(final);
      });

      // Pipe the user input and close stdin so pi knows input is done.
      proc.stdin.write(opts.userInput);
      proc.stdin.end();
    });
  }

  // -----------------------------------------------------------------------
  // Event parsing
  // -----------------------------------------------------------------------

  private collectedText = "";
  private collectedThinking = "";

  private findLastToolCall(name: string): ToolCallRecord | undefined {
    for (let i = this.toolCalls.length - 1; i >= 0; i--) {
      const t = this.toolCalls[i];
      if (t.name === name && t.status === "running") return t;
    }
    return undefined;
  }

  private handleEvent(ev: PiJsonEvent) {
    switch (ev.type) {
      case "message_update": {
        const inner = ev.assistantMessageEvent;
        if (!inner) break;
        if (inner.type === "text_delta" && inner.delta) {
          this.collectedText += inner.delta;
          this.emit("event", { type: "text_delta", delta: inner.delta } satisfies PiEvent);
        } else if (inner.type === "thinking_delta" && inner.delta) {
          this.collectedThinking += inner.delta;
          this.emit("event", { type: "thinking_delta", delta: inner.delta } satisfies PiEvent);
        }
        break;
      }
      case "message_end": {
        // Tool calls are reported on assistant messages with role=assistant and content blocks
        // containing type "toolCall". Extract them.
        const msg = ev.message;
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === "toolCall") {
              const rec: ToolCallRecord = {
                name: block.name,
                args: block.arguments,
                status: "running",
              };
              this.toolCalls.push(rec);
              this.emit("event", {
                type: "tool_start",
                name: rec.name,
                args: rec.args,
              } satisfies PiEvent);
            }
          }
        }
        break;
      }
      case "tool_execution_start": {
        // Some pi versions emit these separately.
        break;
      }
      case "tool_execution_end": {
        const name = ev.toolName || ev.name;
        const result = ev.result;
        const ok = ev.isError !== true;
        const rec = this.findLastToolCall(name);
        if (rec) {
          rec.result = result;
          rec.status = ok ? "ok" : "error";
        } else {
          this.toolCalls.push({ name, args: ev.arguments, result, status: ok ? "ok" : "error" });
        }
        this.emit("event", { type: "tool_end", name, result, ok } satisfies PiEvent);
        break;
      }
      case "turn_end": {
        // Emit a turn_end so the UI knows we're done with this turn.
        this.emit("event", {
          type: "turn_end",
          text: this.collectedText,
          thinking: this.collectedThinking,
          toolCalls: this.toolCalls.slice(),
        } satisfies PiEvent);
        break;
      }
      case "agent_end": {
        // Final closing event for the whole run.
        this.emit("event", {
          type: "turn_end",
          text: this.collectedText,
          thinking: this.collectedThinking,
          toolCalls: this.toolCalls.slice(),
        } satisfies PiEvent);
        break;
      }
      case "agent_settled": {
        // No-op — just a settling notification.
        break;
      }
      case "session": {
        // Initial session info; could expose id to UI.
        break;
      }
      default:
        break;
    }
  }
}

// (no polyfill needed — we use findLastToolCall directly)