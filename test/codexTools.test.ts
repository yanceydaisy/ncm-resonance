import assert from "node:assert/strict";
import test from "node:test";
import { createCodexTools } from "../src/codex/tools.js";
import { InMemoryEventQueue } from "../src/queue.js";
import { TogetherWorker } from "../src/netease/togetherWorker.js";
import { PlaybackStateStore } from "../src/netease/playbackState.js";
import { createMcpServer } from "../src/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

test("Codex music tools reuse the existing schemas and return actual playback results", async t => {
  const queue = new InMemoryEventQueue();
  const playback = new PlaybackStateStore();
  const worker = new TogetherWorker({ cookie: "", enabled: false, onEvent: () => {} });
  const tools = await createCodexTools(queue, worker, playback);
  t.after(async () => { await tools.close(); queue.close(); });
  const names = new Set((await tools.list()).map(tool => tool.name));
  for (const name of ["netease_together_now", "netease_together_pause", "netease_together_goto", "netease_together_leave"]) assert.ok(names.has(name));
  for (const name of ["resonance_bridge_reply", "resonance_bridge_wait", "resonance_bridge_sync", "netease_together_send_message"]) assert.equal(names.has(name), false);
  const result = await tools.call("netease_together_now", {});
  assert.equal(result.success, true);
  assert.equal(JSON.parse(result.contentItems[0].text).inRoom, false);
  assert.equal((await tools.call("netease_together_goto", { songId: "invalid" })).success, false);
});

test("automatic mode exposes recovery and music controls without competing queue consumers", async t => {
  const queue = new InMemoryEventQueue();
  const server = createMcpServer(queue, new PlaybackStateStore(), new TogetherWorker({ cookie: "", enabled: false, onEvent: () => {} }), "music", { automaticReplies: true });
  const client = new Client({ name: "automatic-test", version: "1" });
  const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
  await server.connect(incoming); await client.connect(outgoing);
  t.after(async () => { await client.close(); await server.close(); queue.close(); });
  const listed = (await client.listTools()).tools;
  const names = new Set(listed.map(tool => tool.name));
  assert.match(listed.find(tool => tool.name === "resonance_bridge_recover_reply")!.description!, /automatic scheduler/);
  assert.doesNotMatch(listed.find(tool => tool.name === "resonance_bridge_recover_reply")!.description!, /resonance_bridge_reply/);
  assert.ok(names.has("resonance_bridge_recover_reply"));
  assert.ok(names.has("netease_together_resume"));
  assert.equal(names.has("resonance_bridge_wait"), false);
  assert.equal(names.has("open_resonance_bridge"), false);
  assert.equal(names.has("resonance_bridge_reply"), false);
});
