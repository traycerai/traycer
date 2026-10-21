import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { resolve } from "node:path";
import { errorCode } from "@traycer/protocol/config/credentials-fs";
import {
  decodeHostUpdateAttempt,
  type HostUpdateAttemptRead,
} from "@traycer/protocol/config/host-update-attempt";
import { updateAttemptRecordPath } from "@traycer/protocol/config/host-update-attempt-paths";

// The READ side of `update-attempt.json` (§1.4).
//
// Lock-free by design: a status projection must be able to read without
// contending, and must never be able to write. There is deliberately no raw
// write or delete in this module - the canonical record changes only through
// the handle-bound operations in
// `@traycer-clients/shared/host-update/store`, which verify live lock
// ownership and re-read disk before touching anything.
//
// ### Why the read side lives here and the write side does not
//
// `traycer-host` projects this record into `host.status` and cannot import
// `@traycer-clients/shared`. It needs exactly this: a path, a hardened read,
// and a total decode. It must NOT be able to acquire the attempt lock or
// commit a mutation, and splitting the module along the read/write line makes
// that structural rather than a rule someone has to remember - the host
// imports a module with no writer in it.
//
// `classifyPath` and `errorCode` are exported because the write side in
// `shared/host-update/store.ts` uses them too, and duplicating a symlink
// classifier between the reader and the writer of the same file is how the
// two stop agreeing about what a symlink at the record path means.

// `O_NOFOLLOW | O_NONBLOCK` is the POSIX fast path: it binds the descriptor
// to a non-link and makes an attempted FIFO/device open total. Node does not
// expose either constant on Windows, however. Treating that absence as an
// unconditional read failure would make every Electron-on-Node record look
// unreadable. The capability object deliberately sends that runtime through
// the identity-checked fallback below instead.
interface RecordOpenPlatform {
  readonly noFollow: number;
  readonly nonBlock: number;
}

const defaultRecordOpenPlatform: RecordOpenPlatform = {
  noFollow: typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0,
  nonBlock: typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0,
};

let recordOpenPlatformForTest: RecordOpenPlatform | null = null;

/** Test-only override for the actual Node-on-Windows missing-flag branch. */
export function __setRecordOpenPlatformForTest(
  platform: RecordOpenPlatform | null,
): void {
  recordOpenPlatformForTest = platform;
}

function recordOpenPlatform(): RecordOpenPlatform {
  return recordOpenPlatformForTest ?? defaultRecordOpenPlatform;
}

export { errorCode };

// ---- Path classification ----------------------------------------------------

export type PathKind =
  | { readonly kind: "absent" }
  | { readonly kind: "regular-file"; readonly stats: Stats }
  | { readonly kind: "symlink" }
  | { readonly kind: "other" }
  | { readonly kind: "stat-error"; readonly cause: string };

type ObservedPathKind = Exclude<PathKind, { readonly kind: "stat-error" }>;

// `lstat`, never `stat`: `stat` follows a link and reports the TARGET's type,
// so a symlink planted at the record path would read as a perfectly ordinary
// regular file.
function kindOf(stats: Stats): ObservedPathKind {
  if (stats.isSymbolicLink()) return { kind: "symlink" };
  if (stats.isFile()) return { kind: "regular-file", stats };
  return { kind: "other" };
}

// The descriptor reads below throw a failure other than ENOENT as raised, so
// a caller can report it as its own.
async function lstatKind(path: string): Promise<ObservedPathKind> {
  try {
    return kindOf(await lstat(path));
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { kind: "absent" };
    throw err;
  }
}

function lstatKindSync(path: string): ObservedPathKind {
  try {
    return kindOf(lstatSync(path));
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { kind: "absent" };
    throw err;
  }
}

export async function classifyPath(path: string): Promise<PathKind> {
  try {
    return await lstatKind(path);
  } catch (err) {
    return { kind: "stat-error", cause: errorCode(err) ?? String(err) };
  }
}

// ---- Test seam: deterministic swap-at-open ---------------------------------
//
// Runs immediately before the record `open()`. Exists so a test can swap a
// symlink into the record path at exactly the instant that matters and prove
// the open refuses it, rather than asserting the weaker "a symlink that was
// already there is rejected". Never set in production.
let beforeRecordOpenHook: (() => Promise<void>) | null = null;

export function __setBeforeRecordOpenHookForTest(
  hook: (() => Promise<void>) | null,
): void {
  beforeRecordOpenHook = hook;
}

// ---- Descriptor open ------------------------------------------------------

interface NotRegular {
  readonly kind: "not-regular";
  readonly cause:
    | "attempt-record-is-symlink"
    | "attempt-record-not-a-regular-file"
    | "attempt-record-swapped-at-open";
}

type NoFollowOpen<Handle> =
  | { readonly kind: "opened"; readonly handle: Handle }
  | { readonly kind: "absent" }
  | NotRegular;

/**
 * Result of reading one security-sensitive sidecar through an opened,
 * no-follow descriptor.  `absent` is deliberately narrower than a failed
 * read: it means the canonical pathname was absent at the checked open edge.
 */
export type RegularFileNoFollowRead =
  | { readonly kind: "absent" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "unreadable"; readonly cause: string };

/**
 * A regular file's bytes, read through the same descriptor. `not-regular`: the
 * path is a link or another non-regular file, or changed while it was opened.
 * A special file that `open` itself refuses (a socket, on POSIX) throws.
 */
export type RegularFileBytesRead =
  | { readonly kind: "absent" }
  | { readonly kind: "not-regular" }
  | { readonly kind: "bytes"; readonly bytes: Buffer };

function openFlags(): { readonly safe: boolean; readonly flags: number } {
  const platform = recordOpenPlatform();
  const safe = platform.noFollow !== 0 && platform.nonBlock !== 0;
  return {
    safe,
    flags:
      constants.O_RDONLY |
      (safe ? platform.noFollow | platform.nonBlock : platform.nonBlock),
  };
}

// A pathname that does not name the regular file a read may use: a link, a
// special file, or - gone, or another regular file - one swapped at open.
function notRegular(kind: ObservedPathKind): NotRegular {
  if (kind.kind === "symlink") {
    return { kind: "not-regular", cause: "attempt-record-is-symlink" };
  }
  if (kind.kind === "other") {
    return { kind: "not-regular", cause: "attempt-record-not-a-regular-file" };
  }
  return { kind: "not-regular", cause: "attempt-record-swapped-at-open" };
}

// Validate the OPENED descriptor, not the path - it is the one the bytes will
// actually come from. `null` admits it. `after` is the fallback's second
// pathname observation; the POSIX descriptor path takes none.
function openedVerdict(
  opened: Stats,
  priorStats: Stats | null,
  after: ObservedPathKind | null,
): NotRegular | null {
  if (!opened.isFile()) {
    return { kind: "not-regular", cause: "attempt-record-not-a-regular-file" };
  }
  if (priorStats === null || after === null) return null;
  if (after.kind !== "regular-file") return notRegular(after);
  // The fallback is valid only with positive proof that the descriptor and
  // both pathname observations name one regular object.
  return sameFileIdentity(priorStats, opened) &&
    sameFileIdentity(opened, after.stats)
    ? null
    : { kind: "not-regular", cause: "attempt-record-swapped-at-open" };
}

async function openNoFollow(path: string): Promise<NoFollowOpen<FileHandle>> {
  const { safe, flags } = openFlags();

  // Windows Node exposes neither flag. Its fallback admits only an existing
  // regular entry that has the same positive identity before, through, and
  // after open. That is enough to use proven files while failing closed for
  // reparse points, special files, zero-identity files, and swaps. If only
  // one POSIX flag is absent, take this conservative fallback as well.
  let priorStats: Stats | null = null;
  if (!safe) {
    const kind = await lstatKind(path);
    if (kind.kind === "absent") return kind;
    if (kind.kind !== "regular-file") return notRegular(kind);
    priorStats = kind.stats;
  }

  if (beforeRecordOpenHook !== null) await beforeRecordOpenHook();

  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") {
      // `open` can see ENOENT after an attacker swaps a present pathname for
      // a dangling link. Re-classify the canonical pathname before calling
      // this absence: only a second positive absence is safe to project as
      // missing. A visible replacement is unreadable evidence, never a
      // licence to continue as if no file existed.
      const after = await lstatKind(path);
      return after.kind === "absent" ? after : notRegular(after);
    }
    // `O_NOFOLLOW` reports a symlink as ELOOP on Linux and macOS; some
    // platforms use EMLINK. Either way the path IS a link and must not be
    // followed.
    if (code === "ELOOP" || code === "EMLINK") {
      return { kind: "not-regular", cause: "attempt-record-is-symlink" };
    }
    throw err;
  }

  try {
    const opened = await handle.stat();
    const after =
      opened.isFile() && priorStats !== null ? await lstatKind(path) : null;
    const refused = openedVerdict(opened, priorStats, after);
    if (refused === null) return { kind: "opened", handle };
    await handle.close().catch(() => undefined);
    return refused;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

function closeQuietlySync(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // A failed close loses nothing: the read is already done or refused.
  }
}

// `openNoFollow` for synchronous callers, edge for edge; the comments there
// say why each one is there. It has no swap seam.
function openNoFollowSync(path: string): NoFollowOpen<number> {
  const { safe, flags } = openFlags();

  let priorStats: Stats | null = null;
  if (!safe) {
    const kind = lstatKindSync(path);
    if (kind.kind === "absent") return kind;
    if (kind.kind !== "regular-file") return notRegular(kind);
    priorStats = kind.stats;
  }

  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") {
      const after = lstatKindSync(path);
      return after.kind === "absent" ? after : notRegular(after);
    }
    if (code === "ELOOP" || code === "EMLINK") {
      return { kind: "not-regular", cause: "attempt-record-is-symlink" };
    }
    throw err;
  }

  try {
    const opened = fstatSync(fd);
    const after =
      opened.isFile() && priorStats !== null ? lstatKindSync(path) : null;
    const refused = openedVerdict(opened, priorStats, after);
    if (refused === null) return { kind: "opened", handle: fd };
    closeQuietlySync(fd);
    return refused;
  } catch (err) {
    closeQuietlySync(fd);
    throw err;
  }
}

/**
 * Read a small, security-sensitive file without following links or blocking
 * on a FIFO/device.  This is the descriptor/identity pattern used for the
 * durable update record, shared with the host-start adoption proof so a
 * visible special entry can never be mistaken for an absent proof.
 */
export async function readRegularFileNoFollow(
  path: string,
): Promise<RegularFileNoFollowRead> {
  let opened: NoFollowOpen<FileHandle>;
  try {
    opened = await openNoFollow(path);
  } catch (err) {
    return { kind: "unreadable", cause: errorCode(err) ?? String(err) };
  }
  if (opened.kind === "absent") return opened;
  if (opened.kind === "not-regular") {
    return { kind: "unreadable", cause: opened.cause };
  }
  try {
    return { kind: "text", text: await opened.handle.readFile("utf8") };
  } catch (err) {
    return {
      kind: "unreadable",
      cause: errorCode(err) ?? String(err),
    };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/**
 * The same descriptor read, as bytes, for a caller that refuses a link or a
 * special file where it expects a regular one. The check and the read are one
 * object, so a link swapped in after a check is never followed. Any failure
 * other than absence is thrown as raised.
 */
export async function readRegularFileBytesNoFollow(
  path: string,
): Promise<RegularFileBytesRead> {
  const opened = await openNoFollow(path);
  if (opened.kind === "absent") return opened;
  if (opened.kind === "not-regular") return { kind: "not-regular" };
  try {
    return { kind: "bytes", bytes: await opened.handle.readFile() };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** `readRegularFileBytesNoFollow` for synchronous callers. */
export function readRegularFileBytesNoFollowSync(
  path: string,
): RegularFileBytesRead {
  const opened = openNoFollowSync(path);
  if (opened.kind === "absent") return opened;
  if (opened.kind === "not-regular") return { kind: "not-regular" };
  try {
    return { kind: "bytes", bytes: readFileSync(opened.handle) };
  } finally {
    closeQuietlySync(opened.handle);
  }
}

// The Windows fallback admits an opened descriptor only with POSITIVE proof
// it is the same entry classified before `open`. Node reports zero inode/dev
// values on some Windows filesystems; those values are not proof of sameness,
// so they fail closed instead of reopening the reparse-point swap race.
// The POSIX descriptor path never reaches here; a platform missing either
// required descriptor flag uses this same conservative fallback.
function sameFileIdentity(
  a: Pick<Stats, "ino" | "dev">,
  b: Pick<Stats, "ino" | "dev">,
): boolean {
  if (a.ino === 0 || b.ino === 0 || a.dev === 0 || b.dev === 0) return false;
  return a.ino === b.ino && a.dev === b.dev;
}

/** Test-only projection of the Windows identity rule. */
export function __sameRecordFileIdentityForTest(
  a: Pick<Stats, "ino" | "dev">,
  b: Pick<Stats, "ino" | "dev">,
): boolean {
  return sameFileIdentity(a, b);
}

/**
 * Total read of the durable attempt record. Lock-free by design - a status
 * projection reads without contending, and can never write.
 *
 * A symlink, a non-regular file, or an entry swapped at open is
 * `unreadable`, not `corrupt`: no bytes were examined, so there is nothing a
 * rewrite could repair, and `unreadable` is the arm callers already treat as
 * "no evidence either way".
 */
export async function readUpdateAttemptRecord(
  hostHomeDir: string,
): Promise<HostUpdateAttemptRead> {
  return readUpdateAttemptRecordAtPath(
    updateAttemptRecordPath(resolve(hostHomeDir)),
  );
}

/**
 * The same total read, given the record path directly.
 *
 * Separate from the `hostHomeDir` entry point because the write side already
 * holds a lease bound to one canonical record path and must re-read THAT
 * path, not re-derive one from a directory it would have to be trusted to
 * pass correctly.
 */
export async function readUpdateAttemptRecordAtPath(
  recordPath: string,
): Promise<HostUpdateAttemptRead> {
  const opened = await readRegularFileNoFollow(recordPath);
  if (opened.kind === "absent") {
    return decodeHostUpdateAttempt({ kind: "missing" });
  }
  if (opened.kind === "unreadable") {
    return decodeHostUpdateAttempt({
      kind: "unreadable",
      cause: opened.cause,
    });
  }
  return decodeHostUpdateAttempt({ kind: "bytes", text: opened.text });
}
