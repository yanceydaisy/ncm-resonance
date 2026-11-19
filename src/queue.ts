import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BridgeEvent, ReplyDeliveryState, StoredBridgeEvent } from "./types.js";

export type ReplyClaim =
  | { state: "send"; sentCount: number }
  | { state: "in_progress"; sentCount: number }
  | { state: "already_completed"; sentCount: number };

type StreamCounts = { pending: number; reserved: number; delivered: number; total: number };
export type QueueStatus = StreamCounts & { conversation: StreamCounts; state: StreamCounts };
type StoredRow = { event: string; status: StoredBridgeEvent["status"]; reply: string | null };
const PROCESS_OWNER = randomUUID();
const STATE_HISTORY_PER_KEY = 12;
const emptyCounts = (): StreamCounts => ({ pending: 0, reserved: 0, delivered: 0, total: 0 });

export class SqliteEventQueue {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS bridge_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        event TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_key TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','reserved','delivered')),
        reply TEXT
      );
      CREATE INDEX IF NOT EXISTS bridge_pending ON bridge_events(stream,status,sequence);
      CREATE INDEX IF NOT EXISTS bridge_state ON bridge_events(state_key,sequence);
    `);
  }

  close(): void { this.db.close(); }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private row(eventId: string): StoredBridgeEvent | undefined {
    const row = this.db.prepare("SELECT event,status,reply FROM bridge_events WHERE id=?").get(eventId) as StoredRow | undefined;
    if (!row) return undefined;
    return { event: JSON.parse(row.event), status: row.status, ...(row.reply ? { reply: JSON.parse(row.reply) } : {}) };
  }

  private saveReply(eventId: string, reply: ReplyDeliveryState): void {
    this.db.prepare("UPDATE bridge_events SET reply=? WHERE id=?").run(JSON.stringify(reply), eventId);
  }

  enqueue(event: BridgeEvent): boolean {
    return this.transaction(() => {
      if (this.row(event.id)) return false;
      const key = event.stateKey ?? event.source;
      if (event.stream === "state") {
        this.db.prepare("DELETE FROM bridge_events WHERE stream='state' AND state_key=? AND status='pending'").run(key);
      }
      this.db.prepare("INSERT INTO bridge_events(id,event,stream,state_key,status) VALUES(?,?,?,?,'pending')")
        .run(event.id, JSON.stringify(event), event.stream, event.stream === "state" ? key : null);
      if (event.stream === "state") {
        this.db.prepare(`DELETE FROM bridge_events WHERE id IN (
          SELECT id FROM bridge_events WHERE stream='state' AND state_key=? AND status='delivered'
          AND (reply IS NULL OR json_extract(reply,'$.completed')=1)
          ORDER BY sequence DESC LIMIT -1 OFFSET ?
        )`).run(key, STATE_HISTORY_PER_KEY);
      }
      return true;
    });
  }

  isLatestState(eventId: string): boolean {
    const row = this.db.prepare("SELECT state_key FROM bridge_events WHERE id=? AND stream='state'").get(eventId);
    if (!row) return false;
    return this.db.prepare("SELECT id FROM bridge_events WHERE stream='state' AND state_key=? ORDER BY sequence DESC LIMIT 1").get(row.state_key!)?.id === eventId;
  }

  getPendingEvent(filter: (event: BridgeEvent) => boolean): BridgeEvent | null {
    const rows = this.db.prepare("SELECT event FROM bridge_events WHERE status='pending' ORDER BY sequence").all();
    for (const row of rows) {
      const event: BridgeEvent = JSON.parse(String(row.event));
      if (filter(event)) return event;
    }
    return null;
  }

  getEvent(eventId: string): BridgeEvent | null { return this.row(eventId)?.event ?? null; }
  isReserved(eventId: string): boolean { return this.row(eventId)?.status === "reserved"; }
  getReply(eventId: string): ReplyDeliveryState | undefined { return this.row(eventId)?.reply; }

  getReservedEvent(filter?: (event: BridgeEvent) => boolean): BridgeEvent | null {
    const rows = this.db.prepare(`SELECT event FROM bridge_events AS reserved WHERE status='reserved'
      AND (stream='conversation' OR NOT EXISTS (
        SELECT 1 FROM bridge_events AS newer WHERE newer.state_key=reserved.state_key
        AND newer.stream='state' AND newer.sequence>reserved.sequence
      )) ORDER BY CASE stream WHEN 'conversation' THEN 0 ELSE 1 END, sequence`).all();
    for (const row of rows) {
      const event: BridgeEvent = JSON.parse(String(row.event));
      if (!filter || filter(event)) return event;
    }
    return null;
  }

  getOutstandingRequiredReplyEvent(filter?: (event: BridgeEvent) => boolean): BridgeEvent | null {
    const rows = this.db.prepare(`SELECT event FROM bridge_events WHERE stream='conversation'
      AND status IN ('reserved','delivered') AND json_extract(event,'$.replyPolicy')='required'
      AND (reply IS NULL OR json_extract(reply,'$.completed')=0) ORDER BY sequence`).all();
    for (const row of rows) {
      const event: BridgeEvent = JSON.parse(String(row.event));
      if (!filter || filter(event)) return event;
    }
    return null;
  }

  reserveNext(filter?: (event: BridgeEvent) => boolean): BridgeEvent | null {
    return this.transaction(() => {
      if (this.getOutstandingRequiredReplyEvent(filter)) return null;
      const rows = this.db.prepare(`SELECT event FROM bridge_events WHERE status='pending'
        ORDER BY CASE stream WHEN 'conversation' THEN 0 ELSE 1 END, sequence`).all();
      for (const row of rows) {
        const event: BridgeEvent = JSON.parse(String(row.event));
        if (filter && !filter(event)) continue;
        this.db.prepare("UPDATE bridge_events SET status='reserved' WHERE id=?").run(event.id);
        return event;
      }
      return null;
    });
  }

  markDelivered(eventId: string): void {
    this.transaction(() => {
      const row = this.row(eventId);
      if (!row) throw new Error(`Unknown event: ${eventId}`);
      if (row.status === "delivered") return;
      if (row.status !== "reserved") throw new Error(`Event is not reserved: ${eventId}`);
      this.db.prepare("UPDATE bridge_events SET status='delivered' WHERE id=?").run(eventId);
    });
  }

  release(eventId: string): void {
    this.transaction(() => {
      const row = this.row(eventId);
      if (!row || row.status === "delivered") return;
      if (row.event.stream === "state") {
        const newer = this.db.prepare(`SELECT id FROM bridge_events WHERE stream='state' AND state_key=?
          AND sequence>(SELECT sequence FROM bridge_events WHERE id=?) LIMIT 1`)
          .get(row.event.stateKey ?? row.event.source, eventId);
        if (newer) {
          this.db.prepare("DELETE FROM bridge_events WHERE id=?").run(eventId);
          return;
        }
      }
      this.db.prepare("UPDATE bridge_events SET status='pending' WHERE id=?").run(eventId);
    });
  }

  dismiss(eventId: string): void {
    this.transaction(() => {
      const row = this.row(eventId);
      if (!row) throw new Error(`Unknown event: ${eventId}`);
      if (row.status === "pending") throw new Error(`Event is not reserved: ${eventId}`);
      this.db.prepare("UPDATE bridge_events SET status='delivered' WHERE id=?").run(eventId);
      if (row.event.replyPolicy !== "required" && !row.reply) return;
      const reply = row.reply ?? { fingerprint: "__dismissed__", sentCount: 0, completed: false, inFlight: false };
      reply.completed = true;
      reply.inFlight = false;
      delete reply.sendingIndex;
      reply.completedAt = new Date().toISOString();
      this.saveReply(eventId, reply);
    });
  }

  claimReply(eventId: string, fingerprint: string, messages?: string[]): ReplyClaim {
    return this.transaction(() => {
      const row = this.row(eventId);
      if (!row) throw new Error(`Unknown event: ${eventId}`);
      const reply = row.reply;
      if (!reply) {
        this.saveReply(eventId, { fingerprint, sentCount: 0, completed: false, inFlight: true, owner: PROCESS_OWNER, messages });
        return { state: "send", sentCount: 0 };
      }
      if (reply.completed) return { state: "already_completed", sentCount: reply.sentCount };
      if (reply.fingerprint !== fingerprint) throw new Error(`Event already has a different reply: ${eventId}`);
      if (reply.inFlight && reply.owner === PROCESS_OWNER) return { state: "in_progress", sentCount: reply.sentCount };
      if (reply.sendingIndex !== undefined) throw new Error(`Reply delivery is uncertain; verify the last bubble and use cove_bridge_recover_reply: ${eventId}`);
      reply.inFlight = true;
      reply.owner = PROCESS_OWNER;
      this.saveReply(eventId, reply);
      return { state: "send", sentCount: reply.sentCount };
    });
  }

  private claimedReply(eventId: string, fingerprint: string): ReplyDeliveryState {
    const reply = this.row(eventId)?.reply;
    if (!reply || reply.fingerprint !== fingerprint) throw new Error(`Reply is not claimed: ${eventId}`);
    return reply;
  }

  markReplySending(eventId: string, fingerprint: string): void {
    this.transaction(() => {
      const reply = this.claimedReply(eventId, fingerprint);
      if (!reply.inFlight || reply.completed || reply.sendingIndex !== undefined) throw new Error(`Reply cannot start another send: ${eventId}`);
      if (reply.messages && reply.sentCount >= reply.messages.length) throw new Error(`Reply has no unsent bubble: ${eventId}`);
      reply.sendingIndex = reply.sentCount;
      this.saveReply(eventId, reply);
    });
  }

  markReplyMessageSent(eventId: string, fingerprint: string, receipt?: ReplyDeliveryState["lastReceipt"]): number {
    return this.transaction(() => {
      const reply = this.claimedReply(eventId, fingerprint);
      reply.sentCount += 1;
      if (receipt) reply.lastReceipt = receipt;
      delete reply.sendingIndex;
      this.saveReply(eventId, reply);
      return reply.sentCount;
    });
  }

  markReplyCompleted(eventId: string, fingerprint: string): void {
    this.transaction(() => {
      const reply = this.claimedReply(eventId, fingerprint);
      if (reply.sendingIndex !== undefined) throw new Error(`Reply delivery is uncertain: ${eventId}`);
      if (reply.messages && reply.sentCount !== reply.messages.length) throw new Error(`Reply still has unsent bubbles: ${eventId}`);
      reply.completed = true;
      reply.inFlight = false;
      reply.completedAt = new Date().toISOString();
      this.saveReply(eventId, reply);
      this.db.prepare("UPDATE bridge_events SET status='delivered' WHERE id=?").run(eventId);
    });
  }

  releaseReply(eventId: string, fingerprint: string, retrySafe = false): void {
    this.transaction(() => {
      const reply = this.row(eventId)?.reply;
      if (!reply || reply.fingerprint !== fingerprint || reply.completed) return;
      reply.inFlight = false;
      if (retrySafe) delete reply.sendingIndex;
      this.saveReply(eventId, reply);
    });
  }

  recoverReply(eventId: string, lastBubbleDelivered: boolean): ReplyDeliveryState {
    return this.transaction(() => {
      const reply = this.row(eventId)?.reply;
      if (!reply || reply.completed || reply.sendingIndex === undefined) throw new Error(`Reply has no uncertain send: ${eventId}`);
      if (reply.inFlight && reply.owner === PROCESS_OWNER) throw new Error(`Reply is still being delivered: ${eventId}`);
      if (lastBubbleDelivered) reply.sentCount += 1;
      delete reply.sendingIndex;
      reply.inFlight = false;
      this.saveReply(eventId, reply);
      return reply;
    });
  }

  status(): QueueStatus {
    const conversation = emptyCounts();
    const state = emptyCounts();
    const rows = this.db.prepare("SELECT stream,status,count(*) AS count FROM bridge_events GROUP BY stream,status").all();
    for (const row of rows) {
      const counts = row.stream === "conversation" ? conversation : state;
      counts[row.status as StoredBridgeEvent["status"]] += Number(row.count);
      counts.total += Number(row.count);
    }
    return {
      pending: conversation.pending + state.pending,
      reserved: conversation.reserved + state.reserved,
      delivered: conversation.delivered + state.delivered,
      total: conversation.total + state.total,
      conversation, state,
    };
  }
}

export class InMemoryEventQueue extends SqliteEventQueue {
  constructor() { super(":memory:"); }
}
