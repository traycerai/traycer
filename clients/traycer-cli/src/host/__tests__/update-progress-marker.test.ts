import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    });
    await writeUpdateProgressMarker("production", {
      state: "failed",
      error: "host process (pid 123) is not alive",
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:01:00.000Z",
    });
    const progress = await readUpdateProgressMarker("production");
    expect(progress).toEqual({
      state: "failed",
      error: "host process (pid 123) is not alive",
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:01:00.000Z",
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
    });
    await writeUpdateProgressMarker("dev", {
      state: "failed",
      error: "boom",
      targetVersion: "2.0.0",
      updatedAt: "2026-07-03T00:00:00.000Z",
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

  // Shared by the delete and replace conditional-swap suites: both back
  // `host update`'s marker reconciliation with the same compare-and-swap
  // primitive, and a scratch (`.reconcile-`) or staging (`.tmp-`) leftover in
  // either direction is the same kind of bug.
  const failed = {
    state: "failed" as const,
    error: "host did not become healthy",
    targetVersion: "1.4.0",
    updatedAt: "2026-07-03T00:00:00.000Z",
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
    };
    const failedNext = {
      state: "failed" as const,
      error: "host did not become healthy",
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:01:00.000Z",
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
  });
});
