import type { ToolCallArtifactStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import type { ArtifactManifest } from "@/lib/sandbox/artifact-serving";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";

export type ArtifactRowState =
  | { readonly kind: "deleted" | "pending" }
  | {
      readonly kind: "stamped" | "latest";
      readonly manifest: ArtifactManifest;
    };

/** Absence can precede the record; only a tombstone confirms deletion. */
export function selectArtifactRowState(
  stamp: ToolCallArtifactStamp,
  artifact: ArtifactProjection | null,
  stampedObjectMissing: boolean,
  confirmedDeleted: boolean,
): ArtifactRowState {
  if (confirmedDeleted) return { kind: "deleted" };
  if (artifact === null) return { kind: "pending" };
  if (stampedObjectMissing && artifact.head !== undefined) {
    return { kind: "latest", manifest: artifact.head };
  }
  return { kind: "stamped", manifest: stamp.manifest };
}

/** Snapshot refreshes must not replace a running document with identical bytes. */
export function artifactManifestsEqual(
  left: ArtifactManifest | null,
  right: ArtifactManifest | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  const paths = Object.keys(left.files);
  if (paths.length !== Object.keys(right.files).length) return false;
  return paths.every((path) => {
    if (!Object.hasOwn(right.files, path)) return false;
    const a = left.files[path];
    const b = right.files[path];
    return a.sha256 === b.sha256 && a.byteLength === b.byteLength && a.mediaType === b.mediaType;
  });
}
