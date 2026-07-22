import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHostFsLayout } from "../host-paths";

// Ticket T4 (Settings Restart + apply-after-update, finding C): the
// two-phase reservation handoff persists a durable on-disk marker before the
// tracked `update` operation settles, so the detached apply-ensure (or the
// 30s monitor, or the next launch) can always find it. A marker WRITE
// failure must never let already-downloaded bytes look applied - it has to
// surface as a non-durable pending state that survives for this
// main-process lifetime (i.e. across a renderer reload, which does not
// restart main) until a later write or register cycle resolves it.

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-pending-revision-"));
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

/**
 * Forces every `writePendingLoginItemRevision` attempt to fail with a real
 * fs error (no `node:fs/promises` mocking, which Bun's test runner does not
 * reliably intercept for built-ins imported by production modules): plants a
 * plain file where the marker's parent directory (`rootDir`) needs to be, so
 * `mkdir(rootDir, { recursive: true })` fails with a genuine ENOTDIR/EEXIST.
 */
function blockMarkerDirectoryWithAFile(environment: "production"): void {
  const rootDir = dirname(
    getHostFsLayout(environment).pendingLoginItemRevisionFile,
  );
  mkdirSync(dirname(rootDir), { recursive: true });
  writeFileSync(rootDir, "not a directory", { flag: "wx" });
}

function unblockMarkerDirectory(environment: "production"): void {
  const rootDir = dirname(
    getHostFsLayout(environment).pendingLoginItemRevisionFile,
  );
  unlinkSync(rootDir);
}

describe("pending-login-item-revision - durable marker write/read/clear", () => {
  it("writes the on-disk marker and reports a durable pending state", async () => {
    const mod = await import("../pending-login-item-revision");
    const state = await mod.writePendingLoginItemRevision(
      "production",
      "update",
    );
    expect(state).toEqual({
      pending: true,
      durable: true,
      cause: null,
      error: null,
    });

    const markerPath =
      getHostFsLayout("production").pendingLoginItemRevisionFile;
    const onDisk = JSON.parse(readFileSync(markerPath, "utf8")) as {
      pending: boolean;
    };
    expect(onDisk.pending).toBe(true);

    await expect(
      mod.getPendingLoginItemRevisionState("production"),
    ).resolves.toEqual({
      pending: true,
      durable: true,
      cause: null,
      error: null,
    });
  });

  it("clearing the marker reports pending:false", async () => {
    const mod = await import("../pending-login-item-revision");
    await mod.writePendingLoginItemRevision("production", "update");
    const cleared = await mod.clearPendingLoginItemRevision("production");
    expect(cleared).toEqual({
      pending: false,
      durable: false,
      cause: null,
      error: null,
    });
    await expect(
      mod.getPendingLoginItemRevisionState("production"),
    ).resolves.toEqual({
      pending: false,
      durable: false,
      cause: null,
      error: null,
    });
  });

  it("a marker written for an update survives a fresh main-process launch and clears after its successful apply cycle", async () => {
    const beforeRestart = await import("../pending-login-item-revision");
    await beforeRestart.writePendingLoginItemRevision("production", "update");

    // `vi.resetModules` deliberately drops the first module's volatile
    // state, modelling a main-process crash/relaunch. The durable marker is
    // therefore the only handoff input available to the new monitor/ensure.
    vi.resetModules();
    const afterRestart = await import("../pending-login-item-revision");
    await expect(
      afterRestart.getPendingLoginItemRevisionState("production"),
    ).resolves.toEqual({
      pending: true,
      durable: true,
      cause: null,
      error: null,
    });

    await expect(
      afterRestart.resolvePendingLoginItemRevisionAfterCycle("production"),
    ).resolves.toEqual({
      pending: false,
      durable: false,
      cause: null,
      error: null,
    });
  });

  it("fans out every write, clear, and successful-cycle resolution to subscribed listeners", async () => {
    const mod = await import("../pending-login-item-revision");
    const seen: unknown[] = [];
    const dispose = mod.onPendingLoginItemRevisionChange((state) => {
      seen.push(state);
    });
    await mod.writePendingLoginItemRevision("production", "update");
    await mod.clearPendingLoginItemRevision("production");
    await mod.writePendingLoginItemRevision("production", "update");
    await mod.resolvePendingLoginItemRevisionAfterCycle("production");
    dispose();
    await mod.writePendingLoginItemRevision("production", "update");

    expect(seen).toEqual([
      { pending: true, durable: true, cause: null, error: null },
      { pending: false, durable: false, cause: null, error: null },
      { pending: true, durable: true, cause: null, error: null },
      { pending: false, durable: false, cause: null, error: null },
    ]);
  });

  it("a persistent write failure (all 3 attempts) exposes a non-durable pending state carrying the update cause and error, and it survives repeated reads for this process lifetime", async () => {
    blockMarkerDirectoryWithAFile("production");
    const mod = await import("../pending-login-item-revision");

    const state = await mod.writePendingLoginItemRevision(
      "production",
      "update",
    );
    expect(state.pending).toBe(true);
    expect(state.durable).toBe(false);
    expect(state.cause).toBe("update");
    expect(state.error).toEqual(expect.any(String));
    expect(state.error).not.toBe("");

    // Simulates a renderer reload: the main process never restarted, so the
    // volatile in-memory state must still answer the same non-durable
    // payload on a fresh `get`.
    await expect(
      mod.getPendingLoginItemRevisionState("production"),
    ).resolves.toEqual(state);
    await expect(
      mod.getPendingLoginItemRevisionState("production"),
    ).resolves.toEqual(state);

    const markerPath =
      getHostFsLayout("production").pendingLoginItemRevisionFile;
    expect(() => readFileSync(markerPath, "utf8")).toThrow();
  });

  it("a successful retry after a fully-failed write clears the volatile state and becomes durable", async () => {
    blockMarkerDirectoryWithAFile("production");
    const mod = await import("../pending-login-item-revision");

    await expect(
      mod.writePendingLoginItemRevision("production", "update"),
    ).resolves.toMatchObject({ pending: true, durable: false });

    unblockMarkerDirectory("production");
    const retried = await mod.writePendingLoginItemRevision(
      "production",
      "update",
    );
    expect(retried).toEqual({
      pending: true,
      durable: true,
      cause: null,
      error: null,
    });
    await expect(
      mod.getPendingLoginItemRevisionState("production"),
    ).resolves.toEqual({
      pending: true,
      durable: true,
      cause: null,
      error: null,
    });
  });

  it("a successful register cycle clears a non-durable warning even when marker cleanup still fails", async () => {
    blockMarkerDirectoryWithAFile("production");
    const mod = await import("../pending-login-item-revision");
    await mod.writePendingLoginItemRevision("production", "update");

    // A completed SMAppService cycle means the staged definition applied.
    // Its marker cleanup is best effort: keep the fault in place to prove a
    // persistent unlink failure cannot leave the volatile warning forever.
    const cleared =
      await mod.resolvePendingLoginItemRevisionAfterCycle("production");
    expect(cleared).toEqual({
      pending: false,
      durable: false,
      cause: null,
      error: null,
    });
    await expect(
      mod.getPendingLoginItemRevisionState("production"),
    ).resolves.toEqual({
      pending: false,
      durable: false,
      cause: null,
      error: null,
    });
  });
});

describe("pending-cycle flag query helpers (Finding F)", () => {
  it("are both false on a clean slate", async () => {
    const mod = await import("../pending-login-item-revision");
    expect(mod.isPendingCycleFlagSet("production")).toBe(false);
    await expect(
      mod.hasPendingLoginItemRevisionOrPendingCycle("production"),
    ).resolves.toBe(false);
  });

  it("a failed marker write sets the in-memory pending-cycle flag with no disk trace", async () => {
    blockMarkerDirectoryWithAFile("production");
    const mod = await import("../pending-login-item-revision");
    await mod.writePendingLoginItemRevision("production", "no-agent-spawn");

    expect(mod.isPendingCycleFlagSet("production")).toBe(true);
    // The OR-helper wakes the 30s monitor even though nothing was persisted.
    await expect(
      mod.hasPendingLoginItemRevisionOrPendingCycle("production"),
    ).resolves.toBe(true);
  });

  it("a durable marker (no flag) still satisfies the OR-helper", async () => {
    const mod = await import("../pending-login-item-revision");
    await mod.writePendingLoginItemRevision("production", "update");

    expect(mod.isPendingCycleFlagSet("production")).toBe(false);
    await expect(
      mod.hasPendingLoginItemRevisionOrPendingCycle("production"),
    ).resolves.toBe(true);
  });

  it("resolving the cycle clears the flag even when the marker unlink cannot run", async () => {
    blockMarkerDirectoryWithAFile("production");
    const mod = await import("../pending-login-item-revision");
    await mod.writePendingLoginItemRevision("production", "no-agent-spawn");
    expect(mod.isPendingCycleFlagSet("production")).toBe(true);

    await mod.resolvePendingLoginItemRevisionAfterCycle("production");
    expect(mod.isPendingCycleFlagSet("production")).toBe(false);
    await expect(
      mod.hasPendingLoginItemRevisionOrPendingCycle("production"),
    ).resolves.toBe(false);
  });
});

describe("applied-despite-lingering-marker latch (M-B)", () => {
  // A DIRECTORY at the marker's file path makes the best-effort
  // `rm(path, { force: true })` (non-recursive) fail with EISDIR while
  // `access(path, F_OK)` still reports the path present - modelling a successful
  // cycle whose marker unlink fails (EACCES/EPERM/EBUSY in prod) without any
  // uid-sensitive chmod, so the test is deterministic even under root.
  function makeUnremovableMarker(environment: "production"): string {
    const markerPath =
      getHostFsLayout(environment).pendingLoginItemRevisionFile;
    mkdirSync(markerPath, { recursive: true });
    return markerPath;
  }

  it("a successful cycle whose marker unlink fails reads as applied, not pending, and stops waking the monitor", async () => {
    const markerPath = makeUnremovableMarker("production");
    const mod = await import("../pending-login-item-revision");

    // The cycle applied the staged revision; its unlink then fails. The marker
    // is latched as already-applied instead of reading pending forever.
    await expect(
      mod.resolvePendingLoginItemRevisionAfterCycle("production"),
    ).resolves.toEqual({
      pending: false,
      durable: false,
      cause: null,
      error: null,
    });
    await expect(
      mod.getPendingLoginItemRevisionState("production"),
    ).resolves.toEqual({
      pending: false,
      durable: false,
      cause: null,
      error: null,
    });
    // The 30s monitor's wake predicate and the machine's marker cause both go
    // quiet, so a healthy host is never re-cycled every tick.
    await expect(
      mod.hasPendingLoginItemRevisionOrPendingCycle("production"),
    ).resolves.toBe(false);
    await expect(
      mod.hasUnappliedPendingLoginItemRevision("production"),
    ).resolves.toBe(false);
    // The raw marker is genuinely still on disk - the latch, not a removal, is
    // what makes it read as applied.
    await expect(mod.hasPendingLoginItemRevision("production")).resolves.toBe(
      true,
    );

    rmSync(markerPath, { recursive: true, force: true });
  });

  it("a newly staged revision re-arms the pending state after the applied latch", async () => {
    const markerPath = makeUnremovableMarker("production");
    const mod = await import("../pending-login-item-revision");
    await mod.resolvePendingLoginItemRevisionAfterCycle("production");
    await expect(
      mod.hasPendingLoginItemRevisionOrPendingCycle("production"),
    ).resolves.toBe(false);

    // Clear the directory so a real marker file can be staged, then stage one:
    // a genuinely-new revision must NOT inherit the previous cycle's applied
    // latch.
    rmSync(markerPath, { recursive: true, force: true });
    await mod.writePendingLoginItemRevision("production", "update");

    await expect(
      mod.getPendingLoginItemRevisionState("production"),
    ).resolves.toEqual({
      pending: true,
      durable: true,
      cause: null,
      error: null,
    });
    await expect(
      mod.hasUnappliedPendingLoginItemRevision("production"),
    ).resolves.toBe(true);
  });

  it("the applied latch is in-memory: a fresh launch treats a still-present marker as pending once more (bounded one-cycle)", async () => {
    const markerPath = makeUnremovableMarker("production");
    const first = await import("../pending-login-item-revision");
    await first.resolvePendingLoginItemRevisionAfterCycle("production");
    await expect(
      first.getPendingLoginItemRevisionState("production"),
    ).resolves.toMatchObject({ pending: false });

    // A relaunch drops the in-memory latch. The unremovable marker is still on
    // disk, so the new process treats it as pending and gets exactly one more
    // apply attempt - never an in-session churn loop.
    vi.resetModules();
    const afterRestart = await import("../pending-login-item-revision");
    await expect(
      afterRestart.getPendingLoginItemRevisionState("production"),
    ).resolves.toMatchObject({ pending: true, durable: true });

    rmSync(markerPath, { recursive: true, force: true });
  });
});
