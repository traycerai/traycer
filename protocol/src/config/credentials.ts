import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  bumpMtimeAbove,
  errorCode,
  fileMtimeMsOrZero,
  renameWithWindowsRetry,
} from "./credentials-fs";

/**
 * The `~/.traycer/cli/<env>/credentials` payload - the single, machine-local
 * source of truth for the signed-in user, shared by the CLI, the desktop app,
 * and the host. Stored as JSON with mode 0600 so other users on a shared
 * machine cannot read the bearer token. The `user` block is a cache of the last
 * successful `/api/v3/user` response (handy for `whoami` without a round trip)
 * and is always advisory - the token is the source of truth and is
 * re-validated on demand.
 *
 * These primitives are the extraction target named in the credentials-file
 * token-store tech plan (§1): they live in `@traycer/protocol/config` because
 * the CLI (writer on `traycer login`), the desktop main process (the new
 * `FileTokenStore`), and the host (reads `user.id` to pin its owner-binding
 * gate) must all resolve and parse the exact same file. They stay
 * dependency-light on purpose - `node:fs` + `node:crypto` only, no logger and
 * no config singleton - so every consumer can import them without dragging in
 * CLI internals. The CLI re-exports them with its own path/logging glue.
 */
export interface StoredCredentials {
  readonly token: string;
  // The separately-delivered refresh token (post raw-JWS cutover). Sent in the
  // `POST /api/v3/auth/refresh` body; both rotate on refresh.
  readonly refreshToken: string;
  readonly authnBaseUrl: string;
  readonly savedAt: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
  };
}

export interface CredentialsWriteResult {
  // The mtime the file carries after the write, guaranteed strictly greater
  // than `max(pre-write mtime, mtimeFloorMs)`. The mutation protocol records
  // this as the next floor so a later delete->recreate can never regress it.
  readonly mtimeMs: number;
}

/**
 * Canonical on-disk serialization. The write primitive and the WAL's target
 * digest both go through this, so the digest recovery compares against is the
 * exact byte string the write lands on disk.
 */
export function serializeCredentials(credentials: StoredCredentials): string {
  return JSON.stringify(credentials, null, 2) + "\n";
}

/**
 * Reads and validates the credentials file at `path`.
 *
 * Contract (deliberate deltas from the CLI's historical behavior, per §1):
 *   - Absent file (ENOENT) -> `null` ("no session").
 *   - Malformed JSON or a payload that fails the shape check -> `null`
 *     (treated as "no valid session"; the next sign-in overwrites it).
 *   - Any other I/O error (EACCES, EIO, ...) -> **throws**. The store maps a
 *     throw to "unavailable" (UI signed-out + surfaced error), never a write,
 *     so a temporarily-unreadable file is not mistaken for a signed-out user.
 */
export async function readCredentialsFile(
  path: string,
): Promise<StoredCredentials | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseStoredCredentials(parsed);
}

/** Total decoder for the on-disk shape; `null` on any structural mismatch. */
export function parseStoredCredentials(
  parsed: unknown,
): StoredCredentials | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const user = obj.user;
  if (
    typeof obj.token !== "string" ||
    typeof obj.refreshToken !== "string" ||
    typeof obj.authnBaseUrl !== "string" ||
    typeof obj.savedAt !== "string" ||
    user === null ||
    typeof user !== "object"
  ) {
    return null;
  }
  const userObj = user as Record<string, unknown>;
  if (
    typeof userObj.id !== "string" ||
    typeof userObj.email !== "string" ||
    typeof userObj.name !== "string"
  ) {
    return null;
  }
  return {
    token: obj.token,
    refreshToken: obj.refreshToken,
    authnBaseUrl: obj.authnBaseUrl,
    savedAt: obj.savedAt,
    user: { id: userObj.id, email: userObj.email, name: userObj.name },
  };
}

/**
 * Atomically writes the credentials file with a monotonically-increasing mtime.
 *
 * Mechanics: parent dir ensured at 0700; a per-write unique temp (so concurrent
 * writers never share `${path}.tmp` and clobber each other's staging) written
 * at 0600; mtime stamped strictly greater than `max(pre-write mtime,
 * mtimeFloorMs)` on the temp *before* the rename; the rename retried on the
 * transient Windows codes; then the landed file's mtime verified and re-bumped
 * for coarse-granularity filesystems. Returns the final mtime so the caller can
 * carry it forward as the next floor.
 *
 * `mtimeFloorMs` is the floor carried across a prior delete->recreate (from the
 * WAL sidecar). Pass `0` for a plain write with no external floor - the write
 * still ends up strictly above the file's own prior mtime, which is what keeps
 * the host owner-gate's mtime cache correct.
 */
export async function writeCredentialsFile(
  path: string,
  credentials: StoredCredentials,
  mtimeFloorMs: number,
): Promise<CredentialsWriteResult> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // `recursive` only applies the mode to dirs it creates; tighten an existing
  // (e.g. pre-refactor 0755) parent so another local user cannot swap our 0600
  // files. Best-effort - never fail a write over a defense-in-depth chmod.
  await chmod(dirname(path), 0o700).catch(() => {});
  const floorMs = Math.max(await fileMtimeMsOrZero(path), mtimeFloorMs);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, serializeCredentials(credentials), {
      encoding: "utf8",
      mode: 0o600,
    });
    // Mode on the temp is honored on creation, but a pre-existing temp could
    // have looser bits - re-chmod before the rename to be safe.
    await chmod(tmp, 0o600);
    // Stamp strictly above the floor, but never below wall-clock now: a plain
    // write (floor 0) must land a "now" mtime, not epoch+1ms. Only a carried
    // future floor (delete->recreate under clock skew) pushes it ahead of now.
    const desired = new Date(Math.max(floorMs + 1, Date.now()));
    await utimes(tmp, desired, desired);
    await renameWithWindowsRetry(tmp, path, 0);
  } catch (err) {
    // Don't leave an orphaned temp behind if the write/rename failed.
    await rm(tmp, { force: true });
    throw err;
  }
  return { mtimeMs: await bumpMtimeAbove(path, floorMs) };
}

/**
 * Deletes the credentials file at `path`.
 *
 * Contract (§1): `true` when a file was removed, `false` when it was already
 * absent (ENOENT). Any other failure **throws** - an explicit sign-out that
 * cannot land must surface, leaving the caller signed in rather than falsely
 * reporting success.
 */
export async function deleteCredentialsFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
}
