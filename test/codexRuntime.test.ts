import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexRuntime } from "../src/codex/runtime.js";

function fixture(t: test.TestContext, mode = "normal") {
  const directory = mkdtempSync(join(tmpdir(), "resonance-codex-rpc-"));
  const path = join(directory, "state.json");
  const tools = {
    list: async () => [{ name: "music_test", description: "test", inputSchema: { type: "object" } }],
    call: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, "music_test"); assert.equal(args.value, 42);
      return { success: true, contentItems: [{ type: "inputText" as const, text: "tool result" }] };
    },
  };
  const runtime = new CodexRuntime({ executable: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url)), path, mode], cwd: directory, tools });
  t.after(async () => { await runtime.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { runtime, path };
}

test("native stdio adapter creates and resumes a persistent thread and matches turn identity", async t => {
  const { runtime, path } = fixture(t);
  const threadId = await runtime.createThread();
  const turns: string[] = [];
  for (const marker of ["event-one", "event-two"]) {
    const result = await runtime.generate({ threadId, marker, text: "hello", onStarted: turn => turns.push(turn) });
    assert.deepEqual(JSON.parse(result), { reply: "hello" });
  }
  assert.deepEqual(turns, ["turn-1", "turn-2"]);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(Object.keys(state.threads).length, 1);
  assert.equal(state.threads[threadId].options.ephemeral, false);
  assert.equal(state.threads[threadId].options.dynamicTools[0].name, "music_test");
});

test("native dynamic tools return validated results into the same turn", async t => {
  const { runtime } = fixture(t, "tool");
  const threadId = await runtime.createThread();
  const result = await runtime.generate({ threadId, marker: "tool-event", text: "use a tool", onStarted: () => {} });
  assert.deepEqual(JSON.parse(result), { reply: "tool result" });
});

test("an abort interrupts the active native turn and reports interruption", async t => {
  const { runtime } = fixture(t, "interrupt");
  const threadId = await runtime.createThread();
  const controller = new AbortController();
  const generation = runtime.generate({ threadId, marker: "state-event", text: "listen", signal: controller.signal, onStarted: () => controller.abort() });
  await assert.rejects(generation, /interrupted/);
});

test("a completed native result lost before local acceptance is recovered without another generation", async t => {
  const { runtime, path } = fixture(t, "lost-completed");
  const threadId = await runtime.createThread();
  await assert.rejects(runtime.generate({ threadId, marker: "recover-marker", text: "hello", onStarted: () => {} }), /disconnected/);
  const recovered = await runtime.recover(threadId, "recover-marker", null);
  assert.deepEqual(JSON.parse(recovered!), { reply: "saved before disconnect" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).turns, 1);
});

test("an incomplete native turn requires explicit retry instead of repeating its tools", async t => {
  const { runtime, path } = fixture(t, "lost-running");
  const threadId = await runtime.createThread();
  await assert.rejects(runtime.generate({ threadId, marker: "incomplete", text: "hello", onStarted: () => {} }), /disconnected/);
  await assert.rejects(runtime.recover(threadId, "incomplete", null), /explicit retry/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).turns, 1);
});

test("expired turn context rejects tool execution before reaching a music capability", async t => {
  const { runtime } = fixture(t, "tool");
  const threadId = await runtime.createThread();
  const result = await runtime.generate({ threadId, marker: "stale-route", text: "use a tool", canCallTools: () => false, onStarted: () => {} });
  assert.match(JSON.parse(result).reply, /no longer active/);
});

test("an older turn cannot execute a tool in the current thread", async t => {
  const { runtime } = fixture(t, "stale-tool");
  const threadId = await runtime.createThread();
  const result = await runtime.generate({ threadId, marker: "current-event", text: "hello", onStarted: () => {} });
  assert.match(JSON.parse(result).reply, /no longer active/);
});

test("native history recovery follows pagination when the saved turn ID is unavailable", async t => {
  const { runtime } = fixture(t, "paginated");
  const threadId = await runtime.createThread();
  await runtime.generate({ threadId, marker: "older-event", text: "hello", onStarted: () => {} });
  const recovered = await runtime.recover(threadId, "older-event", null);
  assert.deepEqual(JSON.parse(recovered!), { reply: "hello" });
});
