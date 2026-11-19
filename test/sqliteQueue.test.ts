import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteEventQueue } from "../src/queue.js";
import type { BridgeEvent } from "../src/types.js";

const event = (id: string): BridgeEvent => ({
  id, correlationId: id, kind: "message", source: "netease.chatroom", stream: "conversation",
  replyRoute: "netease.chatroom", replyPolicy: "required", createdAt: new Date(0).toISOString(),
  visibleText: id, modelContext: id, replyTarget: { roomId: "original-room", chatRoomId: "123" },
});

function database(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "resonance-queue-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "bridge.sqlite");
}

function interruptedReply(path: string, acknowledgement: boolean): void {
  const source = `
    import { SqliteEventQueue } from ${JSON.stringify(new URL("../src/queue.ts", import.meta.url).href)};
    const queue = new SqliteEventQueue(${JSON.stringify(path)});
    queue.enqueue(${JSON.stringify(event("interrupted"))});
    queue.reserveNext();
    queue.markDelivered('interrupted');
    queue.claimReply('interrupted', 'fingerprint', ['first', 'second']);
    queue.markReplySending('interrupted', 'fingerprint');
    ${acknowledgement ? "queue.markReplyMessageSent('interrupted', 'fingerprint');" : ""}
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
}

test("SQLite preserves FIFO, newest state, route binding and duplicate IDs after reopening", t => {
  const path = database(t);
  let queue = new SqliteEventQueue(path);
  queue.enqueue(event("first"));
  queue.enqueue(event("second"));
  for (const id of ["old-state", "new-state"]) queue.enqueue({ ...event(id), stream: "state", stateKey: "playback", replyPolicy: "optional" });
  queue.close();
  queue = new SqliteEventQueue(path);
  t.after(() => queue.close());
  assert.equal(queue.enqueue(event("first")), false);
  assert.equal(queue.getEvent("old-state"), null);
  assert.deepEqual(queue.getEvent("first")?.replyTarget, event("first").replyTarget);
  for (const id of ["first", "second", "new-state"]) {
    assert.equal(queue.reserveNext()?.id, id);
    queue.markDelivered(id);
    if (id !== "new-state") queue.dismiss(id);
  }
  assert.equal(queue.reserveNext(), null);
});

test("acknowledged bubbles survive abrupt process exit and resume at the saved cursor", t => {
  const path = database(t);
  interruptedReply(path, true);
  const queue = new SqliteEventQueue(path);
  t.after(() => queue.close());
  assert.deepEqual(queue.claimReply("interrupted", "fingerprint"), { state: "send", sentCount: 1 });
  assert.deepEqual(queue.getReply("interrupted")?.messages, ["first", "second"]);
  assert.equal(queue.getOutstandingRequiredReplyEvent()?.id, "interrupted");
});

test("a lost receipt blocks replay until the observed destination result is recorded", t => {
  const path = database(t);
  interruptedReply(path, false);
  const queue = new SqliteEventQueue(path);
  t.after(() => queue.close());
  assert.throws(() => queue.claimReply("interrupted", "fingerprint"), /uncertain/);
  assert.equal(queue.recoverReply("interrupted", true).sentCount, 1);
  assert.deepEqual(queue.claimReply("interrupted", "fingerprint"), { state: "send", sentCount: 1 });
  assert.throws(() => queue.recoverReply("interrupted", true), /no uncertain send/);
});

test("verified absence allows exactly the unacknowledged bubble to be retried", t => {
  const path = database(t);
  interruptedReply(path, false);
  const queue = new SqliteEventQueue(path);
  t.after(() => queue.close());
  assert.equal(queue.recoverReply("interrupted", false).sentCount, 0);
  assert.deepEqual(queue.claimReply("interrupted", "fingerprint"), { state: "send", sentCount: 0 });
  queue.markReplySending("interrupted", "fingerprint");
  assert.throws(() => queue.recoverReply("interrupted", false), /still being delivered/);
});

test("completed replies and dismissed events remain terminal across restarts", t => {
  const path = database(t);
  let queue = new SqliteEventQueue(path);
  queue.enqueue(event("done"));
  queue.reserveNext();
  queue.markDelivered("done");
  queue.claimReply("done", "fp", ["hello"]);
  queue.markReplySending("done", "fp");
  queue.markReplyMessageSent("done", "fp");
  queue.markReplyCompleted("done", "fp");
  queue.enqueue(event("dismissed"));
  queue.reserveNext();
  queue.dismiss("dismissed");
  queue.close();
  queue = new SqliteEventQueue(path);
  t.after(() => queue.close());
  assert.deepEqual(queue.claimReply("done", "fp"), { state: "already_completed", sentCount: 1 });
  assert.equal(queue.reserveNext(), null);
  assert.equal(queue.getOutstandingRequiredReplyEvent(), null);
});

test("failed persistence rolls back coalescing as one transaction", t => {
  const queue = new SqliteEventQueue(database(t));
  t.after(() => queue.close());
  const state = { ...event("original"), stream: "state" as const, stateKey: "playback" };
  queue.enqueue(state);
  const circular = { ...state, id: "invalid" } as BridgeEvent & { circular?: unknown };
  circular.circular = circular;
  assert.throws(() => queue.enqueue(circular), /circular/i);
  assert.equal(queue.reserveNext()?.id, "original");
});

test("separate handles share atomic claims and reservations", t => {
  const path = database(t);
  const first = new SqliteEventQueue(path);
  const second = new SqliteEventQueue(path);
  t.after(() => { first.close(); second.close(); });
  first.enqueue(event("shared"));
  assert.equal(first.reserveNext()?.id, "shared");
  assert.equal(second.reserveNext(), null);
  assert.deepEqual(first.claimReply("shared", "fp"), { state: "send", sentCount: 0 });
  assert.deepEqual(second.claimReply("shared", "fp"), { state: "in_progress", sentCount: 0 });
});

test("a definitive send rejection can retry, while a timeout retains uncertainty", t => {
  const queue = new SqliteEventQueue(database(t));
  t.after(() => queue.close());
  queue.enqueue(event("retry"));
  queue.claimReply("retry", "fp");
  queue.markReplySending("retry", "fp");
  queue.releaseReply("retry", "fp", true);
  assert.equal(queue.claimReply("retry", "fp").state, "send");
  queue.markReplySending("retry", "fp");
  queue.releaseReply("retry", "fp");
  assert.throws(() => queue.claimReply("retry", "fp"), /uncertain/);
});
