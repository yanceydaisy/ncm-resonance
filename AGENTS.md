# AGENTS.md — Resonance Bridge

This file is intentionally machine-oriented.

If you are an AI coding agent, read this before changing the project.

## Project goal

Resonance Bridge bridges external realtime applications into an official AI client conversation without moving the model into a custom frontend.

Default reference adapter:

```text
NetEase Listen Together ChatRoom
⇄ Resonance Bridge
⇄ MCP Apps Listener
⇄ ChatGPT
```

The NetEase adapter is not the architecture itself.

The optional `BRIDGE_AI_BACKEND=codex` host adapter drives the official Codex app-server directly. It consumes the same durable queue and uses the same delivery journal. In this mode the public MCP view exposes music controls and reply recovery, while Codex owns event consumption and final reply delivery.

Before changing that adapter, read `docs/CODEX.zh-CN.md`, `src/codex/runtime.ts`, `src/codex/store.ts`, `src/codex/service.ts`, and `src/bridge/replyDelivery.ts`. Preserve event-to-thread/turn bindings. Reconcile interrupted native history before considering another generation. An uncertain earlier turn requires an explicit retry decision.

## Required reading order

1. `docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md`
2. `docs/V2.zh-CN.md`
3. `src/types.ts`
4. `src/queue.ts`
5. `src/bridge/events.ts`
6. `src/bridge/registerTools.ts`
7. `src/bridge/registerApp.ts`
8. `src/bridge/registerWaitTool.ts`
9. `src/profiles.ts`
10. `src/server.ts`
11. `src/mcp.ts`
12. `src/listener-html.ts`
13. `src/netease/registerTogetherTools.ts`
14. adapter-specific files only after the core is understood

## Core invariants

Do not violate these without an explicit design decision.

1. Wake channels are optional hints, not authoritative payload transports. A poll-only Listener must remain valid.
2. Queue/sync is the authoritative event delivery path.
3. Stable `eventId` identity is required.
4. Conversation events are FIFO and are not coalesced.
5. State events use latest-state-wins per `stateKey`.
6. Required routed replies create backpressure until reply completion.
7. Once `ui/message` has been handed to the host, failures must not blindly release and redispatch the event.
8. If a human-confirmed host dismisses `ui/message`, mark the event terminal with `resonance_bridge_dismissed`; do not resurrect it and do not leave required-reply backpressure locked.
9. Ingress adapters deduplicate on provider message identity.
10. Reply delivery is idempotent through fingerprint + `sentCount` + completion state.
11. `replyRoute` belongs to the event. The model must not invent a route.
12. A playback control is not successful merely because an HTTP report returned successfully; wait for authoritative realtime or playlist confirmation.
13. Widget Listener and Long-wait MCP are alternative consumers of the same Queue. Do not run them concurrently.
14. Long-wait events use `resonance_bridge_wait_ack`; Widget delivery keeps the app-only delivered path. Do not merge the two ACK responsibilities.

## Layer boundaries

```text
Ingress Adapter
→ BridgeEvent normalization
→ Queue
→ Wake hint
→ Host Adapter
→ Model turn
→ Routed Reply
→ Egress Adapter
```

Prefer changing an adapter instead of modifying Bridge Core.

## Current status

Verified:

- NetEase NIM ChatRoom realtime receive/send
- bidirectional routed chat
- conversation/state split
- required-reply backpressure
- reply dedupe/resume
- full-song lyric context
- playback event decoding
- NIM playback realtime as the primary playback-state source, with HTTP reconcile/fallback
- realtime-confirmed PAUSE / RESUME / GOTO / NEXT controls
- playlist-confirmed `ENQUEUE_NEXT` queue mutation
- rejection of GOTO targets outside the current `displayList`
- public SSE stream/session primitive
- human-confirmed `ui/message` dismissal as a terminal event
- source message dedupe
- listener event dedupe
- backward-compatible `/mcp` plus Music-scoped `/mcp/music`
- accepted Long-wait MCP path with model-side ACK and required-reply backpressure
- real ChatGPT Host validation across web, desktop, and mobile for Long-wait
- authoritative Together leave with post-action room-status confirmation

Still under stability validation:

- long-running SSE listener/reconnect behavior
- edge cases around ACK/reconnect

Implemented in 0.3.0 with automated restart and failure regression coverage:

- SQLite event queue and per-bubble reply journal
- persisted dedupe, reservations, host ACKs and saved reply text
- stable NetEase event identities and original-room reply binding
- explicit recovery for ambiguous send acknowledgements
- worker lifecycle cancellation and native shutdown

Read `docs/PERSISTENCE.zh-CN.md` before changing recovery behavior. Preserve an unresolved send marker until the destination result has been verified. Existing delivered host events stay delivered across restarts.

Implemented in 0.4.0 with automated coverage:

- optional standalone Codex backend and native stdio/dynamic-tool adapter
- persistent peer/thread bindings and generation jobs in the same SQLite file
- playback-state coalescing, silent reactions and human-message priority
- shared per-bubble delivery and original-room validation
- saved native-turn reconciliation before generation retry

Live Codex CLI 0.165.0 checks verified tool calls, process restart with thread resume, and stored-result recovery. Real NetEase-room acceptance of this new host adapter remains a deployment check.

Roadmap, not completed:
- unattended listener watchdog
- multi-listener semantics
- one-command deployment

Do not rewrite roadmap items as completed features.

## Change discipline

0.5.0 publishes neutral project, widget and tool names. `src/legacyNames.ts` accepts older protocol names without listing them. Preserve legacy queue-context normalization, widget local-storage migration and Codex history-marker recovery. Do not rewrite stored human messages, saved reply text, receipt fingerprints or existing data-directory bindings during a rename.

Before coding:

1. Identify the failing layer.
2. Explain the smallest valid change.
3. Preserve working protocol layers.
4. Add or update a regression test.
5. Run:
   - `npm test`
   - `npm run build`
   - `git diff --check`

## Retry rule

For every retry path, ask:

> Can retrying this operation repeat a user-visible side effect?

If yes, add an idempotency boundary before retrying.

## Push rule

For every push/realtime channel, ask:

> Is this push authoritative data or only a wake signal?

Default design: wake signal only, then pull authoritative state from Bridge.

## Adapter porting

For a new external platform, implement:

- ingress decode
- provider-message dedupe
- source routing
- egress send

For a new AI client, first choose one of the two dispatch models:

- Widget/Host-injection path: external event wakes the Host, then the Host injects a new message.
- Long-wait MCP path: an already-running model turn waits for a future event as a tool result.

As of 2026-09-28, the current ChatGPT Widget path requires manual confirmation on web, is not usable on desktop, and works on iOS; Long-wait has been verified on web, desktop, and mobile.

If you choose the Widget/Host-injection path, implement a Host Adapter equivalent to:

- initialize
- fetch/reserve Bridge event
- inject hidden context if supported
- inject foreground user message
- persist recent delivered IDs
- ACK/release
- trigger `sync` manually or on a polling interval
- optionally add SSE / WebSocket / native push later as a wake optimization

Keep the Queue protocol unchanged unless the new Host proves it cannot support it.

## Security

Never expose provider credentials to:

- Widget
- model context
- tool outputs
- logs
- repository

Listener session tokens must remain short-lived and single-use.

## Reference phrase

```text
对话要记忆，状态要新鲜。
```

This is not branding only; it defines queue semantics.

