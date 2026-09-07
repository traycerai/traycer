import type { CheckpointFileOperation } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type { ArtifactOperationAction } from "@traycer/protocol/persistence/epic/content-blocks";

/** Whether an artifact change has a renderable diff. */
export function artifactDiffRenderable(input: {
  readonly operation: ArtifactOperationAction | CheckpointFileOperation;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}): boolean {
  if (input.afterHash !== null) return true;
  return input.operation === "delete" && input.beforeHash !== null;
}
