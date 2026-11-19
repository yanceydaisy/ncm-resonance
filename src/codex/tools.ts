import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerNeteaseAccountTools } from "../netease/accountTools.js";
import { registerNeteaseTogetherTools } from "../netease/registerTogetherTools.js";
import { NeteaseClient } from "../netease/client.js";
import type { PlaybackStateStore } from "../netease/playbackState.js";
import type { TogetherWorker } from "../netease/togetherWorker.js";
import type { SqliteEventQueue } from "../queue.js";

export type CodexTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type CodexToolResult = { success: boolean; contentItems: Array<{ type: "inputText"; text: string }> };
export type CodexTools = { list(): Promise<CodexTool[]>; call(name: string, args: Record<string, unknown>): Promise<CodexToolResult> };

export async function createCodexTools(queue: SqliteEventQueue, worker: TogetherWorker, playback: PlaybackStateStore) {
  const server = new McpServer({ name: "resonance-bridge-codex-tools", version: "0.5.0" });
  registerNeteaseAccountTools(server, new NeteaseClient(process.env.NETEASE_COOKIE?.trim() ?? ""));
  registerNeteaseTogetherTools(server, playback, worker, queue, () => true, { automaticReplies: true });
  const client = new Client({ name: "resonance-bridge-codex", version: "0.5.0" });
  const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
  await server.connect(incoming);
  await client.connect(outgoing);
  const tools: CodexTools = {
    async list() {
      const result = await client.listTools();
      return result.tools.map(tool => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }));
    },
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = Array.isArray(result.content) ? result.content : [];
      return {
        success: result.isError !== true,
        contentItems: content.filter(part => part.type === "text").map(part => ({ type: "inputText" as const, text: String(part.text) })),
      };
    },
  };
  return { ...tools, close: async () => { await client.close(); await server.close(); } };
}
