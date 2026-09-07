/**
 * `git.streamFileAsset@1.0` - versioned streaming-RPC contract that fetches one side (`old`/`new`) of a git-tracked file's raw bytes as a binary image asset, for the git diff tile's image preview (image-preview decision.
 * Brand-new method, not on the released floor and unknown to every host shipped before it.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  assetStreamClientFrameSchema,
  assetStreamServerFrameSchema,
  assetStreamServerFrameSchemaV11,
} from "@traycer/protocol/host/asset-stream-schemas";

export const gitStreamFileAssetSideSchema = z.enum(["old", "new"]);
export type GitStreamFileAssetSide = z.infer<
  typeof gitStreamFileAssetSideSchema
>;

export const gitStreamFileAssetStageSchema = z.enum(["staged", "unstaged"]);
export type GitStreamFileAssetStage = z.infer<
  typeof gitStreamFileAssetStageSchema
>;

export const gitStreamFileAssetOpenRequestSchema = z.object({
  runningDir: z.string(),
  filePath: z.string(),
  previousPath: z.string().nullable(),
  side: gitStreamFileAssetSideSchema,
  stage: gitStreamFileAssetStageSchema,
});
export type GitStreamFileAssetOpenRequest = z.infer<
  typeof gitStreamFileAssetOpenRequestSchema
>;

export const gitStreamFileAssetV10 = defineStreamRpcContract({
  method: "git.streamFileAsset",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: gitStreamFileAssetOpenRequestSchema,
  serverFrameSchema: assetStreamServerFrameSchema,
  clientFrameSchema: assetStreamClientFrameSchema,
});

/**
 * 1.1 adds PDF - same delta, same per-version frame schema, and same emission-gating obligation as `workspace.streamAsset@1.1` (see `workspace/asset-stream.ts`); the two methods share their frame schemas and move minors.
 */
export const gitStreamFileAssetV11 = defineStreamRpcContract({
  method: "git.streamFileAsset",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: gitStreamFileAssetOpenRequestSchema,
  serverFrameSchema: assetStreamServerFrameSchemaV11,
  clientFrameSchema: assetStreamClientFrameSchema,
});
