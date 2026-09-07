/**
 * `workspace.streamAsset@1.0` - versioned streaming-RPC contract that fetches a workspace file's raw bytes as a binary image asset, for the workspace file tile's image preview (image-preview decision log, decisions #1-#2).
 * Brand-new method, not on the released floor and unknown to every host shipped before it.
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
 * 1.1 adds PDF: `application/pdf` joins the media-type enum, served with `width`/`height: null` on the same `assetHeader` frame.
 */
export const workspaceStreamAssetV11 = defineStreamRpcContract({
  method: "workspace.streamAsset",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: workspaceStreamAssetOpenRequestSchema,
  serverFrameSchema: assetStreamServerFrameSchemaV11,
  clientFrameSchema: assetStreamClientFrameSchema,
});
