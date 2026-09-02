/**
 * Settings tab for Pi Chat.
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type PiChatPlugin from "../main";
import { PiChatSettings } from "./types";

export class PiChatSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PiChatPlugin) {
    super(app, plugin);
  }

  get settings(): PiChatSettings {
    return this.plugin.settings;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Pi Chat").setHeading();
    containerEl.createEl("p", {
      text:
        "Chat with your local pi coding agent. " +
        "Pi must be installed and accessible from your PATH (or set a custom path below).",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Pi executable path")
      .setDesc("Path to the pi binary. Leave as 'pi' if it's on your PATH.")
      .addText((t) =>
        t
          .setPlaceholder("pi")
          .setValue(this.settings.piPath)
          .onChange(async (v) => {
            this.settings.piPath = v.trim() || "pi";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("e.g. anthropic, openai, minimax-cn. Empty = pi default.")
      .addText((t) =>
        t
          .setPlaceholder("(default)")
          .setValue(this.settings.provider)
          .onChange(async (v) => {
            this.settings.provider = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Model id or pattern, e.g. claude-sonnet-4-5. Empty = pi default.")
      .addText((t) =>
        t
          .setPlaceholder("(default)")
          .setValue(this.settings.model)
          .onChange(async (v) => {
            this.settings.model = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Thinking level")
      .setDesc("off | minimal | low | medium | high | xhigh | max")
      .addDropdown((d) =>
        d
          .addOptions({
            "off": "off",
            "minimal": "minimal",
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh",
            "max": "max",
          })
          .setValue(this.settings.thinking || "low")
          .onChange(async (v) => {
            this.settings.thinking = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Vault server").setHeading();

    new Setting(containerEl)
      .setName("HTTP port")
      .setDesc("Local port the plugin listens on to expose vault endpoints to pi. Default: 27183.")
      .addText((t) =>
        t
          .setPlaceholder("27183")
          .setValue(String(this.settings.vaultPort))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n)) {
              this.settings.vaultPort = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Auto-attach active file")
      .setDesc("Prepend the currently open note as context for each turn.")
      .addToggle((t) =>
        t
          .setValue(this.settings.attachActiveFile)
          .onChange(async (v) => {
            this.settings.attachActiveFile = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-attach selection")
      .setDesc("Prepend the currently selected text as context for each turn.")
      .addToggle((t) =>
        t
          .setValue(this.settings.attachSelection)
          .onChange(async (v) => {
            this.settings.attachSelection = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Allow writes")
      .setDesc("If on, pi can create or modify notes via the vault server. Off by default.")
      .addToggle((t) =>
        t
          .setValue(this.settings.allowWrites)
          .onChange(async (v) => {
            this.settings.allowWrites = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Forbidden paths")
      .setDesc("One glob/prefix per line. Pi can never read or list these (e.g. .obsidian/, private/).")
      .addTextArea((t) =>
        t
          .setPlaceholder(".obsidian/\n.trash/\nprivate/")
          .setValue(this.settings.denyPatterns)
          .onChange(async (v) => {
            this.settings.denyPatterns = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Extra system prompt")
      .setDesc("Appended to every turn's system prompt. Use this for personal preferences.")
      .addTextArea((t) =>
        t
          .setPlaceholder("Always reply in Chinese.")
          .setValue(this.settings.extraSystemPrompt)
          .onChange(async (v) => {
            this.settings.extraSystemPrompt = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Chat history").setHeading();

    new Setting(containerEl)
      .setName("Autosave chat to vault")
      .setDesc("Save every chat as a note inside your vault so it survives Obsidian restarts.")
      .addToggle((t) =>
        t
          .setValue(this.settings.autosaveChat)
          .onChange(async (v) => {
            this.settings.autosaveChat = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("History folder")
      .setDesc("Vault-relative folder where chat notes are saved. Created on first save if missing.")
      .addText((t) =>
        t
          .setPlaceholder("PiChat")
          .setValue(this.settings.chatHistoryFolder)
          .onChange(async (v) => {
            this.settings.chatHistoryFolder = v.trim() || "PiChat";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("History tag")
      .setDesc("Frontmatter tag applied to every saved chat note. Useful for Dataview queries.")
      .addText((t) =>
        t
          .setPlaceholder("pi-chat")
          .setValue(this.settings.chatHistoryTag)
          .onChange(async (v) => {
            this.settings.chatHistoryTag = v.trim() || "pi-chat";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Status").setHeading();

    const status = containerEl.createDiv({ cls: "pi-chat-settings-status" });
    const port = this.plugin.getVaultServerPort();
    status.createEl("div", {
      text: port
        ? `Vault server: running on http://127.0.0.1:${port}`
        : "Vault server: not running",
    });
    status.createEl("div", {
      text: `pi binary: ${this.settings.piPath}`,
    });
  }
}