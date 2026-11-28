import type { ArtifactProjection } from "@/stores/epics/open-epic/types";

/**
 * Where the host lays out an artifact, as far as it says.
 *
 * - `stated`: the host decided. `segments` is the path from the artifacts
 *   root, or `null` when the artifact has none or the host has not decided
 *   yet; either way nothing is derived in its place.
 * - not `stated`: the host states no placement - the legacy root-doc arm and
 *   a records lane below 1.7, both at index epoch 0. Only then may a caller
 *   derive a path from the stored fields.
 */
export type HostArtifactPath =
  | { readonly stated: true; readonly segments: readonly string[] | null }
  | { readonly stated: false };

const UNSTATED: HostArtifactPath = Object.freeze({ stated: false });

export function hostArtifactPath(
  artifact: ArtifactProjection,
): HostArtifactPath {
  const placement = artifact.placement;
  if (placement === undefined) return UNSTATED;
  return {
    stated: true,
    segments: placement.kind === "placed" ? placement.segments : null,
  };
}
