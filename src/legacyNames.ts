import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

// Accept requests from already-mounted clients without advertising old names.
export function normalizeLegacyRequest(message: JSONRPCMessage): JSONRPCMessage {
  if (!("method" in message) || !message.params) return message;
  if (message.method === "tools/call" && typeof message.params.name === "string") {
    const name = ["open_cove_bridge", "open_resonance_bridge"].includes(message.params.name)
      ? "open_ncm_resonance"
      : message.params.name.replace(/^(?:cove_bridge|resonance_bridge)_/, "ncm_resonance_");
    return { ...message, params: { ...message.params, name } };
  }
  if (message.method === "resources/read" && [
    "ui://widget/cove-bridge.html", "ui://widget/resonance-bridge.html",
  ].includes(String(message.params.uri))) {
    return { ...message, params: { ...message.params, uri: "ui://widget/ncm-resonance.html" } };
  }
  return message;
}

export function normalizeLegacyContext(context: string): string {
  return context.replace(/\b(?:cove_bridge|resonance_bridge)_/g, "ncm_resonance_")
    .replace(/\bopen_(?:cove_bridge|resonance_bridge)\b/g, "open_ncm_resonance")
    .replace(/\b(?:Cove (?:Bridge|Resonance)|Resonance Bridge)\b/g, "NCM Resonance");
}
