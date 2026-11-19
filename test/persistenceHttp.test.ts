import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

async function start(path: string): Promise<{ child: ChildProcess; base: string }> {
  const source = `
    const { createHttpServer } = await import(${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)});
    const server = createHttpServer();
    server.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port));
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    env: { ...process.env, NODE_ENV: "test", BRIDGE_DB_PATH: path, BRIDGE_INGEST_TOKEN: "", NETEASE_COOKIE: "", TOGETHER_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout " + stderr)); }, 10_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error("startup exit " + code + " " + stderr)); });
    child.stdout!.on("data", chunk => {
      output += String(chunk);
      const match = output.match(/READY (\d+)/);
      if (match) { clearTimeout(timer); resolve("http://127.0.0.1:" + match[1]); }
    });
  });
  return { child, base };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function tool(base: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(base + "/mcp/music", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json() as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
  assert.equal(response.status, 200);
  assert.notEqual(body.result.isError, true, JSON.stringify(body));
  return body.result.structuredContent;
}

test("HTTP ingress, reservation, ACK and terminal dedupe survive actual server kills", async t => {
  const dir = mkdtempSync(join(tmpdir(), "resonance-http-"));
  let running = await start(join(dir, "bridge.sqlite"));
  t.after(async () => { await stop(running.child); rmSync(dir, { recursive: true, force: true }); });
  const ingress = () => fetch(running.base + "/events", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: "persisted-http", source: "netease.chatroom", text: "kept across restarts" }),
  });
  assert.equal((await ingress()).status, 201);
  await stop(running.child);
  running = await start(join(dir, "bridge.sqlite"));
  assert.equal((await ingress()).status, 200);
  assert.equal((await tool(running.base, "ncm_resonance_wait", { timeoutSeconds: 1 })).eventId, "persisted-http");
  await stop(running.child);
  running = await start(join(dir, "bridge.sqlite"));
  const reserved = await tool(running.base, "ncm_resonance_wait", { timeoutSeconds: 1 });
  assert.equal(reserved.awaitingReply, true);
  assert.match(String(reserved.visibleText), /kept across restarts/);
  await tool(running.base, "ncm_resonance_wait_ack", { eventId: "persisted-http" });
  await stop(running.child);
  running = await start(join(dir, "bridge.sqlite"));
  assert.equal((await tool(running.base, "ncm_resonance_wait", { timeoutSeconds: 1 })).awaitingReply, true);
  await tool(running.base, "ncm_resonance_dismissed", { eventId: "persisted-http" });
  await stop(running.child);
  running = await start(join(dir, "bridge.sqlite"));
  assert.equal((await ingress()).status, 200);
  assert.equal((await tool(running.base, "ncm_resonance_wait", { timeoutSeconds: 1 })).timedOut, true);
});
