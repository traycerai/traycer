import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  MigrationId,
  MigrationJournal,
} from "@traycer/protocol/config/data-migration-contracts";
import { MIGRATION_COORDINATOR_LOCK_FILENAME } from "@traycer/protocol/config/data-migration-admission";
import {
  newTempNonce,
  ownedTempNonces,
  recordOwnedTempNonce,
} from "../byte-evidence";
import { migrationEvidenceDir, underRoot } from "../content-inventory";
import { copyTempPath } from "../copy-engine";
import { rollbackMigration, startMigration } from "../migration-engine";
import { cleanupSource, discardRolledBackDestination } from "../source-cleanup";
import {
  assertDone,
  assertStopped,
  blockerCodes,
  contentTree,
  CrashError,
  crashAtCheckpoint,
  expectRolledBack,
  factTree,
  harnessScope,
  NOTES_FILE,
  pathExists,
  PROVIDER_FILE,
  readActiveJournal,
  readLocation,
  runToCompletion,
  type EngineHarness,
  type StoppedResult,
} from "./engine-fixtures";

const UNKNOWN_MIGRATION: MigrationId = "m-00000000-0000-4000-8000-0000000000aa";

describe.skipIf(process.platform === "win32")(
  "source cleanup",
  { timeout: 120_000 },
  () => {
    const scope = harnessScope();

    async function completed(): Promise<{
      readonly harness: EngineHarness;
      readonly journal: MigrationJournal;
    }> {
      const harness = await scope.create();
      return { harness, journal: await runToCompletion(harness) };
    }

    async function allSourceFilesExist(
      harness: EngineHarness,
    ): Promise<boolean> {
      for (const path of harness.tree.filePaths) {
        if (!(await pathExists(underRoot(harness.sourceRoot, path))))
          return false;
      }
      return true;
    }

    describe("cleanupSource", () => {
      it("removes the source root, finishes the journal and leaves the destination and bootstrap records alone", async () => {
        const { harness, journal } = await completed();
        const destinationBefore = await contentTree(
          harness.destinationRoot,
          () => false,
        );
        const locationBefore = await readFile(
          join(harness.bootstrapDir, "location.json"),
          "utf8",
        );

        const done = assertDone(
          await cleanupSource(harness.makeDestinationDeps({}), {
            migrationId: journal.id,
          }),
        );

        expect(done.phase).toBe("complete");
        expect(done.cleanupProgress).toEqual({
          removedEntries: done.copyManifest?.entryCount ?? -1,
          removedBytes: harness.tree.byteCount,
          finished: true,
        });
        expect(await pathExists(harness.sourceRoot)).toBe(false);
        expect(await contentTree(harness.destinationRoot, () => false)).toEqual(
          destinationBefore,
        );
        expect(
          await readFile(join(harness.bootstrapDir, "location.json"), "utf8"),
        ).toBe(locationBefore);
        expect(readActiveJournal(harness.bootstrapDir)).toEqual(done);
        expect(readLocation(harness.bootstrapDir)?.root).toBe(
          harness.destinationRoot,
        );
        expect(harness.gate().kind).toBe("open");
      });

      it("is idempotent: a finished cleanup reports done again without touching anything", async () => {
        const { harness, journal } = await completed();
        const first = assertDone(
          await cleanupSource(harness.makeDestinationDeps({}), {
            migrationId: journal.id,
          }),
        );
        const second = assertDone(
          await cleanupSource(harness.makeDestinationDeps({}), {
            migrationId: journal.id,
          }),
        );
        expect(second).toEqual(first);
      });

      it("keeps working when the destination's own non-provider files changed after the migration", async () => {
        const { harness, journal } = await completed();
        await appendFile(
          underRoot(harness.destinationRoot, NOTES_FILE),
          "the user kept working in the new folder\n",
        );
        assertDone(
          await cleanupSource(harness.makeDestinationDeps({}), {
            migrationId: journal.id,
          }),
        );
        expect(await pathExists(harness.sourceRoot)).toBe(false);
      });

      describe("refusals delete nothing", () => {
        it("refuses to run from the source folder (cleanup-not-from-destination)", async () => {
          const { harness, journal } = await completed();
          const result = assertStopped(
            await cleanupSource(harness.makeDeps({}), {
              migrationId: journal.id,
            }),
          );
          expect(result.reason).toBe("blocked");
          expect(blockerCodes(result)).toEqual([
            "cleanup-not-from-destination",
          ]);
          expect(result.journal?.phase).toBe("complete");
          expect(await factTree(harness.sourceRoot)).toEqual(
            harness.initial.facts,
          );
        });

        it("refuses before the migration activated, and for a migration that does not exist", async () => {
          const harness = await scope.create();
          const crash = crashAtCheckpoint({
            target: "after-journal:switched",
            occurrence: 1,
            normalize: harness.normalizeCheckpoint,
          });
          await expect(
            startMigration(harness.makeDeps({ checkpoint: crash.checkpoint }), {
              destination: harness.destinationRoot,
              acceptedSessionImpactDigest: null,
              reviewImpact: false,
            }),
          ).rejects.toBeInstanceOf(CrashError);
          const journal = readActiveJournal(harness.bootstrapDir);
          const early = assertStopped(
            await cleanupSource(harness.makeDestinationDeps({}), {
              migrationId: journal.id,
            }),
          );
          expect(early.reason).toBe("blocked");
          expect(blockerCodes(early)).toEqual(["cleanup-not-activated"]);
          expect(await factTree(harness.sourceRoot)).toEqual(
            harness.initial.facts,
          );

          const unknown = assertStopped(
            await cleanupSource(harness.makeDestinationDeps({}), {
              migrationId: UNKNOWN_MIGRATION,
            }),
          );
          expect(blockerCodes(unknown)).toEqual(["journal-missing"]);
        });

        it("refuses when a source file was modified after the migration", async () => {
          const { harness, journal } = await completed();
          await appendFile(
            underRoot(harness.sourceRoot, NOTES_FILE),
            "edited after the move\n",
          );
          const result = assertStopped(
            await cleanupSource(harness.makeDestinationDeps({}), {
              migrationId: journal.id,
            }),
          );
          expect(result.reason).toBe("conflict");
          expect(blockerCodes(result)).toEqual(["source-modified"]);
          expect(result.blockers[0]?.object).toBe(NOTES_FILE);
          expect(result.journal?.phase).toBe("complete");
          expect(await allSourceFilesExist(harness)).toBe(true);
        });

        it("refuses when a new file or folder appeared in the source", async () => {
          const { harness, journal } = await completed();
          await writeFile(join(harness.sourceRoot, "new-file.txt"), "not ours");
          await mkdir(join(harness.sourceRoot, "new-dir"));
          const result = assertStopped(
            await cleanupSource(harness.makeDestinationDeps({}), {
              migrationId: journal.id,
            }),
          );
          expect(result.reason).toBe("conflict");
          expect(blockerCodes(result)).toEqual([
            "source-added",
            "source-added",
          ]);
          expect(
            result.blockers.map((blocker) => blocker.object).sort(),
          ).toEqual(["new-dir", "new-file.txt"]);
          expect(result.journal?.phase).toBe("complete");
          expect(await allSourceFilesExist(harness)).toBe(true);
        });

        it("refuses when a source file was removed before cleanup started", async () => {
          const { harness, journal } = await completed();
          await unlink(underRoot(harness.sourceRoot, "deep/a/b/c/d.txt"));
          const result = assertStopped(
            await cleanupSource(harness.makeDestinationDeps({}), {
              migrationId: journal.id,
            }),
          );
          expect(result.reason).toBe("conflict");
          expect(blockerCodes(result)).toEqual(["source-removed"]);
          expect(result.journal?.phase).toBe("complete");
        });

        it("keeps the source backup when the destination's provider file no longer matches it", async () => {
          const { harness, journal } = await completed();
          const live = underRoot(harness.destinationRoot, PROVIDER_FILE);
          await appendFile(
            live,
            '{"turn":3,"text":"written live by the provider"}\n',
          );
          const result = assertStopped(
            await cleanupSource(harness.makeDestinationDeps({}), {
              migrationId: journal.id,
            }),
          );
          expect(result.reason).toBe("blocked");
          expect(blockerCodes(result)).toEqual(["provider-bytes-not-retained"]);
          expect(result.blockers[0]?.object).toBe(PROVIDER_FILE);
          expect(await factTree(harness.sourceRoot)).toEqual(
            harness.initial.facts,
          );
          expect(
            (await readFile(live, "utf8")).endsWith(
              'written live by the provider"}\n',
            ),
          ).toBe(true);
        });

        it("keeps the source backup when the destination's provider file is gone", async () => {
          const { harness, journal } = await completed();
          await unlink(underRoot(harness.destinationRoot, PROVIDER_FILE));
          const result = assertStopped(
            await cleanupSource(harness.makeDestinationDeps({}), {
              migrationId: journal.id,
            }),
          );
          expect(blockerCodes(result)).toEqual(["provider-bytes-not-retained"]);
          expect(await factTree(harness.sourceRoot)).toEqual(
            harness.initial.facts,
          );
        });

        it("cleanup refuses a corrupt coordinator lock with the never-taken-over message", async () => {
          const { harness, journal } = await completed();
          await writeFile(
            join(harness.bootstrapDir, MIGRATION_COORDINATOR_LOCK_FILENAME),
            "{ torn",
            { mode: 0o600 },
          );
          const result = assertStopped(
            await cleanupSource(harness.makeDestinationDeps({}), {
              migrationId: journal.id,
            }),
          );
          expect(blockerCodes(result)).toEqual(["coordinator-corrupt"]);
          expect(result.blockers[0]?.message).toContain(
            "never taken over automatically",
          );
          expect(await allSourceFilesExist(harness)).toBe(true);
        });
      });

      describe("interruption", () => {
        it.each(["before-cleanup-delete", "after-cleanup-delete"])(
          "a crash at %s is finished by the next run",
          async (point) => {
            const { harness, journal } = await completed();
            const crash = crashAtCheckpoint({
              target: point,
              occurrence: 1,
              normalize: harness.normalizeCheckpoint,
            });
            await expect(
              cleanupSource(
                harness.makeDestinationDeps({ checkpoint: crash.checkpoint }),
                { migrationId: journal.id },
              ),
            ).rejects.toBeInstanceOf(CrashError);
            expect(readActiveJournal(harness.bootstrapDir).phase).toBe(
              "cleaning",
            );
            expect(await pathExists(harness.sourceRoot)).toBe(true);

            const destinationBefore = await contentTree(
              harness.destinationRoot,
              () => false,
            );
            const done = assertDone(
              await cleanupSource(harness.makeDestinationDeps({}), {
                migrationId: journal.id,
              }),
            );
            expect(done.phase).toBe("complete");
            expect(done.cleanupProgress?.finished).toBe(true);
            expect(await pathExists(harness.sourceRoot)).toBe(false);
            expect(
              await contentTree(harness.destinationRoot, () => false),
            ).toEqual(destinationBefore);
          },
        );

        it("cancellation stops failed with progress recorded, and the next run finishes", async () => {
          const { harness, journal } = await completed();
          const controller = new AbortController();
          let deleted = 0;
          const stopped = assertStopped(
            await cleanupSource(
              harness.makeDestinationDeps({
                signal: controller.signal,
                checkpoint: (point) => {
                  if (point === "after-cleanup-delete") {
                    deleted += 1;
                    if (deleted === 3) controller.abort();
                  }
                  return Promise.resolve();
                },
              }),
              { migrationId: journal.id },
            ),
          );
          expect(stopped.reason).toBe("failed");
          expect(blockerCodes(stopped)).toEqual(["cancelled"]);
          expect(stopped.journal?.phase).toBe("cleaning");
          expect(stopped.journal?.cleanupProgress?.finished).toBe(false);
          expect(
            stopped.journal?.cleanupProgress?.removedEntries,
          ).toBeGreaterThanOrEqual(3);

          const done = assertDone(
            await cleanupSource(harness.makeDestinationDeps({}), {
              migrationId: journal.id,
            }),
          );
          expect(done.cleanupProgress?.finished).toBe(true);
          expect(await pathExists(harness.sourceRoot)).toBe(false);
        });

        it("stops conflict, keeping the new file, when something is added to a source folder mid-cleanup", async () => {
          const { harness, journal } = await completed();
          let deleted = 0;
          const result = assertStopped(
            await cleanupSource(
              harness.makeDestinationDeps({
                checkpoint: async (point) => {
                  if (point === "after-cleanup-delete") {
                    deleted += 1;
                    if (deleted === 1)
                      await writeFile(
                        underRoot(harness.sourceRoot, "notes/added-late.txt"),
                        "late",
                      );
                  }
                },
              }),
              { migrationId: journal.id },
            ),
          );
          expect(result.reason).toBe("conflict");
          expect(blockerCodes(result)).toEqual(["source-added"]);
          expect(result.blockers[0]?.object).toBe("notes");
          expect(
            await readFile(
              underRoot(harness.sourceRoot, "notes/added-late.txt"),
              "utf8",
            ),
          ).toBe("late");
          expect(result.journal?.phase).toBe("cleaning");
          expect(await pathExists(harness.sourceRoot)).toBe(true);
        });

        it("a source file modified in place while cleanup hashes it is kept and stops source-modified", async () => {
          const { harness, journal } = await completed();
          // The checkpoint cannot see which file is next, so every seeded file
          // is overwritten in place with the same size and different bytes.
          const rewritten = new Map<string, Buffer>();
          let fired = false;
          const result = assertStopped(
            await cleanupSource(
              harness.makeDestinationDeps({
                checkpoint: async (point) => {
                  if (point !== "before-cleanup-delete" || fired) return;
                  fired = true;
                  for (const path of harness.tree.filePaths) {
                    const absolute = underRoot(harness.sourceRoot, path);
                    const bytes = Buffer.from(await readFile(absolute));
                    bytes[0] = bytes[0] === 0x7a ? 0x79 : 0x7a;
                    rewritten.set(path, bytes);
                    await writeFile(absolute, bytes);
                  }
                },
              }),
              { migrationId: journal.id },
            ),
          );
          expect(fired).toBe(true);
          expect(result.reason).toBe("conflict");
          expect(blockerCodes(result)).toEqual(["source-modified"]);
          const kept = result.blockers[0]?.object ?? "";
          const expected = rewritten.get(kept);
          if (expected === undefined)
            throw new Error("the blocker names no seeded file");
          expect(await readFile(underRoot(harness.sourceRoot, kept))).toEqual(
            expected,
          );
          // Including the file whose delete was pending at the checkpoint:
          // nothing rewritten is deleted.
          for (const [path, bytes] of rewritten) {
            expect(await readFile(underRoot(harness.sourceRoot, path))).toEqual(
              bytes,
            );
          }
          expect(result.journal?.phase).toBe("cleaning");
        });
      });
    });

    describe("discardRolledBackDestination", () => {
      /** Halted after the repair receipt was mirrored (copy and receipt file exist), then rolled back. */
      async function rolledBackFromRepairing(): Promise<{
        readonly harness: EngineHarness;
        readonly journal: MigrationJournal;
      }> {
        const harness = await scope.create();
        const crash = crashAtCheckpoint({
          target: "after-receipt-mirror",
          occurrence: 1,
          normalize: harness.normalizeCheckpoint,
        });
        await expect(
          startMigration(harness.makeDeps({ checkpoint: crash.checkpoint }), {
            destination: harness.destinationRoot,
            acceptedSessionImpactDigest: null,
            reviewImpact: false,
          }),
        ).rejects.toBeInstanceOf(CrashError);
        const journal = assertDone(
          await rollbackMigration(harness.makeDeps({})),
        );
        await expectRolledBack(harness, journal, harness.initial);
        return { harness, journal };
      }

      /** Halted in the middle of copying (some files copied, none repaired), then rolled back. */
      async function rolledBackFromCopying(): Promise<{
        readonly harness: EngineHarness;
        readonly journal: MigrationJournal;
      }> {
        const harness = await scope.create();
        const crash = crashAtCheckpoint({
          target: "after-copy-file",
          occurrence: 2,
          normalize: harness.normalizeCheckpoint,
        });
        await expect(
          startMigration(harness.makeDeps({ checkpoint: crash.checkpoint }), {
            destination: harness.destinationRoot,
            acceptedSessionImpactDigest: null,
            reviewImpact: false,
          }),
        ).rejects.toBeInstanceOf(CrashError);
        const journal = assertDone(
          await rollbackMigration(harness.makeDeps({})),
        );
        await expectRolledBack(harness, journal, harness.initial);
        return { harness, journal };
      }

      const sessionImpactFile = (journal: MigrationJournal): string =>
        `host/relocation/session-impact-${journal.id}.json`;

      async function copiedPaths(harness: EngineHarness): Promise<string[]> {
        const present: string[] = [];
        for (const path of harness.tree.filePaths) {
          if (await pathExists(underRoot(harness.destinationRoot, path)))
            present.push(path);
        }
        return present;
      }

      async function discard(
        harness: EngineHarness,
        journal: MigrationJournal,
      ): Promise<StoppedResult> {
        return assertStopped(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );
      }

      it("rolled back from copying: removes the copied files, the evidence and the empty destination folder", async () => {
        const { harness, journal } = await rolledBackFromCopying();
        expect((await copiedPaths(harness)).length).toBeGreaterThan(0);

        const done = assertDone(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );

        expect(done.phase).toBe("rolled-back");
        expect(await pathExists(harness.destinationRoot)).toBe(false);
        expect(await factTree(harness.sourceRoot)).toEqual(
          harness.initial.facts,
        );
        expect(readActiveJournal(harness.bootstrapDir)).toEqual(journal);
        expect(harness.gate()).toEqual({ kind: "open", generation: null });
      });

      it("rolled back from repairing: removes the plain copies but RETAINS the repaired store, stopped/blocked", async () => {
        const { harness, journal } = await rolledBackFromRepairing();
        const repaired = underRoot(
          harness.destinationRoot,
          sessionImpactFile(journal),
        );
        expect(
          await pathExists(underRoot(harness.destinationRoot, NOTES_FILE)),
        ).toBe(true);
        expect(await pathExists(repaired)).toBe(true);

        const result = await discard(harness, journal);

        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["discard-repaired-store"]);
        expect(result.blockers[0]?.object).toBe(sessionImpactFile(journal));
        expect(await pathExists(repaired)).toBe(true);
        // The plain copies are gone; the evidence stays while anything is retained.
        expect(
          await pathExists(underRoot(harness.destinationRoot, NOTES_FILE)),
        ).toBe(false);
        expect(
          await pathExists(underRoot(harness.destinationRoot, "deep")),
        ).toBe(false);
        expect(
          await pathExists(
            join(harness.destinationRoot, ".traycer-relocation"),
          ),
        ).toBe(true);
        expect(await pathExists(harness.destinationRoot)).toBe(true);
      });

      it("once the person removes a retained store, the next discard finishes (idempotent convergence)", async () => {
        const { harness, journal } = await rolledBackFromRepairing();
        await discard(harness, journal);
        await unlink(
          underRoot(harness.destinationRoot, sessionImpactFile(journal)),
        );
        assertDone(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );
        expect(await pathExists(harness.destinationRoot)).toBe(false);
        // A destination that is already gone is discarded.
        assertDone(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );
      });

      it("a repaired store edited and back-dated before the rollback is still retained (no mtime rule)", async () => {
        const { harness, journal } = await rolledBackFromRepairing();
        const repaired = underRoot(
          harness.destinationRoot,
          sessionImpactFile(journal),
        );
        await appendFile(repaired, "edited by a person\n");
        const longAgo = new Date("2000-01-01T00:00:00.000Z");
        await utimes(repaired, longAgo, longAgo);
        const result = await discard(harness, journal);
        expect(blockerCodes(result)).toEqual(["discard-repaired-store"]);
        expect(await readFile(repaired, "utf8")).toContain(
          "edited by a person",
        );
      });

      it("a modified copy whose mtime was restored with utimes is retained (discard-modified)", async () => {
        const { harness, journal } = await rolledBackFromCopying();
        const [first] = await copiedPaths(harness);
        if (first === undefined)
          throw new Error("nothing was copied before the halt");
        const path = underRoot(harness.destinationRoot, first);
        const before = await stat(path);
        const bytes = await readFile(path);
        const changed = Buffer.from(bytes);
        changed[0] = changed[0] === 0x61 ? 0x62 : 0x61;
        await writeFile(path, changed);
        await utimes(path, before.atime, before.mtime);

        const result = await discard(harness, journal);

        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["discard-modified"]);
        expect(result.blockers[0]?.object).toBe(first);
        expect(await readFile(path)).toEqual(changed);
      });

      it("retains and reports a file a third party added (discard-unknown), deleting only what is provably the migration's", async () => {
        const { harness, journal } = await rolledBackFromCopying();
        const theirs = underRoot(harness.destinationRoot, "third-party.txt");
        await writeFile(theirs, "not the migration's");

        const result = await discard(harness, journal);

        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["discard-unknown"]);
        expect(result.blockers[0]?.object).toBe("third-party.txt");
        expect(await readFile(theirs, "utf8")).toBe("not the migration's");
        expect(await copiedPaths(harness)).toEqual([]);
        expect(
          await pathExists(
            join(harness.destinationRoot, ".traycer-relocation"),
          ),
        ).toBe(true);

        await unlink(theirs);
        assertDone(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );
        expect(await pathExists(harness.destinationRoot)).toBe(false);
      });

      it("an unrelated file with a matching temp name and an unrecorded nonce is retained (discard-temp-unproven)", async () => {
        const { harness, journal } = await rolledBackFromCopying();
        const target = NOTES_FILE;
        const temp = copyTempPath(
          underRoot(harness.destinationRoot, target),
          journal.id,
          newTempNonce(),
        );
        await mkdir(join(temp, ".."), { recursive: true });
        // Even bytes that are a prefix of the source do not make an unrecorded nonce the migration's.
        await writeFile(
          temp,
          (await readFile(underRoot(harness.sourceRoot, target))).subarray(
            0,
            3,
          ),
        );

        const result = await discard(harness, journal);

        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["discard-temp-unproven"]);
        expect(await pathExists(temp)).toBe(true);
      });

      it("rolled back from copying with an interrupted temp: a recorded nonce and prefix bytes are proven and removed", async () => {
        const { harness, journal } = await rolledBackFromCopying();
        const [nonce] = [
          ...(await ownedTempNonces(
            migrationEvidenceDir(harness.destinationRoot, journal.id),
          )),
        ];
        if (nonce === undefined) throw new Error("the copy recorded no nonce");
        const copied = await copiedPaths(harness);
        const pending = harness.tree.filePaths.find(
          (path) => !copied.includes(path),
        );
        if (pending === undefined)
          throw new Error("every file was copied before the halt");
        const temp = copyTempPath(
          underRoot(harness.destinationRoot, pending),
          journal.id,
          nonce,
        );
        await mkdir(join(temp, ".."), { recursive: true });
        const source = await readFile(underRoot(harness.sourceRoot, pending));
        await writeFile(
          temp,
          source.subarray(0, Math.max(1, Math.floor(source.length / 2))),
        );

        assertDone(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );

        expect(await pathExists(temp)).toBe(false);
        expect(await pathExists(harness.destinationRoot)).toBe(false);
      });

      it("a recorded-nonce temp with bytes that are not a prefix is retained, and so are two temps sharing one nonce", async () => {
        const { harness, journal } = await rolledBackFromCopying();
        const [nonce] = [
          ...(await ownedTempNonces(
            migrationEvidenceDir(harness.destinationRoot, journal.id),
          )),
        ];
        if (nonce === undefined) throw new Error("the copy recorded no nonce");
        const wrong = copyTempPath(
          underRoot(harness.destinationRoot, NOTES_FILE),
          journal.id,
          nonce,
        );
        await mkdir(join(wrong, ".."), { recursive: true });
        await writeFile(wrong, "definitely not the source bytes");
        const first = await discard(harness, journal);
        expect(blockerCodes(first)).toEqual(["discard-temp-unproven"]);
        expect(await pathExists(wrong)).toBe(true);

        // A second temp with the same nonce makes BOTH unprovable, even with prefix bytes.
        const second = copyTempPath(
          underRoot(harness.destinationRoot, "deep/a/b/c/d.txt"),
          journal.id,
          nonce,
        );
        await mkdir(join(second, ".."), { recursive: true });
        await writeFile(second, "");
        await writeFile(wrong, "");
        const both = await discard(harness, journal);
        expect(blockerCodes(both)).toEqual([
          "discard-temp-unproven",
          "discard-temp-unproven",
        ]);
        expect(await pathExists(wrong)).toBe(true);
        expect(await pathExists(second)).toBe(true);
      });

      it("an interrupted discard converges: copies removed by hand beforehand do not matter, and a rerun is idempotent", async () => {
        const { harness, journal } = await rolledBackFromCopying();
        const copied = await copiedPaths(harness);
        for (const path of copied.slice(0, 1))
          await unlink(underRoot(harness.destinationRoot, path));
        assertDone(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );
        expect(await pathExists(harness.destinationRoot)).toBe(false);
        assertDone(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );
      });

      it("a retained third-party file blocks the evidence's removal until it is gone, then a rerun converges", async () => {
        const { harness, journal } = await rolledBackFromCopying();
        const theirs = underRoot(harness.destinationRoot, "keep-me.txt");
        await writeFile(theirs, "mine");
        await discard(harness, journal);
        await discard(harness, journal);
        await unlink(theirs);
        assertDone(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );
        expect(await pathExists(harness.destinationRoot)).toBe(false);
      });

      it("evidence with no pinned inventory (rolled back before the copy manifest) stays: discard-evidence-unpinned", async () => {
        const harness = await scope.create();
        // Halt after the inventory is written but before the journal pins it.
        const crash = crashAtCheckpoint({
          target: "before-journal:copying",
          occurrence: 1,
          normalize: harness.normalizeCheckpoint,
        });
        await expect(
          startMigration(harness.makeDeps({ checkpoint: crash.checkpoint }), {
            destination: harness.destinationRoot,
            acceptedSessionImpactDigest: null,
            reviewImpact: false,
          }),
        ).rejects.toBeInstanceOf(CrashError);
        const journal = assertDone(
          await rollbackMigration(harness.makeDeps({})),
        );
        expect(journal.copyManifest).toBeNull();
        expect(
          await pathExists(
            join(harness.destinationRoot, ".traycer-relocation"),
          ),
        ).toBe(true);

        const result = await discard(harness, journal);

        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["discard-evidence-unpinned"]);
        expect(
          await pathExists(
            join(harness.destinationRoot, ".traycer-relocation"),
          ),
        ).toBe(true);
      });

      it("an unknown file in the evidence folder is retained (discard-evidence-unknown)", async () => {
        const { harness, journal } = await rolledBackFromCopying();
        const stray = join(
          migrationEvidenceDir(harness.destinationRoot, journal.id),
          "notes-from-a-person.txt",
        );
        await writeFile(stray, "hello");
        const result = await discard(harness, journal);
        expect(blockerCodes(result)).toEqual(["discard-evidence-unknown"]);
        expect(await readFile(stray, "utf8")).toBe("hello");
        expect(
          await readdir(
            migrationEvidenceDir(harness.destinationRoot, journal.id),
          ),
        ).toContain("content-inventory.jsonl");
      });

      it("extra ownership records are removed last, with the evidence", async () => {
        const { harness, journal } = await rolledBackFromCopying();
        const evidenceDir = migrationEvidenceDir(
          harness.destinationRoot,
          journal.id,
        );
        await recordOwnedTempNonce({
          evidenceDir,
          nonce: newTempNonce(),
          purpose: "copy",
          createdAt: "2026-01-01T00:00:00.000Z",
          platform: process.platform,
        });
        assertDone(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );
        expect(await pathExists(harness.destinationRoot)).toBe(false);
      });

      it("treats a destination that is already gone as discarded", async () => {
        const { harness, journal } = await rolledBackFromCopying();
        assertDone(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );
        assertDone(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );
      });

      it("refuses a migration that is not rolled back", async () => {
        const harness = await scope.create();
        const journal = await runToCompletion(harness);
        const result = await discard(harness, journal);
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["discard-not-rolled-back"]);
        expect(await pathExists(harness.destinationRoot)).toBe(true);
      });

      it("refuses when the destination is the data folder in use", async () => {
        const { harness, journal } = await rolledBackFromCopying();
        const result = assertStopped(
          await discardRolledBackDestination(harness.makeDestinationDeps({}), {
            migrationId: journal.id,
          }),
        );
        expect(result.reason).toBe("conflict");
        expect(blockerCodes(result)).toEqual(["discard-destination-in-use"]);
        expect((await copiedPaths(harness)).length).toBeGreaterThan(0);
      });
    });

    describe("caller preconditions", () => {
      it("cleanupSource refuses (blocked, coordinator-admitted) from a process holding an admission, deleting nothing", async () => {
        const { harness, journal } = await completed();
        await harness.admitThisProcess();
        const result = assertStopped(
          await cleanupSource(harness.makeDestinationDeps({}), {
            migrationId: journal.id,
          }),
        );
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["coordinator-admitted"]);
        expect(await allSourceFilesExist(harness)).toBe(true);
        expect(readActiveJournal(harness.bootstrapDir)).toEqual(journal);
      });

      it("discardRolledBackDestination refuses the same way and removes nothing", async () => {
        const harness = await scope.create();
        const crash = crashAtCheckpoint({
          target: "after-copy-file",
          occurrence: 2,
          normalize: harness.normalizeCheckpoint,
        });
        await expect(
          startMigration(harness.makeDeps({ checkpoint: crash.checkpoint }), {
            destination: harness.destinationRoot,
            acceptedSessionImpactDigest: null,
            reviewImpact: false,
          }),
        ).rejects.toBeInstanceOf(CrashError);
        const journal = assertDone(
          await rollbackMigration(harness.makeDeps({})),
        );
        const before = await contentTree(harness.destinationRoot, () => false);
        await harness.admitThisProcess();
        const result = assertStopped(
          await discardRolledBackDestination(harness.makeDeps({}), {
            migrationId: journal.id,
          }),
        );
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["coordinator-admitted"]);
        expect(await contentTree(harness.destinationRoot, () => false)).toEqual(
          before,
        );
      });
    });
  },
);
