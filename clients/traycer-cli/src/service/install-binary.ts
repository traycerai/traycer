import { chmod, copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isErrnoException } from "../runner/errors";

// `stat`-based existence check that swallows ENOENT and rethrows other
// errors. Used by status() and doctor checks.
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return false;
    throw err;
  }
}

// Atomically copy `source` to `destination` via a `<destination>.next`
// staging file + rename. Used by the installer to swap in the host
// binary without ever leaving a half-written executable on disk.
export async function installBinaryAtomically(options: {
  readonly source: string;
  readonly destination: string;
}): Promise<void> {
  await mkdir(dirname(options.destination), { recursive: true });
  const stagingPath = `${options.destination}.next`;
  await copyFile(options.source, stagingPath);
  try {
    await chmod(stagingPath, 0o755);
  } catch {
    // POSIX-only; Windows ACLs handle execution.
  }
  await rename(stagingPath, options.destination);
}

export async function removeBinaryIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return;
    throw err;
  }
}
