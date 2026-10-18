import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  commentsListThreadsRequestSchema,
  commentsListThreadsResponseSchema,
  commentsListThreadsResponseSchemaPreAnchor,
  commentsListThreadsResponseSchemaPreHtml,
  commentsSetThreadStatusRequestSchema,
  commentsSetThreadStatusResponseSchema,
} from "./schemas";

export const commentsListThreadsV10 = defineRpcContract({
  method: "comments.listThreads",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: commentsListThreadsRequestSchema,
  responseSchema: commentsListThreadsResponseSchemaPreHtml,
});

export const commentsSetThreadStatusV10 = defineRpcContract({
  method: "comments.setThreadStatus",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: commentsSetThreadStatusRequestSchema,
  responseSchema: commentsSetThreadStatusResponseSchema,
});

/** 1.1 lists HTML, canvas and file artifacts; 1.0 keeps the four-kind response. */
export const commentsListThreadsV11 = defineRpcContract({
  method: "comments.listThreads",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: commentsListThreadsRequestSchema,
  responseSchema: commentsListThreadsResponseSchemaPreAnchor,
});
export const commentsListThreadsUpgradeV10ToV11 = defineUpgradePath<
  typeof commentsListThreadsV10,
  typeof commentsListThreadsV11
>({
  from: commentsListThreadsV10.schemaVersion,
  to: commentsListThreadsV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const commentsListThreadsV12 = defineRpcContract({
  method: "comments.listThreads",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: commentsListThreadsRequestSchema,
  responseSchema: commentsListThreadsResponseSchema,
});
export const commentsListThreadsUpgradeV11ToV12 = defineUpgradePath<
  typeof commentsListThreadsV11,
  typeof commentsListThreadsV12
>({
  from: commentsListThreadsV11.schemaVersion,
  to: commentsListThreadsV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});
