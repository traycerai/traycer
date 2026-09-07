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
 * The `~/.traycer/cli/<env>/credentials` payload - the single, machine-local source of truth for the signed-in user, shared by the CLI, the desktop app, and the host.
 * Stored as JSON with mode 0600 so other users on a shared machine cannot read the bearer token.
 */
export interface StoredCredentials {
  readonly token: string;
  // The separately-delivered refresh token (post raw-JWS cutover). Sent in the
  // `POST /api/v3/auth/refresh` body; both rotate on refresh.
  readonly refreshToken: string;
  readonly savedAt: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
  };
}

export interface CredentialsWriteResult {
  // The mtime the file carries after the write, guaranteed strictly greater than `max(pre-write mtime, mtimeFloorMs)`.
  // The mutation protocol records this as the next floor so a later delete->recreate can never regress it.
  readonly mtimeMs: number;
}

/** Canonical on-disk serialization. */
export function serializeCredentials(credentials: StoredCredentials): string {
  return JSON.stringify(credentials, null, 2) + "\n";
}

/**
 * Reads and validates the credentials file at `path`.
 * The store maps a throw to "unavailable" (UI signed-out + surfaced error), never a write, so a temporarily-unreadable file is not mistaken for a signed-out user.
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

/**
 * Total decoder for the on-disk shape; `null` on any structural mismatch.
 * The authn endpoint is the READER's build-time/env config, never file content - a URL read off disk is whichever stack happened to write last, not the authority this process is configured against.
 */
export function parseStoredCredentials(
  parsed: unknown,
): StoredCredentials | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const user = obj.user;
  if (
    typeof obj.token !== "string" ||
    typeof obj.refreshToken !== "string" ||
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
    savedAt: obj.savedAt,
    user: { id: userObj.id, email: userObj.email, name: userObj.name },
  };
}

/** Atomically writes the credentials file with a monotonically-increasing mtime. */
export async function writeCredentialsFile(
  path: string,
  credentials: StoredCredentials,
  mtimeFloorMs: number,
): Promise<CredentialsWriteResult> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // `recursive` only applies the mode to dirs it creates; tighten an existing (e.g. pre-refactor 0755) parent so another local user cannot swap our 0600 files.
  // Best-effort - never fail a write over a defense-in-depth chmod.
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
    // Stamp strictly above the floor, but never below wall-clock now: a plain write (floor 0) must land a "now" mtime, not epoch+1ms.
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
 * Any other failure **throws** - an explicit sign-out that cannot land must surface, leaving the caller signed in rather than falsely reporting success.
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
