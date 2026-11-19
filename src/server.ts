import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createMcpServer } from "./mcp.js";
import { buildBridgeEvent } from "./bridge/events.js";
export { buildBridgeEvent } from "./bridge/events.js";
import { MCP_PATHS } from "./profiles.js";
import { listenerWakeHub } from "./listenerWake.js";
import { PlaybackStateStore } from "./netease/playbackState.js";
import { createTogetherWorker } from "./netease/togetherWorker.js";
import { SqliteEventQueue } from "./queue.js";
import type { BridgeEvent } from "./types.js";
import { createCodexTools } from "./codex/tools.js";
import { CodexRuntime } from "./codex/runtime.js";
import { CodexService } from "./codex/service.js";

const PORT = Number(process.env.PORT ?? 8787);
const INGEST_TOKEN = process.env.BRIDGE_INGEST_TOKEN ?? "";
const UNIX_SOCKET = process.env.BRIDGE_UNIX_SOCKET?.trim() ?? "";
const AI_BACKEND = process.env.BRIDGE_AI_BACKEND?.trim() || "chatgpt";
if (AI_BACKEND !== "chatgpt" && AI_BACKEND !== "codex") throw new Error("BRIDGE_AI_BACKEND must be chatgpt or codex");
const DB_PATH = process.env.BRIDGE_DB_PATH?.trim()
  || (process.env.NODE_ENV === "test" ? ":memory:" : resolve("data/bridge.sqlite"));
const queue = new SqliteEventQueue(DB_PATH);
let codex: CodexService | undefined;
let codexTools: Awaited<ReturnType<typeof createCodexTools>> | undefined;
let codexStartupError: string | null = null;
const playbackState = new PlaybackStateStore();

function enqueueTogetherEvent(
  source: string,
  text: string,
  additionalModelContext?: string,
  eventId?: string,
  replyTarget?: BridgeEvent["replyTarget"],
  identity: Pick<BridgeEvent, "conversationKey" | "stateFingerprint"> = {},
): boolean {
  const id = eventId ?? randomUUID();
  const event = buildBridgeEvent(
    id,
    source,
    text,
    new Date().toISOString(),
    additionalModelContext,
    replyTarget,
    identity,
  );
  const created = queue.enqueue(event);
  if (created) {
    if (AI_BACKEND === "codex") codex?.notify(event);
    else listenerWakeHub.wake(source);
  }
  return created;
}

const togetherWorker = createTogetherWorker(enqueueTogetherEvent, playbackState);

async function startCodex(): Promise<void> {
  try {
    codexTools = await createCodexTools(queue, togetherWorker, playbackState);
    const instructionsPath = process.env.CODEX_INSTRUCTIONS_FILE?.trim();
    const runtime = new CodexRuntime({
      executable: process.env.CODEX_BIN?.trim() || "codex",
      cwd: resolve(process.env.CODEX_WORKSPACE?.trim() || "data/codex-workspace"),
      model: process.env.CODEX_MODEL?.trim() || undefined,
      effort: process.env.CODEX_REASONING_EFFORT?.trim() || undefined,
      instructions: instructionsPath ? readFileSync(instructionsPath, "utf8") : undefined,
      tools: codexTools,
    });
    codex = new CodexService(queue, togetherWorker, runtime, { path: DB_PATH });
    codex.start();
  } catch (error) {
    codexStartupError = error instanceof Error ? error.message : String(error);
    console.error("Codex backend startup failed", { error: codexStartupError });
    await codexTools?.close();
    codexTools = undefined;
  }
}


const eventInput = z.object({
  eventId: z.string().trim().min(1).max(200).optional(),
  source: z.string().trim().min(1).max(80).default("test"),
  text: z.string().trim().min(1).max(4000),
  conversationKey: z.string().trim().min(1).max(200).optional(),
  replyTarget: z.object({ roomId: z.string().min(1), chatRoomId: z.string().min(1) }).optional(),
});

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function authorized(req: IncomingMessage): boolean {
  return !INGEST_TOKEN || req.headers.authorization === `Bearer ${INGEST_TOKEN}`;
}

export function createHttpServer() {
  return createServer(async (req, res) => {
    if (!req.url || !req.method) {
      res.writeHead(400).end("Bad Request");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, authorization, mcp-session-id",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      writeJson(res, 200, {
        ok: true,
        service: "cove-bridge",
        version: "0.4.0",
        backend: AI_BACKEND,
        codex: AI_BACKEND === "codex" ? { busy: codex?.status().busy ?? false, error: codexStartupError } : undefined,
        queue: queue.status(),
        listener: listenerWakeHub.status(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/listener/events") {
      const authorization = req.headers.authorization ?? "";
      const bearerToken = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : "";
      const token = bearerToken || url.searchParams.get("session")?.trim() || "";
      const session = token ? listenerWakeHub.consumeSession(token) : null;
      if (!session) {
        writeJson(res, 401, { error: "invalid_or_expired_listener_session" });
        return;
      }
      listenerWakeHub.subscribe(res, session.expiresAtMs);
      return;
    }

    if (req.method === "POST" && url.pathname === "/events") {
      if (!authorized(req)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const parsed = eventInput.safeParse(await readJson(req));
        if (!parsed.success) {
          writeJson(res, 400, { error: parsed.error.flatten() });
          return;
        }
        const createdAt = new Date().toISOString();
        const id = parsed.data.eventId ?? randomUUID();
        const event = buildBridgeEvent(id, parsed.data.source, parsed.data.text, createdAt, undefined, parsed.data.replyTarget, { conversationKey: parsed.data.conversationKey });
        const created = queue.enqueue(event);
        if (created) {
          if (AI_BACKEND === "codex") codex?.notify(event);
          else listenerWakeHub.wake(parsed.data.source);
        }
        writeJson(res, created ? 201 : 200, { ok: true, created, eventId: id });
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_request";
        writeJson(res, message === "request_too_large" ? 413 : 400, { error: message });
      }
      return;
    }

    if (url.pathname === "/codex/status" || url.pathname.startsWith("/codex/jobs/")) {
      if (!authorized(req)) { writeJson(res, 401, { error: "unauthorized" }); return; }
      if (!codex) { writeJson(res, 503, { backend: AI_BACKEND, error: codexStartupError ?? "Codex backend is not ready" }); return; }
      if (req.method === "GET" && url.pathname === "/codex/status") { writeJson(res, 200, codex.status()); return; }
      const match = url.pathname.match(/^\/codex\/jobs\/([^/]+)\/(retry|recover)$/);
      try {
        if (req.method !== "POST" || !match) { writeJson(res, 405, { error: "method_not_allowed" }); return; }
        const body = await readJson(req) as Record<string, unknown>;
        const eventId = decodeURIComponent(match[1]);
        if (match[2] === "recover") {
          if (typeof body.lastBubbleDelivered !== "boolean") throw new Error("lastBubbleDelivered must be boolean");
          queue.recoverReply(eventId, body.lastBubbleDelivered);
        }
        codex.retry(eventId, body.confirmRestart === true);
        writeJson(res, 202, { ok: true });
      } catch (error) { writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_request" }); }
      return;
    }

    const mcpMethods = new Set(["POST", "GET", "DELETE"]);
    const mcpProfile = MCP_PATHS.get(url.pathname);
    if (mcpProfile && mcpMethods.has(req.method)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      const server = createMcpServer(queue, playbackState, togetherWorker, mcpProfile, { automaticReplies: AI_BACKEND === "codex" });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("MCP request failed", error);
        if (!res.headersSent) writeJson(res, 500, { error: "internal_server_error" });
      }
      return;
    }

    res.writeHead(404).end("Not Found");
  });
}

if (process.env.NODE_ENV !== "test") {
  const servers = [createHttpServer()];
  servers[0].listen(PORT, "0.0.0.0", () => {
    console.log("Cove Resonance listening on http://0.0.0.0:" + PORT + " (MCP: /mcp, /mcp/music)");
    if (AI_BACKEND === "codex") void startCodex();
    togetherWorker.start();
  });

  if (UNIX_SOCKET) {
    if (existsSync(UNIX_SOCKET)) unlinkSync(UNIX_SOCKET);
    const unixServer = createHttpServer();
    servers.push(unixServer);
    unixServer.listen(UNIX_SOCKET, () => {
      chmodSync(UNIX_SOCKET, 0o666);
      console.log("Cove Resonance listening on unix://" + UNIX_SOCKET + " (MCP: /mcp, /mcp/music)");
    });
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await codex?.stop();
    await togetherWorker.shutdown();
    await codexTools?.close();
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    queue.close();
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

