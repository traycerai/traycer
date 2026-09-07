import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChatPartCache } from "@traycer-clients/shared/cloud-chat/part-cache";

/** Content-addressed chat-part cache. Write beside the target and rename; per-write temp suffix so concurrent writers cannot share a path. */
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
        // Written beside the target and renamed, so a reader never opens a partial file.
        // Named with the digest plus a per-write suffix: two concurrent writers of the same part must not share a temp path, or one would rename the other's half-written file into place.
        const temporary = `${path}.${process.pid}.${writeCounter()}.part`;
        try {
          await writeFile(temporary, bytes);
          await rename(temporary, path);
        } catch (error) {
          // A `.part` the rename never claimed is unreachable: the reader opens the exact digest path and nothing else, and this cache has no eviction, so it would sit in the user's cache directory until they deleted it by hand.
          // Removed best-effort, then re-thrown to the same swallow every other failure here takes.
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

/** The path a digest maps to, or `null` when the value is not a digest at all. The shape check is a path-traversal guard, not validation theatre: this function turns a caller-supplied string into a filesystem path, and the caller's string came off a head document that arrived over the wire. */
function pathFor(rootDir: string, sha256: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  return join(rootDir, sha256.slice(0, 2), sha256);
}

let writes = 0;
function writeCounter(): number {
  writes += 1;
  return writes;
}

/** Drops the whole store. For a sign-out, and for anyone who wants the disk back. */
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
