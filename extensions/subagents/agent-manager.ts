/**
 * agent-manager.ts — Agent lifecycle: spawn, queue, abort, resume.
 *
 * Background agents are subject to a concurrency limit (default: 4).
 * Excess agents queue and auto-start as slots free up.
 * Foreground agents bypass the queue.
 */

import { randomUUID } from "node:crypto";
import { spawnAndRun, resumeSession, steerSession } from "./agent-runner.ts";
import type { AgentActivity, AgentConfig, AgentRecord, ThinkingLevel } from "./types.ts";

const DEFAULT_MAX_CONCURRENT = 4;

export type OnComplete = (record: AgentRecord) => void;
export type OnStart = (record: AgentRecord) => void;

export interface SpawnOptions {
  description: string;
  agentConfig: AgentConfig;
  model?: any;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  agendaId?: number;
}

interface QueueItem {
  id: string;
  ctx: any;
  prompt: string;
  options: SpawnOptions;
}

export class AgentManager {
  private records = new Map<string, AgentRecord>();
  private activities = new Map<string, AgentActivity>();
  private queue: QueueItem[] = [];
  private runningBackground = 0;
  private maxConcurrent: number;
  private onComplete?: OnComplete;
  private onStart?: OnStart;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(onComplete?: OnComplete, onStart?: OnStart, maxConcurrent = DEFAULT_MAX_CONCURRENT) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.maxConcurrent = maxConcurrent;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  getMaxConcurrent(): number { return this.maxConcurrent; }
  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
    this.drainQueue();
  }

  spawn(ctx: any, prompt: string, options: SpawnOptions): string {
    const id = randomUUID().slice(0, 17);
    const activity: AgentActivity = {
      toolUses: 0,
      turnCount: 0,
      maxTurns: options.maxTurns ?? options.agentConfig.maxTurns,
      activeToolNames: new Set(),
      lastText: "",
      log: [],
      currentTurn: undefined,
    };
    const record: AgentRecord = {
      id,
      type: options.agentConfig.name,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      turnCount: 0,
      startedAt: Date.now(),
      abortController: new AbortController(),
    };
    this.records.set(id, record);
    this.activities.set(id, activity);

    if (options.isBackground && this.runningBackground >= this.maxConcurrent) {
      this.queue.push({ id, ctx, prompt, options });
      return id;
    }
    this.startAgent(id, record, activity, ctx, prompt, options);
    return id;
  }

  async spawnAndWait(ctx: any, prompt: string, options: Omit<SpawnOptions, "isBackground">): Promise<AgentRecord> {
    const id = this.spawn(ctx, prompt, { ...options, isBackground: false });
    const record = this.records.get(id)!;
    await record.promise;
    return record;
  }

  private startAgent(
    id: string,
    record: AgentRecord,
    activity: AgentActivity,
    ctx: any,
    prompt: string,
    options: SpawnOptions,
  ): void {
    record.status = "running";
    record.startedAt = Date.now();
    if (options.isBackground) this.runningBackground++;
    this.onStart?.(record);

    const promise = spawnAndRun(ctx, options.agentConfig, prompt, {
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      signal: record.abortController!.signal,
      activity,
      agendaId: options.agendaId,
      onSessionCreated: (session) => {
        record.session = session;
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) session.steer(msg).catch(() => {});
          record.pendingSteers = undefined;
        }
      },
    }).then((result) => {
      if (record.status !== "stopped") {
        record.status = result.status === "error" ? "error"
          : result.status === "aborted" ? "aborted"
          : "completed";
      }
      record.result = result.text;
      record.error = result.error;
      record.session = result.session;
      record.completedAt = Date.now();
      record.toolUses = activity.toolUses;
      record.turnCount = activity.turnCount;

      if (options.isBackground) {
        this.runningBackground--;
        this.onComplete?.(record);
        this.drainQueue();
      }
    }).catch((err: any) => {
      if (record.status !== "stopped") record.status = "error";
      record.error = err?.message ?? String(err);
      record.completedAt = Date.now();
      record.toolUses = activity.toolUses;
      record.turnCount = activity.turnCount;

      if (options.isBackground) {
        this.runningBackground--;
        this.onComplete?.(record);
        this.drainQueue();
      }
    });

    record.promise = promise;
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const item = this.queue.shift()!;
      const record = this.records.get(item.id);
      const activity = this.activities.get(item.id);
      if (!record || !activity || record.status !== "queued") continue;
      this.startAgent(item.id, record, activity, item.ctx, item.prompt, item.options);
    }
  }

  async resume(id: string, prompt: string): Promise<AgentRecord | undefined> {
    const record = this.records.get(id);
    if (!record?.session) return undefined;
    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    try {
      const text = await resumeSession(record.session, prompt);
      record.status = "completed";
      record.result = text;
      record.completedAt = Date.now();
    } catch (err: any) {
      record.status = "error";
      record.error = err?.message ?? String(err);
      record.completedAt = Date.now();
    }
    return record;
  }

  async steer(id: string, message: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.status !== "running") return false;
    if (!record.session) {
      record.pendingSteers = record.pendingSteers ?? [];
      record.pendingSteers.push(message);
      return true;
    }
    try {
      await steerSession(record.session, message);
      return true;
    } catch {
      return false;
    }
  }

  abort(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.status === "queued") {
      this.queue = this.queue.filter((q) => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      return true;
    }
    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  abortAll(): void {
    for (const item of this.queue) {
      const r = this.records.get(item.id);
      if (r) { r.status = "stopped"; r.completedAt = Date.now(); }
    }
    this.queue = [];
    for (const record of this.records.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
      }
    }
  }

  getRecord(id: string): AgentRecord | undefined { return this.records.get(id); }
  getActivity(id: string): AgentActivity | undefined { return this.activities.get(id); }
  listRecords(): AgentRecord[] {
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
  hasRunning(): boolean {
    return [...this.records.values()].some((r) => r.status === "running" || r.status === "queued");
  }

  clearCompleted(): void {
    for (const [id, record] of this.records) {
      if (record.status === "running" || record.status === "queued") continue;
      record.session?.dispose?.();
      this.records.delete(id);
      this.activities.delete(id);
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.records) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      record.session?.dispose?.();
      this.records.delete(id);
      this.activities.delete(id);
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.abortAll();
    for (const record of this.records.values()) record.session?.dispose?.();
    this.records.clear();
    this.activities.clear();
  }
}
