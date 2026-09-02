/**
 * `workspace.streamAsset@1.0` - versioned streaming-RPC contract that fetches
 * a workspace file's raw bytes as a binary image asset, for the workspace
 * file tile's image preview (image-preview decision log, decisions #1-#2).
 *
 * `workspacePath`/`filePath` mirror `workspace.readFile`'s request shape -
 * the frozen v1.0 unary contract this stream sits beside without mutating.
 * The client extension-gates before ever opening this stream (decision #6);
 * the host still validates independently (containment, extension allowlist,
 * magic bytes, size/pixel caps) and answers with `assetError` on a
 * mismatch, never partial bytes.
 *
 * Brand-new method, not on the released floor and unknown to every host
 * shipped before it. Streams carry no registry-level `degrade` field -
 * `subscribe.ts`'s file-level doc on `workspace.subscribeFileList` explains
 * why - so a client whose open is rejected as an unknown method falls back
 * to today's `"Binary files cannot be previewed"` placeholder.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  assetStreamClientFrameSchema,
  assetStreamServerFrameSchema,
  assetStreamServerFrameSchemaV11,
} from "@traycer/protocol/host/asset-stream-schemas";

export const workspaceStreamAssetOpenRequestSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
});
export type WorkspaceStreamAssetOpenRequest = z.infer<
  typeof workspaceStreamAssetOpenRequestSchema
>;

export const workspaceStreamAssetV10 = defineStreamRpcContract({
  method: "workspace.streamAsset",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: workspaceStreamAssetOpenRequestSchema,
  serverFrameSchema: assetStreamServerFrameSchema,
  clientFrameSchema: assetStreamClientFrameSchema,
});

/**
 * 1.1 adds PDF: `application/pdf` joins the media-type enum, served with
 * `width`/`height: null` on the same `assetHeader` frame. The 1.1 contract
 * registers its OWN server-frame schema so 1.0's released wire schema stays
 * frozen exactly (the compat gate diffs released versions literally); the
 * host's resolver additionally consults the negotiated number to (a) reject
 * `.pdf` requests on 1.0 streams with `assetError "not-image"` and (b)
 * never emit the new enum literal to a client whose parser predates it.
 */
export const workspaceStreamAssetV11 = defineStreamRpcContract({
  method: "workspace.streamAsset",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: workspaceStreamAssetOpenRequestSchema,
  serverFrameSchema: assetStreamServerFrameSchemaV11,
  clientFrameSchema: assetStreamClientFrameSchema,
});
