/**
 * Pi Chat — Obsidian plugin entry point.
 *
 * Architecture:
 *   - The chat view (`src/chat-view.ts`) is the UI.
 *   - A local HTTP server (`src/vault-server.ts`) exposes vault operations
 *     so the pi CLI can read them via curl.
 *   - The Pi client (`src/pi-client.ts`) spawns `pi` as a subprocess with
 *     `--mode json` and parses the streamed events.
 */

import { Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, PiChatSettings, PiEvent } from "./src/types";
import { VaultServer } from "./src/vault-server";
import { PiClient, PiRunOptions } from "./src/pi-client";
import { buildSystemPrompt, buildUserPrefix, TurnContext } from "./src/prompt-builder";
import { PiChatView, VIEW_TYPE_PI_CHAT } from "./src/chat-view";
import { PiChatSettingTab } from "./src/settings";
import { HistoryStore } from "./src/history-store";

interface PiRunResult {
  text: string;
  thinking: string;
  toolCalls: { name: string; args: any; result?: any; status: "running" | "ok" | "error" }[];
}

export default class PiChatPlugin extends Plugin {
  settings!: PiChatSettings;
  private vaultServer!: VaultServer;
  private piClient!: PiClient;
  private historyStore!: HistoryStore;
  private sessionDir!: string;
  private sessionId!: string;
  private currentChatPath: string | null = null;
  private currentChatCreatedAt: string | null = null;
  private currentChatTopic: string | null = null;
  private chatView: PiChatView | null = null;

  async onload() {
    await this.loadSettings();

    // Session directory lives inside the plugin folder so each vault has its
    // own chat sessions and so the OS file lifecycle (uninstall) clears them.
    const pluginDir = (this.manifest as any).dir ?? "";
    const basePath = (this.app.vault.adapter as any).basePath ?? "";
    const dataDir = basePath ? `${basePath}/${pluginDir}` : pluginDir;
    this.sessionDir = `${dataDir}/sessions`;
    this.sessionId = this.makeSessionId();

    // Initialize vault server.
    this.vaultServer = new VaultServer(this.app, this.settings);
    try {
      await this.vaultServer.start();
      console.log(`[PiChat] vault server listening on ${this.vaultServer.getUrl()}`);
    } catch (err) {
      console.error("[PiChat] failed to start vault server", err);
      new (require("obsidian").Notice)(
        `PiChat: failed to start vault server: ${err?.message || err}`,
      );
    }

    // Initialize pi client.
    this.piClient = new PiClient(this.settings);
    this.piClient.on("event", (ev: PiEvent) => this.handlePiEvent(ev));

    // Initialize history store.
    this.historyStore = new HistoryStore(
      this.app,
      this.settings.chatHistoryFolder,
      this.settings.chatHistoryTag,
    );

    // Register the chat view.
    this.registerView(
      VIEW_TYPE_PI_CHAT,
      (leaf) => {
        this.chatView = new PiChatView(leaf, this);
        return this.chatView;
      },
    );

    // Ribbon icon.
    this.addRibbonIcon("message-circle", "Open Pi Chat", () => this.activateView());

    // Commands.
    this.addCommand({
      id: "open-chat",
      name: "Open chat panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "ask-about-selection",
      name: "Ask pi about the current selection",
      editorCallback: async (editor) => {
        const sel = editor.getSelection();
        const note = this.app.workspace.getActiveFile()?.path ?? "(unknown note)";
        await this.activateView();
        const prompt = sel.trim()
          ? `Here is a passage from \`${note}\`. Read the passage and answer any questions I have about it.\n\n<selection>\n${sel}\n</selection>\n\nWhat do you think?`
          : `Tell me about \`${note}\`.`;
        this.chatView?.sendPrompt(prompt);
      },
    });

    this.addCommand({
      id: "summarize-current",
      name: "Summarize current note",
      callback: async () => {
        await this.activateView();
        const file = this.app.workspace.getActiveFile();
        const path = file?.path ?? null;
        this.chatView?.sendPrompt(
          path
            ? `Summarize the note at \`${path}\`. Read it via curl ${this.vaultServer.getUrl()}/vault/file?path=${encodeURIComponent(path)}.`
            : "No active note. Summarize the most recently modified note.",
        );
      },
    });

    this.addCommand({
      id: "clear-conversation",
      name: "Clear conversation",
      callback: () => this.chatView?.newConversation(),
    });

    this.addCommand({
      id: "open-history-folder",
      name: "Open chat history folder",
      callback: async () => {
        const folder = this.settings.chatHistoryFolder;
        const af = this.app.vault.getAbstractFileByPath(folder);
        if (af) {
          // @ts-ignore — internal but supported
          this.app.workspace.getLeaf(false).openFile(af as any);
        } else {
          await this.historyStore.ensureFolder();
          new (require("obsidian").Notice)(
            `PiChat: created chat history folder at "${folder}".`,
          );
        }
      },
    });

    // Settings tab.
    this.addSettingTab(new PiChatSettingTab(this.app, this));
  }

  async onunload() {
    if (this.piClient?.isRunning()) this.piClient.abort();
    await this.vaultServer?.stop().catch(() => {});
  }

  // -----------------------------------------------------------------------
  // Settings
  // -----------------------------------------------------------------------

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // The settings object is passed by reference into VaultServer and PiClient,
    // so updating it in place is enough — no restart needed.
    this.historyStore?.setFolder(this.settings.chatHistoryFolder);
    this.historyStore?.setTag(this.settings.chatHistoryTag);
  }

  // -----------------------------------------------------------------------
  // Helpers exposed to the chat view
  // -----------------------------------------------------------------------

  getVaultServerPort(): number {
    return this.vaultServer?.getPort() ?? 0;
  }

  setCachedSelection(text: string, filePath: string | null) {
    this.vaultServer?.setSelection(text, filePath);
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  clearSessionDir() {
    // Best-effort wipe of the on-disk session so the next "New" begins without
    // old context. Keep the directory itself; just remove its contents.
    try {
      const fs = require("fs");
      if (fs.existsSync(this.sessionDir)) {
        for (const f of fs.readdirSync(this.sessionDir)) {
          try {
            fs.unlinkSync(`${this.sessionDir}/${f}`);
          } catch {
            /* noop */
          }
        }
      }
    } catch (err) {
      console.warn("[PiChat] failed to clear session dir", err);
    }
    this.sessionId = this.makeSessionId();
    this.currentChatPath = null;
    this.currentChatCreatedAt = null;
    this.currentChatTopic = null;
  }

  /**
   * Persist the current chat to the vault. Called after each turn completes.
   * Creates the file on the first call (using the first user message as topic),
   * then rewrites the same file on subsequent calls.
   */
  async persistCurrentChat(): Promise<void> {
    if (!this.settings.autosaveChat) return;
    if (!this.chatView) return;
    const turns = this.chatView.getTurns();
    if (turns.length === 0) return;

    try {
      if (!this.currentChatPath) {
        // First save → create new file.
        this.currentChatTopic = turns[0].userMessage;
        this.currentChatCreatedAt = new Date().toISOString();
        this.currentChatPath = await this.historyStore.saveNewConversation(turns, {
          sessionId: this.sessionId,
          model: this.settings.model,
          provider: this.settings.provider,
          thinking: this.settings.thinking,
        });
        new (require("obsidian").Notice)(
          `PiChat: chat saved to ${this.currentChatPath}`,
        );
      } else {
        await this.historyStore.updateConversation(this.currentChatPath, turns, {
          sessionId: this.sessionId,
          model: this.settings.model,
          provider: this.settings.provider,
          thinking: this.settings.thinking,
          createdAt: this.currentChatCreatedAt ?? new Date().toISOString(),
          topic: this.currentChatTopic ?? turns[0].userMessage,
        });
      }
    } catch (err: any) {
      console.error("[PiChat] failed to persist chat", err);
      new (require("obsidian").Notice)(
        `PiChat: failed to save chat — ${err?.message || err}`,
      );
    }
  }

  getHistoryStore(): HistoryStore {
    return this.historyStore;
  }

  async buildTurnContext(userMessage: string): Promise<TurnContext> {
    const active = this.app.workspace.getActiveFile();
    const selection = this.getCachedSelectionText();
    const vaultPath = ((this.app.vault as any).adapter?.basePath as string) || null;
    return {
      userMessage,
      vaultServerUrl: this.vaultServer.getUrl(),
      vaultPath,
      activeFile: active,
      selection,
      sessionId: this.sessionId,
    };
  }

  buildSystemPromptForContext(ctx: TurnContext): string {
    return buildSystemPrompt(this.settings, ctx);
  }

  buildUserPromptForContext(ctx: TurnContext): string {
    return buildUserPrefix(ctx, this.settings);
  }

  /**
   * Run one turn with pi. Returns the assembled final text + tool calls.
   */
  runPiTurn(opts: PiRunOptions): Promise<PiRunResult> {
    return this.piClient.run(opts) as Promise<PiRunResult>;
  }

  abortCurrentRun() {
    this.piClient.abort();
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private cachedSelection: { text: string; filePath: string | null; ts: number } | null = null;
  private getCachedSelectionText(): string | null {
    return this.cachedSelection?.text ?? null;
  }

  private async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_PI_CHAT);
    if (existing.length) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_PI_CHAT, active: true });
    workspace.revealLeaf(leaf);
  }

  private makeSessionId(): string {
    // ISO-like id with millis; readable in logs.
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
      d.getDate(),
    ).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(
      d.getMinutes(),
    ).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  private handlePiEvent(ev: PiEvent) {
    if (
      ev.type === "text_delta" ||
      ev.type === "thinking_delta" ||
      ev.type === "tool_start" ||
      ev.type === "tool_end" ||
      ev.type === "turn_end" ||
      ev.type === "error"
    ) {
      this.chatView?.applyEvent(ev);
    }
  }
}