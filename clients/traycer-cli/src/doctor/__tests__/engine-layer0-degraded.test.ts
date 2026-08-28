import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `traycer host doctor` is the only structured surface where a support
 * engineer can learn that a running host started **without** the Layer 0
 * single-writer guarantee.
 *
 * The host degrades and keeps serving on purpose: refusing to start would
 * trade a rare two-hosts-one-data-dir corruption for a routine outage. What it
 * must not do is fall silent, and every other channel it has is ephemeral —
 * the framed status pipe has no reader on an ordinary production start, and
 * the `[host] layer0-degraded` stderr line is one line at the top of a log
 * whose diagnostic tail is 200 lines and whose support attachment is 500. So
 * the host writes the verdict into pid.json and doctor reads it back.
 *
 * These rows go through the **real** `readHostPidMetadata` against a real
 * pid.json on disk, whose contents match what
 * `traycer-host/src/transport/rpc/pid-metadata.ts` writes (pinned on that side
 * by its own key-shape test). Mocking the reader would have proved only that
 * the engine can format an object this file made up.
 */

// `store/paths` binds its home root from `os.homedir()` at module load.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-layer0-test-"));
  osHome.current = workHome;
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
  vi.restoreAllMocks();
  vi.doUnmock("../../manifest/host-install");
  vi.doUnmock("../../host/bootstrap-log");
  vi.doUnmock("../../service");
});

/**
 * The exact document the host publishes. `pid` is this process so the engine
 * sees a live host — the degraded record only matters for a host that is
 * actually running, and doctor deliberately ignores the field on stale
 * metadata (it would describe a process that is already gone).
 */
function writePidJson(layer0: unknown, layer0Slot: unknown): void {
  const hostRoot = join(workHome, ".traycer", "host");
  mkdirSync(hostRoot, { recursive: true });
  writeFileSync(
    join(hostRoot, "pid.json"),
    JSON.stringify(
      {
        pid: process.pid,
        hostId: "host-under-audit",
        version: "1.1.8",
        // Port 1 is never a live host; the unreachable-endpoint issue that
        // follows is expected and asserted around, not suppressed.
        websocketUrl: "ws://127.0.0.1:1/rpc",
        startedAt: "2026-07-27T00:00:00.000Z",
        processStartTimeMs: 1_700_000_000_000,
        layer0,
        // `JSON.stringify` omits an `undefined` value, so the default call
        // writes a record with no such key at all - which is exactly what
        // every host that predates ticket 38, and every non-pool host, writes.
        layer0Slot,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function stageQuietEnvironment(): void {
  const hostExecutablePath = join(workHome, "bin", "host");
  mkdirSync(join(workHome, "bin"), { recursive: true });
  writeFileSync(hostExecutablePath, "host-bin");
  vi.doMock("../../manifest/host-install", () => ({
    readHostInstallRecord: () => ({
      version: "1.1.8",
      environment: "production",
      executablePath: hostExecutablePath,
      installedAt: "2026-04-01T00:00:00Z",
      source: "registry",
      archiveSha256: "f".repeat(64),
      signatureKeyId: "registry:prod-2026",
    }),
  }));
  vi.doMock("../../host/bootstrap-log", () => ({
    readBootstrapMarkers: async () => [],
  }));
  vi.doMock("../../service", () => ({
    createServiceController: () => ({
      status: async () => ({
        state: "running",
        version: "1.1.8",
        listenUrl: null,
        pid: process.pid,
      }),
      install: async () => undefined,
      uninstall: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      restart: async () => undefined,
    }),
    serviceLabelFor: (environment: string) => ({
      id: `ai.traycer.host.${environment}`,
    }),
  }));
}

async function runDoctorHere(): Promise<
  readonly {
    readonly code: string;
    readonly severity: string;
    readonly message: string;
    readonly fixAction: string | null;
    readonly terminalCommand: string | null;
    readonly details: Record<string, unknown> | null;
  }[]
> {
  const { runDoctor } = await import("../engine");
  const result = await runDoctor({
    environment: "production",
    // Deterministic: never shell out to lsof from a unit row.
    portConflictDeps: { runCommand: async () => null, platform: "darwin" },
  });
  return result.issues;
}

describe("runDoctor Layer 0 guarantee reporting", () => {
  it("reports a degraded host, with the cause and evidence that name the loss", async () => {
    stageQuietEnvironment();
    writePidJson(
      {
        status: "degraded",
        attemptId: "host-4242",
        cause: "addon-load-failed",
        evidence: "Cannot find module 'lifecycle_lock.node'",
      },
      undefined,
    );

    const issues = await runDoctorHere();
    const issue = issues.find(
      (candidate) => candidate.code === "HOST_LAYER0_NOT_GUARANTEED",
    );

    expect(issue).toBeDefined();
    // Warning, not error: nothing is broken, and promoting it would flip the
    // exit code of `traycer host doctor` for every user whose home is on a
    // network filesystem.
    expect(issue?.severity).toBe("warning");
    // The cause is the actionable half - "the host is degraded" without it
    // tells an investigator nothing they can act on.
    expect(issue?.message).toContain("addon-load-failed");
    expect(issue?.message).toContain("lifecycle_lock.node");
    // No CLI fix exists; `host restart` would just reproduce the degradation.
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).toBeNull();
    expect(issue?.details).toMatchObject({
      pid: process.pid,
      hostId: "host-under-audit",
      layer0: { status: "degraded", attemptId: "host-4242" },
    });
  });

  it("carries a structured os-error cause through to the report", async () => {
    stageQuietEnvironment();
    writePidJson(
      {
        status: "degraded",
        attemptId: "host-4242",
        cause: {
          kind: "os-error",
          syscall: "open",
          code: "EACCES",
          fsType: null,
        },
        evidence: "kernel lifecycle lock acquisition was not determinable",
      },
      undefined,
    );

    const issues = await runDoctorHere();
    const issue = issues.find(
      (candidate) => candidate.code === "HOST_LAYER0_NOT_GUARANTEED",
    );

    expect(issue?.message).toContain("EACCES");
    expect(issue?.message).toContain("open");
  });

  it("stays quiet for a host that holds the guarantee", async () => {
    stageQuietEnvironment();
    writePidJson({ status: "acquired", attemptId: "host-4242" }, undefined);

    const issues = await runDoctorHere();

    expect(
      issues.find(
        (candidate) => candidate.code === "HOST_LAYER0_NOT_GUARANTEED",
      ),
    ).toBeUndefined();
    // The rest of the engine still ran - this row is not vacuously quiet
    // because doctor produced nothing at all.
    expect(
      issues.find((candidate) => candidate.code === "PORT_UNREACHABLE"),
    ).toBeDefined();
  });

  /**
   * chat-sync-v2 ticket 38. A dev identity-pool host takes TWO Layer 0 locks -
   * slot home and identity home - and until ticket 38 only the identity one
   * reached pid.json. Not by picking the wrong record of two: the slot outcome
   * was DISCARDED before any record existed, because `main-bootstrap` only
   * announces it on the arm where that lock PREVENTS startup, and that arm
   * returns. So this exact combination - identity `acquired`, slot `degraded` -
   * published a clean `acquired` and doctor answered "guaranteed" to the one
   * question the record exists for.
   */
  it("reports a degraded SLOT home even when the identity home was acquired", async () => {
    stageQuietEnvironment();
    writePidJson(
      { status: "acquired", attemptId: "host-4242" },
      {
        status: "degraded",
        attemptId: "host-4242",
        cause: "addon-load-failed",
        evidence: "slot home lock could not be held",
      },
    );

    const issues = await runDoctorHere();
    const issue = issues.find(
      (candidate) => candidate.code === "HOST_LAYER0_NOT_GUARANTEED",
    );

    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    // Names WHICH home lost it - an investigator holding two homes and one
    // warning cannot act on "the host is degraded".
    expect(issue?.message).toContain("slot home");
    expect(issue?.message).toContain("slot home lock could not be held");
    expect(issue?.details).toMatchObject({
      layer0: { status: "acquired" },
      layer0Slot: { status: "degraded" },
    });
  });

  it("reports BOTH homes when both lost the lock", async () => {
    stageQuietEnvironment();
    writePidJson(
      {
        status: "degraded",
        attemptId: "host-4242",
        cause: "addon-load-failed",
        evidence: "identity home lock could not be held",
      },
      {
        status: "degraded",
        attemptId: "host-4242",
        cause: "fs-unsupported",
        evidence: "slot home lock could not be held",
      },
    );

    const issues = await runDoctorHere();
    const issue = issues.find(
      (candidate) => candidate.code === "HOST_LAYER0_NOT_GUARANTEED",
    );

    // One issue carrying both, not two issues: it is one guarantee, lost.
    expect(issue?.message).toContain("identity home");
    expect(issue?.message).toContain("slot home");
    expect(issue?.message).toContain("fs-unsupported");
  });

  it("stays quiet for a pool host where BOTH homes held the lock", async () => {
    stageQuietEnvironment();
    writePidJson(
      { status: "acquired", attemptId: "host-4242" },
      { status: "acquired", attemptId: "host-4242" },
    );

    const issues = await runDoctorHere();

    expect(
      issues.find(
        (candidate) => candidate.code === "HOST_LAYER0_NOT_GUARANTEED",
      ),
    ).toBeUndefined();
    expect(
      issues.find((candidate) => candidate.code === "PORT_UNREACHABLE"),
    ).toBeDefined();
  });

  it("stays quiet for a pid.json written before the field existed", async () => {
    stageQuietEnvironment();
    const hostRoot = join(workHome, ".traycer", "host");
    mkdirSync(hostRoot, { recursive: true });
    writeFileSync(
      join(hostRoot, "pid.json"),
      JSON.stringify({
        pid: process.pid,
        hostId: "host-under-audit",
        version: "1.1.7",
        websocketUrl: "ws://127.0.0.1:1/rpc",
        startedAt: "2026-07-27T00:00:00.000Z",
      }),
      "utf8",
    );

    const issues = await runDoctorHere();

    expect(
      issues.find(
        (candidate) => candidate.code === "HOST_LAYER0_NOT_GUARANTEED",
      ),
    ).toBeUndefined();
    expect(
      issues.find((candidate) => candidate.code === "PORT_UNREACHABLE"),
    ).toBeDefined();
  });

  /**
   * Version skew in the other direction: a host newer than this CLI. Silence
   * would be the same defect the field exists to remove, so an unfamiliar
   * status reports "cannot confirm" rather than nothing.
   */
  it("reports a status this CLI does not recognise rather than falling silent", async () => {
    stageQuietEnvironment();
    writePidJson({ status: "quarantined", attemptId: "host-4242" }, undefined);

    const issues = await runDoctorHere();
    const issue = issues.find(
      (candidate) => candidate.code === "HOST_LAYER0_NOT_GUARANTEED",
    );

    expect(issue).toBeDefined();
    expect(issue?.message).toContain("quarantined");
  });
});
