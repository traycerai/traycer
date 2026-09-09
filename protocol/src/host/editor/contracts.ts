import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  openPathsRequestSchema,
  openPathsRequestSchemaV11,
  openPathsResponseSchema,
} from "@traycer/protocol/host/editor/unary-schemas";

export const editorOpenPathsV10 = defineRpcContract({
  method: "editor.openPaths",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: openPathsRequestSchema,
  responseSchema: openPathsResponseSchema,
});

/**
 * 1.1 widens the request's `editorId` enum with `"system"` (OS default
 * application). Response unchanged. See `openPathsTargetSchema` for the
 * emission-gating contract on the new literal.
 */
export const editorOpenPathsV11 = defineRpcContract({
  method: "editor.openPaths",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: openPathsRequestSchemaV11,
  responseSchema: openPathsResponseSchema,
});

/**
 * Pure widening: every legal 1.0 request is already a legal 1.1 request,
 * and the response is the empty object on both sides.
 */
export const editorOpenPathsUpgradeV10ToV11 = defineUpgradePath<
  typeof editorOpenPathsV10,
  typeof editorOpenPathsV11
>({
  from: editorOpenPathsV10.schemaVersion,
  to: editorOpenPathsV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});
