/**
 * `git.streamFileAsset@1.0` - versioned streaming-RPC contract that fetches
 * one side (`old`/`new`) of a git-tracked file's raw bytes as a binary image
 * asset, for the git diff tile's image preview (image-preview decision log,
 * decisions #1-#2, #9-#10).
 *
 * `runningDir`/`filePath`/`previousPath`/`stage` mirror
 * `gitGetFileContentsRequestSchema`'s conventions (`git-schemas.ts`), except
 * `stage` here is only `"staged" | "unstaged"` - untracked and conflicted
 * files are expressed through the `old`/`new` side-resolution table in the
 * tech plan (an untracked file has no `old` side at all; a conflicted file's
 * `old` side is HEAD and `new` side is the worktree), not through a wider
 * stage enum. `side` selects which one of the two the caller wants, since
 * unlike the unary contract this streams one binary asset per open.
 *
 * Brand-new method, not on the released floor and unknown to every host
 * shipped before it. Streams carry no registry-level `degrade` field - a
 * client whose open is rejected as an unknown method falls back to today's
 * `BinaryPlaceholder` in the diff tile.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  assetStreamClientFrameSchema,
  assetStreamServerFrameSchema,
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
