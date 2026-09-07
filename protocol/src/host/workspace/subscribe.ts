/**
 * `workspace.subscribeFileList@1.0` - single-level listings. No depth field; `listing` replaces one directory; watch a child only if its parent is covered.
 * Paths are POSIX-relative with a trailing slash on directories (`""` is root). `ignored` is a display hint, never a filter; overlay git status from `git.subscribeStatus`.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { workspaceDirectoryEntryKindSchema } from "@traycer/protocol/host/workspace/unary-schemas";

export const workspaceSubscribeFileListOpenRequestV10Schema = z.object({
  // Canonicalized by the host. The server immediately covers this root's first
  // level and emits its `listing`; no client frame is needed to get started.
  workspacePath: z.string(),
});
export type WorkspaceSubscribeFileListOpenRequestV10 = z.infer<
  typeof workspaceSubscribeFileListOpenRequestV10Schema
>;

export const workspaceSubscribeFileListOpenRequestSchema =
  workspaceSubscribeFileListOpenRequestV10Schema;
export type WorkspaceSubscribeFileListOpenRequest =
  WorkspaceSubscribeFileListOpenRequestV10;

/** One child of a covered directory. */
export const workspaceFileListEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: workspaceDirectoryEntryKindSchema,
  ignored: z.boolean(),
});
export type WorkspaceFileListEntry = z.infer<
  typeof workspaceFileListEntrySchema
>;

/** Why a directory stopped being covered. */
export const workspaceFileListPruneReasonSchema = z.enum([
  "missing",
  "limit",
  "error",
]);
export type WorkspaceFileListPruneReason = z.infer<
  typeof workspaceFileListPruneReasonSchema
>;

export const workspaceSubscribeFileListServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("listing"),
      directoryPath: z.string(),
      entries: z.array(workspaceFileListEntrySchema),
      // The directory holds more children than the per-listing cap; `entries`
      // is a prefix of them.
      truncated: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pruned"),
      directoryPaths: z.array(z.string()),
      reason: workspaceFileListPruneReasonSchema,
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type WorkspaceSubscribeFileListServerFrame = z.infer<
  typeof workspaceSubscribeFileListServerFrameSchema
>;

export const workspaceSubscribeFileListClientFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("watch"),
      directoryPaths: z.array(z.string()),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("unwatch"),
      directoryPaths: z.array(z.string()),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type WorkspaceSubscribeFileListClientFrame = z.infer<
  typeof workspaceSubscribeFileListClientFrameSchema
>;

export const workspaceSubscribeFileListV10 = defineStreamRpcContract({
  method: "workspace.subscribeFileList",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: workspaceSubscribeFileListOpenRequestV10Schema,
  serverFrameSchema: workspaceSubscribeFileListServerFrameSchema,
  clientFrameSchema: workspaceSubscribeFileListClientFrameSchema,
});
