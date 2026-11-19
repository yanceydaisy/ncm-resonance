import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBridgeTools } from "../src/bridge/registerTools.js";
import { buildBridgeEvent } from "../src/bridge/events.js";
import { SqliteEventQueue } from "../src/queue.js";
import type { TogetherWorker } from "../src/netease/togetherWorker.js";
import type { RealtimeChatSendOptions, RealtimeChatSendResult } from "../src/netease/realtimeTransport.js";

async function connect(queue: SqliteEventQueue, send: (text: string, options?: RealtimeChatSendOptions) => Promise<RealtimeChatSendResult>) {
  const server = new McpServer({ name: "reply-test", version: "1" });
  registerBridgeTools(server, queue, () => true, { sendChatRoomText: send } as TogetherWorker);
  const client = new Client({ name: "reply-test", version: "1" });
  const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
  await server.connect(incoming);
  await client.connect(outgoing);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

for (const failure of ["NIM ChatRoom send request was rejected locally", "NIM ChatRoom send timed out"]) {
  test("routed reply journal handles " + failure + " through the real MCP entry point", async t => {
    const dir = mkdtempSync(join(tmpdir(), "resonance-reply-"));
    const path = join(dir, "queue.sqlite");
    let queue = new SqliteEventQueue(path);
    queue.enqueue(buildBridgeEvent("routed", "netease.chatroom", "hello", undefined, undefined, { roomId: "original", chatRoomId: "123" }));
    queue.reserveNext();
    queue.markDelivered("routed");
    const sent: string[] = [];
    const optionsSeen: RealtimeChatSendOptions[] = [];
    let fail = true;
    const send = async (text: string, options?: RealtimeChatSendOptions): Promise<RealtimeChatSendResult> => {
      optionsSeen.push(options!);
      if (text === "second" && fail) throw new Error(failure);
      sent.push(text);
      return { ok: true, roomId: "original", chatRoomId: "123", messageId: options!.messageId!, text, code: 200 };
    };
    let session = await connect(queue, send);
    t.after(async () => { await session.close(); queue.close(); rmSync(dir, { recursive: true, force: true }); });
    const arguments_ = { eventId: "routed", messages: ["first", "second"] };
    assert.equal((await session.client.callTool({ name: "cove_bridge_reply", arguments: arguments_ })).isError, true);
    assert.deepEqual(sent, ["first"]);
    assert.equal(queue.getReply("routed")?.sentCount, 1);
    await session.close();
    queue.close();
    queue = new SqliteEventQueue(path);
    session = await connect(queue, send);
    fail = false;
    if (failure.includes("timed out")) {
      const attempts = optionsSeen.length;
      assert.equal((await session.client.callTool({ name: "cove_bridge_reply", arguments: arguments_ })).isError, true);
      assert.equal(optionsSeen.length, attempts);
      const recovered = await session.client.callTool({ name: "cove_bridge_recover_reply", arguments: { eventId: "routed", lastBubbleDelivered: false } });
      assert.notEqual(recovered.isError, true);
    }
    const completed = await session.client.callTool({ name: "cove_bridge_reply", arguments: arguments_ });
    assert.notEqual(completed.isError, true);
    assert.equal((completed.structuredContent as { completed: boolean }).completed, true);
    assert.deepEqual(sent, ["first", "second"]);
    assert.equal(optionsSeen[1].messageId, optionsSeen.at(-1)!.messageId);
    assert.ok(optionsSeen.every(options => options.roomId === "original" && options.chatRoomId === "123"));
    await session.client.callTool({ name: "cove_bridge_reply", arguments: arguments_ });
    assert.deepEqual(sent, ["first", "second"]);
  });
}
