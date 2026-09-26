import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorResult } from "../issues";

/**
 * `traycer host doctor`'s host-lifecycle-policy issues (D7):
 *
 * - `HOST_LIFECYCLE_POLICY_UNREADABLE` - the policy file on disk is present
 *   but corrupt/unreadable, which quietly reads as Background everywhere
 *   else.
 * - `HOST_LIFECYCLE_POLICY_NOT_ENFORCED` - a non-Background mode is set, the
 *   host is running, but the running supervisor does not advertise the
 *   `lifecycle-policy-v1` capability (no record, or a stale one).
 *
 * `result.lifecycle` (`DoctorResult.lifecycle`) carries the underlying
 * snapshot in every case - facts, not findings - and is asserted directly
 * alongside the issue list.
 *
 * These tests go through the REAL `readHostLifecycleSnapshot` /
 * `readHostPidMetadata` readers against real files in a temp host home,
 * following the pattern in `engine-layer0-degraded.test.ts`: only the
 * install record, bootstrap markers and service controller are mocked, so
 * `runDoctor` still exercises its full lifecycle read.
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
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-lifecycle-test-"));
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

function hostRoot(): string {
  return join(workHome, ".traycer", "host");
}

function stageQuietEnvironment(serviceState: "running" | "stopped"): void {
  const hostExecutablePath = join(workHome, "bin", "host");
  mkdirSync(join(workHome, "bin"), { recursive: true });
  writeFileSync(hostExecutablePath, "host-bin");
  vi.doMock("../../manifest/host-install", () => ({
    readHostInstallRecord: () => ({
      version: "1.7.2",
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
        state: serviceState,
        version: "1.7.2",
        listenUrl: null,
        pid: serviceState === "running" ? process.pid : null,
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

/** A real, live host process: pid.json naming this test process. */
function writeLivePidJson(): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    join(hostRoot(), "pid.json"),
    JSON.stringify(
      {
        pid: process.pid,
        hostId: "host-under-audit",
        version: "1.7.2",
        websocketUrl: "ws://127.0.0.1:1/rpc",
        startedAt: "2026-07-27T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

function writePolicy(mode: string): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    join(hostRoot(), "lifecycle-policy.json"),
    JSON.stringify(
      {
        v: 1,
        rev: 1,
        mode,
        updatedAt: "2026-08-01T00:00:00.000Z",
        updatedBy: "cli",
      },
      null,
      2,
    ),
    "utf8",
  );
}

function writeCorruptPolicy(): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    join(hostRoot(), "lifecycle-policy.json"),
    "{ not json",
    "utf8",
  );
}

interface WriteSupervisorInput {
  readonly pid: number;
  readonly capabilities: readonly string[];
}

function writeSupervisor(input: WriteSupervisorInput): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    join(hostRoot(), "supervisor.json"),
    JSON.stringify(
      {
        v: 1,
        pid: input.pid,
        cliVersion: "1.7.2",
        capabilities: input.capabilities,
        startedAt: "2026-08-01T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function runDoctorHere(): Promise<DoctorResult> {
  const { runDoctor } = await import("../engine");
  return runDoctor({
    environment: "production",
    portConflictDeps: { runCommand: async () => null, platform: "darwin" },
  });
}

describe("runDoctor host lifecycle policy issues", () => {
  it("HOST_LIFECYCLE_POLICY_UNREADABLE: warns with a non-null terminalCommand and fixAction: null for a corrupt policy file", async () => {
    stageQuietEnvironment("stopped");
    writeCorruptPolicy();

    const result = await runDoctorHere();
    const issue = result.issues.find(
      (candidate) => candidate.code === "HOST_LIFECYCLE_POLICY_UNREADABLE",
    );

    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).not.toBeNull();
    expect(result.lifecycle.policy.state).toBe("invalid");
    expect(result.lifecycle.policy.mode).toBe("background");
  });

  it("HOST_LIFECYCLE_POLICY_NOT_ENFORCED: non-background mode, host alive, no supervisor record", async () => {
    stageQuietEnvironment("running");
    writeLivePidJson();
    writePolicy("linked");
    // No supervisor.json at all.

    const result = await runDoctorHere();
    const issue = result.issues.find(
      (candidate) => candidate.code === "HOST_LIFECYCLE_POLICY_NOT_ENFORCED",
    );

    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.fixAction).toBe("host-restart");
    expect(result.lifecycle.policy.mode).toBe("linked");
    expect(result.lifecycle.supervisor.enforcesLifecyclePolicy).toBe(false);
  });

  it("HOST_LIFECYCLE_POLICY_NOT_ENFORCED: non-background mode, host alive, a STALE supervisor record", async () => {
    stageQuietEnvironment("running");
    writeLivePidJson();
    writePolicy("ask");
    // A dead pid: nothing on this machine should ever hold this number.
    writeSupervisor({ pid: 999_999, capabilities: ["lifecycle-policy-v1"] });

    const result = await runDoctorHere();
    const issue = result.issues.find(
      (candidate) => candidate.code === "HOST_LIFECYCLE_POLICY_NOT_ENFORCED",
    );

    expect(issue).toBeDefined();
    expect(issue?.fixAction).toBe("host-restart");
    expect(result.lifecycle.supervisor.liveness).toBe("stale");
    expect(result.lifecycle.supervisor.enforcesLifecyclePolicy).toBe(false);
  });

  it("no lifecycle issue when a live supervisor advertises lifecycle-policy-v1", async () => {
    stageQuietEnvironment("running");
    writeLivePidJson();
    writePolicy("stop-if-idle");
    writeSupervisor({
      pid: process.pid,
      capabilities: ["lifecycle-policy-v1"],
    });

    const result = await runDoctorHere();

    expect(
      result.issues.find(
        (candidate) => candidate.code === "HOST_LIFECYCLE_POLICY_NOT_ENFORCED",
      ),
    ).toBeUndefined();
    expect(
      result.issues.find(
        (candidate) => candidate.code === "HOST_LIFECYCLE_POLICY_UNREADABLE",
      ),
    ).toBeUndefined();
    expect(result.lifecycle.supervisor.liveness).not.toBe("stale");
    expect(result.lifecycle.supervisor.enforcesLifecyclePolicy).toBe(true);
  });

  it("neither issue fires for mode 'background' (default, no policy file) regardless of supervisor state", async () => {
    stageQuietEnvironment("running");
    writeLivePidJson();
    // No policy file - defaults to background.
    writeSupervisor({ pid: 999_999, capabilities: [] });

    const result = await runDoctorHere();

    expect(
      result.issues.find(
        (candidate) => candidate.code === "HOST_LIFECYCLE_POLICY_NOT_ENFORCED",
      ),
    ).toBeUndefined();
    expect(
      result.issues.find(
        (candidate) => candidate.code === "HOST_LIFECYCLE_POLICY_UNREADABLE",
      ),
    ).toBeUndefined();
    expect(result.lifecycle.policy.state).toBe("absent");
    expect(result.lifecycle.policy.mode).toBe("background");
  });

  it("neither issue fires for mode 'background' even with a live enforcing supervisor", async () => {
    stageQuietEnvironment("running");
    writeLivePidJson();
    writePolicy("background");
    writeSupervisor({
      pid: process.pid,
      capabilities: ["lifecycle-policy-v1"],
    });

    const result = await runDoctorHere();

    expect(
      result.issues.find(
        (candidate) => candidate.code === "HOST_LIFECYCLE_POLICY_NOT_ENFORCED",
      ),
    ).toBeUndefined();
    expect(result.lifecycle.policy.mode).toBe("background");
  });

  it("populates result.lifecycle on every run, whatever the policy state", async () => {
    stageQuietEnvironment("stopped");
    // No lifecycle files at all - the quietest possible state.
    const result = await runDoctorHere();

    expect(result.lifecycle).toBeDefined();
    expect(result.lifecycle.policy).toBeDefined();
    expect(result.lifecycle.presence).toBeDefined();
    expect(result.lifecycle.supervisor).toBeDefined();
    expect(result.lifecycle.owner).toBeDefined();
  });
});
