import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Epic files: the manifest that indexes the files stored under an epic - agent
 * pages, MCP App snapshots and the drop zone.
 *
 * The manifest is a SIBLING `Y.Map` on the epic root doc
 * (`doc.getMap("files")`), like `attachments` and `collaboratorRoles`, and is
 * deliberately NOT a field on the registered `epic` record: nothing here goes
 * through `persistenceRecordRegistry`. Only the manifest syncs through the doc;
 * the bytes are immutable sha256 objects on disk and in cloud storage.
 *
 * Keys are epic-root-relative POSIX paths under `files/` ({@link isEpicFilePath}).
 * Two namespaces are written once, by the host: `files/pages/` and
 * `files/mcp-apps/`. Everything else is the drop zone, where an edit ingests a
 * new sha and only the current sha is kept.
 *
 * Leniency is per ENTRY, never per map: a reader parses one key at a time and
 * drops only the key it cannot parse. `kind`, `mediaType` and `status` are open
 * strings for the same reason - a value a newer host adds must not make an
 * older reader drop the entry.
 */

/** Lowercase hex sha256 - the only form a content address is written in. */
export const EPIC_FILE_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const EPIC_FILES_MAP_NAME = "files";

/** Hard per-file cap. */
export const EPIC_FILE_MAX_BYTES = 500 * 1024 * 1024;

/** Files at or below this size are mirrored to every host eagerly. */
export const EPIC_FILE_MIRROR_EAGER_MAX_BYTES = 10 * 1024 * 1024;

export const EPIC_FILE_PAGES_PREFIX = "files/pages/";
export const EPIC_FILE_MCP_APPS_PREFIX = "files/mcp-apps/";

const EPIC_FILE_PATH_PREFIX = "files/";
const EPIC_FILE_PATH_MAX_LENGTH = 1024;

/**
 * Known `kind` values. Open: a reader renders an unknown kind as a generic file.
 * Writers pick from this list so producers stay consistent.
 */
export const epicFileKinds = ["page", "mcp-app", "file"] as const;
export type EpicFileKind = (typeof epicFileKinds)[number];

/**
 * Known upload states: `queued → uploading → published | local-only | failed`.
 * Open, like `kind`; {@link normalizeEpicFileStatus} buckets anything else as
 * `"unknown"`.
 */
export const epicFileStatuses = [
  "queued",
  "uploading",
  "published",
  "local-only",
  "failed",
] as const;
export type EpicFileStatus = (typeof epicFileStatuses)[number];

export function normalizeEpicFileStatus(
  status: string,
): EpicFileStatus | "unknown" {
  return epicFileStatuses.find((known) => known === status) ?? "unknown";
}

/**
 * One manifest entry, keyed in the map by its path.
 *
 * - `v` is the per-entry schema version. A reader accepts a higher `v` and keeps
 *   the fields it understands.
 * - `sha256` / `byteLength` / `mediaType` describe the bytes the path names now.
 *   `mediaType` is the host's sniffed type; a drop-zone `.html` stays
 *   `text/plain`, and only the page writer sets `text/html`.
 * - `derivedFrom` is the `"path@sha"` this file replaced (a page edit), or
 *   `null`.
 * - `deletedAt` tombstones the entry: it is hidden from the Files panel and
 *   `files/.index.md`, but a transcript row still reads it by sha.
 * - `title` is what a reader calls the file: a page's title, `<server> ·
 *   <tool>` for an MCP App snapshot, `null` for a drop-zone file. Optional and
 *   lenient: an older writer leaves it out, an older reader drops it, and a
 *   reader with none falls back to the file name. Agent- and server-authored,
 *   so it is display text only and never decides anything.
 *
 * Who created a file is deliberately absent. Nothing may decide a policy from
 * this map: any peer can write it.
 */
export const epicFileEntrySchema = lazySchema(() =>
  z.object({
    v: z.number(),
    kind: z.string(),
    sha256: z.string().regex(EPIC_FILE_SHA256_PATTERN),
    byteLength: z.number().int().nonnegative(),
    mediaType: z.string(),
    status: z.string(),
    createdAt: z.number(),
    derivedFrom: z.string().nullable().default(null),
    deletedAt: z.number().nullable().default(null),
    title: z.string().nullable().default(null),
  }),
);
export type EpicFileEntry = z.infer<typeof epicFileEntrySchema>;

/** NUL through US, plus DEL - see {@link isEpicFilePath}. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when `path` may key the manifest: an epic-root-relative POSIX path under
 * `files/`, with no leading `/`, no empty or dot-prefixed segment (which also
 * excludes `..` and host projections such as `files/.index.md`), no backslash,
 * no control character, and at most 1024 characters.
 *
 * A key is something any peer can write, and it is rendered into log lines and
 * into the `files/.index.md` table, so a `\r\n` inside one must never get this
 * far.
 */
export function isEpicFilePath(path: string): boolean {
  if (path.length === 0 || path.length > EPIC_FILE_PATH_MAX_LENGTH) {
    return false;
  }
  if (path.includes("\\") || hasControlCharacter(path)) return false;
  if (!path.startsWith(EPIC_FILE_PATH_PREFIX)) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && !segment.startsWith("."));
}

/** True for the two namespaces only the host writes, once. */
export function isEpicFileProducerPath(path: string): boolean {
  return (
    path.startsWith(EPIC_FILE_PAGES_PREFIX) ||
    path.startsWith(EPIC_FILE_MCP_APPS_PREFIX)
  );
}

export interface EpicFileRef {
  readonly path: string;
  readonly sha256: string;
}

/** Formats the `"path@sha"` reference a stamp's `derivedFrom` carries. */
export function formatEpicFileRef(ref: EpicFileRef): string {
  return `${ref.path}@${ref.sha256}`;
}

/**
 * Inverse of {@link formatEpicFileRef}, or `null` when `value` is not one. Split
 * at the LAST `@`: a file name may contain one.
 */
export function parseEpicFileRef(value: string): EpicFileRef | null {
  const separator = value.lastIndexOf("@");
  if (separator === -1) return null;
  const path = value.slice(0, separator);
  const sha256 = value.slice(separator + 1);
  if (!isEpicFilePath(path) || !EPIC_FILE_SHA256_PATTERN.test(sha256)) {
    return null;
  }
  return { path, sha256 };
}
