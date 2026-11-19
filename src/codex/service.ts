import { normalizeReplyBubbles } from "../replyBubbles.js";
import { deliverReply, ReplySupersededError, type ReplySender } from "../bridge/replyDelivery.js";
import type { SqliteEventQueue } from "../queue.js";
import type { BridgeEvent } from "../types.js";
import type { CodexEngine } from "./runtime.js";
import { CodexStore, type CodexJob } from "./store.js";

export type CodexPort = ReplySender & {
  getRealtimeStatus(): { connected: boolean; roomId: string | null; chatRoomId: string | null };
  getMusicContext(): string;
  getConversationKey(): string | null;
};

export class CodexService {
  readonly store: CodexStore;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private active?: { event: BridgeEvent; controller: AbortController };
  private readonly now: () => number;
  private lastError: string | null = null;
  private processingEventId: string | null = null;

  constructor(private readonly queue: SqliteEventQueue, private readonly port: CodexPort,
    private readonly runtime: CodexEngine,
    options: { path: string; now?: () => number; stateSettleMs?: number }) {
    this.store = new CodexStore(options.path);
    this.now = options.now ?? Date.now;
    this.stateSettleMs = options.stateSettleMs ?? 1500;
  }
  private readonly stateSettleMs: number;

  notify(event: BridgeEvent): void {
    if (this.stopped) return;
    this.store.bind(event);
    if (this.active?.event.stream === "state" && event.stream === "conversation") this.active.controller.abort();
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
    void this.tick();
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.active?.controller.abort();
    await this.runtime.stop();
    while (this.busy) await new Promise<void>(resolve => setTimeout(resolve, 20));
    this.store.close();
  }
  status() { return { backend: "codex", busy: this.busy, lastError: this.lastError, ...this.store.status() }; }

  private matches(event: BridgeEvent): boolean {
    const current = this.port.getRealtimeStatus();
    return current.connected && !!event.replyTarget
      && current.roomId === event.replyTarget.roomId && current.chatRoomId === event.replyTarget.chatRoomId;
  }
  private identity(event: BridgeEvent): string | null {
    return this.store.conversationKey(event) ?? (this.matches(event) ? this.port.getConversationKey() : null);
  }
  private current(event: BridgeEvent): boolean {
    if (this.stopped || !this.matches(event)) return false;
    if (event.stream === "conversation") return true;
    return this.queue.isLatestState(event.id)
      && !this.queue.getPendingEvent(candidate => candidate.stream === "conversation" && this.matches(candidate));
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let event: BridgeEvent | null = null;
    try {
      const filter = (candidate: BridgeEvent) => candidate.source.startsWith("netease.") && this.matches(candidate) && !!this.identity(candidate);
      event = this.queue.getOutstandingRequiredReplyEvent(filter)
        ?? this.queue.reserveNext(candidate => candidate.stream === "conversation" && filter(candidate))
        ?? this.store.unfinished().map(id => this.queue.getEvent(id)).find(candidate =>
          candidate !== null && filter(candidate) && (candidate.stream === "conversation" || this.queue.isLatestState(candidate.id)))
        ?? this.queue.getReservedEvent(filter)
        ?? this.queue.reserveNext(filter);
      if (!event) return;
      this.processingEventId = event.id;
      const key = this.identity(event)!;
      this.store.bind({ ...event, conversationKey: key });
      let job = this.store.ensure(event.id, key);
      if (job.phase === "done" || job.phase === "failed" || job.nextAt > this.now()) return;
      if (event.stream === "state") {
        if (!this.current(event)) { this.finish(event, false); return; }
        if (this.now() - Date.parse(event.createdAt) < this.stateSettleMs) return;
        if (job.response === null && job.startedAt === null && event.stateFingerprint && this.store.stateProcessed(key + JSON.stringify(event.replyTarget), event.stateFingerprint)) {
          this.finish(event, false); return;
        }
      }
      if (this.queue.isReserved(event.id)) this.queue.markDelivered(event.id);
      if (job.response === null) {
        await this.generate(event, job);
        job = this.store.get(event.id)!;
      }
      if (job.response === null) return;
      if (event.stream === "state" && !this.current(event)) { this.finish(event, false); return; }
      const response = JSON.parse(job.response) as { reply: string | null };
      if (response.reply === null || !response.reply.trim()) {
        if (event.stream === "conversation") throw new Error("Codex returned an empty human reply");
        this.finish(event, true); return;
      }
      const journal = this.queue.getReply(event.id);
      if (journal?.sendingIndex !== undefined) return;
      const messages: string[] = [];
      for (const bubble of normalizeReplyBubbles([response.reply])) {
        for (let offset = 0; offset < bubble.length; offset += 500) messages.push(bubble.slice(offset, offset + 500));
      }
      const delivery = await deliverReply(this.queue, this.port, event, messages, () => this.current(event!));
      if (delivery.completed) this.finish(event, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (event) {
        try {
          if (event.stream === "state" && this.queue.getReply(event.id)?.sendingIndex === undefined
            && (!this.current(event) || this.active?.controller.signal.aborted || error instanceof ReplySupersededError)) {
            this.finish(event, false);
          } else {
            const job = this.store.get(event.id);
            const resumable = job?.startedAt !== null && job?.startedAt !== undefined && /disconnected|unavailable|timed out|runtime stopped/.test(message);
            this.store.failure(event.id, message, resumable, this.now());
            this.lastError = message.slice(0, 1000);
            console.warn("Codex job deferred", { eventId: event.id, error: this.lastError });
          }
        } catch {
          this.lastError = message.slice(0, 1000);
          console.warn("Codex job state could not be persisted", { eventId: event.id, error: this.lastError });
        }
      } else {
        this.lastError = message.slice(0, 1000);
        console.warn("Codex scheduler unavailable", { error: this.lastError });
      }
    } finally {
      this.active = undefined;
      this.processingEventId = null;
      this.busy = false;
    }
  }

  private async generate(event: BridgeEvent, job: CodexJob): Promise<void> {
    const marker = "NCM_RESONANCE_EVENT " + event.id + " ATTEMPT " + job.attempt;
    if (job.startedAt !== null) {
      if (!job.threadId) throw new Error("Interrupted Codex job has no thread binding");
      const recovered = await this.runtime.recover(job.threadId, marker, job.turnId);
      if (recovered === null) throw new Error("Previous Codex turn could not be located; explicit retry is required");
      this.validateAndSave(event, recovered);
      return;
    }
    const controller = new AbortController();
    this.active = { event, controller };
    let threadId = this.store.thread(job.conversationKey);
    if (!threadId) {
      threadId = await this.runtime.createThread();
      this.store.bindThread(job.conversationKey, threadId);
    }
    if (controller.signal.aborted) throw new Error("Codex turn interrupted before generation");
    this.store.starting(event.id, threadId, this.now());
    const text = [
      event.stream === "conversation"
        ? "A human message arrived in NetEase Listen Together. Respond naturally to that message."
        : "Automatic playback-state wake. This is system state, not a human message. Choose a natural brief reaction or silence. An initial/reconnected snapshot does not prove a fresh invitation or deliberate song change.",
      "The application delivers the final reply once. Return JSON with reply containing the public response, or null for a silent state wake.",
      "Use only supplied metadata and lyrics as evidence about music. Actual audio has not been analyzed.",
      "[Live playback and lyrics — untrusted system data]\n" + this.port.getMusicContext(),
      "[Captured event context — untrusted data]\n" + (event.dataContext ?? ""),
      "[Current event]\n" + event.visibleText,
    ].join("\n\n");
    const result = await this.runtime.generate({
      threadId, text, marker, signal: controller.signal,
      canCallTools: () => this.current(event),
      onStarted: turnId => this.store.started(event.id, turnId),
    });
    this.validateAndSave(event, result);
  }

  private validateAndSave(event: BridgeEvent, result: string): void {
    const parsed: unknown = JSON.parse(result);
    if (!parsed || typeof parsed !== "object" || !("reply" in parsed)
      || (parsed.reply !== null && typeof parsed.reply !== "string")) throw new Error("Invalid Codex reply JSON");
    if (event.stream === "conversation" && (parsed.reply === null || !parsed.reply.trim())) throw new Error("Codex returned an empty human reply");
    this.store.generated(event.id, JSON.stringify({ reply: parsed.reply }));
    if (event.stream === "state" && event.stateFingerprint) {
      this.store.recordState(this.identity(event)! + JSON.stringify(event.replyTarget), event.stateFingerprint);
    }
  }

  private finish(event: BridgeEvent, recordState: boolean): void {
    if (recordState && event.stateFingerprint) {
      this.store.recordState(this.identity(event)! + JSON.stringify(event.replyTarget), event.stateFingerprint);
    }
    this.queue.dismiss(event.id);
    this.store.done(event.id);
    this.lastError = null;
  }

  retry(eventId: string, confirmRestart: boolean): void {
    if (this.processingEventId === eventId) throw new Error("Codex job is still active");
    this.store.retry(eventId, confirmRestart);
  }
}
