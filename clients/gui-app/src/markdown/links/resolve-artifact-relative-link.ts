/**
 * Rewrites a RELATIVE href authored inside an artifact into the same
 * artifact-shaped absolute-ish path string the EXISTING absolute-link flow
 * already understands (`artifactEpicIdFromLinkPath` +
 * `epic.resolveArtifactByPath`).
 *
 * Agents write markdown from the artifact tree's own point of view, where
 * `./`, `../`, and bare names navigate FOLDERS (each sub-artifact is a
 * directory holding its own `index.md` - the sub-artifact convention).
 * Whether a given href is ACTUALLY folder-shaped versus a genuine relative
 * file reference (`../src/main.ts`) is NOT decided here by spelling - a real
 * file can be named `README`, `LICENSE`, or `.env` (no extension, or a
 * leading dot, exactly like a folder slug), and a real sub-artifact folder
 * can carry a dot (`v1.2`), so no extension-based guess is reliable (see the
 * corpus report backing this design). The caller
 * (`use-artifact-link-opener.ts`) instead races this function's result
 * (resolved via the read-only artifact RPC) against the plain
 * workspace-file interpretation of the SAME href and opens whichever
 * resolves to something real.
 *
 * Resolution here walks `selfChain` (this artifact's own root-to-leaf
 * folder-name chain, see `artifact-folder-chain.ts`) the same way a
 * filesystem would walk directory segments, then reappends `index.md` unless
 * the href already named it explicitly.
 */
import {
  EPIC_ARTIFACT_INDEX_FILENAME,
  EPIC_ARTIFACTS_DIRNAME,
  EPICS_DIRNAME,
} from "@traycer/protocol/common/artifact-path";

/**
 * Resolves `relativePath` (as authored inside the artifact whose own
 * folder-name chain is `selfChain`) to an artifact-shaped path string, or
 * `null` when the path is empty/degenerate or navigates above the epic's
 * `artifacts/` root.
 *
 * The path arrives ALREADY percent-decoded - `classifyHref` performs the single
 * decode on the way out of the markdown pipeline. Decoding again here would
 * consume a literal escape in a real folder name and, worse, could resurrect a
 * `..` out of an authored `%252E%252E` and walk out of the linked folder.
 *
 * A `null` return for an over-`../`'d href is a DELIBERATE dead end, not a
 * bug: an authoring agent that miscounts `../` depth either lands one level
 * short (a DIFFERENT real artifact than intended - since nearly every
 * directory in practice holds an `index.md`, guessing a fallback base would
 * silently open the WRONG one) or, as here, walks off the top of
 * `selfChain` entirely. There is no parent-directory or artifacts-root
 * fallback for either case - the caller's plain workspace-file race is the
 * only other candidate, and if that also misses, the ordinary "Couldn't
 * open link" toast is the correct, visible outcome for an authoring
 * mistake, not a wrong-artifact open.
 */
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
