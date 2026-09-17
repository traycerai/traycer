import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  chatSearchRequestSchema,
  chatSearchResponseSchema,
} from "@traycer/protocol/host/chat-search/schemas";

/**
 * Registered `degrade: { kind: "unsupported" }` and off the released floor: a
 * host without a search index does not advertise it, and the client hides
 * search rather than failing the connection.
 */
export const chatSearchV10 = defineRpcContract({
  method: "chat.search",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatSearchRequestSchema,
  responseSchema: chatSearchResponseSchema,
});
