import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { isErrnoException } from "../../runner/errors";

/**
 * Deletion authority for an interrupted temp the migration wrote (a copy
 * temp, an inventory write). Neither a name nor a timestamp proves a file is
 * the migration's to delete; a person can create, edit or back-date a file
 * with any name. A temp is deletable only with BOTH:
 *
 * - ownership: its name carries a random nonce that the migration recorded
 *   durably (`recordOwnedTempNonce`, flushed) in its own evidence folder
 *   BEFORE it created any temp with that nonce, and the temp itself was
 *   created exclusively. No other writer can know the nonce in advance.
 * - integrity: every byte of the temp is a prefix of (or equal to) a
 *   reference file whose WHOLE content hashes, at the moment of the check,
 *   to a digest recorded before the temp could have been written (the frozen
 *   inventory's per-file SHA-256, or the journal-pinned inventory digest).
 *   The expected digest never comes from observing the candidate.
 *
 * So deleting it loses no byte that is not still held, verifiably, elsewhere.
 * Any doubt - a link, a non-regular file, a candidate longer than the
 * reference, a reference that no longer hashes to its digest, an unreadable
 * file, an unrecorded nonce - answers `false`, and the caller retains the
 * file with a blocker.
 */

const CHUNK_BYTES = 1024 * 1024;
const OWNED_TEMPS_DIRNAME = "owned-temps";
const NONCE_PATTERN = /^[0-9a-f]{32}$/u;

export function newTempNonce(): string {
  return randomUUID().replaceAll("-", "");
}

export function isTempNonce(value: string): boolean {
  return NONCE_PATTERN.test(value);
}

function ownedTempsDir(evidenceDir: string): string {
  return join(evidenceDir, OWNED_TEMPS_DIRNAME);
}

/**
 * Durably record `nonce` as this migration's before any temp carrying it is
 * created: exclusive create, flush, then flush the folder entry (POSIX).
 */
export async function recordOwnedTempNonce(input: {
  readonly evidenceDir: string;
  readonly nonce: string;
  readonly purpose: "copy" | "inventory";
  readonly createdAt: string;
  readonly platform: NodeJS.Platform;
}): Promise<void> {
  const dir = ownedTempsDir(input.evidenceDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const handle = await open(join(dir, input.nonce), "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ nonce: input.nonce, purpose: input.purpose, createdAt: input.createdAt })}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (input.platform !== "win32") {
    const folder = await open(dir, constants.O_RDONLY);
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  }
}

/** The nonces this migration recorded; an absent folder records none. */
export async function ownedTempNonces(
  evidenceDir: string,
): Promise<ReadonlySet<string>> {
  let names: string[];
  try {
    names = await readdir(ownedTempsDir(evidenceDir));
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return new Set();
    throw error;
  }
  return new Set(names.filter(isTempNonce));
}

/** Remove the ownership records last, once every temp they vouch for is gone. */
export async function removeOwnedTempRecords(
  evidenceDir: string,
  nonces: ReadonlySet<string>,
): Promise<void> {
  const dir = ownedTempsDir(evidenceDir);
  for (const nonce of nonces) await rm(join(dir, nonce), { force: true });
  try {
    await rmdir(dir);
  } catch (error) {
    if (
      !isErrnoException(error) ||
      (error.code !== "ENOENT" &&
        error.code !== "ENOTEMPTY" &&
        error.code !== "EEXIST")
    )
      throw error;
  }
}

async function openRegular(
  path: string,
  platform: NodeJS.Platform,
): Promise<FileHandle | null> {
  const flags =
    platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    if (isErrnoException(error)) return null;
    throw error;
  }
  const stats = await handle.stat({ bigint: true });
  if (!stats.isFile()) {
    await handle.close();
    return null;
  }
  return handle;
}

async function readFully(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<number> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      buffer.length - filled,
      position + filled,
    );
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled;
}

/**
 * Whether every byte of `candidate` is the leading part of `reference`, and
 * `reference` hashes to `referenceSha256` (lowercase hex) right now.
 */
export async function isPrefixOfVerifiedFile(input: {
  readonly candidate: string;
  readonly reference: string;
  readonly referenceSha256: string;
  readonly platform: NodeJS.Platform;
}): Promise<boolean> {
  const candidate = await openRegular(input.candidate, input.platform);
  if (candidate === null) return false;
  try {
    const reference = await openRegular(input.reference, input.platform);
    if (reference === null) return false;
    try {
      const candidateSize = Number(
        (await candidate.stat({ bigint: true })).size,
      );
      const referenceSize = Number(
        (await reference.stat({ bigint: true })).size,
      );
      if (candidateSize > referenceSize) return false;
      const hash = createHash("sha256");
      const referenceChunk = Buffer.allocUnsafe(CHUNK_BYTES);
      const candidateChunk = Buffer.allocUnsafe(CHUNK_BYTES);
      let position = 0;
      for (;;) {
        const read = await readFully(reference, referenceChunk, position);
        if (read === 0) break;
        hash.update(referenceChunk.subarray(0, read));
        if (position < candidateSize) {
          const want = Math.min(read, candidateSize - position);
          const got = await readFully(
            candidate,
            candidateChunk.subarray(0, want),
            position,
          );
          if (
            got !== want ||
            !candidateChunk
              .subarray(0, want)
              .equals(referenceChunk.subarray(0, want))
          )
            return false;
        }
        position += read;
      }
      // The candidate grew past what it was compared against while we read.
      if (
        Number((await candidate.stat({ bigint: true })).size) !== candidateSize
      )
        return false;
      return (
        position >= candidateSize &&
        hash.digest("hex") === input.referenceSha256
      );
    } finally {
      await reference.close();
    }
  } finally {
    await candidate.close();
  }
}

/** `lstat` with bigint times, or null when the path no longer exists. */
async function currentStats(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return null;
    throw error;
  }
}

/**
 * Unlinks `path` only while it is still the file `before` describes, re-read
 * right before the unlink: a write into bytes a proof had already read leaves
 * the proof's verdict standing, but never the size, times or inode. `gone`
 * when it no longer exists; `changed` (left in place) otherwise.
 */
export async function unlinkIfUnchanged(
  path: string,
  before: BigIntStats,
): Promise<"removed" | "gone" | "changed"> {
  const current = await currentStats(path);
  if (current === null) return "gone";
  if (
    !current.isFile() ||
    current.size !== before.size ||
    current.mtimeNs !== before.mtimeNs ||
    current.ctimeNs !== before.ctimeNs ||
    current.dev !== before.dev ||
    current.ino !== before.ino
  ) {
    return "changed";
  }
  await unlink(path);
  return "removed";
}
