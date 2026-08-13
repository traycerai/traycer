import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  diagnosticsLogsListRequestSchema,
  diagnosticsLogsListResponseSchema,
  diagnosticsLogsTailRequestSchema,
  diagnosticsLogsTailResponseSchema,
} from "./schemas";

/** Lists the connected host's own log targets, never a desktop log. */
export const diagnosticsLogsListV10 = defineRpcContract({
  method: "diagnostics.logs.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: diagnosticsLogsListRequestSchema,
  responseSchema: diagnosticsLogsListResponseSchema,
});

/** Reads a bounded tail from the connected host's own log filesystem. */
export const diagnosticsLogsTailV10 = defineRpcContract({
  method: "diagnostics.logs.tail",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: diagnosticsLogsTailRequestSchema,
  responseSchema: diagnosticsLogsTailResponseSchema,
});
