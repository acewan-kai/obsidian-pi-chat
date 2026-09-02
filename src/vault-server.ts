/**
 * Local HTTP server that exposes Obsidian vault operations to pi.
 *
 * pi talks to this server via curl from inside its `bash` tool, so it can read
 * the user's vault without Obsidian-specific APIs.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /vault/info
 *   GET  /vault/files?path=&recursive=
 *   GET  /vault/file?path=
 *   POST /vault/file  { path, content, mode: "create"|"overwrite"|"append" }
 *   GET  /vault/active
 *   GET  /vault/selection
 *   GET  /vault/tags
 *   GET  /vault/backlinks?path=
 *   GET  /vault/search?q=&limit=
 *   GET  /chat/info
 */

import * as http from "http";
import * as url from "url";
import { App, TFile, TFolder } from "obsidian";
import { PiChatSettings } from "./types";

type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, body: any) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class VaultServer {
  private server: http.Server | null = null;
  private routes: Route[] = [];
  private port: number = 0;
  private actualPort: number = 0;
  private cachedSelection: { text: string; filePath: string | null; ts: number } | null = null;

  constructor(private app: App, private settings: PiChatSettings) {}

  /**
   * Cache the latest selection so /vault/selection can serve it even when the
   * editor isn't focused at the exact moment of the request.
   */
  setSelection(text: string, filePath: string | null): void {
    this.cachedSelection = { text, filePath, ts: Date.now() };
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.actualPort}`;
  }

  getPort(): number {
    return this.actualPort;
  }

  async start(): Promise<number> {
    if (this.server) return this.actualPort;

    this.registerRoutes();
    this.server = http.createServer((req, res) => this.dispatch(req, res));

    // Try the configured port; if it's taken, fall back to a free port.
    for (let attempt = 0; attempt < 10; attempt++) {
      const tryPort = this.settings.vaultPort + attempt;
      const ok = await new Promise<boolean>((resolve) => {
        this.server!.once("error", () => resolve(false));
        this.server!.listen(tryPort, "127.0.0.1", () => resolve(true));
      });
      if (ok) {
        this.actualPort = tryPort;
        break;
      }
      // Recreate server after listen() error closed it.
      this.server = http.createServer((req, res) => this.dispatch(req, res));
    }

    if (!this.actualPort) {
      throw new Error(`Vault server could not bind to port ${this.settings.vaultPort}+`);
    }
    return this.actualPort;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  // -----------------------------------------------------------------------
  // Routing
  // -----------------------------------------------------------------------

  private route(method: string, pathPattern: string, handler: RouteHandler) {
    const paramNames: string[] = [];
    const regexStr = pathPattern.replace(/:([a-zA-Z_]+)/g, (_, n) => {
      paramNames.push(n);
      return "([^/]+)";
    });
    this.routes.push({ method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler });
  }

  private registerRoutes() {
    this.route("GET", "/health", (_req, res) => this.respond(res, 200, { ok: true }));

    this.route("GET", "/vault/info", (_req, res) => this.handleVaultInfo(res));

    this.route("GET", "/vault/files", (req, res, params) =>
      this.handleListFiles(res, params));

    this.route("GET", "/vault/file", (req, res, params) =>
      this.handleReadFile(res, params));

    this.route("POST", "/vault/file", (req, res, _params, body) =>
      this.handleWriteFile(req, res, body));

    this.route("GET", "/vault/active", (_req, res) => this.handleActiveFile(res));

    this.route("GET", "/vault/selection", (_req, res) => this.handleSelection(res));

    this.route("GET", "/vault/tags", (_req, res) => this.handleTags(res));

    this.route("GET", "/vault/backlinks", (req, res, params) =>
      this.handleBacklinks(res, params));

    this.route("GET", "/vault/search", (req, res, params) =>
      this.handleSearch(res, params));

    this.route("GET", "/chat/info", (_req, res) => this.handleChatInfo(res));
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse) {
    const parsed = url.parse(req.url || "/", true);
    const pathname = parsed.pathname || "/";
    const method = (req.method || "GET").toUpperCase();

    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.pattern);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.paramNames.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      const query = parsed.query as Record<string, string>;
      const merged = { ...query, ...params };
      try {
        const body = ["POST", "PUT", "PATCH"].includes(method)
          ? await this.readBody(req)
          : null;
        await r.handler(req, res, merged, body);
      } catch (err: any) {
        this.respond(res, 500, { error: err?.message || String(err) });
      }
      return;
    }

    this.respond(res, 404, { error: "not found", method, path: pathname });
  }

  private readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        if (!data) return resolve(null);
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
      req.on("error", reject);
    });
  }

  private respond(res: http.ServerResponse, status: number, payload: any) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify(payload));
  }

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  private handleVaultInfo(res: http.ServerResponse) {
    const vault = this.app.vault;
    const md = vault.getMarkdownFiles();
    const all = vault.getAllLoadedFiles();
    this.respond(res, 200, {
      name: vault.getName(),
      path: (vault as any).adapter?.basePath ?? null,
      totalFiles: all.length,
      markdownFiles: md.length,
      denylist: this.settings.denyPatterns
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      allowWrites: this.settings.allowWrites,
      serverTime: new Date().toISOString(),
    });
  }

  private handleListFiles(res: http.ServerResponse, params: Record<string, string>) {
    const prefix = params.path || "";
    const recursive = params.recursive !== "false";

    const all = this.app.vault.getAllLoadedFiles();
    const out: any[] = [];

    const startsWith = (p: string, q: string) => {
      if (!q) return true;
      const norm = (s: string) => s.replace(/\\/g, "/");
      return norm(p).startsWith(norm(q));
    };

    for (const f of all) {
      const p = f.path;
      if (!startsWith(p, prefix)) continue;
      if (f instanceof TFolder) {
        out.push({ path: p, type: "folder" });
      } else if (f instanceof TFile && p.endsWith(".md")) {
        out.push({
          path: p,
          type: "file",
          size: f.stat.size,
          mtime: f.stat.mtime,
          ctime: f.stat.ctime,
        });
      } else if (recursive) {
        out.push({ path: p, type: f instanceof TFile ? "file" : "other" });
      }
    }
    this.respond(res, 200, { count: out.length, files: out });
  }

  private handleReadFile(res: http.ServerResponse, params: Record<string, string>) {
    const path = params.path;
    if (!path) return this.respond(res, 400, { error: "missing path" });
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return this.respond(res, 404, { error: "not found", path });
    }
    this.app.vault.read(file).then((content) => {
      this.respond(res, 200, {
        path,
        size: file.stat.size,
        mtime: file.stat.mtime,
        content,
      });
    });
  }

  private async handleWriteFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: any,
  ) {
    if (!this.settings.allowWrites) {
      return this.respond(res, 403, {
        error: "writes are disabled in plugin settings",
      });
    }
    if (!body || typeof body.path !== "string" || typeof body.content !== "string") {
      return this.respond(res, 400, { error: "body must be { path, content, mode? }" });
    }
    const { path: p, content, mode = "create" } = body;
    const exists = this.app.vault.getAbstractFileByPath(p);

    try {
      if (mode === "append" && exists instanceof TFile) {
        const cur = await this.app.vault.read(exists);
        await this.app.vault.modify(exists, cur + content);
      } else if (mode === "overwrite" && exists instanceof TFile) {
        await this.app.vault.modify(exists, content);
      } else if (!exists) {
        // Ensure parent folders exist.
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++) {
          const folder = parts.slice(0, i).join("/");
          const af = this.app.vault.getAbstractFileByPath(folder);
          if (!af) await this.app.vault.createFolder(folder);
        }
        await this.app.vault.create(p, content);
      } else {
        return this.respond(res, 409, { error: "file exists, use mode=overwrite or append" });
      }
      this.respond(res, 200, { ok: true, path: p, mode });
    } catch (err: any) {
      this.respond(res, 500, { error: err?.message || String(err) });
    }
  }

  private handleActiveFile(res: http.ServerResponse) {
    const view = this.app.workspace.getActiveFile();
    if (!view) return this.respond(res, 404, { error: "no active file" });
    this.app.vault.read(view).then((content) => {
      this.respond(res, 200, {
        path: view.path,
        size: view.stat.size,
        mtime: view.stat.mtime,
        content,
      });
    });
  }

  private handleSelection(res: http.ServerResponse) {
    const sel = this.cachedSelection;
    if (!sel || !sel.text) {
      return this.respond(res, 404, {
        error: "no selection cached (call setSelection() from the editor first)",
      });
    }
    this.respond(res, 200, sel);
  }

  private handleTags(res: http.ServerResponse) {
    const counts: Record<string, number> = {};
    for (const f of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(f);
      const tags = cache?.tags?.map((t) => t.tag) ?? [];
      const frontmatter = cache?.frontmatter?.tags ?? [];
      const all = [...tags, ...(Array.isArray(frontmatter) ? frontmatter : [])];
      for (const t of all) counts[t] = (counts[t] || 0) + 1;
    }
    this.respond(res, 200, {
      count: Object.keys(counts).length,
      tags: counts,
    });
  }

  private handleBacklinks(res: http.ServerResponse, params: Record<string, string>) {
    const path = params.path;
    if (!path) return this.respond(res, 400, { error: "missing path" });
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return this.respond(res, 404, { error: "not found", path });
    }
    const links = (this.app.metadataCache as any).getBacklinksForFile
      ? (this.app.metadataCache as any).getBacklinksForFile(file)
      : null;
    // Obsidian's API: app.metadataCache.getBacklinksForFile(file) returns { data: Map<path, Backlink[]> }
    const data = links?.data ?? links ?? {};
    const out: any[] = [];
    if (data instanceof Map) {
      for (const [src, ranges] of data.entries()) {
        out.push({ from: src, count: (ranges as any[]).length });
      }
    } else if (typeof data === "object") {
      for (const [src, ranges] of Object.entries(data)) {
        out.push({ from: src, count: (ranges as any[]).length });
      }
    }
    this.respond(res, 200, { path, count: out.length, backlinks: out });
  }

  private handleSearch(res: http.ServerResponse, params: Record<string, string>) {
    const q = (params.q || "").trim();
    const limit = parseInt(params.limit || "20", 10);
    if (!q) return this.respond(res, 400, { error: "missing q" });

    const lc = q.toLowerCase();
    const out: any[] = [];

    // Filename matches.
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (out.length >= limit) break;
      if (f.path.toLowerCase().includes(lc)) {
        out.push({ path: f.path, match: "filename" });
      }
    }

    this.respond(res, 200, { query: q, count: out.length, results: out });
  }

  private handleChatInfo(res: http.ServerResponse) {
    this.respond(res, 200, {
      model: this.settings.model || "(default)",
      provider: this.settings.provider || "(default)",
      thinking: this.settings.thinking,
      allowWrites: this.settings.allowWrites,
      vaultServer: this.getUrl(),
      });
  }
}