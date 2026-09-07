/** Rewrite a relative artifact href by walking `selfChain` like a filesystem; reappend `index.md` unless the href already named it. Do not guess folder vs file from spelling. The caller races this result against a workspace-file interpretation of the same href. */
import {
  EPIC_ARTIFACT_INDEX_FILENAME,
  EPIC_ARTIFACTS_DIRNAME,
  EPICS_DIRNAME,
} from "@traycer/protocol/common/artifact-path";

/** Resolve an already-decoded relative path against `selfChain`, or `null` if empty or above `artifacts/`. Do not decode again (`%252E%252E` would become `..`). Over-`../` is a dead end, not a fallback. */
export function resolveArtifactRelativeLinkPath(
  epicId: string,
  selfChain: readonly string[],
  relativePath: string,
): string | null {
  // Trim only to decide emptiness, never to reshape the path: `classifyHref`
  // already trimmed the raw href, so an edge space surviving to here came out of
  // a `%20` the author encoded on purpose and is part of the folder name.
  if (relativePath.trim().length === 0) return null;

  const rawSegments = relativePath.split(/[\\/]+/u).filter((s) => s.length > 0);
  if (rawSegments.length === 0) return null;

  const lastSegment = rawSegments[rawSegments.length - 1];
  const explicitIndexFile = lastSegment === EPIC_ARTIFACT_INDEX_FILENAME;
  const navigationSegments = explicitIndexFile
    ? rawSegments.slice(0, -1)
    : rawSegments;

  const chain = [...selfChain];
  for (const segment of navigationSegments) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (chain.length === 0) return null;
      chain.pop();
      continue;
    }
    chain.push(segment);
  }
  if (chain.length === 0) return null;

  return [
    EPICS_DIRNAME,
    epicId,
    EPIC_ARTIFACTS_DIRNAME,
    ...chain,
    EPIC_ARTIFACT_INDEX_FILENAME,
  ].join("/");
}
