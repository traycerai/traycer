import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { errnoCode } from "./errno-code";

export const MAX_LOGIN_IMPORT_FILE_BYTES = 64 * 1024 * 1024;

export type BoundedFileRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | {
      readonly ok: false;
      readonly reason: "not-a-file" | "too-large" | "denied" | "unreadable";
    };

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
    if (filled !== info.size) return { ok: false, reason: "unreadable" };
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      return { ok: false, reason: "unreadable" };
    }
    return { ok: true, bytes: buffer.subarray(0, filled) };
  } catch (error) {
    return { ok: false, reason: refusedFor(error) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function refusedFor(error: unknown): "not-a-file" | "denied" | "unreadable" {
  const code = errnoCode(error);
  if (code === "EISDIR") return "not-a-file";
  return code === "EPERM" || code === "EACCES" ? "denied" : "unreadable";
}
