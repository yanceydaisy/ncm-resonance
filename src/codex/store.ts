import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BridgeEvent } from "../types.js";

export type CodexJob = {
  eventId: string;
  conversationKey: string;
  phase: "queued" | "starting" | "running" | "generated" | "failed" | "done";
  threadId: string | null;
  turnId: string | null;
  response: string | null;
  error: string | null;
  attempt: number;
  startedAt: number | null;
  nextAt: number;
};

export class CodexStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS codex_conversations (key TEXT PRIMARY KEY,thread_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_routes (route TEXT PRIMARY KEY,conversation_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_states (key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_jobs (
        eventId TEXT PRIMARY KEY, conversationKey TEXT NOT NULL, phase TEXT NOT NULL,
        threadId TEXT, turnId TEXT, response TEXT, error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0, startedAt INTEGER, nextAt INTEGER NOT NULL DEFAULT 0
      );
    `);
  }
  close(): void { this.db.close(); }
  bind(event: BridgeEvent): void {
    if (!event.replyTarget || !event.conversationKey) return;
    this.db.prepare("INSERT INTO codex_routes VALUES(?,?) ON CONFLICT(route) DO UPDATE SET conversation_key=excluded.conversation_key")
      .run(JSON.stringify(event.replyTarget), event.conversationKey);
  }
  conversationKey(event: BridgeEvent): string | null {
    if (event.conversationKey) return event.conversationKey;
    if (!event.replyTarget) return null;
    return this.db.prepare("SELECT conversation_key FROM codex_routes WHERE route=?").get(JSON.stringify(event.replyTarget))?.conversation_key as string ?? null;
  }
  thread(key: string): string | null {
    return this.db.prepare("SELECT thread_id FROM codex_conversations WHERE key=?").get(key)?.thread_id as string ?? null;
  }
  bindThread(key: string, threadId: string): void {
    this.db.prepare("INSERT INTO codex_conversations VALUES(?,?) ON CONFLICT(key) DO UPDATE SET thread_id=excluded.thread_id").run(key, threadId);
  }
  ensure(eventId: string, conversationKey: string): CodexJob {
    this.db.prepare("INSERT OR IGNORE INTO codex_jobs(eventId,conversationKey,phase) VALUES(?,?,'queued')").run(eventId, conversationKey);
    return this.get(eventId)!;
  }
  get(eventId: string): CodexJob | null {
    return this.db.prepare("SELECT * FROM codex_jobs WHERE eventId=?").get(eventId) as CodexJob | undefined ?? null;
  }
  starting(eventId: string, threadId: string, now: number): void {
    this.db.prepare("UPDATE codex_jobs SET phase='starting',threadId=?,startedAt=?,error=NULL WHERE eventId=?").run(threadId, now, eventId);
  }
  started(eventId: string, turnId: string): void {
    this.db.prepare("UPDATE codex_jobs SET phase='running',turnId=? WHERE eventId=?").run(turnId, eventId);
  }
  generated(eventId: string, response: string): void {
    this.db.prepare("UPDATE codex_jobs SET phase='generated',response=?,error=NULL,nextAt=0 WHERE eventId=?").run(response, eventId);
  }
  done(eventId: string): void {
    this.db.prepare("UPDATE codex_jobs SET phase='done',error=NULL WHERE eventId=?").run(eventId);
  }
  failure(eventId: string, error: string, resumable: boolean, now: number): void {
    this.db.prepare("UPDATE codex_jobs SET phase=CASE WHEN response IS NOT NULL THEN 'generated' WHEN ? THEN phase ELSE 'failed' END,error=?,nextAt=? WHERE eventId=?")
      .run(Number(resumable), error.slice(0, 1000), now + 5000, eventId);
  }
  retry(eventId: string, confirmRestart: boolean): void {
    const job = this.get(eventId);
    if (!job || job.phase === "done") throw new Error("No unfinished Codex job: " + eventId);
    if (job.response !== null) {
      this.db.prepare("UPDATE codex_jobs SET phase='generated',error=NULL,nextAt=0 WHERE eventId=?").run(eventId);
      return;
    }
    if (job.startedAt !== null && !confirmRestart) throw new Error("Previous turn may have executed tools; confirmRestart is required");
    this.db.prepare("UPDATE codex_jobs SET phase='queued',turnId=NULL,startedAt=NULL,error=NULL,nextAt=0,attempt=attempt+1 WHERE eventId=?").run(eventId);
  }
  stateProcessed(key: string, fingerprint: string): boolean {
    return this.db.prepare("SELECT fingerprint FROM codex_states WHERE key=?").get(key)?.fingerprint === fingerprint;
  }
  recordState(key: string, fingerprint: string): void {
    this.db.prepare("INSERT INTO codex_states VALUES(?,?) ON CONFLICT(key) DO UPDATE SET fingerprint=excluded.fingerprint").run(key, fingerprint);
  }
  unfinished(): string[] {
    return this.db.prepare("SELECT eventId FROM codex_jobs WHERE phase IN ('queued','starting','running','generated') ORDER BY rowid")
      .all().map(row => String(row.eventId));
  }
  status() {
    return {
      counts: this.db.prepare("SELECT phase,count(*) AS count FROM codex_jobs GROUP BY phase").all(),
      jobs: this.db.prepare("SELECT eventId,phase,error,nextAt FROM codex_jobs ORDER BY rowid DESC LIMIT 20").all(),
    };
  }
}
