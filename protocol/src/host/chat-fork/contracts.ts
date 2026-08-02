import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  chatForkGetRequestSchema,
  chatForkGetResponseSchema,
  chatForkReadCandidateHeadRequestSchema,
  chatForkReadCandidateHeadResponseSchema,
  chatForkResolveRequestSchema,
  chatForkResolveResponseSchema,
} from "@traycer/protocol/host/chat-fork/schemas";

export const chatForkGetV10 = defineRpcContract({
  method: "host.chatFork.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatForkGetRequestSchema,
  responseSchema: chatForkGetResponseSchema,
});

export const chatForkResolveV10 = defineRpcContract({
  method: "host.chatFork.resolve",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatForkResolveRequestSchema,
  responseSchema: chatForkResolveResponseSchema,
});

export const chatForkReadCandidateHeadV10 = defineRpcContract({
  method: "host.chatFork.readCandidateHead",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatForkReadCandidateHeadRequestSchema,
  responseSchema: chatForkReadCandidateHeadResponseSchema,
});
