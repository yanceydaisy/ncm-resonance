import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteEventQueue } from "../src/queue.js";
import { buildBridgeEvent } from "../src/bridge/events.js";
import { CodexService, type CodexPort } from "../src/codex/service.js";
import type { CodexEngine, CodexGeneration } from "../src/codex/runtime.js";
import type { BridgeEvent } from "../src/types.js";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "resonance-codex-service-"));
  const path = join(directory, "bridge.sqlite");
  const queue = new SqliteEventQueue(path);
  let now = 10_000;
  const route = { connected: true, roomId: "room-one", chatRoomId: "123" };
  const generations: CodexGeneration[] = [];
  const sends: Array<{ text: string; roomId?: string }> = [];
  let threads = 0;
  let recoveries = 0;
  const engine: CodexEngine = {
    createThread: async () => "thread-" + (++threads),
    generate: async input => { generations.push(input); input.onStarted("turn-" + generations.length); return JSON.stringify({ reply: "hello" }); },
    recover: async () => { recoveries += 1; return JSON.stringify({ reply: "recovered" }); },
    stop: async () => {},
  };
  const port: CodexPort = {
    getRealtimeStatus: () => ({ ...route }), getMusicContext: () => "latest playback data", getConversationKey: () => "self:peer",
    sendChatRoomText: async (text, options = {}) => {
      sends.push({ text, roomId: options.roomId });
      return { ok: true, roomId: route.roomId, chatRoomId: route.chatRoomId, messageId: options.messageId!, text, code: 200 };
    },
  };
  const service = new CodexService(queue, port, engine, { path, now: () => now, stateSettleMs: 0 });
  t.after(async () => { await service.stop(); queue.close(); rmSync(directory, { recursive: true, force: true }); });
  const enqueue = (id: string, state = false, fingerprint = id): BridgeEvent => {
    const event = buildBridgeEvent(id, state ? "netease.music_changed" : "netease.chatroom", id,
      new Date(now - 2000).toISOString(), "captured lyrics", { roomId: route.roomId, chatRoomId: route.chatRoomId },
      { conversationKey: "self:peer", stateFingerprint: state ? fingerprint : undefined });
    queue.enqueue(event); service.notify(event); return event;
  };
  return { path, queue, service, engine, port, route, generations, sends, enqueue,
    threadCount: () => threads, recoveryCount: () => recoveries, advance: () => { now += 6000; } };
}

test("Codex reply generation and native delivery complete once through the durable queue", async t => {
  const f = fixture(t);
  f.enqueue("first"); await f.service.tick(); await f.service.tick();
  assert.equal(f.generations.length, 1);
  assert.deepEqual(f.sends, [{ text: "hello", roomId: "room-one" }]);
  assert.equal(f.service.store.get("first")?.phase, "done");
  assert.match(f.generations[0].text, /latest playback data/);
  assert.match(f.generations[0].text, /captured lyrics/);
  assert.doesNotMatch(f.generations[0].text, /call resonance_bridge_reply exactly once/);
});

test("reopening Together with the same peer reuses its persistent Codex thread", async t => {
  const f = fixture(t);
  f.enqueue("first"); await f.service.tick();
  f.route.roomId = "room-two"; f.route.chatRoomId = "456";
  f.enqueue("second"); await f.service.tick();
  assert.equal(f.threadCount(), 1);
  assert.equal(f.generations[0].threadId, f.generations[1].threadId);
  assert.equal(f.sends[1].roomId, "room-two");
});

test("offline rooms retain pending messages without starting Codex", async t => {
  const f = fixture(t);
  f.enqueue("offline"); f.route.connected = false;
  await f.service.tick();
  assert.equal(f.threadCount(), 0);
  assert.equal(f.queue.status().pending, 1);
});

test("latest state coalescing, silence and reconnect dedupe use persisted state identity", async t => {
  const f = fixture(t);
  f.engine.generate = async input => { f.generations.push(input); return JSON.stringify({ reply: null }); };
  f.enqueue("old-state", true); f.enqueue("current-state", true, "same-song");
  await f.service.tick();
  f.enqueue("reconnect", true, "same-song"); await f.service.tick();
  assert.equal(f.generations.length, 1);
  assert.equal(f.sends.length, 0);
  assert.equal(f.service.store.get("reconnect")?.phase, "done");
});

test("human messages interrupt a music-state reaction and receive priority", async t => {
  const f = fixture(t);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.engine.generate = input => {
    f.generations.push(input);
    if (input.text.includes("A human message")) return Promise.resolve(JSON.stringify({ reply: "human reply" }));
    return new Promise((_, reject) => { input.signal!.addEventListener("abort", () => reject(new Error("interrupted"))); entered(); });
  };
  f.enqueue("music", true);
  const tick = f.service.tick(); await started;
  f.enqueue("human"); await tick; await f.service.tick();
  assert.deepEqual(f.sends.map(value => value.text), ["human reply"]);
});

test("a newer song suppresses an obsolete reaction generated in flight", async t => {
  const f = fixture(t);
  let complete!: (response: string) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.engine.generate = async input => { f.generations.push(input); entered(); return new Promise(resolve => { complete = resolve; }); };
  f.enqueue("old-song", true);
  const tick = f.service.tick(); await started;
  f.enqueue("new-song", true); complete(JSON.stringify({ reply: "obsolete" })); await tick;
  assert.equal(f.sends.length, 0);
  f.engine.generate = async () => JSON.stringify({ reply: "current" });
  await f.service.tick();
  assert.deepEqual(f.sends.map(value => value.text), ["current"]);
});

test("an interrupted generation reconciles the saved native turn without generating twice", async t => {
  const f = fixture(t);
  f.enqueue("recover"); f.queue.reserveNext(); f.queue.markDelivered("recover");
  f.service.store.ensure("recover", "self:peer"); f.service.store.bindThread("self:peer", "thread-existing");
  f.service.store.starting("recover", "thread-existing", 9000); f.service.store.started("recover", "native-turn");
  await f.service.tick();
  assert.equal(f.recoveryCount(), 1);
  assert.equal(f.generations.length, 0);
  assert.deepEqual(f.sends.map(value => value.text), ["recovered"]);
});

test("missing native history requires explicit restart confirmation", async t => {
  const f = fixture(t);
  f.enqueue("unknown"); f.queue.reserveNext(); f.queue.markDelivered("unknown");
  f.service.store.ensure("unknown", "self:peer"); f.service.store.bindThread("self:peer", "thread-existing");
  f.service.store.starting("unknown", "thread-existing", 9000);
  f.engine.recover = async () => null;
  await f.service.tick();
  assert.equal(f.service.store.get("unknown")?.phase, "failed");
  assert.throws(() => f.service.retry("unknown", false), /confirmRestart/);
  f.service.retry("unknown", true); await f.service.tick();
  assert.equal(f.generations.length, 1);
});

test("cached generation resumes delivery after a definitive send rejection", async t => {
  const f = fixture(t);
  let reject = true;
  const send = f.port.sendChatRoomText;
  f.port.sendChatRoomText = async (text, options) => {
    if (reject) throw new Error("NIM ChatRoom send request was rejected locally");
    return send(text, options);
  };
  f.enqueue("retry-send"); await f.service.tick();
  assert.equal(f.service.store.get("retry-send")?.phase, "generated");
  reject = false; f.advance(); await f.service.tick();
  assert.equal(f.generations.length, 1);
  assert.equal(f.sends.length, 1);
});

test("a room switch during generation retains the result for its original route", async t => {
  const f = fixture(t);
  f.engine.generate = async input => {
    f.generations.push(input); f.route.roomId = "different-room";
    return JSON.stringify({ reply: "original reply" });
  };
  f.enqueue("old-room"); await f.service.tick();
  assert.equal(f.sends.length, 0);
  f.route.roomId = "room-one"; f.advance(); await f.service.tick();
  assert.equal(f.generations.length, 1);
  assert.deepEqual(f.sends, [{ text: "original reply", roomId: "room-one" }]);
});

test("long generated text is delivered within platform limits without losing its ending", async t => {
  const f = fixture(t);
  const text = Array.from({ length: 8 }, (_, index) => "paragraph " + index + " " + "x".repeat(400)).join("\n\n") + " KEEP_THE_END";
  f.engine.generate = async () => JSON.stringify({ reply: text });
  f.enqueue("long"); await f.service.tick();
  assert.ok(f.sends.every(send => send.text.length <= 500));
  assert.match(f.sends.at(-1)!.text, /KEEP_THE_END$/);
});

test("a lost delivery receipt blocks replay until its original journal is resolved", async t => {
  const f = fixture(t);
  let calls = 0;
  f.port.sendChatRoomText = async () => { calls += 1; throw new Error("NIM ChatRoom send timed out"); };
  f.enqueue("uncertain"); await f.service.tick();
  f.advance(); await f.service.tick();
  assert.equal(calls, 1);
  f.queue.recoverReply("uncertain", true);
  await f.service.tick();
  assert.equal(calls, 1);
  assert.equal(f.service.store.get("uncertain")?.phase, "done");
});

test("empty human output is reported as a generation failure that can be explicitly retried", async t => {
  const f = fixture(t);
  f.engine.generate = async () => JSON.stringify({ reply: null });
  f.enqueue("empty-human"); await f.service.tick();
  assert.equal(f.service.store.get("empty-human")?.phase, "failed");
  assert.equal(f.service.store.get("empty-human")?.response, null);
  assert.match(String(f.service.status().lastError), /empty human reply/);
});

test("a generated optional state reply resumes after a transient delivery failure", async t => {
  const f = fixture(t);
  const send = f.port.sendChatRoomText;
  let failing = true;
  f.port.sendChatRoomText = async (text, options) => {
    if (failing) throw new Error("NIM ChatRoom send request was rejected locally");
    return send(text, options);
  };
  f.enqueue("state-retry", true); await f.service.tick();
  failing = false; f.advance(); await f.service.tick();
  assert.equal(f.generations.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.service.store.get("state-retry")?.phase, "done");
});

test("conversation-to-thread mapping survives rebuilding the standalone service", async t => {
  const f = fixture(t);
  f.enqueue("before-restart"); await f.service.tick();
  await f.service.stop();
  const resumed = new CodexService(f.queue, f.port, f.engine, { path: f.path });
  t.after(() => resumed.stop());
  f.enqueue("after-restart"); await resumed.tick();
  assert.equal(f.threadCount(), 1);
  assert.equal(f.generations[0].threadId, f.generations[1].threadId);
});

test("old offline jobs cannot starve a cached state reply for the connected room", async t => {
  const f = fixture(t);
  for (let index = 0; index < 101; index += 1) {
    f.route.roomId = "offline-" + index;
    const event = f.enqueue("offline-job-" + index, true);
    f.queue.reserveNext(); f.queue.markDelivered(event.id);
    f.service.store.ensure(event.id, "self:peer");
    f.service.store.generated(event.id, JSON.stringify({ reply: "old" }));
  }
  f.route.roomId = "room-one";
  const event = f.enqueue("cached-state", true);
  f.queue.reserveNext(); f.queue.markDelivered(event.id);
  f.service.store.ensure(event.id, "self:peer");
  f.service.store.generated(event.id, JSON.stringify({ reply: "current" }));
  await f.service.tick();
  assert.deepEqual(f.sends, [{ text: "current", roomId: "room-one" }]);
  assert.equal(f.generations.length, 0);
});
