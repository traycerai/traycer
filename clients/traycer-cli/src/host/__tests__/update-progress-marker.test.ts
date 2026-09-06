import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A genuinely dead pid, established the same way
// `store/__tests__/cli-lock.test.ts` does for its cross-process tests: spawn
// a short-lived real process, wait for it to exit, then use that now-dead
// pid - never a magic number that might collide with an unrelated live
// process on the test machine.
async function deadPid(): Promise<number> {
  const shortLived = spawn("sleep", ["0.1"]);
  const pid = await new Promise<number>((resolve, reject) => {
    shortLived.once("spawn", () => {
      if (shortLived.pid === undefined) {
        reject(new Error("spawned short-lived process has no pid"));
        return;
      }
      resolve(shortLived.pid);
    });
    shortLived.once("error", reject);
  });
  await new Promise<void>((resolve) =>
    shortLived.once("exit", () => resolve()),
  );
  return pid;
}

// The update-progress marker is the cross-process handoff the host daemon
// polls after spawning `traycer host update` detached (it does not wait
// for the process). This suite exercises the real filesystem contract
// against a sandboxed HOME, mirroring the pattern `host-restart-finalize
// .test.ts` uses - `store/paths` resolves `homedir()` once at module load,
// so each test re-points HOME and drops the module cache.

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-update-progress-test-"));
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
  rmSync(workHome, { recursive: true, force: true });
});

describe("update-progress-marker", () => {
  it("writes the marker at hostHomeDir/update-progress.json with state 'updating'", async () => {
    const { writeUpdateProgressMarker } =
      await import("../update-progress-marker");
    const { hostUpdateProgressMarkerPath } = await import("../../store/paths");
    await writeUpdateProgressMarker("production", {
      state: "updating",
      error: null,
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:00:00.000Z",
      writerId: "writer-a",
    });
    const raw = readFileSync(
      hostUpdateProgressMarkerPath("production"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual({
      state: "updating",
      error: null,
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:00:00.000Z",
      writerId: "writer-a",
    });
  });

  it("rewrites the marker with state 'failed' and an error string on confirmed failure", async () => {
    const { writeUpdateProgressMarker, readUpdateProgressMarker } =
      await import("../update-progress-marker");
    await writeUpdateProgressMarker("production", {
      state: "updating",
      error: null,
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:00:00.000Z",
      writerId: "writer-a",
    });
    await writeUpdateProgressMarker("production", {
      state: "failed",
      error: "host process (pid 123) is not alive",
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:01:00.000Z",
      writerId: "writer-a",
    });
    const progress = await readUpdateProgressMarker("production");
    expect(progress).toEqual({
      state: "failed",
      error: "host process (pid 123) is not alive",
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:01:00.000Z",
      writerId: "writer-a",
    });
  });

  it("deletes the marker on confirmed success, leaving nothing behind", async () => {
    const {
      writeUpdateProgressMarker,
      deleteUpdateProgressMarker,
      readUpdateProgressMarker,
    } = await import("../update-progress-marker");
    await writeUpdateProgressMarker("production", {
      state: "updating",
      error: null,
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:00:00.000Z",
      writerId: "writer-a",
    });
    await deleteUpdateProgressMarker("production");
    expect(await readUpdateProgressMarker("production")).toBeNull();
  });

  it("keeps prod and dev markers isolated", async () => {
    const { writeUpdateProgressMarker, readUpdateProgressMarker } =
      await import("../update-progress-marker");
    await writeUpdateProgressMarker("production", {
      state: "updating",
      error: null,
      targetVersion: "1.0.0",
      updatedAt: "2026-07-03T00:00:00.000Z",
      writerId: "writer-a",
    });
    await writeUpdateProgressMarker("dev", {
      state: "failed",
      error: "boom",
      targetVersion: "2.0.0",
      updatedAt: "2026-07-03T00:00:00.000Z",
      writerId: "writer-b",
    });
    expect((await readUpdateProgressMarker("production"))?.state).toBe(
      "updating",
    );
    expect((await readUpdateProgressMarker("dev"))?.state).toBe("failed");
  });

  it("readUpdateProgressMarker returns null when no marker has ever been written", async () => {
    const { readUpdateProgressMarker } =
      await import("../update-progress-marker");
    expect(await readUpdateProgressMarker("production")).toBeNull();
  });

  it("a marker written without a writerId (older CLI) reads back with writerId null", async () => {
    const { readUpdateProgressMarker } =
      await import("../update-progress-marker");
    const { hostUpdateProgressMarkerPath } = await import("../../store/paths");
    const path = hostUpdateProgressMarkerPath("production");
    mkdirSync(dirname(path), { recursive: true });
    const legacyRecord = {
      state: "updating" as const,
      error: null,
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:00:00.000Z",
    };
    writeFileSync(path, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
    expect(await readUpdateProgressMarker("production")).toEqual({
      ...legacyRecord,
      writerId: null,
    });
  });

  it("progressRecord stamps the process identity and two records from this process share it", async () => {
    const { progressRecord, sameProgress } =
      await import("../update-progress-marker");
    const a = progressRecord({
      state: "updating",
      error: null,
      targetVersion: "1.4.0",
    });
    const b = progressRecord({
      state: "updating",
      error: null,
      targetVersion: "1.4.0",
    });
    expect(a.writerId).toMatch(/^\d+-[0-9a-f]{12}$/);
    expect(b.writerId).toBe(a.writerId);
    expect(sameProgress(a, { ...a, writerId: "someone-else" })).toBe(false);
  });

  // Shared by the delete and replace conditional-swap suites: both back
  // `host update`'s marker reconciliation with the same compare-and-swap
  // primitive, and a scratch (`.reconcile-`) or staging (`.tmp-`) leftover in
  // either direction is the same kind of bug.
  const failed = {
    state: "failed" as const,
    error: "host did not become healthy",
    targetVersion: "1.4.0",
    updatedAt: "2026-07-03T00:00:00.000Z",
    writerId: "writer-a",
  };

  function scratchAndStagingFiles(): string[] {
    const dir = join(workHome, ".traycer", "host");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ENOENT"
      ) {
        return [];
      }
      throw err;
    }
    return names.filter(
      (name) => name.includes(".reconcile-") || name.includes(".tmp-"),
    );
  }

  // The conditional delete backs `host update`'s stale-failure reconcile: it
  // decided from a marker it READ, and another updater can replace that
  // marker with a live `updating` before the unlink. Deleting unconditionally
  // there would erase the legacy path's only progress signal.
  describe("deleteUpdateProgressMarkerIfUnchanged", () => {
    it("clears the marker when it still reads exactly as expected", async () => {
      const {
        writeUpdateProgressMarker,
        readUpdateProgressMarker,
        deleteUpdateProgressMarkerIfUnchanged,
      } = await import("../update-progress-marker");
      await writeUpdateProgressMarker("production", failed);
      expect(
        await deleteUpdateProgressMarkerIfUnchanged("production", failed),
      ).toBe("cleared");
      expect(await readUpdateProgressMarker("production")).toBeNull();
    });

    it("leaves a marker that changed underneath - a live `updating` written by another updater survives", async () => {
      const {
        writeUpdateProgressMarker,
        readUpdateProgressMarker,
        deleteUpdateProgressMarkerIfUnchanged,
      } = await import("../update-progress-marker");
      await writeUpdateProgressMarker("production", failed);
      // The race: between the caller's read and its delete, another updater
      // replaced the marker.
      await writeUpdateProgressMarker("production", {
        state: "updating",
        error: null,
        targetVersion: "1.5.0",
        updatedAt: "2026-07-03T00:00:01.000Z",
        writerId: "writer-b",
      });
      expect(
        await deleteUpdateProgressMarkerIfUnchanged("production", failed),
      ).toBe("changed");
      // Restored byte-for-byte, and the scratch the compare-and-delete took
      // it through is gone.
      expect(await readUpdateProgressMarker("production")).toEqual({
        state: "updating",
        error: null,
        targetVersion: "1.5.0",
        updatedAt: "2026-07-03T00:00:01.000Z",
        writerId: "writer-b",
      });
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("leaves no scratch behind on the cleared path either", async () => {
      const {
        writeUpdateProgressMarker,
        deleteUpdateProgressMarkerIfUnchanged,
      } = await import("../update-progress-marker");
      await writeUpdateProgressMarker("production", failed);
      await deleteUpdateProgressMarkerIfUnchanged("production", failed);
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("reports absent when there is no marker to clear", async () => {
      const { deleteUpdateProgressMarkerIfUnchanged } =
        await import("../update-progress-marker");
      expect(
        await deleteUpdateProgressMarkerIfUnchanged("production", failed),
      ).toBe("absent");
    });

    it("does not clear a byte-identical record written by ANOTHER writer in the same millisecond", async () => {
      const {
        writeUpdateProgressMarker,
        readUpdateProgressMarker,
        deleteUpdateProgressMarkerIfUnchanged,
      } = await import("../update-progress-marker");
      const theirRecord = { ...failed, writerId: "writer-b" };
      await writeUpdateProgressMarker("production", theirRecord);
      expect(
        await deleteUpdateProgressMarkerIfUnchanged("production", {
          ...theirRecord,
          writerId: "writer-a",
        }),
      ).toBe("changed");
      expect(await readUpdateProgressMarker("production")).toEqual(theirRecord);
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("restores via the wx fallback when link fails for a reason other than EEXIST", async () => {
      vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("node:fs/promises")>();
        return {
          ...actual,
          link: async () => {
            throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          },
        };
      });
      try {
        const {
          writeUpdateProgressMarker,
          readUpdateProgressMarker,
          deleteUpdateProgressMarkerIfUnchanged,
        } = await import("../update-progress-marker");
        const a = {
          state: "updating" as const,
          error: null,
          targetVersion: "1.4.0",
          updatedAt: "2026-07-03T00:00:00.000Z",
          writerId: "writer-a",
        };
        const b = {
          state: "updating" as const,
          error: null,
          targetVersion: "1.5.0",
          updatedAt: "2026-07-03T00:00:01.000Z",
          writerId: "writer-b",
        };
        await writeUpdateProgressMarker("production", a);
        await writeUpdateProgressMarker("production", b);
        expect(
          await deleteUpdateProgressMarkerIfUnchanged("production", a),
        ).toBe("changed");
        expect(await readUpdateProgressMarker("production")).toEqual(b);
        expect(scratchAndStagingFiles()).toEqual([]);
      } finally {
        vi.doUnmock("node:fs/promises");
      }
    });

    it("reports `failed` (not `changed`) and retains the displaced marker in its scratch when neither restore route can land it", async () => {
      // Falsification: discard the restore's landing and return `changed`
      // (the old shape) - the caller then logs "another updater owns it
      // now" over an EMPTY live path.
      vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("node:fs/promises")>();
        return {
          ...actual,
          link: async () => {
            throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          },
          writeFile: async (
            path: Parameters<typeof actual.writeFile>[0],
            data: Parameters<typeof actual.writeFile>[1],
            options: Parameters<typeof actual.writeFile>[2],
          ) => {
            if (
              typeof options === "object" &&
              options !== null &&
              "flag" in options &&
              options.flag === "wx"
            ) {
              throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
            }
            return actual.writeFile(path, data, options);
          },
        };
      });
      try {
        const {
          writeUpdateProgressMarker,
          readUpdateProgressMarker,
          deleteUpdateProgressMarkerIfUnchanged,
        } = await import("../update-progress-marker");
        const a = {
          state: "updating" as const,
          error: null,
          targetVersion: "1.4.0",
          updatedAt: "2026-07-03T00:00:00.000Z",
          writerId: "writer-a",
        };
        const b = {
          state: "updating" as const,
          error: null,
          targetVersion: "1.5.0",
          updatedAt: "2026-07-03T00:00:01.000Z",
          writerId: "writer-b",
        };
        await writeUpdateProgressMarker("production", a);
        await writeUpdateProgressMarker("production", b);
        expect(
          await deleteUpdateProgressMarkerIfUnchanged("production", a),
        ).toBe("failed");
        // Neither `link` nor the `wx` fallback could land the displaced
        // marker back at the live path - it stays retained in its scratch
        // rather than being dropped, the live path is left empty, and the
        // outcome says so: a `changed` here would promise a record that is
        // not there.
        expect(await readUpdateProgressMarker("production")).toBeNull();
        const scratchFiles = scratchAndStagingFiles().filter((name) =>
          name.includes(".reconcile-"),
        );
        expect(scratchFiles).toHaveLength(1);
        const scratchContents = readFileSync(
          join(workHome, ".traycer", "host", scratchFiles[0]),
          "utf8",
        );
        expect(JSON.parse(scratchContents)).toEqual(b);
      } finally {
        vi.doUnmock("node:fs/promises");
      }
    });
  });

  // `host update`'s republish-under-the-lock (the empty-path arm of
  // `reassertMarkerUnderLock`): land `next` only into a still-empty live
  // path, refusing rather than overwriting a marker another updater landed
  // first. Unlike a read-then-rename, the refusal leaves the existing
  // marker's bytes completely untouched.
  describe("createUpdateProgressMarkerIfAbsent", () => {
    it("creates the marker when none exists, and the file decodes to `next`", async () => {
      const { createUpdateProgressMarkerIfAbsent, readUpdateProgressMarker } =
        await import("../update-progress-marker");
      const next = {
        state: "updating" as const,
        error: null,
        targetVersion: "1.6.0",
        updatedAt: "2026-07-03T00:00:00.000Z",
        writerId: "writer-a",
      };
      expect(await createUpdateProgressMarkerIfAbsent("production", next)).toBe(
        "created",
      );
      expect(await readUpdateProgressMarker("production")).toEqual(next);
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("reports `exists` when a marker already stands, leaving its bytes byte-identical - the read-then-rename could not guarantee this", async () => {
      const { writeUpdateProgressMarker, createUpdateProgressMarkerIfAbsent } =
        await import("../update-progress-marker");
      const { hostUpdateProgressMarkerPath } =
        await import("../../store/paths");
      await writeUpdateProgressMarker("production", failed);
      const path = hostUpdateProgressMarkerPath("production");
      const before = readFileSync(path, "utf8");
      const next = {
        state: "updating" as const,
        error: null,
        targetVersion: "1.7.0",
        updatedAt: "2026-07-03T00:02:00.000Z",
        writerId: "writer-b",
      };
      expect(await createUpdateProgressMarkerIfAbsent("production", next)).toBe(
        "exists",
      );
      // Byte-identical, not merely equivalent JSON - the old read-then-rename
      // could still land its own write over what it read.
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("leaves no stray `.tmp-*` staging file behind after either outcome", async () => {
      const { createUpdateProgressMarkerIfAbsent } =
        await import("../update-progress-marker");
      const created = {
        state: "updating" as const,
        error: null,
        targetVersion: "1.6.0",
        updatedAt: "2026-07-03T00:00:00.000Z",
        writerId: "writer-a",
      };
      // Absent path: the create outcome.
      expect(
        await createUpdateProgressMarkerIfAbsent("production", created),
      ).toBe("created");
      expect(scratchAndStagingFiles()).toEqual([]);

      // Present path: the refuse outcome, against the marker just created.
      expect(
        await createUpdateProgressMarkerIfAbsent("production", {
          ...created,
          targetVersion: "1.7.0",
        }),
      ).toBe("exists");
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("replaces a MALFORMED file (a crash mid-write) instead of reporting `exists` forever", async () => {
      // Falsification: return `landing` unchanged for `exists` (the old
      // shape) and this reports `exists` while the read answers `null` - the
      // pair every caller loops on until it gives up, on every later update.
      const { createUpdateProgressMarkerIfAbsent, readUpdateProgressMarker } =
        await import("../update-progress-marker");
      const { hostUpdateProgressMarkerPath } =
        await import("../../store/paths");
      const path = hostUpdateProgressMarkerPath("production");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{"state":"updating","targetVer');
      expect(await readUpdateProgressMarker("production")).toBeNull();
      const next = {
        state: "updating" as const,
        error: null,
        targetVersion: "1.6.0",
        updatedAt: "2026-07-03T00:00:00.000Z",
        writerId: "writer-a",
      };
      expect(await createUpdateProgressMarkerIfAbsent("production", next)).toBe(
        "created",
      );
      expect(await readUpdateProgressMarker("production")).toEqual(next);
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("leaves an UNRECOGNISED record (a shape this CLI does not read) in place as `exists`", async () => {
      // A valid JSON object with a state this CLI predates is another
      // writer's marker, not garbage: its liveness cannot be honoured, so it
      // is never replaced outside the lock. Falsification: fold
      // `unrecognised` into `malformed` and this replaces it.
      const { createUpdateProgressMarkerIfAbsent, readUpdateProgressMarker } =
        await import("../update-progress-marker");
      const { hostUpdateProgressMarkerPath } =
        await import("../../store/paths");
      const path = hostUpdateProgressMarkerPath("production");
      mkdirSync(dirname(path), { recursive: true });
      const foreign =
        '{"state":"verifying","error":null,"targetVersion":"9.0.0","updatedAt":"2026-07-03T00:00:00.000Z","writerId":"7-ab"}';
      writeFileSync(path, foreign);
      expect(await readUpdateProgressMarker("production")).toBeNull();
      expect(
        await createUpdateProgressMarkerIfAbsent("production", {
          state: "updating",
          error: null,
          targetVersion: "1.6.0",
          updatedAt: "2026-07-03T00:00:00.000Z",
          writerId: "writer-a",
        }),
      ).toBe("exists");
      expect(readFileSync(path, "utf8")).toBe(foreign);
      expect(scratchAndStagingFiles()).toEqual([]);
    });
  });

  // The conditional replace backs `host update`'s failure stamp: it computes
  // `next` from a record it already holds (the `updating` marker THIS
  // invocation wrote), and another updater can land its own `updating` at
  // the same path before the stamp writes. Replacing unconditionally there
  // would bury that updater's live progress under a failure that is not
  // about it.
  describe("replaceUpdateProgressMarkerIfUnchanged", () => {
    const expectedUpdating = {
      state: "updating" as const,
      error: null,
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:00:00.000Z",
      writerId: "writer-a",
    };
    const failedNext = {
      state: "failed" as const,
      error: "host did not become healthy",
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:01:00.000Z",
      writerId: "writer-a",
    };

    it("replaces the marker when it still reads exactly as expected", async () => {
      const {
        writeUpdateProgressMarker,
        readUpdateProgressMarker,
        replaceUpdateProgressMarkerIfUnchanged,
      } = await import("../update-progress-marker");
      await writeUpdateProgressMarker("production", expectedUpdating);
      expect(
        await replaceUpdateProgressMarkerIfUnchanged(
          "production",
          expectedUpdating,
          failedNext,
        ),
      ).toBe("replaced");
      expect(await readUpdateProgressMarker("production")).toEqual(failedNext);
    });

    it("leaves a marker that changed underneath - another updater's `updating` survives byte-for-byte", async () => {
      const {
        writeUpdateProgressMarker,
        readUpdateProgressMarker,
        replaceUpdateProgressMarkerIfUnchanged,
      } = await import("../update-progress-marker");
      await writeUpdateProgressMarker("production", expectedUpdating);
      // The race: between the caller's read (of `expectedUpdating`) and its
      // replace, another updater landed its own `updating` at the same path.
      const theirs = {
        state: "updating" as const,
        error: null,
        targetVersion: "1.5.0",
        updatedAt: "2026-07-03T00:00:01.000Z",
        writerId: "writer-b",
      };
      await writeUpdateProgressMarker("production", theirs);
      expect(
        await replaceUpdateProgressMarkerIfUnchanged(
          "production",
          expectedUpdating,
          failedNext,
        ),
      ).toBe("changed");
      expect(await readUpdateProgressMarker("production")).toEqual(theirs);
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("treats an absent marker as changed - nothing is landed", async () => {
      const {
        readUpdateProgressMarker,
        replaceUpdateProgressMarkerIfUnchanged,
      } = await import("../update-progress-marker");
      expect(
        await replaceUpdateProgressMarkerIfUnchanged(
          "production",
          expectedUpdating,
          failedNext,
        ),
      ).toBe("changed");
      expect(await readUpdateProgressMarker("production")).toBeNull();
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("leaves no scratch or staging files behind on the replaced path", async () => {
      const {
        writeUpdateProgressMarker,
        replaceUpdateProgressMarkerIfUnchanged,
      } = await import("../update-progress-marker");
      await writeUpdateProgressMarker("production", expectedUpdating);
      await replaceUpdateProgressMarkerIfUnchanged(
        "production",
        expectedUpdating,
        failedNext,
      );
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("does not replace a byte-identical record written by ANOTHER writer in the same millisecond", async () => {
      const {
        writeUpdateProgressMarker,
        readUpdateProgressMarker,
        replaceUpdateProgressMarkerIfUnchanged,
      } = await import("../update-progress-marker");
      const theirRecord = { ...expectedUpdating, writerId: "writer-b" };
      await writeUpdateProgressMarker("production", theirRecord);
      expect(
        await replaceUpdateProgressMarkerIfUnchanged(
          "production",
          { ...expectedUpdating, writerId: "writer-a" },
          failedNext,
        ),
      ).toBe("changed");
      expect(await readUpdateProgressMarker("production")).toEqual(theirRecord);
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("still lands the replace via the wx fallback when link fails for a reason other than EEXIST", async () => {
      vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("node:fs/promises")>();
        return {
          ...actual,
          link: async () => {
            throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          },
        };
      });
      try {
        const {
          writeUpdateProgressMarker,
          readUpdateProgressMarker,
          replaceUpdateProgressMarkerIfUnchanged,
        } = await import("../update-progress-marker");
        await writeUpdateProgressMarker("production", expectedUpdating);
        expect(
          await replaceUpdateProgressMarkerIfUnchanged(
            "production",
            expectedUpdating,
            failedNext,
          ),
        ).toBe("replaced");
        expect(await readUpdateProgressMarker("production")).toEqual(
          failedNext,
        );
        expect(scratchAndStagingFiles()).toEqual([]);
      } finally {
        vi.doUnmock("node:fs/promises");
      }
    });

    it("never throws even when every rm call rejects", async () => {
      vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("node:fs/promises")>();
        return {
          ...actual,
          rm: async () => {
            const err = Object.assign(new Error("EACCES"), {
              code: "EACCES",
            });
            throw err;
          },
        };
      });
      try {
        const {
          writeUpdateProgressMarker,
          readUpdateProgressMarker,
          deleteUpdateProgressMarkerIfUnchanged,
          replaceUpdateProgressMarkerIfUnchanged,
        } = await import("../update-progress-marker");
        // writeUpdateProgressMarker does not use rm, so it still works with
        // the mocked module.
        await writeUpdateProgressMarker("production", failed);
        await expect(
          deleteUpdateProgressMarkerIfUnchanged("production", failed),
        ).resolves.toBe("cleared");
        // The marker exists again and matches: replaces despite every `rm`
        // rejecting.
        await writeUpdateProgressMarker("production", expectedUpdating);
        await expect(
          replaceUpdateProgressMarkerIfUnchanged(
            "production",
            expectedUpdating,
            failedNext,
          ),
        ).resolves.toBe("replaced");
        expect(await readUpdateProgressMarker("production")).toEqual(
          failedNext,
        );
      } finally {
        vi.doUnmock("node:fs/promises");
      }
    });

    // The new record is staged (`ensureHostHomeDir` + `stageMarkerFile`)
    // BEFORE the live record is ever taken into the scratch, precisely so
    // nothing after the take can throw. A throw at the STAGING write itself
    // - before the take - must therefore leave the live path completely
    // untouched: still `expected`, byte-identical, with no `.reconcile-*`
    // or `.tmp-*` leftover from a take that never happened.
    //
    // Falsification: move the staging call back below the take (the shape
    // this replaced) and the live path reads null instead of `expected` -
    // the take would have already moved the record into the scratch before
    // the staging write throws, so the "failed, nothing changed" promise
    // breaks.
    it('reports "failed" and leaves the live path untouched when the STAGING write throws, before the live record is ever taken', async () => {
      let plainWriteCalls = 0;
      vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("node:fs/promises")>();
        return {
          ...actual,
          writeFile: async (
            path: Parameters<typeof actual.writeFile>[0],
            data: Parameters<typeof actual.writeFile>[1],
            options: Parameters<typeof actual.writeFile>[2],
          ) => {
            const isWx =
              typeof options === "object" &&
              options !== null &&
              "flag" in options &&
              options.flag === "wx";
            // Keyed on the BYTES being staged, not on a call count: this
            // test's own setup (`writeUpdateProgressMarker`, seeding the
            // `updating` record) must land, and only `stageMarkerFile`'s
            // write of the `failed` record inside the call under test
            // throws. A count would silently retarget the injection if
            // setup ever gained a write.
            if (!isWx && String(data).includes('"state": "failed"')) {
              plainWriteCalls += 1;
              throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
            }
            return actual.writeFile(path, data, options);
          },
        };
      });
      try {
        const {
          writeUpdateProgressMarker,
          readUpdateProgressMarker,
          replaceUpdateProgressMarkerIfUnchanged,
        } = await import("../update-progress-marker");
        await writeUpdateProgressMarker("production", expectedUpdating);
        expect(
          await replaceUpdateProgressMarkerIfUnchanged(
            "production",
            expectedUpdating,
            failedNext,
          ),
        ).toBe("failed");
        expect(await readUpdateProgressMarker("production")).toEqual(
          expectedUpdating,
        );
        expect(plainWriteCalls).toBe(1);
        expect(scratchAndStagingFiles()).toEqual([]);
      } finally {
        vi.doUnmock("node:fs/promises");
      }
    });
  });

  // The pre-lock publish: claim the live path for `next` without overwriting
  // a marker whose writer may still be acting on it. Backs `host update`'s
  // `publishUpdating` (see the production comment on
  // `claimUpdateProgressMarkerBeforeLock`). Returns `{outcome}` - a
  // "replaced-stale" claim's replaced record is gone, not returned: see
  // `updateProgressRecordHasLiveWriter` for why putting a record no writer
  // is acting on back would be worse than the blind publish it replaces.
  describe("claimUpdateProgressMarkerBeforeLock", () => {
    const next = {
      state: "updating" as const,
      error: null,
      targetVersion: "1.8.0",
      updatedAt: "2026-07-03T00:03:00.000Z",
      writerId: "writer-next",
    };

    it("publishes into an empty path", async () => {
      const { claimUpdateProgressMarkerBeforeLock, readUpdateProgressMarker } =
        await import("../update-progress-marker");
      expect(
        await claimUpdateProgressMarkerBeforeLock("production", next),
      ).toEqual({ outcome: "published" });
      expect(await readUpdateProgressMarker("production")).toEqual(next);
    });

    it("publishes over a MALFORMED file instead of deferring forever", async () => {
      // A crash mid-write left bytes that are not a record. The read answers
      // `null`, the create used to answer `exists`, and three rounds of that
      // ended `deferred` - on this update and every later one, until someone
      // deleted the file by hand. Falsification: make the create report
      // `exists` for a malformed file again and this claim reads `deferred`.
      const { claimUpdateProgressMarkerBeforeLock, readUpdateProgressMarker } =
        await import("../update-progress-marker");
      const { hostUpdateProgressMarkerPath } =
        await import("../../store/paths");
      const path = hostUpdateProgressMarkerPath("production");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{"state":"upd');
      expect(
        await claimUpdateProgressMarkerBeforeLock("production", next),
      ).toEqual({ outcome: "published" });
      expect(await readUpdateProgressMarker("production")).toEqual(next);
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("replaces a `failed` record regardless of its writerId - no writer is acting on a stamped failure - the replaced record is gone", async () => {
      const {
        writeUpdateProgressMarker,
        claimUpdateProgressMarkerBeforeLock,
        readUpdateProgressMarker,
      } = await import("../update-progress-marker");
      await writeUpdateProgressMarker("production", failed);
      expect(
        await claimUpdateProgressMarkerBeforeLock("production", next),
      ).toEqual({ outcome: "replaced-stale" });
      expect(await readUpdateProgressMarker("production")).toEqual(next);
    });

    // `deadPid()` spawns a real `sleep` process to get a genuinely dead pid -
    // not available on win32 (no `sleep`), the same reason
    // `store/__tests__/cli-lock.test.ts` skips its own real-process tests
    // there.
    it.skipIf(process.platform === "win32")(
      "replaces an `updating` record whose writer process is dead - the replaced record is gone",
      async () => {
        const {
          writeUpdateProgressMarker,
          claimUpdateProgressMarkerBeforeLock,
          readUpdateProgressMarker,
        } = await import("../update-progress-marker");
        const pid = await deadPid();
        const deadWriterRecord = {
          state: "updating" as const,
          error: null,
          targetVersion: "1.4.0",
          updatedAt: "2026-07-03T00:00:00.000Z",
          writerId: `${pid}-abcdef`,
        };
        await writeUpdateProgressMarker("production", deadWriterRecord);
        expect(
          await claimUpdateProgressMarkerBeforeLock("production", next),
        ).toEqual({ outcome: "replaced-stale" });
        expect(await readUpdateProgressMarker("production")).toEqual(next);
      },
    );

    it("defers to an `updating` record whose writer process is this very (live) process, leaving the file untouched", async () => {
      const {
        writeUpdateProgressMarker,
        claimUpdateProgressMarkerBeforeLock,
        readUpdateProgressMarker,
      } = await import("../update-progress-marker");
      const theirs = {
        state: "updating" as const,
        error: null,
        targetVersion: "1.4.0",
        updatedAt: "2026-07-03T00:00:00.000Z",
        writerId: `${process.pid}-abcdef`,
      };
      await writeUpdateProgressMarker("production", theirs);
      expect(
        await claimUpdateProgressMarkerBeforeLock("production", next),
      ).toEqual({ outcome: "deferred" });
      expect(await readUpdateProgressMarker("production")).toEqual(theirs);
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("defers (fail-open) when the on-disk `updating` record has writerId null - an older CLI's marker, unprovable as abandoned", async () => {
      const { claimUpdateProgressMarkerBeforeLock, readUpdateProgressMarker } =
        await import("../update-progress-marker");
      const { hostUpdateProgressMarkerPath } =
        await import("../../store/paths");
      const path = hostUpdateProgressMarkerPath("production");
      mkdirSync(dirname(path), { recursive: true });
      const legacyRecord = {
        state: "updating" as const,
        error: null,
        targetVersion: "1.4.0",
        updatedAt: "2026-07-03T00:00:00.000Z",
      };
      writeFileSync(path, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
      expect(
        await claimUpdateProgressMarkerBeforeLock("production", next),
      ).toEqual({ outcome: "deferred" });
      expect(await readUpdateProgressMarker("production")).toEqual({
        ...legacyRecord,
        writerId: null,
      });
    });

    it("defers (fail-open) when the on-disk `updating` record's writerId is unparseable", async () => {
      const {
        writeUpdateProgressMarker,
        claimUpdateProgressMarkerBeforeLock,
        readUpdateProgressMarker,
      } = await import("../update-progress-marker");
      const theirs = {
        state: "updating" as const,
        error: null,
        targetVersion: "1.4.0",
        updatedAt: "2026-07-03T00:00:00.000Z",
        writerId: "not-a-pid",
      };
      await writeUpdateProgressMarker("production", theirs);
      expect(
        await claimUpdateProgressMarkerBeforeLock("production", next),
      ).toEqual({ outcome: "deferred" });
      expect(await readUpdateProgressMarker("production")).toEqual(theirs);
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    // I/O-failure trio: the same non-EEXIST landing failure
    // (`link` throws EPERM, the `wx` create fallback throws ENOSPC) drives
    // `createUpdateProgressMarkerIfAbsent`, `replaceUpdateProgressMarkerIfUnchanged`,
    // and `claimUpdateProgressMarkerBeforeLock` all to their `"failed"`
    // outcome - never silently collapsed into `"exists"` / `"changed"` /
    // `"deferred"`, which callers retry or defer to differently. Reuses the
    // exact double-mock shape `deleteUpdateProgressMarkerIfUnchanged`'s
    // "retains the displaced marker in its scratch" test above provokes the
    // same failure with.
    function mockUnlandableWrites(): void {
      vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("node:fs/promises")>();
        return {
          ...actual,
          link: async () => {
            throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          },
          writeFile: async (
            path: Parameters<typeof actual.writeFile>[0],
            data: Parameters<typeof actual.writeFile>[1],
            options: Parameters<typeof actual.writeFile>[2],
          ) => {
            if (
              typeof options === "object" &&
              options !== null &&
              "flag" in options &&
              options.flag === "wx"
            ) {
              throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
            }
            return actual.writeFile(path, data, options);
          },
        };
      });
    }

    // Same failure, but only for the STAMP landing: the `wx` fallback throws
    // ENOSPC on its first call, then succeeds - so the swap's restore of the
    // record it still holds in scratch (the "expected record is still held
    // in the scratch while `next` lands" branch in the production comment)
    // actually lands.
    function mockStampFailsRestoreSucceeds(): void {
      let wxWriteCalls = 0;
      vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("node:fs/promises")>();
        return {
          ...actual,
          link: async () => {
            throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          },
          writeFile: async (
            path: Parameters<typeof actual.writeFile>[0],
            data: Parameters<typeof actual.writeFile>[1],
            options: Parameters<typeof actual.writeFile>[2],
          ) => {
            if (
              typeof options === "object" &&
              options !== null &&
              "flag" in options &&
              options.flag === "wx"
            ) {
              wxWriteCalls += 1;
              if (wxWriteCalls === 1) {
                throw Object.assign(new Error("ENOSPC"), {
                  code: "ENOSPC",
                });
              }
            }
            return actual.writeFile(path, data, options);
          },
        };
      });
    }

    it('createUpdateProgressMarkerIfAbsent reports "failed" (not "exists") when neither the link nor the wx-create route can land it', async () => {
      mockUnlandableWrites();
      try {
        const { createUpdateProgressMarkerIfAbsent, readUpdateProgressMarker } =
          await import("../update-progress-marker");
        expect(
          await createUpdateProgressMarkerIfAbsent("production", next),
        ).toBe("failed");
        // The path is left exactly as it was found - empty, not `next`.
        expect(await readUpdateProgressMarker("production")).toBeNull();
      } finally {
        vi.doUnmock("node:fs/promises");
      }
    });

    it('replaceUpdateProgressMarkerIfUnchanged reports "failed" and RESTORES the expected record when the stamp landing fails but the restore lands', async () => {
      mockStampFailsRestoreSucceeds();
      try {
        const {
          writeUpdateProgressMarker,
          replaceUpdateProgressMarkerIfUnchanged,
          readUpdateProgressMarker,
        } = await import("../update-progress-marker");
        const expected = {
          state: "updating" as const,
          error: null,
          targetVersion: "1.4.0",
          updatedAt: "2026-07-03T00:00:00.000Z",
          writerId: "writer-a",
        };
        await writeUpdateProgressMarker("production", expected);
        expect(
          await replaceUpdateProgressMarkerIfUnchanged(
            "production",
            expected,
            next,
          ),
        ).toBe("failed");
        // `failed` now means "nothing on the live path changed": the swap
        // kept `expected` in scratch while `next` tried to land, and puts it
        // back byte-for-byte once the stamp can't land but the restore can -
        // neither the old record nor `next` is lost.
        expect(await readUpdateProgressMarker("production")).toEqual(expected);
      } finally {
        vi.doUnmock("node:fs/promises");
      }
    });

    it('replaceUpdateProgressMarkerIfUnchanged reports "failed" with an EMPTY live path when neither the stamp nor the restore can land', async () => {
      mockUnlandableWrites();
      try {
        const {
          writeUpdateProgressMarker,
          replaceUpdateProgressMarkerIfUnchanged,
          readUpdateProgressMarker,
        } = await import("../update-progress-marker");
        const expected = {
          state: "updating" as const,
          error: null,
          targetVersion: "1.4.0",
          updatedAt: "2026-07-03T00:00:00.000Z",
          writerId: "writer-a",
        };
        await writeUpdateProgressMarker("production", expected);
        expect(
          await replaceUpdateProgressMarkerIfUnchanged(
            "production",
            expected,
            next,
          ),
        ).toBe("failed");
        // The one case `failed` cannot promise "nothing changed": the
        // restore attempt (putting `expected` back from scratch) fails the
        // same way the stamp did, so the live path is left empty and the
        // marker layer warns about it by name.
        expect(await readUpdateProgressMarker("production")).toBeNull();
      } finally {
        vi.doUnmock("node:fs/promises");
      }
    });

    it('returns {outcome: "failed"} when its internal replace cannot land the claim', async () => {
      mockUnlandableWrites();
      try {
        const {
          writeUpdateProgressMarker,
          claimUpdateProgressMarkerBeforeLock,
          readUpdateProgressMarker,
        } = await import("../update-progress-marker");
        // A `failed` record replaces unconditionally regardless of writerId,
        // so this drives the claim straight into the replace call that then
        // fails to land.
        await writeUpdateProgressMarker("production", failed);
        expect(
          await claimUpdateProgressMarkerBeforeLock("production", next),
        ).toEqual({ outcome: "failed" });
        expect(await readUpdateProgressMarker("production")).toBeNull();
      } finally {
        vi.doUnmock("node:fs/promises");
      }
    });
  });

  // `updateProgressRecordHasLiveWriter`: the one predicate behind every
  // "is this record mine to replace/restore?" decision (see its own doc
  // comment). Direct pins, independent of the claim/replace/delete
  // primitives that consult it.
  describe("updateProgressRecordHasLiveWriter", () => {
    it("a `failed` record is never live, even with a live pid's writerId", async () => {
      const { updateProgressRecordHasLiveWriter } =
        await import("../update-progress-marker");
      expect(
        updateProgressRecordHasLiveWriter({
          state: "failed",
          error: "host did not become healthy",
          targetVersion: "1.4.0",
          updatedAt: "2026-07-03T00:00:00.000Z",
          writerId: `${process.pid}-abcdef`,
        }),
      ).toBe(false);
    });

    it("an `updating` record whose writer is this very (live) process is live", async () => {
      const { updateProgressRecordHasLiveWriter } =
        await import("../update-progress-marker");
      expect(
        updateProgressRecordHasLiveWriter({
          state: "updating",
          error: null,
          targetVersion: "1.4.0",
          updatedAt: "2026-07-03T00:00:00.000Z",
          writerId: `${process.pid}-abcdef`,
        }),
      ).toBe(true);
    });

    it.skipIf(process.platform === "win32")(
      "an `updating` record whose writer process is dead is not live",
      async () => {
        const { updateProgressRecordHasLiveWriter } =
          await import("../update-progress-marker");
        const pid = await deadPid();
        expect(
          updateProgressRecordHasLiveWriter({
            state: "updating",
            error: null,
            targetVersion: "1.4.0",
            updatedAt: "2026-07-03T00:00:00.000Z",
            writerId: `${pid}-abcdef`,
          }),
        ).toBe(false);
      },
    );

    it("an `updating` record with writerId null (an older CLI's marker) fails open as live - unprovable as abandoned", async () => {
      const { updateProgressRecordHasLiveWriter } =
        await import("../update-progress-marker");
      expect(
        updateProgressRecordHasLiveWriter({
          state: "updating",
          error: null,
          targetVersion: "1.4.0",
          updatedAt: "2026-07-03T00:00:00.000Z",
          writerId: null,
        }),
      ).toBe(true);
    });

    it("an `updating` record with an unparseable writerId fails open as live", async () => {
      const { updateProgressRecordHasLiveWriter } =
        await import("../update-progress-marker");
      expect(
        updateProgressRecordHasLiveWriter({
          state: "updating",
          error: null,
          targetVersion: "1.4.0",
          updatedAt: "2026-07-03T00:00:00.000Z",
          writerId: "not-a-pid",
        }),
      ).toBe(true);
    });
  });

  describe("updateProgressRecordHasProvenLiveWriter", () => {
    // The takeover under the lock retains a displaced record for restore on
    // POSITIVE evidence only. Falsification: implement it as the fail-open
    // predicate and the first two pins report `true`.
    it("a record with NO writer id is not proven live (the fail-open predicate still calls it live)", async () => {
      const {
        updateProgressRecordHasLiveWriter,
        updateProgressRecordHasProvenLiveWriter,
      } = await import("../update-progress-marker");
      const record = {
        state: "updating" as const,
        error: null,
        targetVersion: "1.4.0",
        updatedAt: "2026-07-03T00:00:00.000Z",
        writerId: null,
      };
      expect(updateProgressRecordHasProvenLiveWriter(record)).toBe(false);
      expect(updateProgressRecordHasLiveWriter(record)).toBe(true);
    });

    it("an unparseable writer id is not proven live", async () => {
      const { updateProgressRecordHasProvenLiveWriter } =
        await import("../update-progress-marker");
      expect(
        updateProgressRecordHasProvenLiveWriter({
          state: "updating",
          error: null,
          targetVersion: "1.4.0",
          updatedAt: "2026-07-03T00:00:00.000Z",
          writerId: "not-a-pid",
        }),
      ).toBe(false);
    });

    it("this very (live) process's writer id is proven live; a `failed` with the same id is not", async () => {
      const { updateProgressRecordHasProvenLiveWriter } =
        await import("../update-progress-marker");
      const base = {
        error: null,
        targetVersion: "1.4.0",
        updatedAt: "2026-07-03T00:00:00.000Z",
        writerId: `${process.pid}-abcdef`,
      };
      expect(
        updateProgressRecordHasProvenLiveWriter({
          state: "updating",
          ...base,
        }),
      ).toBe(true);
      expect(
        updateProgressRecordHasProvenLiveWriter({
          state: "failed",
          ...base,
          error: "host did not become healthy",
        }),
      ).toBe(false);
    });

    it.skipIf(process.platform === "win32")(
      "a dead writer process is not proven live",
      async () => {
        const { updateProgressRecordHasProvenLiveWriter } =
          await import("../update-progress-marker");
        const pid = await deadPid();
        expect(
          updateProgressRecordHasProvenLiveWriter({
            state: "updating",
            error: null,
            targetVersion: "1.4.0",
            updatedAt: "2026-07-03T00:00:00.000Z",
            writerId: `${pid}-abcdef`,
          }),
        ).toBe(false);
      },
    );
  });

  // A file that is there but cannot be READ (a marker a `sudo traycer host
  // update` left root-owned; here, mode 000) is neither absent nor a record
  // this CLI can compare. Nothing is replaced: the create answers `exists`
  // (the caller's bounded loop then gives up with its own warning) and the
  // claim defers. Root reads a 000 file, so the pin is skipped there.
  // Falsification: fold `unreadable` into `absent` in `readMarkerState` and
  // the create tries to replace the file it could not read - answering
  // `exists` only because its swap's compare fails - while the claim pin
  // still holds; fold it into `malformed` (with empty bytes) and the create
  // REPLACES the file, reddening the byte-identical assertion.
  describe.skipIf(
    process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )("an UNREADABLE marker file", () => {
    const next = {
      state: "updating" as const,
      error: null,
      targetVersion: "1.6.0",
      updatedAt: "2026-07-03T00:00:00.000Z",
      writerId: "writer-a",
    };
    const contents =
      '{"state":"updating","error":null,"targetVersion":"1.5.0","updatedAt":"2026-07-03T00:00:00.000Z","writerId":"7-ab"}';

    it("is left in place as `exists` by the create-if-absent", async () => {
      const { createUpdateProgressMarkerIfAbsent, readUpdateProgressMarker } =
        await import("../update-progress-marker");
      const { hostUpdateProgressMarkerPath } =
        await import("../../store/paths");
      const path = hostUpdateProgressMarkerPath("production");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
      chmodSync(path, 0o000);
      try {
        expect(await readUpdateProgressMarker("production")).toBeNull();
        expect(
          await createUpdateProgressMarkerIfAbsent("production", next),
        ).toBe("exists");
      } finally {
        chmodSync(path, 0o600);
      }
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect(scratchAndStagingFiles()).toEqual([]);
    });

    it("is deferred to by the pre-lock claim", async () => {
      const { claimUpdateProgressMarkerBeforeLock } =
        await import("../update-progress-marker");
      const { hostUpdateProgressMarkerPath } =
        await import("../../store/paths");
      const path = hostUpdateProgressMarkerPath("production");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
      chmodSync(path, 0o000);
      try {
        expect(
          await claimUpdateProgressMarkerBeforeLock("production", next),
        ).toEqual({ outcome: "deferred" });
      } finally {
        chmodSync(path, 0o600);
      }
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect(scratchAndStagingFiles()).toEqual([]);
    });
  });
});
