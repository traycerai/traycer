/**
 * The identity file tree the rail renders: `documents` (markdown) and `files`
 * (blobs) folded into one path space and grouped by the top-level folder an
 * identity is made of.
 *
 * Pure over the two slices, so the grouping, the pending badge and the
 * media-type labelling can be asserted without mounting anything.
 *
 * ## Groups
 *
 * `soul` is the root-level markdown (`SOUL.md`, `IDENTITY.md`, anything with
 * no folder), `memories` is `memories/**`, `skills` is `skills/**`, and
 * `other` is whatever else a host wrote. The three named groups match the
 * spec's rail; `other` exists so a path the spec did not anticipate still
 * renders rather than vanishing.
 */
import type {
  IdentityDocumentsSlice,
  IdentityFilesSlice,
} from "@/stores/identities/open-identity/types";

export type IdentityFileGroupId = "soul" | "memories" | "skills" | "other";

export interface IdentityFileGroup {
  readonly id: IdentityFileGroupId;
  readonly label: string;
}

export const IDENTITY_FILE_GROUPS: readonly IdentityFileGroup[] = [
  { id: "soul", label: "Soul" },
  { id: "memories", label: "Memories" },
  { id: "skills", label: "Skills" },
  { id: "other", label: "Other" },
];

export type IdentityFileBodyKind = "document" | "blob";

export interface IdentityTreeFile {
  readonly path: string;
  /** The last path segment. */
  readonly name: string;
  readonly group: IdentityFileGroupId;
  readonly kind: IdentityFileBodyKind;
  /** `text/markdown` for a document; the manifest's media type for a blob. */
  readonly mediaType: string;
  /** `null` for a document - its size lives in the CRDT, not the manifest. */
  readonly byteLength: number | null;
  /**
   * The manifest status for a blob (`pending`, `available`, `failed`,
   * `local-only`, or a value this build does not know); `null` for a document.
   */
  readonly status: string | null;
  readonly pending: boolean;
  readonly executable: boolean;
}

export interface IdentityTreeGroup extends IdentityFileGroup {
  readonly files: readonly IdentityTreeFile[];
}

const MARKDOWN_MEDIA_TYPE = "text/markdown";

export function identityFileGroupOf(path: string): IdentityFileGroupId {
  const slash = path.indexOf("/");
  if (slash === -1) return "soul";
  const folder = path.slice(0, slash);
  if (folder === "memories") return "memories";
  if (folder === "skills") return "skills";
  return "other";
}

export function identityFileName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function buildIdentityFileTree(
  documents: IdentityDocumentsSlice,
  files: IdentityFilesSlice,
): readonly IdentityTreeGroup[] {
  const entries: IdentityTreeFile[] = [];
  for (const path of documents.allPaths) {
    entries.push({
      path,
      name: identityFileName(path),
      group: identityFileGroupOf(path),
      kind: "document",
      mediaType: MARKDOWN_MEDIA_TYPE,
      byteLength: null,
      status: null,
      pending: false,
      executable: false,
    });
  }
  for (const path of files.allPaths) {
    const projection = files.byPath[path];
    if (projection === undefined) continue;
    const entry = projection.entry;
    // A tombstoned manifest entry is a deleted blob; the index lane usually
    // removes the row too, but the entry states it first.
    if (entry.deletedAt !== null) continue;
    entries.push({
      path,
      name: identityFileName(path),
      group: identityFileGroupOf(path),
      kind: "blob",
      mediaType: entry.current.mediaType,
      byteLength: entry.current.byteLength,
      status: entry.status,
      pending: entry.status === "pending",
      executable: entry.executable,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return IDENTITY_FILE_GROUPS.map((group) => ({
    ...group,
    files: entries.filter((entry) => entry.group === group.id),
  }));
}

/**
 * The file an identity opens on when nothing has been picked: its first root
 * MARKDOWN document (the soul), then the first document anywhere, then - only
 * when the identity holds no document at all - its first file of any kind.
 *
 * Kind before position, deliberately: the root group holds blobs as well as
 * documents, and a root asset such as `avatar.png` sorts before `SOUL.md`, so
 * "the first root file" would open every fresh tab on an image preview
 * instead of the soul editor (finding 43).
 */
export function defaultIdentityFilePath(
  groups: readonly IdentityTreeGroup[],
): string | null {
  const soul = groups.find((group) => group.id === "soul");
  const rootDocument = soul?.files.find((file) => file.kind === "document");
  if (rootDocument !== undefined) return rootDocument.path;
  for (const group of groups) {
    const document = group.files.find((file) => file.kind === "document");
    if (document !== undefined) return document.path;
  }
  for (const group of groups) {
    if (group.files.length > 0) return group.files[0].path;
  }
  return null;
}

/** Whether a media type is one the body can render as an image. */
export function isPreviewableImage(mediaType: string): boolean {
  return /^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/.test(mediaType);
}

/** Whether a media type is one the body can render as text. */
export function isPreviewableText(mediaType: string): boolean {
  if (mediaType.startsWith("text/")) return true;
  return /^application\/(json|x-yaml|yaml|toml|xml|javascript|typescript|x-sh)$/.test(
    mediaType,
  );
}

export function formatByteLength(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
