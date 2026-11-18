import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MigrationId } from "@traycer/protocol/config/data-migration-contracts";
import {
  newTempNonce,
  ownedTempNonces,
  recordOwnedTempNonce,
} from "../byte-evidence";
import {
  freezeContentInventory,
  migrationEvidenceDir,
  underRoot,
  type ContentInventory,
} from "../content-inventory";
import {
  copyInventory,
  copyTempPath,
  parseCopyTemp,
  type CopyResult,
} from "../copy-engine";
import type { EngineCheckpoint } from "../engine-types";
import {
  buildSourceTree,
  captureStop,
  contentTree,
  HOST_ID_FILE,
  NOTES_FILE,
  pathExists,
  scratchScope,
  stopCodes,
  type SourceTreeSummary,
} from "./engine-fixtures";

const MIGRATION_ID: MigrationId = "m-00000000-0000-4000-8000-000000000002";
const OTHER_MIGRATION_ID: MigrationId =
  "m-00000000-0000-4000-8000-0000000000ff";
const UNICODE_FILE = "notes/ünïcode-文件.txt";
const LARGE_FILE = "blob/large.bin";

/** The migration's own evidence folder is not part of the copied tree. */
function isEvidence(relative: string): boolean {
  return (
    relative === ".traycer-relocation" ||
    relative.startsWith(".traycer-relocation/")
  );
}

describe.skipIf(process.platform === "win32")(
  "copy engine",
  { timeout: 120_000 },
  () => {
    const scratch = scratchScope();

    type Setup = {
      readonly sourceRoot: string;
      readonly destinationRoot: string;
      readonly inventory: ContentInventory;
      readonly tree: SourceTreeSummary;
    };

    async function setup(): Promise<Setup> {
      const base = await scratch.create();
      const sourceRoot = join(base, "source");
      const destinationRoot = join(base, "destination");
      await mkdir(sourceRoot);
      await mkdir(destinationRoot, { mode: 0o700 });
      const tree = await buildSourceTree(sourceRoot);
      const inventory = await freezeContentInventory({
        sourceRoot,
        migrationId: MIGRATION_ID,
        providerRoots: [],
        signal: new AbortController().signal,
      });
      return { sourceRoot, destinationRoot, inventory, tree };
    }

    type Run = {
      readonly progress: { readonly files: number; readonly bytes: number }[];
      readonly checkpoints: string[];
    };

    async function copy(
      state: Setup,
      options: {
        readonly signal: AbortSignal;
        readonly checkpoint:
          | ((point: EngineCheckpoint) => Promise<void>)
          | null;
        readonly progress:
          | ((files: number, bytes: number) => Promise<void>)
          | null;
      },
    ): Promise<{ readonly result: CopyResult; readonly run: Run }> {
      const run: Run = { progress: [], checkpoints: [] };
      const result = await copyInventory({
        sourceRoot: state.sourceRoot,
        destinationRoot: state.destinationRoot,
        inventory: state.inventory,
        migrationId: MIGRATION_ID,
        platform: process.platform,
        signal: options.signal,
        progressEvery: 2,
        now: () => "2026-01-01T00:00:00.000Z",
        progress: async (files, bytes) => {
          run.progress.push({ files, bytes });
          if (options.progress !== null) await options.progress(files, bytes);
        },
        checkpoint: async (point) => {
          run.checkpoints.push(point);
          if (options.checkpoint !== null) await options.checkpoint(point);
        },
      });
      return { result, run };
    }

    const plain = (): {
      readonly signal: AbortSignal;
      readonly checkpoint: null;
      readonly progress: null;
    } => ({
      signal: new AbortController().signal,
      checkpoint: null,
      progress: null,
    });

    it("copies every file byte for byte, keeping each file's mode and modification time", async () => {
      const state = await setup();
      const { result } = await copy(state, plain());
      expect(result).toEqual({
        verifiedFiles: state.tree.fileCount,
        verifiedBytes: state.tree.byteCount,
      });
      expect(await contentTree(state.destinationRoot, isEvidence)).toEqual(
        await contentTree(state.sourceRoot, () => false),
      );
      const copiedStats = await lstat(
        underRoot(state.destinationRoot, HOST_ID_FILE),
      );
      const sourceStats = await lstat(
        underRoot(state.sourceRoot, HOST_ID_FILE),
      );
      expect(copiedStats.mode & 0o777).toBe(0o600);
      expect(Math.abs(copiedStats.mtimeMs - sourceStats.mtimeMs)).toBeLessThan(
        2,
      );
      expect(
        await pathExists(underRoot(state.destinationRoot, "empty-dir")),
      ).toBe(true);
    });

    it("calls the progress callback every two verified files and once at the end", async () => {
      const state = await setup();
      const { run } = await copy(state, plain());
      expect(run.progress).toHaveLength(
        Math.floor(state.tree.fileCount / 2) + 1,
      );
      const files = run.progress.map((entry) => entry.files);
      expect(files).toEqual([...files].sort((left, right) => left - right));
      expect(run.progress[run.progress.length - 1]).toEqual({
        files: state.tree.fileCount,
        bytes: state.tree.byteCount,
      });
      expect(run.progress[0]?.files).toBe(2);
    });

    it("writes through the after-copy-file checkpoint once per copied file", async () => {
      const state = await setup();
      const { run } = await copy(state, plain());
      expect(
        run.checkpoints.filter((point) => point === "after-copy-file"),
      ).toHaveLength(state.tree.fileCount);
    });

    it("a second run over a finished copy verifies without copying anything again", async () => {
      const state = await setup();
      await copy(state, plain());
      const { result, run } = await copy(state, plain());
      expect(result.verifiedFiles).toBe(state.tree.fileCount);
      expect(
        run.checkpoints.filter((point) => point === "after-copy-file"),
      ).toHaveLength(0);
    });

    describe("resume", () => {
      async function recordNonce(state: Setup): Promise<string> {
        const nonce = newTempNonce();
        await recordOwnedTempNonce({
          evidenceDir: migrationEvidenceDir(
            state.destinationRoot,
            MIGRATION_ID,
          ),
          nonce,
          purpose: "copy",
          createdAt: "2026-01-01T00:00:00.000Z",
          platform: process.platform,
        });
        return nonce;
      }

      async function readSource(
        state: Setup,
        relative: string,
      ): Promise<Buffer> {
        return readFile(underRoot(state.sourceRoot, relative));
      }

      it("removes a truncated temp of a recorded nonce (a prefix of the unchanged source) and finishes the copy", async () => {
        const state = await setup();
        await mkdir(join(state.destinationRoot, "notes"));
        const nonce = await recordNonce(state);
        const notesTemp = copyTempPath(
          underRoot(state.destinationRoot, NOTES_FILE),
          MIGRATION_ID,
          nonce,
        );
        await writeFile(
          notesTemp,
          (await readSource(state, NOTES_FILE)).subarray(0, 4),
        );

        const { result } = await copy(state, plain());

        expect(result.verifiedFiles).toBe(state.tree.fileCount);
        expect(await pathExists(notesTemp)).toBe(false);
        expect(await contentTree(state.destinationRoot, isEvidence)).toEqual(
          await contentTree(state.sourceRoot, () => false),
        );
      });

      it("removes a truncated large-file temp of a recorded nonce", async () => {
        const state = await setup();
        await mkdir(join(state.destinationRoot, "blob"));
        const nonce = await recordNonce(state);
        const largeSource = await readSource(state, LARGE_FILE);
        const largeTemp = copyTempPath(
          underRoot(state.destinationRoot, LARGE_FILE),
          MIGRATION_ID,
          nonce,
        );
        await writeFile(largeTemp, largeSource.subarray(0, 150_000));

        const { result } = await copy(state, plain());

        expect(result.verifiedFiles).toBe(state.tree.fileCount);
        expect(await pathExists(largeTemp)).toBe(false);
        expect(
          await readFile(underRoot(state.destinationRoot, LARGE_FILE)),
        ).toEqual(largeSource);
      });

      it("an empty temp of a recorded nonce is removed", async () => {
        const state = await setup();
        await mkdir(join(state.destinationRoot, "notes"));
        const nonce = await recordNonce(state);
        const temp = copyTempPath(
          underRoot(state.destinationRoot, NOTES_FILE),
          MIGRATION_ID,
          nonce,
        );
        await writeFile(temp, "");
        await copy(state, plain());
        expect(await pathExists(temp)).toBe(false);
      });

      it("crash after the link and before the unlink: the final file is complete beside a full recorded temp, and resume removes the temp", async () => {
        const state = await setup();
        await mkdir(join(state.destinationRoot, "notes"));
        const nonce = await recordNonce(state);
        const finalPath = underRoot(state.destinationRoot, NOTES_FILE);
        const bytes = await readSource(state, NOTES_FILE);
        const temp = copyTempPath(finalPath, MIGRATION_ID, nonce);
        await writeFile(finalPath, bytes);
        await writeFile(temp, bytes);

        const { result } = await copy(state, plain());

        expect(result.verifiedFiles).toBe(state.tree.fileCount);
        expect(await pathExists(temp)).toBe(false);
        expect(await readFile(finalPath)).toEqual(bytes);
      });

      it("records a nonce at the first file copied, in the migration's evidence folder", async () => {
        const state = await setup();
        await copy(state, plain());
        const evidence = migrationEvidenceDir(
          state.destinationRoot,
          MIGRATION_ID,
        );
        expect(evidence).toBe(
          join(
            state.destinationRoot,
            ".traycer-relocation",
            "migrations",
            MIGRATION_ID,
          ),
        );
        const nonces = await ownedTempNonces(evidence);
        expect(nonces.size).toBe(1);
        expect(await readdir(join(evidence, "owned-temps"))).toEqual([
          ...nonces,
        ]);
      });

      it("a run that copies nothing records no new nonce", async () => {
        const state = await setup();
        await copy(state, plain());
        const before = await ownedTempNonces(
          migrationEvidenceDir(state.destinationRoot, MIGRATION_ID),
        );
        await copy(state, plain());
        expect(
          await ownedTempNonces(
            migrationEvidenceDir(state.destinationRoot, MIGRATION_ID),
          ),
        ).toEqual(before);
      });

      it("leaves no copy temp behind after a finished copy (install is link, then unlink)", async () => {
        const state = await setup();
        await copy(state, plain());
        const copied = await contentTree(state.destinationRoot, isEvidence);
        expect(
          [...copied.keys()].filter((path) => path.endsWith(".tmp")),
        ).toEqual([]);
      });

      it("resumes after a cancellation in the middle of the copy and finishes the rest", async () => {
        const state = await setup();
        const controller = new AbortController();
        let copied = 0;
        const stop = await captureStop(
          copy(state, {
            signal: controller.signal,
            progress: null,
            checkpoint: (point) => {
              if (point === "after-copy-file") {
                copied += 1;
                if (copied === 3) controller.abort();
              }
              return Promise.resolve();
            },
          }),
        );
        expect(stop.reason).toBe("failed");
        expect(stopCodes(stop)).toEqual(["cancelled"]);
        const { result, run } = await copy(state, plain());
        expect(result.verifiedFiles).toBe(state.tree.fileCount);
        // The three files already verified are not copied again.
        expect(
          run.checkpoints.filter((point) => point === "after-copy-file"),
        ).toHaveLength(state.tree.fileCount - 3);
        expect(await contentTree(state.destinationRoot, isEvidence)).toEqual(
          await contentTree(state.sourceRoot, () => false),
        );
      });
    });

    describe("refusals", () => {
      it("never merges into a populated destination (conflict, destination-populated), writing nothing", async () => {
        const state = await setup();
        await writeFile(join(state.destinationRoot, "stray.txt"), "not ours");
        const stop = await captureStop(copy(state, plain()));
        expect(stop.reason).toBe("conflict");
        expect(stopCodes(stop)).toEqual(["destination-populated"]);
        expect(stop.blockers[0]?.object).toBe("stray.txt");
        expect(await readdir(state.destinationRoot)).toEqual(["stray.txt"]);
      });

      it("refuses a final file with the wrong bytes (conflict destination-modified) and leaves it untouched", async () => {
        const state = await setup();
        await mkdir(join(state.destinationRoot, "notes"));
        const wrong = underRoot(state.destinationRoot, UNICODE_FILE);
        await writeFile(wrong, "unic");
        const stop = await captureStop(copy(state, plain()));
        expect(stop.reason).toBe("conflict");
        expect(stopCodes(stop)).toEqual(["destination-modified"]);
        expect(stop.blockers[0]?.object).toBe(UNICODE_FILE);
        expect(await readFile(wrong, "utf8")).toBe("unic");
      });

      it("refuses a correct-looking temp whose nonce was never recorded (destination-temp-unproven) and keeps it", async () => {
        const state = await setup();
        await mkdir(join(state.destinationRoot, "notes"));
        const temp = copyTempPath(
          underRoot(state.destinationRoot, NOTES_FILE),
          MIGRATION_ID,
          newTempNonce(),
        );
        await writeFile(temp, "x");
        const stop = await captureStop(copy(state, plain()));
        expect(stop.reason).toBe("conflict");
        expect(stopCodes(stop)).toEqual(["destination-temp-unproven"]);
        expect(await readFile(temp, "utf8")).toBe("x");
      });

      it("refuses a recorded-nonce temp whose bytes are not a prefix of the source", async () => {
        const state = await setup();
        await mkdir(join(state.destinationRoot, "notes"));
        const nonce = newTempNonce();
        await recordOwnedTempNonce({
          evidenceDir: migrationEvidenceDir(
            state.destinationRoot,
            MIGRATION_ID,
          ),
          nonce,
          purpose: "copy",
          createdAt: "2026-01-01T00:00:00.000Z",
          platform: process.platform,
        });
        const temp = copyTempPath(
          underRoot(state.destinationRoot, NOTES_FILE),
          MIGRATION_ID,
          nonce,
        );
        await writeFile(temp, "definitely not the source bytes");
        const stop = await captureStop(copy(state, plain()));
        expect(stop.reason).toBe("conflict");
        expect(stopCodes(stop)).toEqual(["destination-temp-unproven"]);
        expect(await pathExists(temp)).toBe(true);
      });

      it("refuses two temps that carry one nonce, and keeps both", async () => {
        const state = await setup();
        await mkdir(join(state.destinationRoot, "notes"));
        const nonce = newTempNonce();
        await recordOwnedTempNonce({
          evidenceDir: migrationEvidenceDir(
            state.destinationRoot,
            MIGRATION_ID,
          ),
          nonce,
          purpose: "copy",
          createdAt: "2026-01-01T00:00:00.000Z",
          platform: process.platform,
        });
        const first = copyTempPath(
          underRoot(state.destinationRoot, NOTES_FILE),
          MIGRATION_ID,
          nonce,
        );
        const second = copyTempPath(
          underRoot(state.destinationRoot, UNICODE_FILE),
          MIGRATION_ID,
          nonce,
        );
        await writeFile(first, "");
        await writeFile(second, "");
        const stop = await captureStop(copy(state, plain()));
        expect(stop.reason).toBe("conflict");
        expect(stopCodes(stop)).toEqual(["destination-temp-unproven"]);
        expect(await pathExists(first)).toBe(true);
        expect(await pathExists(second)).toBe(true);
      });

      it("refuses another migration's copy temp and a temp of a file the inventory does not hold", async () => {
        const state = await setup();
        await mkdir(join(state.destinationRoot, "notes"));
        await writeFile(
          copyTempPath(
            underRoot(state.destinationRoot, NOTES_FILE),
            OTHER_MIGRATION_ID,
            newTempNonce(),
          ),
          "x",
        );
        const foreign = await captureStop(copy(state, plain()));
        expect(foreign.reason).toBe("conflict");
        expect(stopCodes(foreign)).toEqual(["destination-populated"]);

        const second = await setup();
        await writeFile(
          copyTempPath(
            join(second.destinationRoot, "ghost.txt"),
            MIGRATION_ID,
            newTempNonce(),
          ),
          "x",
        );
        const orphan = await captureStop(copy(second, plain()));
        expect(orphan.reason).toBe("conflict");
        expect(stopCodes(orphan)).toEqual(["destination-populated"]);
      });

      it("stops conflict source-modified when a frozen source file became a symlink (ELOOP)", async () => {
        const state = await setup();
        const path = underRoot(state.sourceRoot, NOTES_FILE);
        await rm(path);
        await symlink(underRoot(state.sourceRoot, HOST_ID_FILE), path);
        const stop = await captureStop(copy(state, plain()));
        expect(stop.reason).toBe("conflict");
        expect(stopCodes(stop)).toEqual(["source-modified"]);
        expect(stop.blockers[0]?.object).toBe(NOTES_FILE);
      });

      it("stops conflict when a source file changed after the freeze, leaving no partial file for it", async () => {
        const state = await setup();
        await appendFile(
          underRoot(state.sourceRoot, "deep/a/b/c/d.txt"),
          "changed after the freeze",
        );
        const stop = await captureStop(copy(state, plain()));
        expect(stop.reason).toBe("conflict");
        expect(stopCodes(stop)).toEqual(["source-modified"]);
        expect(stop.blockers[0]?.object).toBe("deep/a/b/c/d.txt");
        const copied = await contentTree(state.destinationRoot, isEvidence);
        expect(
          [...copied.keys()].filter((path) => path.endsWith(".tmp")),
        ).toEqual([]);
        expect(copied.has("deep/a/b/c/d.txt")).toBe(false);
      });

      it("stops failed/cancelled before copying anything when the signal is already aborted", async () => {
        const state = await setup();
        const controller = new AbortController();
        controller.abort();
        const stop = await captureStop(
          copy(state, {
            signal: controller.signal,
            checkpoint: null,
            progress: null,
          }),
        );
        expect(stop.reason).toBe("failed");
        expect(stopCodes(stop)).toEqual(["cancelled"]);
        expect(await readdir(state.destinationRoot)).toEqual([]);
      });
    });

    describe("I/O failures stop failed and name the code", () => {
      it.each([
        { errno: "ENOSPC", code: "destination-full" },
        { errno: "EDQUOT", code: "destination-full" },
        { errno: "EACCES", code: "access-denied" },
        { errno: "EPERM", code: "access-denied" },
        { errno: "EIO", code: "io-error" },
      ])("maps $errno to $code", async ({ errno, code }) => {
        const state = await setup();
        const failure = Object.assign(new Error("injected"), { code: errno });
        const stop = await captureStop(
          copy(state, {
            signal: new AbortController().signal,
            checkpoint: null,
            progress: () => Promise.reject(failure),
          }),
        );
        expect(stop.reason).toBe("failed");
        expect(stopCodes(stop)).toEqual([code]);
      });

      it("lets an error it does not recognise propagate unchanged", async () => {
        const state = await setup();
        const failure = Object.assign(new Error("something else"), {
          code: "EXDEV",
        });
        await expect(
          copy(state, {
            signal: new AbortController().signal,
            checkpoint: null,
            progress: () => Promise.reject(failure),
          }),
        ).rejects.toBe(failure);
      });
    });

    describe("copy temp names", () => {
      it("copyTempPath is <dest>.traycer-copy-<migration>-<nonce>.tmp", () => {
        expect(
          copyTempPath("/d/notes/a.txt", MIGRATION_ID, "a".repeat(32)),
        ).toBe(
          `/d/notes/a.txt.traycer-copy-${MIGRATION_ID}-${"a".repeat(32)}.tmp`,
        );
      });

      it("parseCopyTemp round-trips and rejects everything else", () => {
        const nonce = newTempNonce();
        expect(
          parseCopyTemp(
            copyTempPath("notes/a.txt", MIGRATION_ID, nonce),
            MIGRATION_ID,
          ),
        ).toEqual({ file: "notes/a.txt", nonce });
        expect(
          parseCopyTemp(
            copyTempPath("notes/a.txt", OTHER_MIGRATION_ID, nonce),
            MIGRATION_ID,
          ),
        ).toBeNull();
        expect(
          parseCopyTemp(
            copyTempPath("notes/a.txt", MIGRATION_ID, "not-a-nonce"),
            MIGRATION_ID,
          ),
        ).toBeNull();
        expect(parseCopyTemp("notes/a.txt", MIGRATION_ID)).toBeNull();
        expect(
          parseCopyTemp(
            `.traycer-copy-${MIGRATION_ID}-${nonce}.tmp`,
            MIGRATION_ID,
          ),
        ).toBeNull();
        expect(
          parseCopyTemp(
            `notes/a.txt.traycer-copy-${MIGRATION_ID}-${nonce}`,
            MIGRATION_ID,
          ),
        ).toBeNull();
      });
    });
  },
);
