import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  migrationIdSchema,
  type MigrationId,
  type Sha256Digest,
} from "@traycer/protocol/config/data-migration-contracts";
import { isErrnoException } from "../../runner/errors";
import {
  isTempNonce,
  newTempNonce,
  recordOwnedTempNonce,
} from "./byte-evidence";
import { EngineStop, engineBlocker, type EngineBlocker } from "./engine-types";

/**
 * The frozen CONTENT inventory of a quiesced source root: every folder and
 * regular file with its metadata and SHA-256, taken after quiescence and
 * before the first byte is copied.
 *
 * It is a different thing from the journal's `inventoryDigest`, which is the
 * host maintenance role's store MANIFEST (what each store is and what its
 * adapter will do). This one is the evidence that copy verification, every
 * later "source unchanged" revalidation and explicit source cleanup compare
 * against. Its bytes are stored in the destination's evidence folder and its
 * SHA-256 is pinned in `journal.copyManifest.digest`; a load that does not
 * reproduce the digest is refused.
 *
 * The walk never follows a link: a symbolic link, junction or any other
 * non-regular, non-folder entry is a named blocker (the design forbids
 * silently omitting or following them). Paths are root-relative with `/`.
 */

export const RELOCATION_EVIDENCE_DIRNAME = ".traycer-relocation";
const INVENTORY_FILENAME = "content-inventory.jsonl";
const INVENTORY_VERSION = 1;

const fileEntrySchema = z.strictObject({
  kind: z.literal("file"),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  mtimeNs: z.string().regex(/^\d+$/u),
  ctimeNs: z.string().regex(/^\d+$/u),
  dev: z.string().min(1),
  ino: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
const dirEntrySchema = z.strictObject({
  kind: z.literal("dir"),
  path: z.string().min(1),
  mode: z.number().int().nonnegative(),
});
const entrySchema = z.discriminatedUnion("kind", [
  fileEntrySchema,
  dirEntrySchema,
]);
export type ContentFileEntry = z.infer<typeof fileEntrySchema>;
export type ContentDirEntry = z.infer<typeof dirEntrySchema>;
export type ContentEntry = z.infer<typeof entrySchema>;

const headerSchema = z.strictObject({
  format: z.literal("traycer-content-inventory"),
  version: z.literal(INVENTORY_VERSION),
  migrationId: migrationIdSchema,
  /**
   * Root-relative folders holding provider-native bytes (managed provider
   * profile folders). Cleanup requires their destination copies byte-equal.
   */
  providerRoots: z.array(z.string().min(1)),
  fileCount: z.number().int().nonnegative(),
  dirCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative(),
});
export type ContentInventoryHeader = z.infer<typeof headerSchema>;

export type ContentInventory = {
  readonly header: ContentInventoryHeader;
  /** In walk order: every folder before its children; sorted by name per folder. */
  readonly entries: readonly ContentEntry[];
};

export type LoadedContentInventory = ContentInventory & {
  readonly digest: Sha256Digest;
};

export function contentInventoryPath(
  destinationRoot: string,
  migrationId: MigrationId,
): string {
  return join(
    destinationRoot,
    RELOCATION_EVIDENCE_DIRNAME,
    "migrations",
    migrationId,
    INVENTORY_FILENAME,
  );
}

/** The temp an inventory write uses, and its parser (nonce or null). */
export function inventoryTempPath(
  inventoryFile: string,
  nonce: string,
): string {
  return `${inventoryFile}.${nonce}.tmp`;
}

export function parseInventoryTempName(name: string): string | null {
  const prefix = `${INVENTORY_FILENAME}.`;
  if (!name.startsWith(prefix) || !name.endsWith(".tmp")) return null;
  const nonce = name.slice(prefix.length, -".tmp".length);
  return isTempNonce(nonce) ? nonce : null;
}

/** The evidence folder this migration owns inside the destination. */
export function migrationEvidenceDir(
  destinationRoot: string,
  migrationId: MigrationId,
): string {
  return join(
    destinationRoot,
    RELOCATION_EVIDENCE_DIRNAME,
    "migrations",
    migrationId,
  );
}

/** Native spelling of a root-relative inventory path under `root`. */
export function underRoot(root: string, relative: string): string {
  return join(root, ...relative.split("/"));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return hash.digest("hex");
}

function fileFacts(
  stats: BigIntStats,
): Omit<ContentFileEntry, "kind" | "path" | "sha256"> {
  return {
    size: Number(stats.size),
    mode: Number(stats.mode & 0o7777n),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
    dev: String(stats.dev),
    ino: String(stats.ino),
  };
}

function sameFacts(
  left: Omit<ContentFileEntry, "kind" | "path" | "sha256">,
  right: Omit<ContentFileEntry, "kind" | "path" | "sha256">,
): boolean {
  return (
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

type WalkVisit =
  | { readonly kind: "dir"; readonly path: string; readonly stats: BigIntStats }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly stats: BigIntStats;
    }
  | {
      readonly kind: "unsupported";
      readonly path: string;
      readonly what: string;
    };

/**
 * Depth-first walk in sorted order, folders before their children. Never
 * follows links. `visit` sees every entry below `root` (not `root` itself).
 */
async function walk(
  root: string,
  visit: (entry: WalkVisit) => Promise<void> | void,
  signal: AbortSignal,
): Promise<void> {
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relative = stack.pop() ?? "";
    const names = (
      await readdir(relative.length === 0 ? root : underRoot(root, relative))
    ).sort();
    const childDirs: string[] = [];
    for (const name of names) {
      if (signal.aborted) throw cancelled();
      const childRelative =
        relative.length === 0 ? name : `${relative}/${name}`;
      const stats = await lstat(underRoot(root, childRelative), {
        bigint: true,
      });
      if (stats.isSymbolicLink()) {
        await visit({
          kind: "unsupported",
          path: childRelative,
          what: "a symbolic link or junction",
        });
      } else if (stats.isDirectory()) {
        await visit({ kind: "dir", path: childRelative, stats });
        childDirs.push(childRelative);
      } else if (stats.isFile()) {
        await visit({ kind: "file", path: childRelative, stats });
      } else {
        await visit({
          kind: "unsupported",
          path: childRelative,
          what: "a special file (socket, pipe or device)",
        });
      }
    }
    // Reversed onto the stack so folders are visited in sorted order.
    for (const dir of childDirs.reverse()) stack.push(dir);
  }
}

function cancelled(): EngineStop {
  return new EngineStop(
    "failed",
    [engineBlocker("cancelled", null, "the migration was cancelled")],
    null,
  );
}

/**
 * Freeze the quiesced source. A file whose metadata changes while it is
 * hashed is a writer that quiescence missed: the freeze stops `blocked`.
 */
export async function freezeContentInventory(input: {
  readonly sourceRoot: string;
  readonly migrationId: MigrationId;
  readonly providerRoots: readonly string[];
  readonly signal: AbortSignal;
}): Promise<ContentInventory> {
  const entries: ContentEntry[] = [];
  const blockers: EngineBlocker[] = [];
  let byteCount = 0;
  let fileCount = 0;
  let dirCount = 0;
  await walk(
    input.sourceRoot,
    async (visit) => {
      if (visit.kind === "unsupported") {
        blockers.push(
          engineBlocker(
            "unsupported-entry",
            visit.path,
            `the data folder contains ${visit.what}, which the migration does not follow or omit`,
          ),
        );
        return;
      }
      if (visit.kind === "dir") {
        entries.push({
          kind: "dir",
          path: visit.path,
          mode: Number(visit.stats.mode & 0o7777n),
        });
        dirCount += 1;
        return;
      }
      const absolute = underRoot(input.sourceRoot, visit.path);
      const before = fileFacts(visit.stats);
      const sha256 = await sha256File(absolute);
      const after = fileFacts(await lstat(absolute, { bigint: true }));
      if (!sameFacts(before, after)) {
        blockers.push(
          engineBlocker(
            "source-changing",
            visit.path,
            "a file in the data folder changed while it was being read",
          ),
        );
        return;
      }
      entries.push({ kind: "file", path: visit.path, sha256, ...before });
      byteCount += before.size;
      fileCount += 1;
    },
    input.signal,
  );
  if (blockers.length > 0) throw new EngineStop("blocked", blockers, null);
  return {
    header: {
      format: "traycer-content-inventory",
      version: INVENTORY_VERSION,
      migrationId: input.migrationId,
      providerRoots: [...input.providerRoots].sort(),
      fileCount,
      dirCount,
      byteCount,
    },
    entries,
  };
}

/**
 * Read-only size measurement of a live source for a dry run: file bytes and
 * the entries the copy would refuse. Nothing is hashed or frozen.
 */
export async function measureSource(input: {
  readonly sourceRoot: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly byteCount: number;
  readonly blockers: readonly EngineBlocker[];
}> {
  let byteCount = 0;
  const blockers: EngineBlocker[] = [];
  await walk(
    input.sourceRoot,
    (visit) => {
      if (visit.kind === "file") byteCount += Number(visit.stats.size);
      if (visit.kind === "unsupported") {
        blockers.push(
          engineBlocker(
            "unsupported-entry",
            visit.path,
            `the data folder contains ${visit.what}, which the migration does not follow or omit`,
          ),
        );
      }
    },
    input.signal,
  );
  return { byteCount, blockers };
}

function encodeInventory(inventory: ContentInventory): Buffer {
  const lines = [JSON.stringify(headerSchema.parse(inventory.header))];
  for (const entry of inventory.entries)
    lines.push(JSON.stringify(entrySchema.parse(entry)));
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function digestOf(bytes: Buffer): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Persist the inventory in the destination's evidence folder (temp, flush,
 * rename) and return the digest the journal pins. The temp's nonce is
 * recorded as the migration's before the temp exists, so an interrupted write
 * can later be proven the migration's own (`byte-evidence.ts`).
 */
export async function storeContentInventory(input: {
  readonly destinationRoot: string;
  readonly inventory: ContentInventory;
  readonly now: () => string;
  readonly platform: NodeJS.Platform;
}): Promise<Sha256Digest> {
  const bytes = encodeInventory(input.inventory);
  const migrationId = input.inventory.header.migrationId;
  const path = contentInventoryPath(input.destinationRoot, migrationId);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const nonce = newTempNonce();
  await recordOwnedTempNonce({
    evidenceDir: migrationEvidenceDir(input.destinationRoot, migrationId),
    nonce,
    purpose: "inventory",
    createdAt: input.now(),
    platform: input.platform,
  });
  const tmp = inventoryTempPath(path, nonce);
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return digestOf(bytes);
}

/**
 * Load the inventory and prove it is the one the journal pinned. A missing
 * file or a different digest refuses: nothing that depends on the frozen
 * source can proceed on unverified evidence.
 */
export async function loadContentInventory(input: {
  readonly destinationRoot: string;
  readonly migrationId: MigrationId;
  readonly digest: Sha256Digest;
}): Promise<LoadedContentInventory> {
  const path = contentInventoryPath(input.destinationRoot, input.migrationId);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      throw new EngineStop(
        "failed",
        [
          engineBlocker(
            "inventory-missing",
            path,
            "the migration's source inventory is not available in the destination",
          ),
        ],
        null,
      );
    }
    throw error;
  }
  if (digestOf(bytes) !== input.digest) {
    throw new EngineStop(
      "conflict",
      [
        engineBlocker(
          "inventory-mismatch",
          path,
          "the migration's source inventory does not match the journal",
        ),
      ],
      null,
    );
  }
  const lines = bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  const header = headerSchema.parse(JSON.parse(lines[0] ?? "null"));
  if (header.migrationId !== input.migrationId) {
    throw new EngineStop(
      "conflict",
      [
        engineBlocker(
          "inventory-mismatch",
          path,
          "the source inventory names another migration",
        ),
      ],
      null,
    );
  }
  const entries = lines
    .slice(1)
    .map((line) => entrySchema.parse(JSON.parse(line)));
  return { header, entries, digest: input.digest };
}

/**
 * The stop codes for a source that no longer matches its frozen inventory.
 * The frozen inventory never matches again, so the move cannot continue
 * forward: rollback is the way out.
 */
export const SOURCE_CHANGED_CODES: ReadonlySet<string> = new Set([
  "source-added",
  "source-removed",
  "source-modified",
  "source-type-changed",
]);

/** What the person is told on a `SOURCE_CHANGED_CODES` stop. */
export const SOURCE_CHANGED_GUIDANCE =
  "the old Traycer folder changed during the move; close the programs using it, including any opened as administrator, then run `traycer data recover --rollback` and start the move again";

export type SourceDifference = {
  readonly path: string;
  readonly change: "added" | "removed" | "modified" | "type-changed";
};

/**
 * Re-walk the source and compare it with the frozen inventory by metadata
 * (size, mode, mtime and ctime in nanoseconds, device, inode). Any write,
 * replace, addition or removal changes one of them; reading does not. Returns
 * at most `limit` differences.
 */
export async function diffSourceAgainstInventory(input: {
  readonly sourceRoot: string;
  readonly inventory: ContentInventory;
  readonly limit: number;
  readonly signal: AbortSignal;
}): Promise<readonly SourceDifference[]> {
  const expected = new Map<string, ContentEntry>();
  for (const entry of input.inventory.entries) expected.set(entry.path, entry);
  const seen = new Set<string>();
  const differences: SourceDifference[] = [];
  const note = (difference: SourceDifference): void => {
    if (differences.length < input.limit) differences.push(difference);
  };
  await walk(
    input.sourceRoot,
    (visit) => {
      seen.add(visit.path);
      const frozen = expected.get(visit.path);
      if (frozen === undefined) {
        note({ path: visit.path, change: "added" });
        return;
      }
      if (visit.kind === "unsupported" || visit.kind !== frozen.kind) {
        note({ path: visit.path, change: "type-changed" });
        return;
      }
      if (visit.kind === "dir" || frozen.kind === "dir") return;
      if (!sameFacts(fileFacts(visit.stats), frozen))
        note({ path: visit.path, change: "modified" });
    },
    input.signal,
  );
  for (const path of expected.keys()) {
    if (!seen.has(path)) note({ path, change: "removed" });
  }
  return differences;
}

/** Stops `conflict` when the source no longer matches its frozen inventory. */
export async function assertSourceUnchanged(input: {
  readonly sourceRoot: string;
  readonly inventory: ContentInventory;
  readonly signal: AbortSignal;
}): Promise<void> {
  const differences = await diffSourceAgainstInventory({ ...input, limit: 20 });
  if (differences.length === 0) return;
  throw new EngineStop(
    "conflict",
    differences.map((difference) =>
      engineBlocker(
        `source-${difference.change}`,
        difference.path,
        SOURCE_CHANGED_GUIDANCE,
      ),
    ),
    null,
  );
}

/** Digest over the preserved identity files (machine/host/device ids, identity and auth folders). */
export function identityFileHashes(
  inventory: ContentInventory,
  identityStoreKeys: readonly string[],
): readonly { readonly storeKey: string; readonly sha256: string | null }[] {
  const byPath = new Map<string, ContentEntry>();
  for (const entry of inventory.entries) byPath.set(entry.path, entry);
  return [...identityStoreKeys].sort().map((storeKey) => {
    const entry = byPath.get(storeKey);
    return { storeKey, sha256: entry?.kind === "file" ? entry.sha256 : null };
  });
}
