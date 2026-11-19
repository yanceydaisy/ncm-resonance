import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { SqliteEventQueue } from "../src/queue.js";
import { buildBridgeEvent } from "../src/bridge/events.js";
import { buildListenerHtml } from "../src/listener-html.js";

test("a pre-rename database keeps pending content and acknowledged reply progress", t => {
  const directory = mkdtempSync(join(tmpdir(), "resonance-upgrade-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "bridge.sqlite");
  let queue = new SqliteEventQueue(path);
  const event = buildBridgeEvent("existing", "netease.chatroom", "Cove is a quoted human message");
  event.modelContext = "Cove Bridge: use cove_bridge_reply for eventId=existing";
  queue.enqueue(event); queue.reserveNext(); queue.markDelivered(event.id);
  queue.claimReply(event.id, "original-fingerprint", ["original reply", "remaining reply"]);
  queue.markReplySending(event.id, "original-fingerprint");
  queue.markReplyMessageSent(event.id, "original-fingerprint");
  queue.releaseReply(event.id, "original-fingerprint"); queue.close();
  queue = new SqliteEventQueue(path); t.after(() => queue.close());
  const pending = queue.getOutstandingRequiredReplyEvent()!;
  assert.equal(pending.visibleText, event.visibleText);
  assert.equal(pending.modelContext, "NCM Resonance: use ncm_resonance_reply for eventId=existing");
  assert.deepEqual(queue.claimReply(event.id, "original-fingerprint"), { state: "send", sentCount: 1 });
  assert.deepEqual(queue.getReply(event.id)?.messages, ["original reply", "remaining reply"]);
});

test("the renamed widget merges old local terminal records before listening", () => {
  const storage = new Map([
    ["cove-bridge-dispatched-v1", '["old-event"]'],
    ["resonance-bridge-dispatched-v1", '["middle-event"]'],
    ["ncm-resonance-dispatched-v1", '["new-event"]'],
    ["cove-bridge-pending-acks-v1", '["old-ack"]'],
    ["resonance-bridge-pending-acks-v1", '["middle-ack"]'],
    ["cove-bridge-pending-dismissals-v1", '["old-dismissal"]'],
  ]);
  const script = buildListenerHtml().match(/<script>([\s\S]*?)<\/script>/)![1];
  runInNewContext(script, {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    document: { getElementById: () => ({ addEventListener() {} }) },
    window: { parent: { postMessage() {} }, addEventListener() {}, setTimeout() {} },
  });
  assert.deepEqual(JSON.parse(storage.get("ncm-resonance-dispatched-v1")!), ["new-event", "middle-event", "old-event"]);
  assert.deepEqual(JSON.parse(storage.get("ncm-resonance-pending-acks-v1")!), ["middle-ack", "old-ack"]);
  assert.deepEqual(JSON.parse(storage.get("ncm-resonance-pending-dismissals-v1")!), ["old-dismissal"]);
  assert.equal(storage.has("cove-bridge-dispatched-v1"), false);
  assert.equal(storage.has("resonance-bridge-dispatched-v1"), false);
});
