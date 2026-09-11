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

/**
 * 1.2 changes no schema: it is a BEHAVIOR minor. A 1.1 host accepts the
 * `"system"` target for `.pdf` paths only; from 1.2 it also accepts `.docx`
 * (`validateSystemOpenPath`). The bump exists so a client can tell the two
 * hosts apart at the handshake and keep sending an older host the editor
 * target for a Word file, instead of a request that host would reject.
 */
export const editorOpenPathsV12 = defineRpcContract({
  method: "editor.openPaths",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: openPathsRequestSchemaV11,
  responseSchema: openPathsResponseSchema,
});

export const editorOpenPathsUpgradeV11ToV12 = defineUpgradePath<
  typeof editorOpenPathsV11,
  typeof editorOpenPathsV12
>({
  from: editorOpenPathsV11.schemaVersion,
  to: editorOpenPathsV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});
