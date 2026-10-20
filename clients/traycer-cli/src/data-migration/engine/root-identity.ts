import { lstat } from "node:fs/promises";
import type { CapturedRoot } from "@traycer/protocol/config/data-migration-contracts";
import { isErrnoException } from "../../runner/errors";
import { EngineStop, engineBlocker } from "./engine-types";

/**
 * Root identity capture: the lexical path plus `String(bigint dev)` and
 * `String(bigint ino)` of the folder itself, read with `lstat` so a link at
 * the root's spelling is refused rather than followed. The host's maintenance
 * role compares the same strings before any destination write
 * (`destination-guard.ts`); the engine re-checks them before every phase that
 * writes and at every revalidation, so a remounted or replaced folder at the
 * same spelling is detected rather than trusted.
 */

export async function captureRoot(path: string): Promise<CapturedRoot> {
  const stats = await lstat(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new EngineStop(
      "blocked",
      [
        engineBlocker(
          "root-not-a-folder",
          path,
          "the data folder is not a plain folder",
        ),
      ],
      null,
    );
  }
  return { path, volumeId: String(stats.dev), directoryId: String(stats.ino) };
}

export type RootIdentityCheck =
  | { readonly kind: "same" }
  | { readonly kind: "missing" }
  | { readonly kind: "changed" };

/** Whether the folder at `captured.path` is still the captured folder. */
export async function checkRootIdentity(
  captured: CapturedRoot,
): Promise<RootIdentityCheck> {
  let current: CapturedRoot;
  try {
    current = await captureRoot(captured.path);
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return { kind: "missing" };
    }
    if (error instanceof EngineStop) return { kind: "changed" };
    throw error;
  }
  return current.volumeId === captured.volumeId &&
    current.directoryId === captured.directoryId
    ? { kind: "same" }
    : { kind: "changed" };
}

/** Stops unless the folder is still the captured one. */
export async function assertRootIdentity(
  captured: CapturedRoot,
  role: "source" | "destination",
): Promise<void> {
  const check = await checkRootIdentity(captured);
  if (check.kind === "same") return;
  throw new EngineStop(
    check.kind === "missing" ? "failed" : "conflict",
    [
      engineBlocker(
        check.kind === "missing" ? `${role}-missing` : `${role}-replaced`,
        captured.path,
        check.kind === "missing"
          ? `the ${role} data folder is not available`
          : `the ${role} data folder is not the folder this migration recorded`,
      ),
    ],
    null,
  );
}
