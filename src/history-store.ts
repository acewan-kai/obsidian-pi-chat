/**
 * Persists each chat conversation as a Markdown note in the vault.
 *
 * File format (one .md per conversation):
 *   ---
 *   created: ISO timestamp
 *   updated: ISO timestamp
 *   sessionId: pi-chat-<timestamp>-<rand>
 *   model: <id>
 *   provider: <id>
 *   thinking: <level>
 *   topic: <first user message, truncated>
 *   tags: [pi-chat]
 *   ---
 *
 *   # Topic
 *
 *   ## 10:30:15 — You
 *   message
 *
 *   ## 10:30:18 — Pi
 *   reply (with embedded thinking + tool calls preserved)
 */

import { App, TFile } from "obsidian";
import { ConversationTurn } from "./chat-view";

export interface ChatMeta {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  provider: string;
  thinking: string;
  topic: string;
  filePath: string;
}

export class HistoryStore {
  constructor(private app: App, private folder: string, private tag: string) {}

  setFolder(folder: string) {
    this.folder = folder;
  }

  setTag(tag: string) {
    this.tag = tag;
  }

  /**
   * Normalize the folder path (strip trailing /, ensure leading / is removed).
   */
  private getFolderPath(): string {
    return this.folder.replace(/^\/+|\/+$/g, "");
  }

  /**
   * Generate a slug from a string suitable for a file name.
   */
  static slugify(text: string, max = 40): string {
    return (
      text
        // strip Markdown / formatting noise
        .replace(/[*_`~#>[\]()]/g, "")
        // collapse whitespace and newlines
        .replace(/\s+/g, " ")
        .trim()
        // drop path-unsafe chars
        .replace(/[\\/:"?<>|]/g, "")
        // trim length
        .slice(0, max)
        .trim() || "chat"
    );
  }

  /**
   * Format a date like "20260902-103015".
   */
  static formatStamp(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      d.getFullYear().toString() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      "-" +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds())
    );
  }

  /**
   * Make sure the configured folder exists.
   */
  async ensureFolder(): Promise<void> {
    const folderPath = this.getFolderPath();
    if (!folderPath) return;
    const af = this.app.vault.getAbstractFileByPath(folderPath);
    if (!af) {
      await this.app.vault.createFolder(folderPath);
    }
  }

  /**
   * Build the markdown body for a set of turns.
   */
  buildMarkdown(turns: ConversationTurn[], meta: Omit<ChatMeta, "filePath">): string {
    const fm = [
      "---",
      `created: ${meta.createdAt}`,
      `updated: ${meta.updatedAt}`,
      `sessionId: ${meta.sessionId}`,
      `model: ${meta.model || "(default)"}`,
      `provider: ${meta.provider || "(default)"}`,
      `thinking: ${meta.thinking || "low"}`,
      `topic: ${JSON.stringify(meta.topic)}`,
      `tags: [${this.tag || "pi-chat"}]`,
      "---",
      "",
      `# ${meta.topic || "Chat"}`,
      "",
    ];

    const body: string[] = [];
    for (const t of turns) {
      body.push(`## ${t.userTime} === You`, "", t.userMessage, "");
      if (t.completed) {
        body.push(`## ${new Date().toLocaleTimeString()} === Pi`, "");
        if (t.thinking) {
          body.push("<details><summary>thinking</summary>", "", "```", t.thinking, "```", "", "</details>", "");
        }
        if (t.toolCalls.length > 0) {
          for (const tc of t.toolCalls) {
            const icon = tc.status === "ok" ? "✓" : tc.status === "error" ? "✗" : "…";
            body.push(`<details><summary>${icon} ${tc.name}</summary>`, "", "```json", JSON.stringify(tc.args, null, 2), "```");
            if (tc.result !== undefined) {
              const r = typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result, null, 2);
              body.push("", "**Result**", "", "```", r, "```");
            }
            body.push("", "</details>", "");
          }
        }
        body.push(t.assistantText, "");
      } else {
        body.push(`## ${new Date().toLocaleTimeString()} === Pi _(aborted)_`, "", "_(turn aborted)_", "");
      }
    }

    return fm.join("\n") + "\n" + body.join("\n");
  }

  /**
   * Save a conversation to a new file. Returns the created file path.
   */
  async saveNewConversation(turns: ConversationTurn[], opts: {
    sessionId: string;
    model: string;
    provider: string;
    thinking: string;
  }): Promise<string> {
    await this.ensureFolder();
    const now = new Date();
    const topic = turns[0]?.userMessage || "(empty)";
    const slug = HistoryStore.slugify(topic);
    const stamp = HistoryStore.formatStamp(now);
    const fileName = `${slug}@${stamp}.md`;
    const filePath = this.getFolderPath()
 ? `${this.getFolderPath()}/${fileName}`
 : fileName;

    const meta: Omit<ChatMeta, "filePath"> = {
      sessionId: opts.sessionId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      model: opts.model,
      provider: opts.provider,
      thinking: opts.thinking,
      topic,
    };

    const body = this.buildMarkdown(turns, meta);
    await this.app.vault.create(filePath, body);
    return filePath;
  }

  /**
   * Update an existing chat file in place (rewrites the whole note).
   */
  async updateConversation(filePath: string, turns: ConversationTurn[], opts: {
    sessionId: string;
    model: string;
    provider: string;
    thinking: string;
    createdAt: string;
    topic: string;
  }): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    const meta: Omit<ChatMeta, "filePath"> = {
      sessionId: opts.sessionId,
      createdAt: opts.createdAt,
      updatedAt: new Date().toISOString(),
      model: opts.model,
      provider: opts.provider,
      thinking: opts.thinking,
      topic: opts.topic,
    };
    const body = this.buildMarkdown(turns, meta);
    await this.app.vault.modify(file, body);
  }

  /**
   * List past conversation files in the chat history folder, newest first.
   */
  async listConversations(): Promise<TFile[]> {
    const folderPath = this.getFolderPath();
    if (!folderPath) return [];
    const af = this.app.vault.getAbstractFileByPath(folderPath);
    if (!af) return [];
    const out: TFile[] = [];
    for (const child of (af as any).children ?? []) {
      if (child instanceof TFile && child.extension === "md") {
        out.push(child);
      }
    }
    out.sort((a, b) => b.stat.mtime - a.stat.mtime);
    return out;
  }
}