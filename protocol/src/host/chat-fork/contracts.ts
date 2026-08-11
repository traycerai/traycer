import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  chatForkGetRequestSchema,
  chatForkGetResponseSchema,
} from "@traycer/protocol/host/chat-fork/schemas";

export const chatForkGetV10 = defineRpcContract({
  method: "host.chatFork.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatForkGetRequestSchema,
  responseSchema: chatForkGetResponseSchema,
});
