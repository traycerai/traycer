import { open, stat, type FileHandle } from "node:fs/promises";
import { errnoCode } from "./errno-code";

/**
 * The most bytes one login-import file read buffers in main.
 *
 * A cookie export or a Safari jar is kilobytes to a few megabytes; a
 * browser's `Local State` or `profiles.ini` smaller still. The picker offers
 * "All files", so the path can name anything on the disk: a bigger regular
 * file is refused by SIZE and a FIFO, a device or a directory by KIND, before
 * `readFile` would block on the one or buffer the other into the process.
 */
export const MAX_LOGIN_IMPORT_FILE_BYTES = 64 * 1024 * 1024;

export type BoundedFileRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | {
      readonly ok: false;
      readonly reason: "not-a-file" | "too-large" | "denied" | "unreadable";
    };

/**
 * Reads a regular file of at most `maxBytes`, or says why not.
 *
 * The kind is checked with `stat` BEFORE the open: opening a FIFO for reading
 * blocks until a writer appears, and a device answers bytes for ever. The
 * size is checked twice - on the path, then on the open handle - and the read
 * itself is capped at one byte past the bound, so a file that grows while it
 * is read is refused rather than truncated.
 */
export async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<BoundedFileRead> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, reason: "not-a-file" };
    if (info.size > maxBytes) return { ok: false, reason: "too-large" };
  } catch (error) {
    return { ok: false, reason: deniedOrUnreadable(error) };
  }
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    return { ok: false, reason: deniedOrUnreadable(error) };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: "not-a-file" };
    if (info.size > maxBytes) return { ok: false, reason: "too-large" };
    // One byte past the stat'd size: a read that fills it means the file
    // grew under us, and the content on hand is not the file.
    const buffer = Buffer.alloc(info.size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled === buffer.length) return { ok: false, reason: "unreadable" };
    return { ok: true, bytes: buffer.subarray(0, filled) };
  } catch (error) {
    return { ok: false, reason: deniedOrUnreadable(error) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function deniedOrUnreadable(error: unknown): "denied" | "unreadable" {
  const code = errnoCode(error);
  return code === "EPERM" || code === "EACCES" ? "denied" : "unreadable";
}
