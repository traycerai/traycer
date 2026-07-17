/**
 * Rewrites a RELATIVE href authored inside an artifact into the same
 * artifact-shaped absolute-ish path string the EXISTING absolute-link flow
 * already understands (`artifactEpicIdFromLinkPath` +
 * `epic.resolveArtifactByPath`).
 *
 * Agents write markdown from the artifact tree's own point of view, where
 * `./`, `../`, and bare names navigate FOLDERS (each sub-artifact is a
 * directory holding its own `index.md` - the sub-artifact convention), not
 * arbitrary files. Resolution therefore walks `selfChain` (this artifact's
 * own root-to-leaf folder-name chain, see `artifact-folder-chain.ts`) the
 * same way a filesystem would walk directory segments, then reappends
 * `index.md` unless the href already named it explicitly.
 */
import {
  EPIC_ARTIFACT_INDEX_FILENAME,
  EPIC_ARTIFACTS_DIRNAME,
  EPICS_DIRNAME,
} from "@traycer/protocol/common/artifact-path";

/**
 * Resolves `relativeHref` (as authored inside the artifact whose own
 * folder-name chain is `selfChain`) to an artifact-shaped path string, or
 * `null` when the href is empty/degenerate or navigates above the epic's
 * `artifacts/` root. The caller is responsible for only calling this for
 * NON-absolute hrefs; an absolute href already carries its own marker and
 * needs no rewrite.
 */
export function resolveArtifactRelativeLinkPath(
  epicId: string,
  selfChain: readonly string[],
  relativeHref: string,
): string | null {
  const trimmed = relativeHref.trim();
  if (trimmed.length === 0) return null;

  const rawSegments = trimmed.split(/[\\/]+/u).filter((s) => s.length > 0);
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
