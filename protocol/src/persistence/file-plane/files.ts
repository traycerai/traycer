import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The file plane's manifest: an index of arbitrary files stored under a
 * CONTAINER (an epic, an identity), keyed by container-root-relative path and
 * valued by immutable, content-addressed objects.
 *
 * Lifted from `feat/epic-media-pipeline` (`protocol/src/persistence/epic/files.ts`)
 * and parameterized on the container: the schemas, ref format and caps below
 * carry nothing epic-specific. What an epic adds - the map name (`files`), the
 * allowed path prefixes (`files/`) and its per-file byte cap - lives in
 * `persistence/epic/files.ts`, which also re-exports this module under its
 * original epic-prefixed names so the epic integration rebases onto it.
 *
 * The manifest is a SIBLING `Y.Map` on the container's root doc - reached by
 * `doc.getMap(<mapName>)`, exactly like `attachments` / `attachmentRefs` /
 * `collaboratorRoles` - and is deliberately NOT a field on a registered record
 * (D02). Nothing here goes through `persistenceRecordRegistry`, so the frozen
 * epic-schema surface is untouched.
 *
 * Keys are container-root-relative POSIX paths (`isFilePlanePath`); values are
 * entries of `filePlaneEntrySchema`. Leniency is per ENTRY, never per map: a
 * reader parses one key at a time and drops only the key it cannot parse, so
 * one bad entry renders as a generic/unknown file instead of blocking the
 * container from opening. `kind`, `mediaType` and `status` are open strings for
 * the same reason - a value added later is a compatible same-major addition and
 * needs no frozen copy.
 *
 * Bytes never enter the doc (D03). Objects are immutable and content-addressed
 * by sha256; names and paths are manifest metadata only.
 */

/** Lowercase hex sha256 - the only form a content address is written in. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Newest first; older versions past the cap are dropped by the writer (D03). */
export const FILE_PLANE_VERSIONS_CAP = 10;

/** Tombstones older than this are compacted out of the map (D25). */
export const FILE_PLANE_TOMBSTONE_COMPACT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Entries at or below this size are mirrored eagerly on container open (D11).
 * Plane policy, not container policy: it bounds what a host downloads without
 * being asked, whatever the container.
 */
export const FILE_PLANE_MIRROR_EAGER_MAX_BYTES = 10 * 1024 * 1024;

const FILE_PLANE_PATH_MAX_LENGTH = 1024;

/**
 * Known `kind` values. Open by design (D02) - a reader must render an
 * unrecognized kind as a generic file, never as a failure. Writers pick from
 * this list so the vocabulary stays consistent across producers; `file` is the
 * only kind every container produces, the rest are the epic plane's.
 */
export const filePlaneKinds = [
  "file",
  "screenshot",
  "recording",
  "recording-events",
  "poster",
  "artifact-image",
] as const;
export type FilePlaneKind = (typeof filePlaneKinds)[number];

/**
 * Known `status` values (D08, D24). Also open: readers bucket anything else as
 * `"unknown"` via `normalizeFilePlaneStatus` rather than dropping the entry.
 */
export const filePlaneStatuses = [
  "pending",
  "available",
  "failed",
  "local-only",
] as const;
export type FilePlaneStatus = (typeof filePlaneStatuses)[number];
export type FilePlaneStatusOrUnknown = FilePlaneStatus | "unknown";

export function normalizeFilePlaneStatus(
  status: string,
): FilePlaneStatusOrUnknown {
  return filePlaneStatuses.find((known) => known === status) ?? "unknown";
}

/**
 * Who produced the object. `createdBy` on the object is a user id: manifest DATA,
 * never log text (D31).
 *
 * OPEN, like `kind`, `mediaType` and `status`, and for the file's own reason: a
 * closed union here would make one unrecognized producer written by a newer
 * host fail the whole ENTRY, which contradicts the per-entry leniency rule this
 * module is built on - an entry a reader cannot fully understand renders as a
 * generic file, it does not vanish. So an unknown `type` parses as a generic
 * producer carrying nothing but its name.
 *
 * `agent` keeps its typed `chatId`: it is the one producer anything branches
 * on, and the generic arm refuses the `agent` name precisely so an agent
 * producer that lost its `chatId` still fails rather than degrading into a
 * generic row that no longer names the chat. Narrow with
 * `producer.type === "agent" && "chatId" in producer` - the `in` check is what
 * excludes the generic arm, whose `type` is an unconstrained string.
 */
const filePlaneAgentProducerSchema = lazySchema(() =>
  z.object({
    type: z.literal("agent"),
    chatId: z.string(),
    /**
     * Set when the chat is an identity's hidden EVOLUTION pass, so a blob it
     * writes (a skill script, an image) keeps the same provenance its
     * markdown edits carry through the version log. Additive: absent on
     * every other agent write, and a reader that predates it sees a plain
     * agent producer, which is the honest degradation.
     */
    evolution: z.literal(true).optional(),
  }),
);
const filePlaneGenericProducerSchema = lazySchema(() =>
  z.object({
    type: z.string().refine((type) => type !== "agent", {
      message: "an agent producer must carry a chatId",
    }),
  }),
);
export const filePlaneProducerSchema = lazySchema(() =>
  z.union([filePlaneAgentProducerSchema, filePlaneGenericProducerSchema]),
);
export type FilePlaneProducer = z.infer<typeof filePlaneProducerSchema>;

/**
 * One immutable, content-addressed object. Overwriting a path mints a new one.
 *
 * `executable` is the one bit of file MODE the plane carries. Optional rather
 * than defaulted so an object written before the field existed parses
 * unchanged and a writer that has no mode to report (a staged host write, a
 * recording) may omit it; a reader treats absence as `false`. The producing
 * host sets it from the file mode at ingest and the mirror reapplies it after
 * a download, so a script arrives on a second host still runnable.
 */
export const filePlaneObjectSchema = lazySchema(() =>
  z.object({
    sha256: z.string().regex(SHA256_HEX),
    byteLength: z.number().int().nonnegative(),
    mediaType: z.string(),
    createdAt: z.number(),
    createdBy: z.string(),
    producer: filePlaneProducerSchema,
    executable: z.boolean().optional(),
  }),
);
export type FilePlaneObject = z.infer<typeof filePlaneObjectSchema>;

/**
 * One manifest entry, keyed in the map by its container-root-relative path.
 *
 * `v` is the per-entry schema version; a reader accepts a higher `v` and keeps
 * the fields it understands (unknown keys are stripped by Zod). The fields a
 * writer may legitimately omit carry defaults so an entry written by an older or
 * newer host still parses; `current` is the one field an entry cannot be missing,
 * because without it there are no bytes to point at.
 *
 * `versions` is bounded by `FILE_PLANE_VERSIONS_CAP` so a `path@sha` link keeps
 * meaning (D03). The WRITER enforces the cap; the reader only trims
 * (`.transform`), because an entry that fails to parse loses its `current`
 * too, and losing the bytes' address over a bookkeeping overflow is the wrong
 * failure for a lenient reader.
 */
export const filePlaneEntrySchema = lazySchema(() =>
  z.object({
    v: z.number(),
    kind: z.string(),
    current: filePlaneObjectSchema,
    versions: z
      .array(filePlaneObjectSchema)
      .default([])
      .transform((versions) => versions.slice(0, FILE_PLANE_VERSIONS_CAP)),
    status: z.string(),
    /** Links the objects of one recording together (D14). Epic-only in practice; `null` elsewhere. */
    recordingId: z.string().nullable().default(null),
    /** Lineage as `"<path>@<sha>"` refs; a referenced object counts as live (D26). */
    derivedFrom: z.array(z.string()).default([]),
    /** Tombstone timestamp; bytes go, the cloud object stays until the container does (D25). */
    deletedAt: z.number().nullable().default(null),
  }),
);
export type FilePlaneEntry = z.infer<typeof filePlaneEntrySchema>;

/** NUL through US, plus DEL - see {@link isFilePlanePath}. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when `path` may key a manifest whose allowed prefixes are
 * `pathPrefixes`: a container-root-relative POSIX path under one of them, with
 * no leading `/`, no `..` or empty segment, no dot-prefixed segment (which also
 * excludes host projections such as `files/.index.md` and the `.file-staging/`
 * sibling), no backslash, no C0/DEL control character, and at most 1024
 * characters.
 *
 * `pathPrefixes` is the container's choice - `["files/"]` for an epic,
 * `["skills/"]` for an identity - and each prefix is matched literally, so a
 * prefix ends in `/` by convention.
 *
 * The control-character rule is wider than "no NUL" on purpose. A manifest key
 * is a Y.Map key any peer can write, and it is rendered into `file=` log lines
 * and into a projected markdown table: a `\r\n` inside one closes the log line
 * and opens a forged one under a level it never earned, which is the same class
 * `describeErrorBody`'s allowlist exists for.
 */
export function isFilePlanePath(
  path: string,
  pathPrefixes: readonly string[],
): boolean {
  if (path.length === 0 || path.length > FILE_PLANE_PATH_MAX_LENGTH) {
    return false;
  }
  if (path.includes("\\") || hasControlCharacter(path)) {
    return false;
  }
  if (!pathPrefixes.some((prefix) => path.startsWith(prefix))) {
    return false;
  }
  return path
    .split("/")
    .every((segment) => segment.length > 0 && !segment.startsWith("."));
}

export interface FilePlaneRef {
  path: string;
  sha256: string;
}

/** Formats the `"<path>@<sha>"` lineage / version link of D26. */
export function formatFilePlaneRef(path: string, sha256: string): string {
  return `${path}@${sha256}`;
}

/**
 * Inverse of `formatFilePlaneRef`, or `null` when the ref is not one under
 * `pathPrefixes`. Split at the LAST `@` - a file name may legitimately contain
 * one.
 */
export function parseFilePlaneRef(
  ref: string,
  pathPrefixes: readonly string[],
): FilePlaneRef | null {
  const separator = ref.lastIndexOf("@");
  if (separator === -1) {
    return null;
  }
  const path = ref.slice(0, separator);
  const sha256 = ref.slice(separator + 1);
  if (!isFilePlanePath(path, pathPrefixes) || !SHA256_HEX.test(sha256)) {
    return null;
  }
  return { path, sha256 };
}
