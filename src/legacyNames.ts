import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

// Accept requests from already-mounted clients without advertising old names.
export function normalizeLegacyRequest(message: JSONRPCMessage): JSONRPCMessage {
  if (!("method" in message) || !message.params) return message;
  if (message.method === "tools/call" && typeof message.params.name === "string") {
    const name = message.params.name === "open_cove_bridge"
      ? "open_resonance_bridge" : message.params.name.replace(/^cove_bridge_/, "resonance_bridge_");
    return { ...message, params: { ...message.params, name } };
  }
  if (message.method === "resources/read" && message.params.uri === "ui://widget/cove-bridge.html") {
    return { ...message, params: { ...message.params, uri: "ui://widget/resonance-bridge.html" } };
  }
  return message;
}

export function normalizeLegacyContext(context: string): string {
  return context.replace(/\bcove_bridge_/g, "resonance_bridge_")
    .replace(/\bopen_cove_bridge\b/g, "open_resonance_bridge")
    .replace(/\bCove (?:Bridge|Resonance)\b/g, "Resonance Bridge");
}
