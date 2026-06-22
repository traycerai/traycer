import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  commentsListThreadsRequestSchema,
  commentsListThreadsResponseSchema,
  commentsSetThreadStatusRequestSchema,
  commentsSetThreadStatusResponseSchema,
} from "./schemas";

export const commentsListThreadsV10 = defineRpcContract({
  method: "comments.listThreads",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: commentsListThreadsRequestSchema,
  responseSchema: commentsListThreadsResponseSchema,
});

export const commentsSetThreadStatusV10 = defineRpcContract({
  method: "comments.setThreadStatus",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: commentsSetThreadStatusRequestSchema,
  responseSchema: commentsSetThreadStatusResponseSchema,
});
