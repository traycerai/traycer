/**
 * Which side of which surface an image asset came from - the routing part of
 * the blob-cache key (image-preview decision log, decision #11). Distinct
 * from the wire `side: "old" | "new"` param on `git.streamFileAsset`: this
 * also distinguishes a git side from a workspace file entirely, since the
 * same `filePath` can legitimately identify unrelated content on each.
 */
export type ImageAssetSource = "workspace" | "git-old" | "git-new";

/**
 * Composite key for `imageBlobCache`: `hostId + source + path + contentIdentity`
 * (image-preview decision log, decision #11), joined with `|` - the same
 * separator `subscriptionKeyFor` uses for stream subscription keys elsewhere
 * in this codebase. Git object sides are immutable by OID, so their key never
 * changes for the life of the session; worktree files carry a
 * `size:mtimeMs` fingerprint as `contentIdentity`, so a re-stat that finds the
 * same fingerprint reuses the cached blob instead of re-transferring bytes.
 */
export function buildImageAssetCacheKey(parts: {
  readonly hostId: string;
  readonly source: ImageAssetSource;
  readonly path: string;
  readonly contentIdentity: string;
}): string {
  return [parts.hostId, parts.source, parts.path, parts.contentIdentity].join(
    "|",
  );
}
