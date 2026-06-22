import type { CheckpointFileOperation } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type { ArtifactOperationAction } from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * Whether an artifact change has a renderable diff.
 *
 * A non-delete change with no `afterHash` is NOT renderable: that happens when
 * the after-capture produced no snapshot (binary content / a transient capture
 * failure) or never ran (the turn aborted before `completeEdit`). Such an entry
 * must NOT fall through to an all-deletions diff for a file that still exists.
 * A delete legitimately has a null `afterHash` and renders as all-deletions
 * from its `beforeHash`.
 */
export function artifactDiffRenderable(input: {
  readonly operation: ArtifactOperationAction | CheckpointFileOperation;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}): boolean {
  if (input.afterHash !== null) return true;
  return input.operation === "delete" && input.beforeHash !== null;
}
