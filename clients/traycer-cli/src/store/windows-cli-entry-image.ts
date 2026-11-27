import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { hashFileSha256 } from "../installer/sha256";

interface WindowsCliEntryImage {
  readonly path: string;
  readonly sha256: string | null;
}

let entryImage: WindowsCliEntryImage | null = null;

// The entry point imports this before Sentry and command modules. Later
// reads of the pathname can only check this identity.
export function captureWindowsCliEntryImage(): void {
  if (process.platform !== "win32" || entryImage !== null) return;
  const sea: typeof import("node:sea") | undefined =
    process.getBuiltinModule?.("node:sea");
  if (sea?.isSea() !== true) return;
  const path = process.execPath;
  let sha256: string | null = null;
  try {
    const fd = openSync(path, "r");
    try {
      if (fstatSync(fd).isFile()) {
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(128 * 1024);
        for (;;) {
          const size = readSync(fd, buffer, 0, buffer.length, null);
          if (size === 0) break;
          hash.update(buffer.subarray(0, size));
        }
        sha256 = hash.digest("hex");
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    sha256 = null;
  }
  entryImage = { path, sha256 };
}

export function windowsCliEntryImage(): WindowsCliEntryImage | null {
  return entryImage;
}

export function isWindowsCliEntryPath(path: string): boolean {
  return (
    entryImage !== null &&
    resolve(path).toLowerCase() === resolve(entryImage.path).toLowerCase()
  );
}

export async function windowsCliEntryImageMatches(
  path: string,
): Promise<boolean> {
  const digest = entryImage?.sha256;
  return (
    typeof digest === "string" &&
    (await hashFileSha256(path, null).catch(() => null)) === digest
  );
}

captureWindowsCliEntryImage();
