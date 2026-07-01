import type { CheckpointFileOperation } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type { ArtifactOperationAction } from "@traycer/protocol/persistence/epic/content-blocks";

type ArtifactOperationVerbKey =
  CheckpointFileOperation | ArtifactOperationAction;

const ARTIFACT_OPERATION_VERBS = {
  create: "Created",
  delete: "Deleted",
  edit: "Updated",
  update: "Updated",
} satisfies Readonly<Record<ArtifactOperationVerbKey, string>>;

/**
 * Past-tense verb for an artifact operation, shared by the card badge, the
 * per-turn change row, and the accumulated-changes row (one source of truth so
 * the surfaces can't drift). Accepts either the block's `ArtifactOperationAction`
 * ("update") or the manifest's `CheckpointFileOperation` ("edit"); both map to
 * "Updated".
 */
export function artifactOperationVerb(
  operation: ArtifactOperationVerbKey,
): string {
  return ARTIFACT_OPERATION_VERBS[operation];
}
