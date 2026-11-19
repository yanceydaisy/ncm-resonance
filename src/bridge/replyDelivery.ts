import { createHash } from "node:crypto";
import type { SqliteEventQueue } from "../queue.js";
import type { BridgeEvent } from "../types.js";
import { isDefinitiveChatSendFailure, type RealtimeChatSendOptions, type RealtimeChatSendResult } from "../netease/realtimeTransport.js";

export type ReplySender = {
  sendChatRoomText(text: string, options?: RealtimeChatSendOptions): Promise<RealtimeChatSendResult>;
};

export class ReplySupersededError extends Error {
  constructor() { super("Reply superseded by newer input"); }
}

export async function deliverReply(
  queue: SqliteEventQueue,
  sender: ReplySender,
  event: BridgeEvent,
  messages: string[],
  canSend: () => boolean = () => true,
): Promise<{ sentCount: number; completed: boolean; deduplicated: boolean }> {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ eventId: event.id, route: event.replyRoute, messages }))
    .digest("hex");
  const claim = queue.claimReply(event.id, fingerprint, messages);
  if (claim.state !== "send") {
    return { sentCount: claim.sentCount, completed: claim.state === "already_completed", deduplicated: true };
  }
  try {
    let sentCount = claim.sentCount;
    for (let index = sentCount; index < messages.length; index += 1) {
      if (!canSend()) throw new ReplySupersededError();
      queue.markReplySending(event.id, fingerprint);
      const receipt = await sender.sendChatRoomText(messages[index], {
        ...event.replyTarget,
        messageId: createHash("sha256").update(fingerprint + ":" + index).digest("hex"),
      });
      sentCount = queue.markReplyMessageSent(event.id, fingerprint, receipt);
      if (index < messages.length - 1) await new Promise<void>(resolve => setTimeout(resolve, 350));
    }
    queue.markReplyCompleted(event.id, fingerprint);
    return { sentCount, completed: true, deduplicated: false };
  } catch (error) {
    queue.releaseReply(event.id, fingerprint, isDefinitiveChatSendFailure(error));
    throw error;
  }
}
