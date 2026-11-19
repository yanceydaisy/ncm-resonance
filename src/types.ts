export type ReplyRoute = "netease.chatroom";
export type ReplyPolicy = "required" | "optional";
export type BridgeStream = "conversation" | "state";

export type BridgeEvent = {
  id: string;
  correlationId: string;
  kind: "message";
  source: string;
  stream: BridgeStream;
  stateKey?: string;
  replyRoute?: ReplyRoute;
  replyPolicy?: ReplyPolicy;
  replyTarget?: { roomId: string; chatRoomId: string };
  createdAt: string;
  visibleText: string;
  modelContext: string;
};

export type EventStatus = "pending" | "reserved" | "delivered";

export type ReplyDeliveryState = {
  fingerprint: string;
  sentCount: number;
  completed: boolean;
  inFlight: boolean;
  completedAt?: string;
  owner?: string;
  sendingIndex?: number;
  messages?: string[];
  lastReceipt?: {
    ok: true;
    roomId: string;
    chatRoomId: string;
    messageId: string;
    text: string;
    code: number;
  };
};

export type StoredBridgeEvent = {
  event: BridgeEvent;
  status: EventStatus;
  reply?: ReplyDeliveryState;
};

