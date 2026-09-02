import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
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
 * Every check is made on the OPEN handle, never on the path beforehand: a
 * path checked and then opened is two different files if anything moves in
 * between. The open is non-blocking so that a FIFO - which an ordinary
 * read-only open waits on until a writer appears - opens at once and is then
 * refused by kind, like a device or a directory; the flag changes nothing
 * about a regular file. The read itself is capped at one byte past the
 * handle's size, so a file that grows while it is read is refused rather
 * than truncated.
 */
export async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<BoundedFileRead> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return { ok: false, reason: refusedFor(error) };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: "not-a-file" };
    if (info.size > maxBytes) return { ok: false, reason: "too-large" };
    // One byte past the handle's size: a read that fills it means the file
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
    return { ok: false, reason: refusedFor(error) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * A directory refuses the open itself on Windows (`EISDIR`), where POSIX
 * opens it and the handle's kind refuses it; the two agree on the reason.
 */
function refusedFor(error: unknown): "not-a-file" | "denied" | "unreadable" {
  const code = errnoCode(error);
  if (code === "EISDIR") return "not-a-file";
  return code === "EPERM" || code === "EACCES" ? "denied" : "unreadable";
}
