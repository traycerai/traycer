import { defineRpcContract } from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  chatContinueHereRequestSchema,
  chatContinueHereResponseSchema,
  chatServingSubscribeClientFrameSchema,
  chatServingSubscribeOpenRequestSchema,
  chatServingSubscribeServerFrameSchema,
} from "@traycer/protocol/host/chat-serving/schemas";

/**
 * The per-chat readiness and authority witness: whether a team sandbox's
 * chat is served live by its owner host or at rest by the pool. Served by the
 * pool only, from the server's published fact; never inferred from a host's
 * reachability.
 */
export const chatServingSubscribeV10 = defineStreamRpcContract({
  method: "chat.serving.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: chatServingSubscribeOpenRequestSchema,
  serverFrameSchema: chatServingSubscribeServerFrameSchema,
  clientFrameSchema: chatServingSubscribeClientFrameSchema,
});

/**
 * Off the released floor, registered `degrade: { kind: "unsupported" }`: a
 * host without it is a host that cannot continue a chat, and the app offers
 * Clone instead.
 */
export const chatContinueHereV10 = defineRpcContract({
  method: "chat.continueHere",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatContinueHereRequestSchema,
  responseSchema: chatContinueHereResponseSchema,
});
