import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqliteEventQueue } from "../queue.js";
import type { BridgeEvent } from "../types.js";

const DEFAULT_TIMEOUT_SECONDS = 45;
const POLL_INTERVAL_MS = 250;

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("NCM Resonance long-wait request was cancelled.");

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("NCM Resonance long-wait request was cancelled."));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function registerBridgeWaitTool(
  server: McpServer,
  queue: SqliteEventQueue,
  eventFilter: (event: BridgeEvent) => boolean,
): void {
  server.registerTool(
    "ncm_resonance_wait",
    {
      title: "Wait for a NCM Resonance event",
      description:
        "Long-wait Listener path. Hold this MCP tool call until a Bridge event becomes available or the timeout expires. " +
        "Use only when the user explicitly asks to start long-wait listening. Do not run this concurrently with the Widget Listener. " +
        "When hasEvent=true, immediately call ncm_resonance_wait_ack with the returned eventId, then handle the event using modelContext and visibleText. " +
        "After any required routed reply completes, call ncm_resonance_wait again only if the user asked to remain listening.",
      inputSchema: {
        timeoutSeconds: z.number().int().min(1).max(DEFAULT_TIMEOUT_SECONDS).optional(),
      },
      outputSchema: {
        hasEvent: z.boolean(),
        timedOut: z.boolean(),
        awaitingReply: z.boolean(),
        eventId: z.string().optional(),
        source: z.string().optional(),
        stream: z.enum(["conversation", "state"]).optional(),
        stateKey: z.string().optional(),
        visibleText: z.string().optional(),
        modelContext: z.string().optional(),
        replyRoute: z.literal("netease.chatroom").optional(),
        replyPolicy: z.enum(["required", "optional"]).optional(),
        createdAt: z.string().optional(),
        replyMessages: z.array(z.string()).optional(),
        sentCount: z.number().optional(),
        deliveryUncertain: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async ({ timeoutSeconds }, extra) => {
      const timeoutMs = (timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
      const deadline = Date.now() + timeoutMs;

      while (true) {
        if (extra.signal.aborted) {
          throw new Error("NCM Resonance long-wait request was cancelled.");
        }

        const outstanding = queue.getOutstandingRequiredReplyEvent(eventFilter);
        if (outstanding) {
          const reply = queue.getReply(outstanding.id);
          return {
            structuredContent: {
              hasEvent: false,
              timedOut: false,
              awaitingReply: true,
              eventId: outstanding.id,
              visibleText: outstanding.visibleText,
              modelContext: outstanding.modelContext,
              replyMessages: reply?.messages,
              sentCount: reply?.sentCount ?? 0,
              deliveryUncertain: reply?.sendingIndex !== undefined,
            },
            content: [{
              type: "text",
              text:
                "NCM Resonance long-wait is paused because a required routed reply is still outstanding. " +
                "Resume this existing event without injecting another user message. If its reservation is unacknowledged, call ncm_resonance_wait_ack first. " +
                "Reuse replyMessages when present. If deliveryUncertain=true, ask the owner to verify the last bubble before ncm_resonance_recover_reply. " +
                "Complete the current ncm_resonance_reply before waiting for another event.\n" + outstanding.modelContext + "\n" + outstanding.visibleText,
            }],
          };
        }

        const event = queue.getReservedEvent(eventFilter) ?? queue.reserveNext(eventFilter);
        if (event) {
          if (extra.signal.aborted) {
            queue.release(event.id);
            throw new Error("NCM Resonance long-wait request was cancelled.");
          }

          return {
            structuredContent: {
              hasEvent: true,
              timedOut: false,
              awaitingReply: false,
              eventId: event.id,
              source: event.source,
              stream: event.stream,
              stateKey: event.stateKey,
              visibleText: event.visibleText,
              modelContext: event.modelContext,
              replyRoute: event.replyRoute,
              replyPolicy: event.replyPolicy,
              createdAt: event.createdAt,
            },
            content: [{
              type: "text",
              text: [
                "RESONANCE BRIDGE LONG-WAIT EVENT",
                "This event was reserved by ncm_resonance_wait.",
                "Immediately call ncm_resonance_wait_ack with eventId=" + event.id + " before waiting again.",
                "",
                event.modelContext,
                "",
                "VISIBLE EVENT:",
                event.visibleText,
              ].join("\n"),
            }],
          };
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          return {
            structuredContent: {
              hasEvent: false,
              timedOut: true,
              awaitingReply: false,
            },
            content: [{
              type: "text",
              text:
                "No NCM Resonance event arrived before the long-wait timeout. " +
                "If the user explicitly asked to keep listening, ncm_resonance_wait may be called again.",
            }],
          };
        }

        await delay(Math.min(POLL_INTERVAL_MS, remainingMs), extra.signal);
      }
    },
  );

  server.registerTool(
    "ncm_resonance_wait_ack",
    {
      title: "Acknowledge a NCM Resonance long-wait event",
      description:
        "Acknowledge an event returned by ncm_resonance_wait after the model has accepted it. " +
        "This is the model-side long-wait acknowledgement path; the existing app-only ncm_resonance_delivered tool remains reserved for the Widget Listener.",
      inputSchema: { eventId: z.string().trim().min(1) },
      outputSchema: { acknowledged: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async ({ eventId }) => {
      const event = queue.getEvent(eventId);
      if (!event || !eventFilter(event)) {
        throw new Error(`Unknown NCM Resonance long-wait event: ${eventId}`);
      }
      queue.markDelivered(eventId);
      return {
        structuredContent: { acknowledged: true },
        content: [{ type: "text", text: `Acknowledged long-wait event ${eventId}.` }],
      };
    },
  );
}

