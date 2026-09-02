/**
 * Builds the per-turn prompt for pi.
 *
 * The system prompt teaches pi about the vault, the local HTTP server it can
 * talk to, and any denylist of paths it should not access.
 *
 * The user message gets an optional prefix with active file / selection so the
 * user can refer to "this note" without spelling out the path.
 */

import { TFile } from "obsidian";
import { PiChatSettings } from "./types";

export interface TurnContext {
  /** User input from the chat box. */
  userMessage: string;
  /** URL of the local vault HTTP server, e.g. http://127.0.0.1:27183. */
  vaultServerUrl: string;
  /** Absolute path to the vault on the filesystem (so pi can read files directly via `read`). */
  vaultPath: string | null;
  /** Currently open file in the editor (if any). */
  activeFile: TFile | null;
  /** Selected text in the editor (if any). */
  selection: string | null;
  /** Per-chat session id, so pi can mention it. */
  sessionId: string;
}

export function buildSystemPrompt(settings: PiChatSettings, ctx: TurnContext): string {
  const lines: string[] = [];
  lines.push(
    "You are running as the AI backend for an Obsidian chat plugin called \"Pi Chat\".",
    "The user is interacting with you from inside Obsidian on their own machine. Be concise.",
    "Use Markdown formatting. Use short paragraphs and bullet lists. Avoid huge code dumps unless asked.",
    "",
  );

  // Vault info.
  lines.push("## Vault access");
  lines.push(`Vault root (filesystem path): ${ctx.vaultPath ?? "(unknown)"}`);
  lines.push(`Vault HTTP server (this plugin): ${ctx.vaultServerUrl}`);
  lines.push("");
  lines.push("How to read the vault:");
  lines.push(
    "1. Prefer the HTTP endpoints below — they go through Obsidian's API and respect the active editor state.",
    "2. You can also use your built-in `read` / `bash` (with `ls`, `grep`) tools directly on the vault path.",
    "",
  );

  // Endpoints table.
  lines.push("### Vault HTTP endpoints (use curl from `bash`)");
  const eol = "GET";
  const tbl: [string, string][] = [
    ["/health", "GET — sanity check"],
    ["/vault/info", "GET — vault metadata, denylist, allowed writes"],
    ["/vault/files?path=&recursive=", "GET — list files (default recursive=true)"],
    ["/vault/file?path=PATH", "GET — read file by vault-relative path"],
    ["/vault/active", "GET — currently focused note in the editor"],
    ["/vault/selection", "GET — currently selected text in the editor"],
    ["/vault/tags", "GET — all tags with counts"],
    ["/vault/backlinks?path=PATH", "GET — backlinks pointing at PATH"],
    ["/vault/search?q=TERM&limit=20", "GET — filename search"],
  ];
  for (const [p, desc] of tbl) lines.push(`- \`${p}\` — ${desc}`);
  lines.push("");

  // Write endpoint (conditional).
  if (settings.allowWrites) {
    lines.push("### Writing notes");
    lines.push(
      "You are allowed to write notes on the user's behalf.",
      "To create or modify a note:",
      "```",
      "curl -X POST <vaultServerUrl>/vault/file -H 'Content-Type: application/json' \\",
      "  -d '{\"path\":\"folder/note.md\",\"content\":\"...\",\"mode\":\"create|overwrite|append\"}'",
      "```",
      "Always confirm with the user before destructive changes (overwrite/delete).",
      "Folders in `path` are created automatically when creating new notes.",
      "",
    );
  } else {
    lines.push("### Writing notes");
    lines.push(
      "Writes are currently DISABLED in the plugin settings. You cannot create or modify notes.",
      "If the user asks you to write something, tell them to enable \"Allow writes\" in Settings → Pi Chat.",
      "",
    );
  }

  // Denylist.
  const deny = settings.denyPatterns
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (deny.length) {
    lines.push("### Forbidden paths (never read or list)");
    for (const d of deny) lines.push(`- \`${d}\``);
    lines.push("");
  }

  // Session.
  lines.push("## Session");
  lines.push(`Session id: ${ctx.sessionId}`);
  lines.push(
    "Every turn you see is one message from the user — the same session id means continued conversation.",
    "",
  );

  // Extra user system prompt.
  if (settings.extraSystemPrompt.trim()) {
    lines.push("## User instructions");
    lines.push(settings.extraSystemPrompt.trim());
    lines.push("");
  }

  return lines.join("\n");
}

export function buildUserPrefix(ctx: TurnContext, settings: PiChatSettings): string {
  const blocks: string[] = [];

  if (settings.attachActiveFile && ctx.activeFile) {
    const f = ctx.activeFile;
    blocks.push(
      `<active_file path="${f.path}" size="${f.stat.size}">\nThe note currently open in the editor. Reference it as "the current note" if useful.\n</active_file>`,
    );
  }

  if (settings.attachSelection && ctx.selection && ctx.selection.trim()) {
    const trimmed =
      ctx.selection.length > 4000
        ? ctx.selection.slice(0, 4000) + "\n... (truncated)"
        : ctx.selection;
    blocks.push(
      `<selection>\nThe text currently selected by the user. Use it as immediate context.\n${trimmed}\n</selection>`,
    );
  }

  blocks.push(`<user_message>\n${ctx.userMessage}\n</user_message>`);
  return blocks.join("\n\n");
}