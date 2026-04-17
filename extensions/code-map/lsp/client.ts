import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import type {
  DocumentSymbolResult,
  Diagnostic,
  Location,
  SymbolInformation,
  CallHierarchyItem,
} from "./protocol.ts";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LspClientOptions {
  command: string;
  args: string[];
  rootPath: string;
  languageId: string;
  initTimeout?: number;
  requestTimeout?: number;
}

export class LspClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private msgId = 1;
  private pending = new Map<number, PendingRequest>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private openFiles = new Set<string>();
  private opts: LspClientOptions;
  /** Serializes heavy requests (workspace/symbol, references) to avoid LSP server starvation */
  private requestQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: LspClientOptions) {
    super();
    this.opts = opts;
    this.proc = spawn(opts.command, opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.rootPath,
    });
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on("data", () => {}); // swallow LSP server logs
    this.proc.on("error", (err) => this.emit("error", err));
    this.proc.on("exit", (code) => this.emit("exit", code));
  }

  // ── Transport ─────────────────────────────────────────────────────────

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const header = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
      if (!header) break;
      const len = parseInt(header[1], 10);
      const start = this.buffer.indexOf("\r\n\r\n") + 4;
      if (this.buffer.length < start + len) break;
      const body = this.buffer.slice(start, start + len);
      this.buffer = this.buffer.slice(start + len);
      try { this.onMessage(JSON.parse(body)); } catch (_) {}
    }
  }

  private onMessage(msg: Record<string, unknown>) {
    if (!msg.id && msg.method === "textDocument/publishDiagnostics") {
      const p = msg.params as { uri: string; diagnostics: Diagnostic[] };
      this.diagnostics.set(p.uri, p.diagnostics ?? []);
      return;
    }
    if (msg.id !== undefined) {
      const id = msg.id as number;
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
    }
  }

  private send(method: string, params: unknown): void {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  private request<T>(method: string, params: unknown, timeout?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const ms = timeout ?? this.opts.requestTimeout ?? 10000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, ms);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    });
  }

  /** Serialize heavy requests so they don't starve each other in the LSP server */
  private queued<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.requestQueue.then(() => fn()).catch((e) => { throw e; });
    this.requestQueue = next.catch(() => {});
    return next as Promise<T>;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.opts.rootPath).href;
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: this.opts.rootPath,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didOpen: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: false },
          definition: {},
          references: {},
          callHierarchy: {},
        },
        workspace: { symbol: {}, workspaceFolders: true },
      },
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
    }, this.opts.initTimeout ?? 15000);
    this.send("initialized", {});
  }

  openFile(filePath: string): void {
    const uri = pathToFileURL(filePath).href;
    if (this.openFiles.has(uri)) return;
    this.openFiles.add(uri);
    let text = "";
    try { text = readFileSync(filePath, "utf8"); } catch (_) {}
    this.send("textDocument/didOpen", {
      textDocument: { uri, languageId: this.opts.languageId, version: 1, text },
    });
  }

  waitForDiagnostics(ms = 3000): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async shutdown(): Promise<void> {
    try { await this.request("shutdown", null, 3000); this.send("exit", null); } catch (_) {}
    this.proc.kill();
  }

  // ── Queries ───────────────────────────────────────────────────────────

  async documentSymbols(filePath: string): Promise<DocumentSymbolResult> {
    const uri = pathToFileURL(filePath).href;
    const result = await this.request<DocumentSymbolResult>(
      "textDocument/documentSymbol", { textDocument: { uri } }, 15000
    );
    return result ?? [];
  }

  async workspaceSymbols(query: string): Promise<SymbolInformation[]> {
    return this.queued(() =>
      this.request<SymbolInformation[]>("workspace/symbol", { query }, 15000)
        .then(r => r ?? [])
    );
  }

  async definition(filePath: string, line: number, character: number): Promise<Location[]> {
    const uri = pathToFileURL(filePath).href;
    const result = await this.request<Location | Location[] | null>(
      "textDocument/definition", { textDocument: { uri }, position: { line, character } }
    );
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = false
  ): Promise<Location[]> {
    const uri = pathToFileURL(filePath).href;
    return this.queued(() =>
      this.request<Location[] | null>(
        "textDocument/references",
        { textDocument: { uri }, position: { line, character }, context: { includeDeclaration } },
        60000
      ).then(r => r ?? [])
    );
  }

  async prepareCallHierarchy(filePath: string, line: number, character: number): Promise<CallHierarchyItem[]> {
    const uri = pathToFileURL(filePath).href;
    const result = await this.request<CallHierarchyItem[] | null>(
      "textDocument/prepareCallHierarchy", { textDocument: { uri }, position: { line, character } }
    );
    return result ?? [];
  }

  async incomingCalls(item: CallHierarchyItem): Promise<Array<{ from: CallHierarchyItem; fromRanges: unknown[] }>> {
    const result = await this.request<Array<{ from: CallHierarchyItem; fromRanges: unknown[] }> | null>(
      "callHierarchy/incomingCalls", { item }
    );
    return result ?? [];
  }

  getDiagnostics(uri?: string): Map<string, Diagnostic[]> | Diagnostic[] {
    if (uri) return this.diagnostics.get(uri) ?? [];
    return this.diagnostics;
  }
}
