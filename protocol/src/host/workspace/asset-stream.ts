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
