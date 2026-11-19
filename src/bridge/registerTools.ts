import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listenerWakeHub } from "../listenerWake.js";
import type { TogetherWorker } from "../netease/togetherWorker.js";
import { deliverReply } from "./replyDelivery.js";
import type { SqliteEventQueue } from "../queue.js";
import { normalizeReplyBubbles } from "../replyBubbles.js";
import type { BridgeEvent } from "../types.js";

export function registerBridgeTools(
  server: McpServer,
  queue: SqliteEventQueue,
  eventFilter: (event: BridgeEvent) => boolean,
  togetherWorker: TogetherWorker,
): void {
  server.registerTool(
    "resonance_bridge_reply",
    {
      title: "Reply through Resonance Bridge",
      description: "Deliver the user-facing reply for the active Resonance Bridge event back through its recorded reply route. For replyPolicy=required, call this exactly once before completing the turn. eventId is optional because the Bridge binds to the active required event and corrects stale ids. For normal conversation, messages[] should contain 2-5 short natural bubbles; a single bubble is only for a genuinely brief reply. Do not pack multiple sentences into one long bubble and do not add filler just to increase the count. The Bridge will also split an obviously long single bubble as a fallback. Do not call netease_together_send_message directly for routed replies.",
      inputSchema: {
        eventId: z.string().trim().min(1).optional(),
        messages: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
      },
      outputSchema: {
        ok: z.literal(true),
        eventId: z.string(),
        route: z.literal("netease.chatroom"),
        sentCount: z.number(),
        completed: z.boolean(),
        deduplicated: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ eventId, messages }) => {
      const outstanding = queue.getOutstandingRequiredReplyEvent(eventFilter);
      const rawRequested = eventId ? queue.getEvent(eventId) : null;
      const requested = rawRequested && eventFilter(rawRequested) ? rawRequested : null;
      const event = outstanding ?? requested;
      if (!event) {
        throw new Error(eventId
          ? `Unknown Resonance Bridge event: ${eventId}`
          : "No active Resonance Bridge event is awaiting a routed reply.");
      }

      const resolvedEventId = event.id;
      if (eventId && eventId !== resolvedEventId) {
        console.warn(
          `Resonance Bridge reply eventId corrected: requested=${eventId} resolved=${resolvedEventId}`,
        );
      }
      if (!event.replyRoute) throw new Error(`Event has no reply route: ${resolvedEventId}`);
      if (event.replyRoute !== "netease.chatroom") {
        throw new Error(`Unsupported reply route: ${event.replyRoute}`);
      }

      const normalized = normalizeReplyBubbles(messages);
      const delivered = await deliverReply(queue, togetherWorker, event, normalized);
      if (delivered.completed) listenerWakeHub.wake("reply-completed");
      return {
        structuredContent: { ok: true as const, eventId: resolvedEventId, route: "netease.chatroom" as const, ...delivered },
        content: [{ type: "text" as const, text: delivered.completed
          ? `Delivered ${delivered.sentCount} chat bubble(s) through ${event.replyRoute}.`
          : "The same reply is already being delivered; duplicate send suppressed." }],
      };
    },
  );

  registerReplyRecoveryTool(server, queue, eventFilter);

  server.registerTool(
    "resonance_bridge_sync",
    {
      title: "Resonance Bridge sync",
      description: "Reserve one pending test event for the Resonance Bridge component.",
      inputSchema: {},
      outputSchema: {
        hasEvent: z.boolean(),
        eventId: z.string().optional(),
        awaitingReply: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => {
      const outstanding = queue.getOutstandingRequiredReplyEvent(eventFilter);
      if (outstanding && !queue.isReserved(outstanding.id)) {
        return {
          structuredContent: {
            hasEvent: false,
            eventId: outstanding.id,
            awaitingReply: true,
          },
          content: [],
        };
      }

      const event = outstanding ?? queue.getReservedEvent(eventFilter) ?? queue.reserveNext(eventFilter);
      if (!event) return { structuredContent: { hasEvent: false }, content: [] };
      console.log(
        `Resonance Bridge event reserved: eventId=${event.id} stream=${event.stream} source=${event.source} replyPolicy=${event.replyPolicy ?? "none"}`,
      );
      return {
        structuredContent: { hasEvent: true, eventId: event.id, awaitingReply: false },
        content: [],
        _meta: { event },
      };
    },
  );

  server.registerTool(
    "resonance_bridge_delivered",
    {
      title: "Resonance Bridge delivered",
      description: "Mark a reserved event as accepted by the chat host.",
      inputSchema: { eventId: z.string().min(1) },
      outputSchema: { delivered: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ eventId }) => {
      queue.markDelivered(eventId);
      return { structuredContent: { delivered: true }, content: [] };
    },
  );

  server.registerTool(
    "resonance_bridge_dismissed",
    {
      title: "Resonance Bridge dismissed",
      description: "Mark a reserved event as terminal after the user or host dismisses the app-initiated message prompt. Required-reply backpressure is completed without sending a routed reply.",
      inputSchema: { eventId: z.string().min(1) },
      outputSchema: { dismissed: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ eventId }) => {
      queue.dismiss(eventId);
      listenerWakeHub.wake("dismissed");
      return { structuredContent: { dismissed: true }, content: [] };
    },
  );

  server.registerTool(
    "resonance_bridge_release",
    {
      title: "Resonance Bridge release",
      description: "Release a reserved event only when host dispatch failed before ui/message was handed off.",
      inputSchema: { eventId: z.string().min(1) },
      outputSchema: { released: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ eventId }) => {
      queue.release(eventId);
      listenerWakeHub.wake("released");
      return { structuredContent: { released: true }, content: [] };
    },
  );
}


export function registerReplyRecoveryTool(
  server: McpServer,
  queue: SqliteEventQueue,
  eventFilter: (event: BridgeEvent) => boolean,
  automaticReplies = false,
): void {
  server.registerTool(
    "resonance_bridge_recover_reply",
    {
      title: "Resolve an uncertain reply receipt",
      description: "Resolve the last bubble of an interrupted routed reply only after the owner explicitly verifies in the destination app whether that bubble arrived. Never guess or call automatically. This records the owner's verification without sending a message. "
        + (automaticReplies ? "The automatic scheduler resumes delivery from the saved progress." : "Resume using resonance_bridge_reply with the returned saved messages."),
      inputSchema: { eventId: z.string().min(1), lastBubbleDelivered: z.boolean() },
      outputSchema: { eventId: z.string(), sentCount: z.number(), messages: z.array(z.string()) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    },
    async ({ eventId, lastBubbleDelivered }) => {
      const event = queue.getEvent(eventId);
      if (!event || !eventFilter(event)) throw new Error(`Unknown event: ${eventId}`);
      const reply = queue.recoverReply(eventId, lastBubbleDelivered);
      const result = { eventId, sentCount: reply.sentCount, messages: reply.messages ?? [] };
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

}
