import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Doctor's `SERVICE_STOPPED` issue used to surface
// `traycer host start --environment …` as both the GUI `fixAction` and
// the copyable terminal command. That's the wrong recovery path for a
// user-facing shell: `host start` is the OS-service supervisor
// entrypoint (launchd / systemd-user / Windows Scheduled Task)
// - running it from an interactive shell blocks the terminal until
// the user kills it AND risks racing the OS-managed supervisor for
// the same socket.
//
// The fix here: keep `fixAction: "host-start"` (the GUI label
// remains user-friendly; Desktop's CLI bridge maps that key to
// `restartHost()` which is the safe path) but rewrite the
// copyable `terminalCommand` to `traycer host restart …`, the
// idempotent CLI-owned service-control command. This isolation test
// pins the contract by stubbing every other doctor data source so
// the SERVICE_STOPPED branch is the only signal in the result.

// `store/paths` binds its home root from `os.homedir()` at module load.
// Keep the environment mutation below, but redirect `homedir()` too.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-stopped-test-"));
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
  vi.doUnmock("../../host/pid-metadata");
  vi.doUnmock("../../service");
  vi.doUnmock("../../store/cli-lock");
});

interface StageServiceMocksInput {
  readonly hostExecutablePath: string;
  readonly serviceState: "stopped" | "not-installed" | "externally-managed";
  readonly pidMetadata: {
    readonly pid: number;
    readonly hostId: string;
    readonly version: string;
    readonly websocketUrl: string;
    readonly startedAt: string;
  } | null;
}

function stageServiceMocks(input: StageServiceMocksInput): void {
  vi.doMock("../../manifest/host-install", () => ({
    readHostInstallRecord: () => ({
      version: "1.4.0",
      environment: "production",
      executablePath: input.hostExecutablePath,
      installedAt: "2026-04-01T00:00:00Z",
      source: "registry",
      archiveSha256: "f".repeat(64),
      signatureKeyId: "registry:prod-2026",
    }),
  }));
  vi.doMock("../../host/bootstrap-log", () => ({
    readBootstrapMarkers: async () => [],
  }));
  // `pidMetadata === null` while the service does not report running
  // suppresses the PID_METADATA_MISSING branch. That leaves the service
  // issue as the only issue in the result other than the unverified-binary
  // info (skipped because the install record's signatureKeyId is a registry
  // key).
  vi.doMock("../../host/pid-metadata", () => ({
    readHostPidMetadata: async () => input.pidMetadata,
  }));
  vi.doMock("../../service", () => ({
    createServiceController: () => ({
      status: async () => ({
        state: input.serviceState,
        version: "1.4.0",
        listenUrl: null,
        pid: null,
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

describe("runDoctor SERVICE_STOPPED recovery routing", () => {
  it("emits SERVICE_STOPPED with the safe `host restart` terminal command", async () => {
    const hostExecutablePath = join(workHome, "bin", "host");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(hostExecutablePath, "host-bin");
    stageServiceMocks({
      hostExecutablePath,
      serviceState: "stopped",
      pidMetadata: null,
    });

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });
    const issue = result.issues.find((i) => i.code === "SERVICE_STOPPED");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    // GUI label stays user-friendly - Desktop's CLI bridge maps
    // `host-start` to `restartHost()` (the safe path).
    expect(issue?.fixAction).toBe("host-start");
    // The copyable terminal command MUST NOT invoke the long-running
    // supervisor entrypoint directly.
    expect(issue?.terminalCommand).not.toMatch(/^traycer host start\b/);
    // …and MUST route to the idempotent service-control restart. The command
    // is environment-agnostic now - the CLI resolves its slot from
    // config.environment, so no --environment is appended.
    expect(issue?.terminalCommand).toBe("traycer host restart");
    expect(issue?.details).toMatchObject({
      label: "ai.traycer.host.production",
    });
  });

  it("surfaces the active environment's service label in the issue details", async () => {
    const hostExecutablePath = join(workHome, "bin", "host");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(hostExecutablePath, "host-bin");
    stageServiceMocks({
      hostExecutablePath,
      serviceState: "stopped",
      pidMetadata: null,
    });

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "dev",
      portConflictDeps: null,
    });
    const issue = result.issues.find((i) => i.code === "SERVICE_STOPPED");
    expect(issue).toBeDefined();
    // The recovery command is environment-agnostic; the dev slot shows up in the
    // service label, not the command.
    expect(issue?.terminalCommand).toBe("traycer host restart");
    expect(issue?.details).toMatchObject({ label: "ai.traycer.host.dev" });
  });

  it("does not emit SERVICE_STOPPED when pid metadata proves a host process is running", async () => {
    const hostExecutablePath = join(workHome, "bin", "host");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(hostExecutablePath, "host-bin");
    stageServiceMocks({
      hostExecutablePath,
      serviceState: "stopped",
      pidMetadata: {
        pid: process.pid,
        hostId: "host-live",
        version: "1.4.0",
        websocketUrl: "ws://127.0.0.1/rpc",
        startedAt: "2026-04-01T00:00:00Z",
      },
    });

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "staging",
      portConflictDeps: null,
    });

    expect(
      result.issues.find((i) => i.code === "SERVICE_STOPPED"),
    ).toBeUndefined();
    expect(
      result.issues.find((i) => i.code === "PORT_UNREACHABLE"),
    ).toBeDefined();
  });

  it("emits an info-only SERVICE_EXTERNALLY_MANAGED card (no fix) for a Desktop/SMAppService-owned label instead of the not-registered error", async () => {
    // The old behavior surfaced SERVICE_NOT_REGISTERED (error) whose
    // suggested fix - `traycer host service install` - refuses
    // SMAppService-owned labels by design: a permanent error card with no
    // working fix on every Desktop-managed machine.
    const hostExecutablePath = join(workHome, "bin", "host");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(hostExecutablePath, "host-bin");
    stageServiceMocks({
      hostExecutablePath,
      serviceState: "externally-managed",
      pidMetadata: null,
    });

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });

    expect(
      result.issues.find((i) => i.code === "SERVICE_NOT_REGISTERED"),
    ).toBeUndefined();
    expect(
      result.issues.find((i) => i.code === "SERVICE_STOPPED"),
    ).toBeUndefined();
    const issue = result.issues.find(
      (i) => i.code === "SERVICE_EXTERNALLY_MANAGED",
    );
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("info");
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).toBeNull();
  });

  it("still emits SERVICE_NOT_REGISTERED when pid metadata proves a host process is running", async () => {
    const hostExecutablePath = join(workHome, "bin", "host");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(hostExecutablePath, "host-bin");
    stageServiceMocks({
      hostExecutablePath,
      serviceState: "not-installed",
      pidMetadata: {
        pid: process.pid,
        hostId: "host-live",
        version: "1.4.0",
        websocketUrl: "ws://127.0.0.1/rpc",
        startedAt: "2026-04-01T00:00:00Z",
      },
    });

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "staging",
      portConflictDeps: null,
    });

    const issue = result.issues.find(
      (i) => i.code === "SERVICE_NOT_REGISTERED",
    );
    expect(issue).toBeDefined();
    expect(issue?.terminalCommand).toBe("traycer host service install");
  });

  it("suppresses the PID_METADATA_STALE fix action for a Desktop/SMAppService-owned label", async () => {
    // Desktop's SMAppService owns registration+recovery for an
    // externally-managed label. A stale pid.json here must still surface
    // the diagnostic, but `traycer host restart` is the CLI's own service
    // control command and must not be offered - it's the wrong recovery
    // path for a job the CLI doesn't manage.
    const hostExecutablePath = join(workHome, "bin", "host");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(hostExecutablePath, "host-bin");
    stageServiceMocks({
      hostExecutablePath,
      serviceState: "externally-managed",
      pidMetadata: {
        pid: 999_999,
        hostId: "host-stale",
        version: "1.4.0",
        websocketUrl: "ws://127.0.0.1/rpc",
        startedAt: "2026-04-01T00:00:00Z",
      },
    });
    vi.doMock("../../store/cli-lock", () => ({
      isProcessAlive: () => false,
    }));

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });

    const issue = result.issues.find((i) => i.code === "PID_METADATA_STALE");
    expect(issue).toBeDefined();
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).toBeNull();
  });
});
