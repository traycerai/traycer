/**
 * Rewrites a RELATIVE href authored inside an artifact into the same
 * artifact-shaped absolute-ish path string the EXISTING absolute-link flow
 * already understands (`artifactEpicIdFromLinkPath` +
 * `epic.resolveArtifactByPath`).
 *
 * Agents write markdown from the artifact tree's own point of view, where
 * `./`, `../`, and bare names WITHOUT a file extension navigate FOLDERS (each
 * sub-artifact is a directory holding its own `index.md` - the sub-artifact
 * convention). A bare name WITH a file extension (`../src/main.ts`,
 * `diagram.png`) is not a sub-artifact reference at all - see
 * `isArtifactFolderHref`, which the caller consults FIRST so a genuine file
 * reference is left untouched instead of being coerced into `name/index.md`.
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

/** Decodes a URL-encoded href segment (`%2E%2E`, `my%20folder`) before any `.`/`..` traversal or comparison; malformed escapes fall back to the raw string. */
function decodeHrefComponent(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function hasFileExtension(segment: string): boolean {
  // A dot at position 0 is a dotfile-style name (".gitignore"), not an
  // extension - folder slugs never start with a dot either, so treating it
  // as extension-less (folder-shaped) is safe on both counts.
  return segment.lastIndexOf(".") > 0;
}

/**
 * Whether `href` (as authored inside an artifact) navigates the ARTIFACT
 * FOLDER tree rather than referencing an arbitrary file: directory-shaped
 * (trailing separator), a bare `.`/`..` navigation token, an explicit
 * `index.md`, or a bare name with no file extension (the folder-slug
 * convention). A last segment carrying any OTHER extension (`main.ts`,
 * `diagram.png`) is a genuine relative file reference - the caller should
 * leave the href unchanged and resolve it as a normal workspace-relative
 * file instead of calling `resolveArtifactRelativeLinkPath`.
 */
export function isArtifactFolderHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0) return false;
  const decoded = decodeHrefComponent(trimmed);
  if (decoded.endsWith("/") || decoded.endsWith("\\")) return true;
  const segments = decoded.split(/[\\/]+/u).filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  const last = segments[segments.length - 1];
  if (last === "." || last === ".." || last === EPIC_ARTIFACT_INDEX_FILENAME) {
    return true;
  }
  return !hasFileExtension(last);
}

/**
 * Resolves `relativeHref` (as authored inside the artifact whose own
 * folder-name chain is `selfChain`) to an artifact-shaped path string, or
 * `null` when the href is empty/degenerate or navigates above the epic's
 * `artifacts/` root. The caller is responsible for only calling this for
 * NON-absolute hrefs that `isArtifactFolderHref` has already confirmed are
 * folder-shaped; an absolute href already carries its own marker and needs a
 * different canonicalization (see `use-artifact-link-opener.ts`).
 */
export function resolveArtifactRelativeLinkPath(
  epicId: string,
  selfChain: readonly string[],
  relativeHref: string,
): string | null {
  const trimmed = relativeHref.trim();
  if (trimmed.length === 0) return null;

  const decoded = decodeHrefComponent(trimmed);
  const rawSegments = decoded.split(/[\\/]+/u).filter((s) => s.length > 0);
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
