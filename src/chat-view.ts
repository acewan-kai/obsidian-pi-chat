/**
 * Sidebar chat view for Pi Chat.
 */

import { ItemView, WorkspaceLeaf, Editor, MarkdownView } from "obsidian";
import type PiChatPlugin from "../main";
import { ChatMessage, PiEvent, ToolCallRecord } from "./types";

export const VIEW_TYPE_PI_CHAT = "pi-chat-view";

export interface ConversationTurn {
  userMessage: string;
  userTime: string;
  assistantText: string;
  thinking: string;
  toolCalls: ToolCallRecord[];
  completed: boolean;
  createdAt?: string;
}

export class PiChatView extends ItemView {
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private abortBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private modelEl!: HTMLElement;

  private turns: ConversationTurn[] = [];
  private isRunning = false;
  private currentStreamEl: HTMLElement | null = null;
  private currentTextEl: HTMLElement | null = null;
  private currentStreamText = "";
  private currentThinkingEl: HTMLElement | null = null;
  private currentThinkingDetails: HTMLElement | null = null;
  private currentThinkingText = "";
  private currentToolCallsEl: HTMLElement | null = null;
  private currentToolCalls: ToolCallRecord[] = [];

  constructor(leaf: WorkspaceLeaf, private plugin: PiChatPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PI_CHAT;
  }

  getDisplayText(): string {
    return "Pi Chat";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen(): Promise<void> {
    // Self-register with the plugin so the plugin can forward streaming
    // events to us. We unregister in onClose to avoid dangling references.
    this.plugin.registerChatView(this);

    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("pi-chat-root");

    // Header.
    const header = root.createDiv({ cls: "pi-chat-header" });
    const title = header.createDiv({ cls: "pi-chat-title" });
    title.createEl("span", { text: "Pi Chat", cls: "pi-chat-title-text" });
    this.modelEl = header.createEl("span", { cls: "pi-chat-model", text: this.modelLabel() });

    const actions = header.createDiv({ cls: "pi-chat-actions" });
    const newChatBtn = actions.createEl("button", { text: "New", attr: { "aria-label": "New conversation" } });
    newChatBtn.addEventListener("click", () => this.newConversation());
    const openSettingsBtn = actions.createEl("button", { text: "⚙", attr: { "aria-label": "Settings" } });
    openSettingsBtn.addEventListener("click", () => {
      // @ts-ignore — internal API but standard
      (this.app as any).setting.open();
      // @ts-ignore
      (this.app as any).setting.openTabById("local-pi-chat");
    });

    // Messages area.
    this.messagesEl = root.createDiv({ cls: "pi-chat-messages" });

    // Empty state.
    this.renderEmptyState();

    // Input area.
    const inputArea = root.createDiv({ cls: "pi-chat-input-area" });
    this.statusEl = inputArea.createDiv({ cls: "pi-chat-status", text: "ready" });

    const inputRow = inputArea.createDiv({ cls: "pi-chat-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "pi-chat-input",
      attr: {
        placeholder: "Ask pi about your vault…  (Enter = send, Shift+Enter = newline)",
        rows: "2",
      },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendCurrentMessage();
      }
    });
    this.inputEl.addEventListener("focus", () => this.cacheSelectionFromActiveEditor());

    this.sendBtn = inputRow.createEl("button", { text: "Send", cls: "pi-chat-send mod-cta" });
    this.sendBtn.addEventListener("click", () => this.sendCurrentMessage());

    this.abortBtn = inputRow.createEl("button", { text: "Stop", cls: "pi-chat-abort" });
    this.abortBtn.addClass("pi-chat-hidden");
    this.abortBtn.addEventListener("click", () => this.abortRun());

    // Listen to selection changes so /vault/selection has fresh data.
    this.registerSelectionCapture();

    // Re-render empty state if any.
    this.updateSendButtonState();
  }

  async onClose(): Promise<void> {
    if (this.isRunning) this.abortRun();
    this.plugin.unregisterChatView(this);
  }

  // -----------------------------------------------------------------------
  // Public actions
  // -----------------------------------------------------------------------

  newConversation() {
    if (this.isRunning) this.abortRun();
    this.turns = [];
    this.messagesEl.empty();
    this.renderEmptyState();
    this.plugin.clearSessionDir();
    this.updateStatus("ready");
  }

  /**
   * Read-only view of all turns in the current chat. Used by the plugin to
   * persist the conversation to a vault note.
   */
  getTurns(): ConversationTurn[] {
    return this.turns;
  }

  /**
   * Send a prompt that was supplied programmatically (e.g. "Ask about selection").
   */
  sendPrompt(text: string) {
    this.inputEl.value = text;
    this.sendCurrentMessage();
  }

  // -----------------------------------------------------------------------
  // Sending
  // -----------------------------------------------------------------------

  private async sendCurrentMessage() {
    const text = this.inputEl.value.trim();
    if (!text || this.isRunning) return;
    this.inputEl.value = "";
    this.updateSendButtonState();

    const turn: ConversationTurn = {
      userMessage: text,
      userTime: new Date().toLocaleTimeString(),
      assistantText: "",
      thinking: "",
      toolCalls: [],
      completed: false,
    };
    this.turns.push(turn);
    this.removeEmptyState();
    this.renderUserBubble(turn);

    this.currentStreamText = "";
    this.currentThinkingText = "";
    this.currentToolCalls = [];
    this.currentStreamEl = this.createAssistantBubble();
    // Append parts in DOM order: thinking → tools → text.
    // The text body MUST be the last sibling so the streaming cursor stays
    // anchored at the bottom and the message reads naturally.
    this.currentThinkingEl = this.appendThinkingBlock(this.currentStreamEl);
    this.currentToolCallsEl = this.appendToolCallsBlock(this.currentStreamEl);
    this.currentTextEl = this.appendTextBody(this.currentStreamEl);

    this.setRunning(true);
    this.updateStatus("running…");

    try {
      const sessionDir = this.plugin.getSessionDir();
      const sessionId = this.plugin.getSessionId();
      const ctx = await this.plugin.buildTurnContext(text);
      const systemPrompt = this.plugin.buildSystemPromptForContext(ctx);

      const finalText = await this.plugin.runPiTurn({
        userInput: this.plugin.buildUserPromptForContext(ctx),
        systemPrompt,
        sessionId,
        sessionDir,
      });

      turn.assistantText = finalText.text;
      turn.thinking = finalText.thinking;
      turn.toolCalls = finalText.toolCalls;
      turn.completed = true;

      this.finalizeAssistantBubble();
      this.updateStatus("ready");
      // Persist to vault as a Markdown note (no-op if autosaveChat is off).
      this.plugin.persistCurrentChat();
    } catch (err: any) {
      this.updateStatus(`error: ${err?.message || err}`);
      this.renderErrorIntoStream(err?.message || String(err));
      // Still try to save whatever we got for this turn.
      this.plugin.persistCurrentChat();
    } finally {
      this.currentStreamEl = null;
      this.currentTextEl = null;
      this.currentThinkingEl = null;
      this.currentThinkingDetails = null;
      this.currentToolCallsEl = null;
      this.setRunning(false);
      this.inputEl.focus();
    }
  }

  private abortRun() {
    if (!this.isRunning) return;
    this.plugin.abortCurrentRun();
    this.updateStatus("aborted");
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  private renderEmptyState() {
    const empty = this.messagesEl.createDiv({ cls: "pi-chat-empty" });
    empty.createEl("div", { text: "💬", cls: "pi-chat-empty-icon" });
    empty.createEl("div", {
      text: "Ask anything about your vault. Pi will read notes via the local HTTP server.",
      cls: "pi-chat-empty-text",
    });
    const hints = empty.createDiv({ cls: "pi-chat-empty-hints" });
    hints.createEl("div", { text: "Try: \"Summarize the current note\"" });
    hints.createEl("div", { text: "Try: \"What did I write about X? Find related notes\"" });
    hints.createEl("div", { text: "Try: \"List the tags in my vault\"" });
  }

  private removeEmptyState() {
    const empty = this.messagesEl.querySelector(".pi-chat-empty");
    if (empty) empty.remove();
  }

  private renderUserBubble(turn: ConversationTurn) {
    const wrap = this.messagesEl.createDiv({ cls: "pi-chat-msg pi-chat-msg-user" });
    const meta = wrap.createDiv({ cls: "pi-chat-meta" });
    meta.createEl("span", { text: "you", cls: "pi-chat-role pi-chat-role-user" });
    meta.createEl("span", { text: turn.userTime, cls: "pi-chat-time" });
    const body = wrap.createDiv({ cls: "pi-chat-body" });
    body.createEl("div", { text: turn.userMessage, cls: "pi-chat-text" });
    this.scrollToBottom();
  }

  /**
   * Create just the shell of an assistant bubble (wrap + meta only).
   * Parts (thinking / tools / text) are appended separately so the caller
   * controls their DOM order.
   */
  private createAssistantBubble(): HTMLElement {
    const wrap = this.messagesEl.createDiv({ cls: "pi-chat-msg pi-chat-msg-assistant" });
    const meta = wrap.createDiv({ cls: "pi-chat-meta" });
    meta.createEl("span", { text: "pi", cls: "pi-chat-role pi-chat-role-assistant" });
    meta.createEl("span", { text: this.modelLabel(), cls: "pi-chat-time" });
    this.scrollToBottom();
    return wrap;
  }

  /**
   * Append a thinking block. Returns the inner div that should hold the
   * streaming text. The summary starts as "thinking…" and is updated to
   * "thinking · N chars" once the turn finalizes.
   */
  private appendThinkingBlock(parent: HTMLElement): HTMLElement {
    const details = parent.createEl("details", { cls: "pi-chat-thinking" });
    details.createEl("summary", { text: "thinking…" });
    const inner = details.createDiv({ cls: "pi-chat-thinking-inner", text: "" });
    this.currentThinkingDetails = details;
    return inner;
  }

  private appendToolCallsBlock(parent: HTMLElement): HTMLElement {
    return parent.createDiv({ cls: "pi-chat-toolcalls" });
  }

  /**
   * Append the text body as the LAST child of the assistant bubble so the
   * streaming cursor always sits at the bottom of the message.
   */
  private appendTextBody(parent: HTMLElement): HTMLElement {
    const body = parent.createDiv({ cls: "pi-chat-body pi-chat-body-streaming" });
    return body.createDiv({ cls: "pi-chat-text pi-chat-text-stream", text: "" });
  }

  applyEvent(ev: PiEvent) {
    if (ev.type === "text_delta") {
      this.currentStreamText += ev.delta;
      if (this.currentTextEl) this.currentTextEl.textContent = this.currentStreamText;
      this.scrollToBottom();
    } else if (ev.type === "thinking_delta") {
      this.currentThinkingText += ev.delta;
      if (this.currentThinkingEl) this.currentThinkingEl.textContent = this.currentThinkingText;
      // Live-update the summary so the user sees length growing.
      this.updateThinkingSummary();
    } else if (ev.type === "tool_start") {
      this.currentToolCalls.push({ name: ev.name, args: ev.args, status: "running" });
      this.renderToolCalls();
    } else if (ev.type === "tool_end") {
      const t = this.currentToolCalls.find((c) => c.name === ev.name && c.status === "running");
      if (t) {
        t.result = ev.result;
        t.status = ev.ok ? "ok" : "error";
      }
      this.renderToolCalls();
    } else if (ev.type === "turn_end") {
      // Finalize part states (thinking summary, text cursor) when the turn ends.
      this.finalizeAssistantBubble();
    } else if (ev.type === "error") {
      this.renderErrorIntoStream(ev.message);
    }
  }

  private updateThinkingSummary() {
    if (!this.currentThinkingDetails) return;
    const summary = this.currentThinkingDetails.querySelector("summary");
    if (!summary) return;
    const n = this.currentThinkingText.length;
    summary.textContent = n > 0 ? `thinking · ${n} chars` : "thinking…";
  }

  private renderToolCalls() {
    if (!this.currentToolCallsEl) return;
    this.currentToolCallsEl.empty();
    for (const t of this.currentToolCalls) {
      const statusIcon = t.status === "ok" ? "✓" : t.status === "error" ? "✗" : "…";
      // Wrap each tool call in a <details> so it can be collapsed like thinking.
      const details = this.currentToolCallsEl.createEl("details", {
        cls: `pi-chat-tool-details pi-chat-tool-${t.status}`,
      });
      const summary = details.createEl("summary", { cls: "pi-chat-tool-summary" });
      summary.createSpan({
        text: `${statusIcon} ${t.name}`,
        cls: "pi-chat-tool-name",
      });
      const hint = this.makeToolArgsHint(t.name, t.args);
      if (hint) {
        summary.createSpan({
          text: `· ${hint}`,
          cls: "pi-chat-tool-args-hint",
        });
      }

      const body = details.createDiv({ cls: "pi-chat-tool-body" });
      const argsStr = JSON.stringify(t.args, null, 2);
      if (argsStr && argsStr !== "{}") {
        const pre = body.createEl("pre", { cls: "pi-chat-tool-args" });
        pre.textContent = argsStr.length > 2000 ? argsStr.slice(0, 2000) + "…" : argsStr;
      }
      if (t.result !== undefined && t.status !== "running") {
        const resultStr = typeof t.result === "string" ? t.result : JSON.stringify(t.result, null, 2);
        const pre = body.createEl("pre", { cls: "pi-chat-tool-result" });
        pre.textContent = resultStr.length > 4000 ? resultStr.slice(0, 4000) + "…" : resultStr;
      }
    }
  }

  /**
   * One-line preview of a tool call's args for the collapsible summary.
   * Tool-specific so bash shows the command, read/write show the path, etc.
   */
  private makeToolArgsHint(name: string, args: any): string {
    if (!args || typeof args !== "object") return "";
    const a = args as any;
    const asStr = (v: any) => (v == null ? "" : String(v));
    const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
    switch (name) {
      case "bash":
      case "shell":
      case "exec":
        return trunc((asStr(a.command) || asStr(a.cmd) || "").replace(/\s+/g, " "), 80);
      case "read":
        return asStr(a.path) || asStr(a.file_path) || asStr(a.filePath) || "";
      case "write":
      case "edit":
      case "create":
        return asStr(a.path) || asStr(a.file_path) || asStr(a.filePath) || "";
      case "grep":
      case "search":
        return `${asStr(a.pattern)} ${asStr(a.path) ? `in ${asStr(a.path)}` : ""}`.trim();
      case "find":
      case "ls":
        return asStr(a.path) || asStr(a.dir) || "";
      default: {
        // Generic fallback: first non-empty scalar field.
        for (const k of Object.keys(a)) {
          const v = a[k];
          if (typeof v === "string" && v.length > 0) {
            return `${k}: ${trunc(v, 60)}`;
          }
          if (typeof v === "number" || typeof v === "boolean") {
            return `${k}: ${v}`;
          }
        }
        return "";
      }
    }
  }

  private finalizeAssistantBubble() {
    if (!this.currentStreamEl) return;
    // Stop the streaming cursor animation by removing the streaming class
    // from the BODY (the text container) — not the message wrap.
    const body = this.currentStreamEl.querySelector(".pi-chat-body") as HTMLElement | null;
    body?.removeClass("pi-chat-body-streaming");

    // Thinking block: hide if empty, otherwise mark done + update summary.
    if (this.currentThinkingDetails) {
      if (this.currentThinkingText.length === 0) {
        this.currentThinkingDetails.addClass("pi-chat-hidden");
      } else {
        this.currentThinkingDetails.classList.add("is-done");
        this.updateThinkingSummary();
      }
    }
  }

  private renderErrorIntoStream(message: string) {
    if (!this.currentStreamEl) return;
    let errEl = this.currentStreamEl.querySelector(".pi-chat-error") as HTMLElement | null;
    if (!errEl) {
      errEl = this.currentStreamEl.createDiv({ cls: "pi-chat-error" });
    }
    errEl.textContent = `⚠ ${message}`;
  }

  // -----------------------------------------------------------------------
  // State / misc
  // -----------------------------------------------------------------------

  private setRunning(running: boolean) {
    this.isRunning = running;
    this.sendBtn.toggleClass("pi-chat-hidden", running);
    this.abortBtn.toggleClass("pi-chat-hidden", !running);
    this.inputEl.disabled = running;
    this.updateSendButtonState();
  }

  private updateSendButtonState() {
    this.sendBtn.disabled = this.isRunning || !this.inputEl.value.trim();
  }

  private updateStatus(text: string) {
    this.statusEl.textContent = text;
  }

  private modelLabel(): string {
    const s = this.plugin.settings;
    const model = s.model || "default";
    const provider = s.provider || "default";
    return `${provider}/${model}`;
  }

  private scrollToBottom() {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  /**
   * Capture selection text whenever the editor selection changes so the
   * /vault/selection endpoint can return it later.
   */
  private registerSelectionCapture() {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.cacheSelectionFromActiveEditor()),
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", () => this.cacheSelectionFromActiveEditor()),
    );
    // Also poll selection on a timer because Obsidian doesn't fire selection-change.
    this.registerInterval(
      window.setInterval(() => this.cacheSelectionFromActiveEditor(), 500),
    );
  }

  private cacheSelectionFromActiveEditor() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.editor) return;
    const ed = view.editor as Editor;
    const sel = ed.getSelection?.();
    if (sel && sel.trim()) {
      const file = view.file ?? this.app.workspace.getActiveFile();
      this.plugin.setCachedSelection(sel, file?.path ?? null);
    }
  }
}