import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  // The conditional delete backs `host update`'s stale-failure reconcile: it
  // decided from a marker it READ, and another updater can replace that
  // marker with a live `updating` before the unlink. Deleting unconditionally
  // there would erase the legacy path's only progress signal.
  describe("deleteUpdateProgressMarkerIfUnchanged", () => {
    const failed = {
      state: "failed" as const,
      error: "host did not become healthy",
      targetVersion: "1.4.0",
      updatedAt: "2026-07-03T00:00:00.000Z",
    };

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
      expect((await readUpdateProgressMarker("production"))?.state).toBe(
        "updating",
      );
    });

    it("reports absent when there is no marker to clear", async () => {
      const { deleteUpdateProgressMarkerIfUnchanged } =
        await import("../update-progress-marker");
      expect(
        await deleteUpdateProgressMarkerIfUnchanged("production", failed),
      ).toBe("absent");
    });
  });
});
