import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newTempNonce, ownedTempNonces } from "../byte-evidence";
import type { MigrationId } from "@traycer/protocol/config/data-migration-contracts";
import {
  assertSourceUnchanged,
  contentInventoryPath,
  diffSourceAgainstInventory,
  freezeContentInventory,
  identityFileHashes,
  inventoryTempPath,
  loadContentInventory,
  measureSource,
  migrationEvidenceDir,
  parseInventoryTempName,
  storeContentInventory,
  underRoot,
  type ContentInventory,
} from "../content-inventory";
import {
  buildSourceTree,
  captureStop,
  HOST_ID_FILE,
  NOTES_FILE,
  PROVIDER_FILE,
  scratchScope,
  stopCodes,
} from "./engine-fixtures";

const MIGRATION_ID: MigrationId = "m-00000000-0000-4000-8000-000000000001";
const NOW = (): string => "2026-01-01T00:00:00.000Z";
const PROVIDER_ROOT = "host/harness-accounts/claude/p1";
const WRONG_DIGEST = `sha256:${"0".repeat(64)}`;

describe.skipIf(process.platform === "win32")("content inventory", () => {
  const scratch = scratchScope();

  async function frozenSource(): Promise<{
    readonly sourceRoot: string;
    readonly destinationRoot: string;
    readonly inventory: ContentInventory;
    readonly fileCount: number;
    readonly byteCount: number;
  }> {
    const base = await scratch.create();
    const sourceRoot = join(base, "source");
    const destinationRoot = join(base, "destination");
    await mkdir(sourceRoot);
    await mkdir(destinationRoot);
    const tree = await buildSourceTree(sourceRoot);
    const inventory = await freezeContentInventory({
      sourceRoot,
      migrationId: MIGRATION_ID,
      providerRoots: [PROVIDER_ROOT],
      signal: new AbortController().signal,
    });
    return {
      sourceRoot,
      destinationRoot,
      inventory,
      fileCount: tree.fileCount,
      byteCount: tree.byteCount,
    };
  }

  describe("freeze", () => {
    it("lists every folder before its children with exact counts, sizes and hashes", async () => {
      const { inventory, fileCount, byteCount } = await frozenSource();
      expect(inventory.header).toMatchObject({
        format: "traycer-content-inventory",
        version: 1,
        migrationId: MIGRATION_ID,
        providerRoots: [PROVIDER_ROOT],
        fileCount,
        byteCount,
      });
      const dirs = inventory.entries.filter((entry) => entry.kind === "dir");
      expect(inventory.header.dirCount).toBe(dirs.length);
      expect(inventory.entries).toHaveLength(fileCount + dirs.length);
      const index = new Map(
        inventory.entries.map((entry, position) => [entry.path, position]),
      );
      for (const entry of inventory.entries) {
        const slash = entry.path.lastIndexOf("/");
        if (slash < 0) continue;
        const parent = entry.path.slice(0, slash);
        expect(index.get(parent), `parent of ${entry.path}`).toBeLessThan(
          index.get(entry.path) ?? -1,
        );
      }
      const names = inventory.entries.map((entry) => entry.path);
      expect(names).toContain("empty-dir");
      expect(names).toContain("notes/ünïcode-文件.txt");
      expect(names).toContain(NOTES_FILE);
      const file = inventory.entries.find(
        (entry) => entry.path === HOST_ID_FILE,
      );
      expect(file).toMatchObject({
        kind: "file",
        size: "host-0001\n".length,
        mode: 0o600,
      });
      expect(
        file !== undefined && file.kind === "file" ? file.sha256 : "",
      ).toMatch(/^[0-9a-f]{64}$/u);
    });

    it("sorts the provider roots it records", async () => {
      const { sourceRoot } = await frozenSource();
      const inventory = await freezeContentInventory({
        sourceRoot,
        migrationId: MIGRATION_ID,
        providerRoots: ["z/root", "a/root"],
        signal: new AbortController().signal,
      });
      expect(inventory.header.providerRoots).toEqual(["a/root", "z/root"]);
    });

    it("stops blocked, naming the entry, when the source holds a symbolic link", async () => {
      const base = await scratch.create();
      const sourceRoot = join(base, "source");
      await mkdir(sourceRoot);
      await buildSourceTree(sourceRoot);
      await symlink(join(sourceRoot, "notes"), join(sourceRoot, "a-link"));
      const stop = await captureStop(
        freezeContentInventory({
          sourceRoot,
          migrationId: MIGRATION_ID,
          providerRoots: [],
          signal: new AbortController().signal,
        }),
      );
      expect(stop.reason).toBe("blocked");
      expect(stopCodes(stop)).toEqual(["unsupported-entry"]);
      expect(stop.blockers[0]?.object).toBe("a-link");
    });

    it("stops failed/cancelled when the signal is already aborted", async () => {
      const base = await scratch.create();
      const sourceRoot = join(base, "source");
      await mkdir(sourceRoot);
      await buildSourceTree(sourceRoot);
      const controller = new AbortController();
      controller.abort();
      const stop = await captureStop(
        freezeContentInventory({
          sourceRoot,
          migrationId: MIGRATION_ID,
          providerRoots: [],
          signal: controller.signal,
        }),
      );
      expect(stop.reason).toBe("failed");
      expect(stopCodes(stop)).toEqual(["cancelled"]);
    });
  });

  describe("store and load", () => {
    it("round-trips the inventory under the destination's evidence folder and returns its digest", async () => {
      const { destinationRoot, inventory } = await frozenSource();
      const digest = await storeContentInventory({
        destinationRoot,
        inventory,
        now: NOW,
        platform: process.platform,
      });
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      const loaded = await loadContentInventory({
        destinationRoot,
        migrationId: MIGRATION_ID,
        digest,
      });
      expect(loaded.digest).toBe(digest);
      expect(loaded.header).toEqual(inventory.header);
      expect(loaded.entries).toEqual(inventory.entries);
      expect(contentInventoryPath(destinationRoot, MIGRATION_ID)).toContain(
        ".traycer-relocation",
      );
    });

    it("storing the same inventory twice is idempotent and leaves no temp file", async () => {
      const { destinationRoot, inventory } = await frozenSource();
      const first = await storeContentInventory({
        destinationRoot,
        inventory,
        now: NOW,
        platform: process.platform,
      });
      const second = await storeContentInventory({
        destinationRoot,
        inventory,
        now: NOW,
        platform: process.platform,
      });
      expect(second).toBe(first);
      const evidenceDir = join(
        contentInventoryPath(destinationRoot, MIGRATION_ID),
        "..",
      );
      // The inventory and the ownership records; no temp.
      expect((await readdir(evidenceDir)).sort()).toEqual([
        "content-inventory.jsonl",
        "owned-temps",
      ]);
      // Each store recorded its own nonce before writing its temp.
      expect((await ownedTempNonces(evidenceDir)).size).toBe(2);
    });

    it("records an inventory nonce durably before the temp it names exists", async () => {
      const { destinationRoot, inventory } = await frozenSource();
      await storeContentInventory({
        destinationRoot,
        inventory,
        now: NOW,
        platform: process.platform,
      });
      const evidenceDir = migrationEvidenceDir(destinationRoot, MIGRATION_ID);
      const [nonce] = [...(await ownedTempNonces(evidenceDir))];
      expect(nonce).toMatch(/^[0-9a-f]{32}$/u);
      const record = JSON.parse(
        await readFile(join(evidenceDir, "owned-temps", nonce ?? ""), "utf8"),
      );
      expect(record).toEqual({
        nonce,
        purpose: "inventory",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(await readdir(evidenceDir)).not.toContain(
        `content-inventory.jsonl.${nonce}.tmp`,
      );
    });

    it("refuses a digest the journal did not pin (conflict, inventory-mismatch)", async () => {
      const { destinationRoot, inventory } = await frozenSource();
      await storeContentInventory({
        destinationRoot,
        inventory,
        now: NOW,
        platform: process.platform,
      });
      const stop = await captureStop(
        loadContentInventory({
          destinationRoot,
          migrationId: MIGRATION_ID,
          digest: WRONG_DIGEST,
        }),
      );
      expect(stop.reason).toBe("conflict");
      expect(stopCodes(stop)).toEqual(["inventory-mismatch"]);
    });

    it("refuses an inventory file that was edited after it was pinned", async () => {
      const { destinationRoot, inventory } = await frozenSource();
      const digest = await storeContentInventory({
        destinationRoot,
        inventory,
        now: NOW,
        platform: process.platform,
      });
      await appendFile(
        contentInventoryPath(destinationRoot, MIGRATION_ID),
        "{}\n",
      );
      const stop = await captureStop(
        loadContentInventory({
          destinationRoot,
          migrationId: MIGRATION_ID,
          digest,
        }),
      );
      expect(stop.reason).toBe("conflict");
      expect(stopCodes(stop)).toEqual(["inventory-mismatch"]);
    });

    it("stops failed when the inventory file is missing (inventory-missing)", async () => {
      const { destinationRoot } = await frozenSource();
      const stop = await captureStop(
        loadContentInventory({
          destinationRoot,
          migrationId: MIGRATION_ID,
          digest: WRONG_DIGEST,
        }),
      );
      expect(stop.reason).toBe("failed");
      expect(stopCodes(stop)).toEqual(["inventory-missing"]);
    });
  });

  describe("inventory temp names", () => {
    it("inventoryTempPath appends <nonce>.tmp to the inventory file", () => {
      const nonce = newTempNonce();
      expect(inventoryTempPath("/e/content-inventory.jsonl", nonce)).toBe(
        `/e/content-inventory.jsonl.${nonce}.tmp`,
      );
    });

    it("parseInventoryTempName returns the nonce, and null for any other name", () => {
      const nonce = newTempNonce();
      expect(
        parseInventoryTempName(`content-inventory.jsonl.${nonce}.tmp`),
      ).toBe(nonce);
      expect(parseInventoryTempName("content-inventory.jsonl")).toBeNull();
      expect(
        parseInventoryTempName(`content-inventory.jsonl.${nonce}`),
      ).toBeNull();
      expect(
        parseInventoryTempName("content-inventory.jsonl.not-a-nonce.tmp"),
      ).toBeNull();
      expect(parseInventoryTempName(`other.jsonl.${nonce}.tmp`)).toBeNull();
    });
  });

  describe("diffSourceAgainstInventory", () => {
    const signal = new AbortController().signal;

    it("reports nothing for an untouched source", async () => {
      const { sourceRoot, inventory } = await frozenSource();
      expect(
        await diffSourceAgainstInventory({
          sourceRoot,
          inventory,
          limit: 50,
          signal,
        }),
      ).toEqual([]);
      await assertSourceUnchanged({ sourceRoot, inventory, signal });
    });

    it("detects an added file and an added folder", async () => {
      const { sourceRoot, inventory } = await frozenSource();
      await writeFile(join(sourceRoot, "added.txt"), "new");
      await mkdir(join(sourceRoot, "added-dir"));
      const differences = await diffSourceAgainstInventory({
        sourceRoot,
        inventory,
        limit: 50,
        signal,
      });
      expect(differences).toEqual(
        expect.arrayContaining([
          { path: "added.txt", change: "added" },
          { path: "added-dir", change: "added" },
        ]),
      );
      expect(differences).toHaveLength(2);
    });

    it("detects a removed file", async () => {
      const { sourceRoot, inventory } = await frozenSource();
      await unlink(underRoot(sourceRoot, "deep/a/b/c/d.txt"));
      expect(
        await diffSourceAgainstInventory({
          sourceRoot,
          inventory,
          limit: 50,
          signal,
        }),
      ).toEqual([{ path: "deep/a/b/c/d.txt", change: "removed" }]);
    });

    it("detects a modified file", async () => {
      const { sourceRoot, inventory } = await frozenSource();
      await appendFile(underRoot(sourceRoot, NOTES_FILE), "more");
      expect(
        await diffSourceAgainstInventory({
          sourceRoot,
          inventory,
          limit: 50,
          signal,
        }),
      ).toEqual([{ path: NOTES_FILE, change: "modified" }]);
    });

    it("detects a file replaced by a folder as a type change", async () => {
      const { sourceRoot, inventory } = await frozenSource();
      await rm(underRoot(sourceRoot, "deep/a/b/c/d.txt"));
      await mkdir(underRoot(sourceRoot, "deep/a/b/c/d.txt"));
      expect(
        await diffSourceAgainstInventory({
          sourceRoot,
          inventory,
          limit: 50,
          signal,
        }),
      ).toEqual([{ path: "deep/a/b/c/d.txt", change: "type-changed" }]);
    });

    it("never reports more than the limit", async () => {
      const { sourceRoot, inventory } = await frozenSource();
      for (const name of ["one", "two", "three"])
        await writeFile(join(sourceRoot, name), name);
      expect(
        await diffSourceAgainstInventory({
          sourceRoot,
          inventory,
          limit: 2,
          signal,
        }),
      ).toHaveLength(2);
    });

    it("assertSourceUnchanged stops conflict with one blocker per difference", async () => {
      const { sourceRoot, inventory } = await frozenSource();
      await appendFile(underRoot(sourceRoot, PROVIDER_FILE), "{}\n");
      await writeFile(join(sourceRoot, "extra.txt"), "x");
      const stop = await captureStop(
        assertSourceUnchanged({ sourceRoot, inventory, signal }),
      );
      expect(stop.reason).toBe("conflict");
      expect(stopCodes(stop).sort()).toEqual([
        "source-added",
        "source-modified",
      ]);
    });
  });

  describe("measureSource", () => {
    it("sums file bytes without hashing or freezing", async () => {
      const { sourceRoot, byteCount } = await frozenSource();
      const measured = await measureSource({
        sourceRoot,
        signal: new AbortController().signal,
      });
      expect(measured.byteCount).toBe(byteCount);
      expect(measured.blockers).toEqual([]);
    });

    it("names a symbolic link as a blocker and keeps counting", async () => {
      const { sourceRoot, byteCount } = await frozenSource();
      await symlink(join(sourceRoot, "notes"), join(sourceRoot, "a-link"));
      const measured = await measureSource({
        sourceRoot,
        signal: new AbortController().signal,
      });
      expect(measured.byteCount).toBe(byteCount);
      expect(measured.blockers.map((blocker) => blocker.code)).toEqual([
        "unsupported-entry",
      ]);
      expect(measured.blockers[0]?.object).toBe("a-link");
    });
  });

  describe("identityFileHashes", () => {
    it("returns the identity files in key order, null for one the inventory lacks", async () => {
      const { sourceRoot, inventory } = await frozenSource();
      const hashes = identityFileHashes(inventory, [
        HOST_ID_FILE,
        "machine/missing-id",
      ]);
      expect(hashes.map((entry) => entry.storeKey)).toEqual([
        HOST_ID_FILE,
        "machine/missing-id",
      ]);
      const bytes = await readFile(underRoot(sourceRoot, HOST_ID_FILE));
      expect(hashes[0]?.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(hashes[1]?.sha256).toBeNull();
    });
  });
});
