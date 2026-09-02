/**
 * Shared types for the Pi Chat plugin.
 */

export interface PiChatSettings {
  /** Path to the pi binary. Default: "pi" (resolved from PATH). */
  piPath: string;
  /** Model passed to pi via --model. Empty = pi default. */
  model: string;
  /** Provider passed to pi via --provider. Empty = pi default. */
  provider: string;
  /** Thinking level: off | minimal | low | medium | high | xhigh | max */
  thinking: string;
  /** HTTP port for the vault server (default 27183). */
  vaultPort: number;
  /** Auto-attach the active file as context. */
  attachActiveFile: boolean;
  /** Auto-attach the current selection as context. */
  attachSelection: boolean;
  /** When true, pi is allowed to write/modify notes (otherwise vault server is read-only). */
  allowWrites: boolean;
  /** Extra folders/files pi is forbidden to access, one per line. */
  denyPatterns: string;
  /** Extra system prompt text appended to every turn. */
  extraSystemPrompt: string;
  /** When true, each chat is saved as a Markdown note in the vault. */
  autosaveChat: boolean;
  /** Vault-relative folder where chat notes are saved. Default: "PiChat". */
  chatHistoryFolder: string;
  /** Tag applied to every saved chat note (for filtering / Dataview). Default: "pi-chat". */
  chatHistoryTag: string;
}

export const DEFAULT_SETTINGS: PiChatSettings = {
  piPath: "pi",
  model: "",
  provider: "",
  thinking: "low",
  vaultPort: 27183,
  attachActiveFile: true,
  attachSelection: true,
  allowWrites: false,
  denyPatterns: ".obsidian/\n.trash/\nprivate/",
  extraSystemPrompt: "",
  autosaveChat: true,
  chatHistoryFolder: "PiChat",
  chatHistoryTag: "pi-chat",
};

/**
 * UI message shown in the chat panel.
 * `kind` discriminates the streaming chunks from completed messages.
 */
export type ChatMessage =
  | {
      id: string;
      role: "user" | "assistant" | "system";
      text: string;
      completed: true;
      meta?: { thinking?: string; toolCalls?: ToolCallRecord[] };
    }
  | {
      id: string;
      role: "assistant";
      kind: "stream";
      textDelta: string;
      thinkingDelta: string;
      completed: false;
    };

export interface ToolCallRecord {
  name: string;
  args: any;
  result?: any;
  status: "running" | "ok" | "error";
}

/**
 * Streamed events emitted by PiClient.
 */
export type PiEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; name: string; args: any }
  | { type: "tool_end"; name: string; result: any; ok: boolean }
  | { type: "turn_end"; text: string; thinking: string; toolCalls: ToolCallRecord[] }
  | { type: "error"; message: string }
  | { type: "aborted" };

/**
 * JSON event types emitted by `pi -p --mode json` (one JSON per line on stdout).
 * Only the fields we care about are declared; everything else is ignored.
 */
export interface PiJsonEvent {
  type: string;
  message?: any;
  assistantMessageEvent?: {
    type: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
  };
  [k: string]: any;
}