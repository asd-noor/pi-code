/**
 * Unix socket server — pure graph reads + live LSP fallback for impact.
 * Protocol: newline-delimited JSON
 *   → {"id":1,"method":"outline","params":{"file":"src/foo.ts"}}
 *   ← {"id":1,"result":[...]}
 */

import { createServer, type Server, type Socket } from "node:net";
import { resolve, relative } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CodeGraph, GraphNode, RefLocation } from "./graph.ts";
import { REF_KINDS } from "./graph.ts";
import type { LspClient } from "../lsp/client.ts";

export interface DiagRow {
  severity: string;
  file: string;
  line: number;
  col: number;
  source: string;
  message: string;
}

export interface SymbolRow {
  kind: string;
  name: string;
  lineStart: number;
  lineEnd: number;
  file: string;
}

export interface SymbolDefRow {
  kind: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  colStart: number;
  name: string;
  source?: string;
}

export interface ImpactRow {
  kind: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  name: string;
}

export class DaemonServer {
  private server: Server;
  private activeConnections = 0;

  constructor(
    private socketPath: string,
    private graph: CodeGraph,
    private lspClient: LspClient,
    private rootPath: string,
    private onShutdown: () => void,
  ) {
    this.server = createServer((s) => this.handleConnection(s));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((res) => this.server.close(() => res()));
  }

  private handleConnection(socket: Socket) {
    this.activeConnections++;
    let buf = "";

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (t) this.handleLine(t, socket);
      }
    });
    socket.on("close", () => { this.activeConnections--; });
    socket.on("error", () => { this.activeConnections--; });
  }

  private async handleLine(line: string, socket: Socket) {
    let req: { id: number; method: string; params?: Record<string, unknown> };
    try { req = JSON.parse(line); }
    catch { this.send(socket, { id: -1, error: "invalid JSON" }); return; }

    try {
      const result = await this.dispatch(req.method, req.params ?? {});
      this.send(socket, { id: req.id, result });
    } catch (err) {
      this.send(socket, { id: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private send(socket: Socket, payload: unknown) {
    try { socket.write(JSON.stringify(payload) + "\n"); } catch (_) {}
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "ping":        return { pong: true, ...this.graph.stats() };
      case "status":      return this.graph.stats();
      case "outline":     return this.handleOutline(String(params.file));
      case "symbol":      return this.handleSymbol(String(params.name), !!params.withSource);
      case "diagnostics": return this.handleDiagnostics(
        params.file ? String(params.file) : undefined,
        typeof params.severity === "number" ? params.severity : 0,
      );
      case "impact":      return this.handleImpact(String(params.name));
      case "shutdown":    setTimeout(() => this.onShutdown(), 100); return { ok: true };
      default:            throw new Error(`unknown method: ${method}`);
    }
  }

  private handleOutline(file: string): SymbolRow[] {
    const rel   = file.startsWith("/") ? relative(this.rootPath, file) : file;
    const nodes = this.graph.byFile.get(rel) ?? [];
    return nodes.map((n) => ({
      kind: n.kind, name: n.name,
      lineStart: n.lineStart, lineEnd: n.lineEnd, file: n.file,
    }));
  }

  private handleSymbol(name: string, withSource: boolean): SymbolDefRow[] {
    return this.graph.findByName(name).map((n) => {
      const row: SymbolDefRow = {
        kind: n.kind, file: n.file,
        lineStart: n.lineStart, lineEnd: n.lineEnd,
        colStart: n.colStart, name: n.name,
      };
      if (withSource) {
        row.source = extractSource(resolve(this.rootPath, n.file), n.lineStart, n.lineEnd);
      }
      return row;
    });
  }

  private handleDiagnostics(file: string | undefined, minSeverity: number): DiagRow[] {
    const SEV: Record<string, number> = { error: 1, warning: 2, info: 3, hint: 4 };
    const rows: DiagRow[] = [];
    for (const [relFile, diags] of this.graph.diagnostics) {
      if (file) {
        const rel = file.startsWith("/") ? relative(this.rootPath, file) : file;
        if (relFile !== rel) continue;
      }
      for (const d of diags) {
        if (minSeverity > 0 && (SEV[d.severity] ?? 99) > minSeverity) continue;
        rows.push(d);
      }
    }
    return rows.sort((a, b) =>
      a.file !== b.file ? a.file.localeCompare(b.file) : a.line - b.line,
    );
  }

  private async handleImpact(name: string): Promise<ImpactRow[]> {
    const nodes = this.graph.findByName(name);
    if (!nodes.length) throw new Error(`symbol not found: ${name}`);

    const target = nodes.find((n) => REF_KINDS.has(n.kind)) ?? nodes[0];

    if (!this.graph.indexed.has(target.id)) {
      const absFile = resolve(this.rootPath, target.file);
      try {
        const refs = await this.lspClient.references(absFile, target.lineStart - 1, target.colStart, false);
        const locations: RefLocation[] = refs
          .map((r) => ({
            file:      relative(this.rootPath, r.uri.startsWith("file://") ? fileURLToPath(r.uri) : r.uri),
            lineStart: r.range.start.line + 1,
            lineEnd:   r.range.end.line + 1,
          }))
          .filter((r) => !(r.file === target.file && r.lineStart === target.lineStart));
        this.graph.setReverseRefs(target.id, locations);
      } catch (err) {
        this.graph.indexed.add(target.id);
        throw new Error(`references query failed: ${err}`);
      }
    }

    const refs = this.graph.reverseRefs.get(target.id) ?? [];
    return refs.map((r) => ({
      kind: "ref", file: r.file,
      lineStart: r.lineStart, lineEnd: r.lineEnd,
      name: nameAtLocation(this.graph, r.file, r.lineStart),
    }));
  }
}

function extractSource(absPath: string, lineStart: number, lineEnd: number): string | undefined {
  if (!existsSync(absPath)) return undefined;
  try {
    const lines = readFileSync(absPath, "utf8").split("\n");
    return lines.slice(lineStart - 1, lineEnd).join("\n");
  } catch { return undefined; }
}

function nameAtLocation(graph: CodeGraph, relFile: string, line: number): string {
  const nodes = graph.byFile.get(relFile) ?? [];
  let best: GraphNode | undefined;
  for (const n of nodes) {
    if (n.lineStart <= line && n.lineEnd >= line) {
      if (!best || (n.lineStart >= best.lineStart && n.lineEnd <= best.lineEnd)) best = n;
    }
  }
  return best?.name ?? "(reference)";
}
