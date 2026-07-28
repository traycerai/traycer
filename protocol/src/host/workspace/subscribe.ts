/**
 * `workspace.subscribeFileList@1.0` - versioned streaming-RPC contract for
 * live, SINGLE-LEVEL workspace directory listings.
 *
 * Replaces the unary `workspace.listFileTree` snapshot+poll path for the file
 * explorer: one stream per workspace, opened on the workspace root, whose
 * covered set of directories grows and shrinks with the client's expansion
 * state. Every covered directory stays live for as long as the stream is open -
 * the host arms its filesystem watch on subscribe and drops it on close.
 *
 * ## Single level, by construction
 *
 * There is deliberately NO depth field anywhere in this contract. A `listing`
 * frame describes exactly ONE directory, one level deep; covering a subtree
 * means naming each of its directories in a `watch` frame. Recursion is
 * structurally impossible rather than policed by a bound the server has to
 * judge. Surfaces that genuinely need a full recursive snapshot (command-palette
 * fuzzy search) stay on the unary `workspace.listFileTree`.
 *
 * ## No filtering
 *
 * The server lists everything it can read - ignored files, dotfiles, all of it.
 * `ignored` is a display hint (the client dims those rows), never a filter.
 * Git status badges are NOT carried here; the client overlays them from the
 * existing `git.subscribeStatus` stream so that pipeline stays the one source
 * of truth.
 *
 * ## Path conventions
 *
 * Every path on this stream is POSIX-relative to the canonical workspace root:
 * `/`-separated, no leading slash. Entry `path`/`name`/`kind` follow the
 * `WorkspaceDirectoryEntry` conventions of `workspace.listDirectory`, including
 * the trailing slash on a directory's `path` (`"src/"`).
 *
 * `directoryPath` / `directoryPaths` use that SAME trailing-slash directory
 * form, with `""` naming the workspace root. This differs from the unary
 * `workspace.listDirectory` request, which strips the trailing slash: here a
 * directory is identified by exactly the token the client already received as
 * that directory's entry `path`, so an expansion toggle can hand it straight
 * back in a `watch` frame without parsing the string (the renderer treats these
 * paths as opaque tokens). The host canonicalizes what it receives and rejects
 * anything resolving outside the workspace root.
 *
 * ## Frame semantics
 *
 * Frames are idempotent per directory: a `listing` REPLACES the client's prior
 * state for its `directoryPath` wholesale. There are no granular add/remove
 * events and no cross-frame ordering dependency beyond "latest listing wins",
 * which is what lets the server answer both a coverage-add and a filesystem
 * change with the same frame.
 *
 * Parent coverage is the source of truth for child existence: when a covered
 * directory's refresh shows a previously covered child gone, the server prunes
 * that child *and its covered descendants* via `pruned`. Unwatching a directory
 * likewise implicitly drops its covered descendants, so a client collapsing a
 * subtree only has to name its root.
 *
 * That invariant is ENFORCED, not assumed: a `watch` for a directory whose
 * parent is not covered is refused with `pruned` reason `"error"` (the root
 * `""` is always covered while the stream is open, so covering top-level
 * directories is always legal). A single `watch` frame may name a parent and
 * its descendants together - paths are processed ancestors-first within the
 * frame - but a path whose parent was itself refused is refused with it. A
 * client that only ever expands visible rows satisfies this for free.
 *
 * A directory the server cannot keep serving is pruned, never streamed as an
 * error - the stream survives an unreadable, vanished, or over-budget path.
 *
 * Server frames:
 *
 * - `listing` - the full current contents of ONE covered directory.
 * - `pruned`  - those directories are no longer covered: `"missing"` (gone from
 *               disk), `"limit"` (per-stream coverage cap), `"error"` (not
 *               readable / watchable).
 * - `pong`    - heartbeat response.
 *
 * Client frames:
 *
 * - `watch`   - extend coverage, batched; idempotent for already-covered paths.
 *               The server answers with one `listing` per newly covered path.
 * - `unwatch` - drop coverage for those paths and their covered descendants.
 * - `ping`    - heartbeat.
 *
 * ## Degrade story
 *
 * Brand-new method, deliberately NOT on the released floor (which covers the
 * unary `/rpc` name set) and unknown to every host shipped before it. A client
 * whose subscribe is rejected as an unknown method falls back to the unary
 * `workspace.listFileTree` path, which stays intact until the fallback can be
 * retired - the file explorer degrades to the 25k-file snapshot with a poll,
 * not to an empty tree.
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

/**
 * One child of a covered directory. `path`, `name` and `kind` carry exactly the
 * `WorkspaceDirectoryEntry` semantics (`path` workspace-relative and
 * trailing-slashed for directories, `name` the host-computed basename, `kind`
 * resolved through symlinks); `ignored` is this stream's addition - true when
 * the workspace is a git work tree and git ignores the path. Outside a git work
 * tree, or when the ignore check fails, every entry reports `false`.
 */
export const workspaceFileListEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: workspaceDirectoryEntryKindSchema,
  ignored: z.boolean(),
});
export type WorkspaceFileListEntry = z.infer<
  typeof workspaceFileListEntrySchema
>;

/**
 * Why a directory stopped being covered. `missing` - it is gone from disk
 * (deleted or renamed away). `limit` - the stream's coverage budget is spent,
 * so the `watch` was refused. `error` - it could not be read or watched.
 */
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
