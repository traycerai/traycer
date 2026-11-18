import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChatPartCache } from "@traycer-clients/shared/cloud-chat/part-cache";

/**
 * The CLI's content-addressed store for published chat parts: one file per
 * digest, under `~/.traycer/cli/chat-parts/`.
 *
 * ## Why a directory of files is the whole design
 *
 * Every property a cache normally needs machinery for is supplied by content
 * addressing. The key IS the digest, so a filename is the index and there is no
 * index to keep in step. Bytes never change under a name, so there is no
 * invalidation, no TTL and no version stamp. Two processes writing the same part
 * concurrently write identical bytes, so a race is not one. And the reader
 * re-hashes what it reads back, so a partially written or corrupted file is
 * caught and refetched rather than served.
 *
 * That last point is why the temp-then-rename below is a courtesy rather than a
 * correctness requirement: it costs nothing and it keeps the common case
 * (interrupted write) from occupying a slot the reader has to discover is bad.
 *
 * ## Fan-out
 *
 * Digests are split one byte deep (`ab/abcdef...`), so a heavy user's cache is
 * ≤256 directories rather than one with tens of thousands of entries. That is a
 * filesystem courtesy, not a lookup structure - the path is still derived
 * arithmetically from the digest, never searched.
 *
 * ## Eviction
 *
 * There is none, and its absence is deliberate rather than deferred. A part is
 * ~64 KiB and a chat is a handful of them; a heavy reader's whole cache is
 * measured in megabytes. Adding an LRU would mean tracking access times, which
 * means state that CAN be stale - reintroducing exactly the class of problem
 * content addressing removed. If a size policy is ever wanted, deleting the
 * directory is always safe, which is the only primitive it would need.
 */
export function createDiskChatPartCache(rootDir: string): ChatPartCache {
  return {
    get: async (sha256) => {
      const path = pathFor(rootDir, sha256);
      if (path === null) return null;
      try {
        const bytes = await readFile(path);
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } catch {
        // Absent, unreadable, or half-written. All three mean "ask the cloud".
        return null;
      }
    },
    put: async (sha256, bytes) => {
      const path = pathFor(rootDir, sha256);
      if (path === null) return;
      try {
        await mkdir(dirname(path), { recursive: true });
        // Written beside the target and renamed, so a reader never opens a
        // partial file. Named with the digest plus a per-write suffix: two
        // concurrent writers of the same part must not share a temp path, or
        // one would rename the other's half-written file into place.
        const temporary = `${path}.${process.pid}.${writeCounter()}.part`;
        try {
          await writeFile(temporary, bytes);
          await rename(temporary, path);
        } catch (error) {
          // A `.part` the rename never claimed is unreachable: the reader opens
          // the exact digest path and nothing else, and this cache has no
          // eviction, so it would sit in the user's cache directory until they
          // deleted it by hand. Removed best-effort, then re-thrown to the same
          // swallow every other failure here takes.
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
      } catch {
        // Full disk, read-only home, denied permission. A failed `put` costs a
        // refetch next time and must never fail the read in progress.
      }
    },
  };
}

/**
 * The path a digest maps to, or `null` when the value is not a digest at all.
 *
 * The shape check is a path-traversal guard, not validation theatre: this
 * function turns a caller-supplied string into a filesystem path, and the
 * caller's string came off a head document that arrived over the wire. A
 * `sha256` of `../../../../etc/passwd` must not become a write target. Lowercase
 * hex of exactly 64 characters cannot contain a separator or a dot segment.
 */
function pathFor(rootDir: string, sha256: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  return join(rootDir, sha256.slice(0, 2), sha256);
}

let writes = 0;
function writeCounter(): number {
  writes += 1;
  return writes;
}

/**
 * Drops the whole store. For a sign-out, and for anyone who wants the disk back.
 *
 * Always safe: every entry is a copy of bytes the cloud still holds. The
 * failure is RETURNED, not thrown and not swallowed: by the time logout runs
 * this its own contract (the credential delete) has already landed, so a
 * filesystem refusal here must neither crash that nor pass silently - the
 * caller owes the user an honest report of what remains on disk.
 */
export async function clearDiskChatPartCache(
  rootDir: string,
): Promise<Error | null> {
  try {
    await rm(rootDir, { recursive: true, force: true });
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
