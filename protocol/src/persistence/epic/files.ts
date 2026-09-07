import { z } from "zod";

/**
 * Epic files: the manifest that indexes arbitrary files stored under an epic
 * (drop-zone files, screenshots, recordings, artifact-image bytes).
 *
 * The manifest is a SIBLING `Y.Map` on the epic root doc — `doc.getMap("files")`,
 * exactly like `attachments` / `attachmentRefs` / `collaboratorRoles` — and is
 * deliberately NOT a field on the registered `epic` record (D02). Nothing here
 * goes through `persistenceRecordRegistry`, so the frozen epic-schema surface is
 * untouched.
 *
 * Keys are epic-root-relative POSIX paths (`isEpicFilePath`); values are entries
 * of `epicFileEntrySchema`. Leniency is per ENTRY, never per map: a reader parses
 * one key at a time and drops only the key it cannot parse, so one bad entry
 * renders as a generic/unknown file instead of blocking the epic from opening.
 * `kind`, `mediaType` and `status` are open strings for the same reason — a value
 * added later is a compatible same-major addition and needs no frozen copy.
 *
 * Bytes never enter the doc (D03). Objects are immutable and content-addressed by
 * sha256; names and paths are manifest metadata only.
 */

/** Lowercase hex sha256 - the only form a content address is written in. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

export const EPIC_FILES_MAP_NAME = "files";

/** Newest first; older versions past the cap are dropped by the writer (D03). */
export const EPIC_FILE_VERSIONS_CAP = 10;

/** Tombstones older than this are compacted out of the map (D25). */
export const EPIC_FILE_TOMBSTONE_COMPACT_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-file byte cap (D21). */
export const EPIC_FILE_MAX_BYTES = 512 * 1024 * 1024;

/** Entries at or below this size are mirrored eagerly on epic open (D11). */
export const EPIC_FILE_MIRROR_EAGER_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Epic-root-relative prefixes the manifest addresses. `files/` is the only one:
 * every object's bytes, migrated artifact images included
 * (`files/artifact-images/<sha>.<ext>`, D04), live under it. The per-artifact
 * `artifacts/<id>/images/` folder is a PROJECTION the artifact mirror writes and
 * prunes, never a manifest key. `.file-staging/` is a sibling of `files/` by
 * construction and is therefore rejected here — staging files are never
 * manifest entries.
 */
export const EPIC_FILE_PATH_PREFIXES = ["files/"] as const;

const EPIC_FILE_PATH_MAX_LENGTH = 1024;

/**
 * Known `kind` values. Open by design (D02) — a reader must render an
 * unrecognized kind as a generic file, never as a failure. Writers pick from
 * this list so the vocabulary stays consistent across producers.
 */
export const epicFileKinds = [
  "file",
  "screenshot",
  "recording",
  "recording-events",
  "poster",
  "artifact-image",
] as const;
export type EpicFileKind = (typeof epicFileKinds)[number];

/**
 * Known `status` values (D08, D24). Also open: readers bucket anything else as
 * `"unknown"` via `normalizeEpicFileStatus` rather than dropping the entry.
 */
export const epicFileStatuses = [
  "pending",
  "available",
  "failed",
  "local-only",
] as const;
export type EpicFileStatus = (typeof epicFileStatuses)[number];
export type EpicFileStatusOrUnknown = EpicFileStatus | "unknown";

export function normalizeEpicFileStatus(
  status: string,
): EpicFileStatusOrUnknown {
  return epicFileStatuses.find((known) => known === status) ?? "unknown";
}

/**
 * Who produced the object. `createdBy` on the object is a user id: manifest DATA,
 * never log text (D31).
 */
export const epicFileProducerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user") }),
  z.object({ type: z.literal("agent"), chatId: z.string() }),
]);
export type EpicFileProducer = z.infer<typeof epicFileProducerSchema>;

/** One immutable, content-addressed object. Overwriting a path mints a new one. */
export const epicFileObjectSchema = z.object({
  sha256: z.string().regex(SHA256_HEX),
  byteLength: z.number().int().nonnegative(),
  mediaType: z.string(),
  createdAt: z.number(),
  createdBy: z.string(),
  producer: epicFileProducerSchema,
});
export type EpicFileObject = z.infer<typeof epicFileObjectSchema>;

/**
 * One manifest entry, keyed in the map by its epic-root-relative path.
 *
 * `v` is the per-entry schema version; a reader accepts a higher `v` and keeps
 * the fields it understands (unknown keys are stripped by Zod). The fields a
 * writer may legitimately omit carry defaults so an entry written by an older or
 * newer host still parses; `current` is the one field an entry cannot be missing,
 * because without it there are no bytes to point at.
 *
 * `versions` is bounded by `EPIC_FILE_VERSIONS_CAP` so a `path@sha` link keeps
 * meaning (D03). The WRITER enforces the cap; the reader only trims
 * (`.transform`), because an entry that fails to parse loses its `current`
 * too, and losing the bytes' address over a bookkeeping overflow is the wrong
 * failure for a lenient reader.
 */
export const epicFileEntrySchema = z.object({
  v: z.number(),
  kind: z.string(),
  current: epicFileObjectSchema,
  versions: z
    .array(epicFileObjectSchema)
    .default([])
    .transform((versions) => versions.slice(0, EPIC_FILE_VERSIONS_CAP)),
  status: z.string(),
  /** Links the three objects of one recording together (D14). */
  recordingId: z.string().nullable().default(null),
  /** Lineage as `"<path>@<sha>"` refs; a referenced object counts as live (D26). */
  derivedFrom: z.array(z.string()).default([]),
  /** Tombstone timestamp; bytes go, the cloud object stays until the epic does (D25). */
  deletedAt: z.number().nullable().default(null),
});
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
 * one of `EPIC_FILE_PATH_PREFIXES`, with no leading `/`, no `..` or empty
 * segment, no dot-prefixed segment (which also excludes host projections such as
 * `files/.index.md`), no backslash, no C0/DEL control character, and at most
 * 1024 characters.
 *
 * The control-character rule is wider than "no NUL" on purpose. A manifest key
 * is a Y.Map key any peer can write, and it is rendered into `file=` log lines
 * and into the `files/.index.md` markdown table: a `\r\n` inside one closes the
 * log line and opens a forged one under a level it never earned, which is the
 * same class `describeErrorBody`'s allowlist exists for.
 */
export function isEpicFilePath(path: string): boolean {
  if (path.length === 0 || path.length > EPIC_FILE_PATH_MAX_LENGTH) {
    return false;
  }
  if (path.includes("\\") || hasControlCharacter(path)) {
    return false;
  }
  if (!EPIC_FILE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return false;
  }
  return path
    .split("/")
    .every((segment) => segment.length > 0 && !segment.startsWith("."));
}

export interface EpicFileRef {
  path: string;
  sha256: string;
}

/** Formats the `"<path>@<sha>"` lineage / version link of D26. */
export function formatEpicFileRef(path: string, sha256: string): string {
  return `${path}@${sha256}`;
}

/**
 * Inverse of `formatEpicFileRef`, or `null` when the ref is not one. Split at the
 * LAST `@` — a file name may legitimately contain one.
 */
export function parseEpicFileRef(ref: string): EpicFileRef | null {
  const separator = ref.lastIndexOf("@");
  if (separator === -1) {
    return null;
  }
  const path = ref.slice(0, separator);
  const sha256 = ref.slice(separator + 1);
  if (!isEpicFilePath(path) || !SHA256_HEX.test(sha256)) {
    return null;
  }
  return { path, sha256 };
}
