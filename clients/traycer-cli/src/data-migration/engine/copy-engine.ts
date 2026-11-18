import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  unlink,
  utimes,
} from "node:fs/promises";
import type { MigrationId } from "@traycer/protocol/config/data-migration-contracts";
import { isErrnoException } from "../../runner/errors";
import {
  isPrefixOfVerifiedFile,
  unlinkIfUnchanged,
  isTempNonce,
  newTempNonce,
  ownedTempNonces,
  recordOwnedTempNonce,
} from "./byte-evidence";
import {
  migrationEvidenceDir,
  RELOCATION_EVIDENCE_DIRNAME,
  sha256File,
  SOURCE_CHANGED_GUIDANCE,
  underRoot,
  type ContentFileEntry,
  type ContentInventory,
} from "./content-inventory";
import {
  EngineStop,
  engineBlocker,
  type EngineCheckpoint,
} from "./engine-types";

/**
 * Copies a frozen source inventory into the private destination and verifies
 * every file, resumably.
 *
 * - Only inventory entries are written, and only inside the destination. A
 *   destination entry that is neither an inventory path, this migration's
 *   evidence folder nor one of its own proven copy temps refuses before
 *   anything is written: the copy never merges into a populated folder.
 * - Each run records a random temp nonce durably in the evidence folder
 *   before creating any temp. Each file goes to
 *   `<path>.traycer-copy-<migrationId>-<nonce>.tmp` (created exclusively), is
 *   flushed, given the source's times and mode, hard-linked into place (which
 *   never replaces an existing file), unlinked, then read back and hashed.
 * - The source is opened without following links and must still show the
 *   frozen metadata and produce the frozen hash; anything else is a writer
 *   that quiescence missed (`conflict`).
 * - Resuming keeps a final file only when its bytes hash to the frozen digest.
 *   A final file with any other bytes is NOT a state this writer leaves (the
 *   final name only ever receives a complete, verified image), so it refuses
 *   (`destination-modified`) and is never overwritten. A leftover temp is
 *   removed only when its nonce was recorded by this migration AND its bytes
 *   are a prefix of the source file that still hashes to the frozen digest
 *   (`byte-evidence.ts`); otherwise it refuses and stays.
 *
 * Disk full, access denied and cancellation stop `failed`. The source is never
 * written, so it stays the authoritative copy.
 */

const COPY_CHUNK_BYTES = 1024 * 1024;

export function copyTempPath(
  destinationFile: string,
  migrationId: MigrationId,
  nonce: string,
): string {
  return `${destinationFile}${copyTempInfix(migrationId)}${nonce}.tmp`;
}

function copyTempInfix(migrationId: MigrationId): string {
  return `.traycer-copy-${migrationId}-`;
}

/**
 * Parse `relative` as one of this migration's copy temps: the inventory file
 * it belongs to and its nonce, or null for any other name.
 */
export function parseCopyTemp(
  relative: string,
  migrationId: MigrationId,
): { readonly file: string; readonly nonce: string } | null {
  if (!relative.endsWith(".tmp")) return null;
  const infix = copyTempInfix(migrationId);
  const at = relative.lastIndexOf(infix);
  if (at <= 0) return null;
  const nonce = relative.slice(at + infix.length, -".tmp".length);
  return isTempNonce(nonce) ? { file: relative.slice(0, at), nonce } : null;
}

function destinationConflict(
  code: string,
  path: string,
  message: string,
): EngineStop {
  return new EngineStop("conflict", [engineBlocker(code, path, message)], null);
}

/**
 * Whether a leftover temp is provably this migration's interrupted copy of
 * `entry`: a recorded nonce, at most one temp per nonce (the copy is
 * sequential), and bytes that are a prefix of the source image that still
 * hashes to the frozen digest. Shared with the rolled-back discard.
 */
export async function isOwnedCopyTemp(input: {
  readonly tempPath: string;
  readonly sourceFile: string;
  readonly entry: ContentFileEntry;
  readonly nonceRecorded: boolean;
  readonly platform: NodeJS.Platform;
}): Promise<boolean> {
  if (!input.nonceRecorded) return false;
  return isPrefixOfVerifiedFile({
    candidate: input.tempPath,
    reference: input.sourceFile,
    referenceSha256: input.entry.sha256,
    platform: input.platform,
  });
}

export type CopyProgress = (
  verifiedFiles: number,
  verifiedBytes: number,
) => Promise<void>;

function ioStop(error: unknown, object: string): EngineStop | null {
  if (!isErrnoException(error)) return null;
  switch (error.code) {
    case "ENOSPC":
    case "EDQUOT":
      return new EngineStop(
        "failed",
        [
          engineBlocker(
            "destination-full",
            object,
            "the destination drive is full",
          ),
        ],
        null,
      );
    case "EACCES":
    case "EPERM":
      return new EngineStop(
        "failed",
        [engineBlocker("access-denied", object, "access to a file was denied")],
        null,
      );
    // The frozen regular file was replaced by a link (O_NOFOLLOW).
    case "ELOOP":
      return new EngineStop(
        "conflict",
        [engineBlocker("source-modified", object, SOURCE_CHANGED_GUIDANCE)],
        null,
      );
    case "EIO":
    case "ENXIO":
    case "ENODEV":
      return new EngineStop(
        "failed",
        [
          engineBlocker(
            "io-error",
            object,
            "the drive reported an input/output error",
          ),
        ],
        null,
      );
    default:
      return null;
  }
}

async function lstatOrNull(path: string): Promise<BigIntStats | null> {
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

/** A proven copy temp and its metadata as read before the proof. */
type ProvenTemp = { readonly path: string; readonly stats: BigIntStats };

/**
 * Every destination entry must be one the copy owns. Returns the proven copy
 * temps found (left by a crash), which the caller removes; an unproven temp,
 * or any other unknown entry, refuses.
 */
async function auditDestination(input: {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly inventory: ContentInventory;
  readonly migrationId: MigrationId;
  readonly platform: NodeJS.Platform;
}): Promise<readonly ProvenTemp[]> {
  const known = new Map<string, ContentInventory["entries"][number]>();
  for (const entry of input.inventory.entries) known.set(entry.path, entry);
  const evidence = `${RELOCATION_EVIDENCE_DIRNAME}/migrations/${input.migrationId}`;
  const evidenceAncestors = new Set([
    RELOCATION_EVIDENCE_DIRNAME,
    `${RELOCATION_EVIDENCE_DIRNAME}/migrations`,
  ]);
  const nonces = await ownedTempNonces(
    migrationEvidenceDir(input.destinationRoot, input.migrationId),
  );
  const tempsPerNonce = new Map<string, number>();
  const temps: ProvenTemp[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relative = stack.pop() ?? "";
    const dir =
      relative.length === 0
        ? input.destinationRoot
        : underRoot(input.destinationRoot, relative);
    for (const name of await readdir(dir)) {
      const child = relative.length === 0 ? name : `${relative}/${name}`;
      if (child === evidence) continue;
      const stats = await lstat(underRoot(input.destinationRoot, child), {
        bigint: true,
      });
      const entry = known.get(child);
      if (
        stats.isDirectory() &&
        (entry?.kind === "dir" || evidenceAncestors.has(child))
      ) {
        stack.push(child);
        continue;
      }
      // A final image is judged when its turn to copy comes.
      if (stats.isFile() && entry?.kind === "file") continue;
      const temp = stats.isFile()
        ? parseCopyTemp(child, input.migrationId)
        : null;
      const owner = temp === null ? undefined : known.get(temp.file);
      if (temp !== null && owner?.kind === "file") {
        const count = (tempsPerNonce.get(temp.nonce) ?? 0) + 1;
        tempsPerNonce.set(temp.nonce, count);
        const proven =
          count === 1 &&
          (await isOwnedCopyTemp({
            tempPath: underRoot(input.destinationRoot, child),
            sourceFile: underRoot(input.sourceRoot, temp.file),
            entry: owner,
            nonceRecorded: nonces.has(temp.nonce),
            platform: input.platform,
          }));
        if (proven) {
          temps.push({ path: child, stats });
          continue;
        }
        throw destinationConflict(
          "destination-temp-unproven",
          child,
          "the destination holds a copy temp this migration cannot prove it wrote; it is left in place",
        );
      }
      throw destinationConflict(
        "destination-populated",
        child,
        "the destination folder holds an entry this migration did not copy; it never merges into a populated folder",
      );
    }
  }
  return temps;
}

function sameSourceFacts(stats: BigIntStats, entry: ContentFileEntry): boolean {
  return (
    Number(stats.size) === entry.size &&
    Number(stats.mode & 0o7777n) === entry.mode &&
    String(stats.mtimeNs) === entry.mtimeNs &&
    String(stats.ctimeNs) === entry.ctimeNs &&
    String(stats.dev) === entry.dev &&
    String(stats.ino) === entry.ino
  );
}

function sourceChanged(path: string): EngineStop {
  return new EngineStop(
    "conflict",
    [engineBlocker("source-modified", path, SOURCE_CHANGED_GUIDANCE)],
    null,
  );
}

async function copyOneFile(input: {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly entry: ContentFileEntry;
  readonly migrationId: MigrationId;
  readonly nonce: string;
  readonly platform: NodeJS.Platform;
}): Promise<void> {
  const { entry } = input;
  const source = underRoot(input.sourceRoot, entry.path);
  const destination = underRoot(input.destinationRoot, entry.path);
  // Unique per run and per file: exclusive creation below never meets a
  // leftover (the audit removed every proven one and refused the rest).
  const temp = copyTempPath(destination, input.migrationId, input.nonce);
  const readFlags =
    input.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
  const reader = await open(source, readFlags);
  try {
    // A link swapped in after the freeze: the Windows open above follows it,
    // so the handle itself must still be the frozen regular file.
    const opened = await reader.stat({ bigint: true });
    if (!opened.isFile() || !sameSourceFacts(opened, entry))
      throw sourceChanged(entry.path);
    const writer = await open(
      temp,
      "wx",
      input.platform === "win32" ? 0o666 : entry.mode & 0o777,
    );
    const hash = createHash("sha256");
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (;;) {
        const { bytesRead } = await reader.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        let written = 0;
        while (written < bytesRead) {
          const result = await writer.write(
            chunk,
            written,
            bytesRead - written,
            null,
          );
          written += result.bytesWritten;
        }
      }
      await writer.sync();
    } finally {
      await writer.close();
    }
    const after = await reader.stat({ bigint: true });
    if (hash.digest("hex") !== entry.sha256 || !sameSourceFacts(after, entry)) {
      await rm(temp, { force: true });
      throw sourceChanged(entry.path);
    }
  } finally {
    await reader.close();
  }
  const mtimeSeconds = Number(BigInt(entry.mtimeNs) / 1000n) / 1_000_000;
  await utimes(temp, mtimeSeconds, mtimeSeconds);
  // A hard link never replaces an existing final file (EEXIST), so a file
  // created at the final name meanwhile is refused, not overwritten.
  try {
    await link(temp, destination);
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      await rm(temp, { force: true });
      throw destinationConflict(
        "destination-modified",
        entry.path,
        "a file appeared at a path the migration was copying; it is left in place",
      );
    }
    throw error;
  }
  await unlink(temp);
  if ((await sha256File(destination)) !== entry.sha256) {
    throw new EngineStop(
      "failed",
      [
        engineBlocker(
          "copy-mismatch",
          entry.path,
          "a copied file did not read back with the source's bytes",
        ),
      ],
      null,
    );
  }
}

/**
 * The final image at an inventory path: absent (copy it), exactly the frozen
 * bytes (keep it), or anything else (refuse: never overwritten).
 */
async function finalImageState(
  destination: string,
  entry: ContentFileEntry,
): Promise<"absent" | "verified"> {
  const stats = await lstatOrNull(destination);
  if (stats === null) return "absent";
  if (
    stats.isFile() &&
    Number(stats.size) === entry.size &&
    (await sha256File(destination)) === entry.sha256
  )
    return "verified";
  throw destinationConflict(
    "destination-modified",
    entry.path,
    "a file in the destination differs from the source file the migration copied there; it is left in place",
  );
}

export type CopyResult = {
  readonly verifiedFiles: number;
  readonly verifiedBytes: number;
};

/**
 * Copy (or resume copying) `inventory` into the destination. Calls
 * `progress` after every `progressEvery` verified files and once at the end.
 */
export async function copyInventory(input: {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly inventory: ContentInventory;
  readonly migrationId: MigrationId;
  readonly platform: NodeJS.Platform;
  readonly signal: AbortSignal;
  readonly progressEvery: number;
  readonly progress: CopyProgress;
  readonly checkpoint: (point: EngineCheckpoint) => Promise<void>;
  readonly now: () => string;
}): Promise<CopyResult> {
  let verifiedFiles = 0;
  let verifiedBytes = 0;
  let sinceProgress = 0;
  let current = input.destinationRoot;
  try {
    for (const temp of await auditDestination(input)) {
      current = temp.path;
      // Changed since its proof read it: no longer proven, so never deleted.
      if (
        (await unlinkIfUnchanged(
          underRoot(input.destinationRoot, temp.path),
          temp.stats,
        )) === "changed"
      ) {
        throw destinationConflict(
          "destination-temp-unproven",
          temp.path,
          "the destination holds a copy temp this migration cannot prove it wrote; it is left in place",
        );
      }
    }
    let nonce: string | null = null;
    for (const entry of input.inventory.entries) {
      if (input.signal.aborted) {
        throw new EngineStop(
          "failed",
          [engineBlocker("cancelled", null, "the migration was cancelled")],
          null,
        );
      }
      current = entry.path;
      const destination = underRoot(input.destinationRoot, entry.path);
      if (entry.kind === "dir") {
        try {
          await mkdir(destination, {
            mode: input.platform === "win32" ? 0o777 : entry.mode & 0o777,
          });
        } catch (error) {
          if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
          const existing = await lstat(destination);
          if (!existing.isDirectory() || existing.isSymbolicLink()) {
            throw new EngineStop(
              "conflict",
              [
                engineBlocker(
                  "destination-populated",
                  entry.path,
                  "the destination holds a non-folder where a folder belongs",
                ),
              ],
              null,
            );
          }
        }
        continue;
      }
      if ((await finalImageState(destination, entry)) === "absent") {
        if (nonce === null) {
          nonce = newTempNonce();
          await recordOwnedTempNonce({
            evidenceDir: migrationEvidenceDir(
              input.destinationRoot,
              input.migrationId,
            ),
            nonce,
            purpose: "copy",
            createdAt: input.now(),
            platform: input.platform,
          });
        }
        await copyOneFile({ ...input, entry, nonce });
        await input.checkpoint("after-copy-file");
      }
      verifiedFiles += 1;
      verifiedBytes += entry.size;
      sinceProgress += 1;
      if (sinceProgress >= input.progressEvery) {
        sinceProgress = 0;
        await input.progress(verifiedFiles, verifiedBytes);
      }
    }
  } catch (error) {
    if (error instanceof EngineStop) throw error;
    const stop = ioStop(error, current);
    if (stop !== null) throw stop;
    throw error;
  }
  await input.progress(verifiedFiles, verifiedBytes);
  return { verifiedFiles, verifiedBytes };
}
