import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wiring pin: `probeUpdateMarkerLock` existing is not the same thing as
// runDoctor consulting it. This mocks the probe module and asserts its
// issue reaches the issue list, and that the engine hands it the marker
// lock path of the environment it was asked about.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-marker-lock-wiring-"));
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
  vi.doUnmock("../update-marker-lock");
  vi.doUnmock("../launchd-wedge");
  vi.doUnmock("../systemd-health");
  vi.doUnmock("../../manifest/host-install");
  vi.doUnmock("../../host/bootstrap-log");
  vi.doUnmock("../../host/pid-metadata");
  vi.doUnmock("../../service");
});

describe("runDoctor progress-marker lock wiring", () => {
  it("surfaces the marker-lock probe's issue in the doctor result, probing the environment's lock path", async () => {
    const hostExecutablePath = join(workHome, "bin", "host");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(hostExecutablePath, "host-bin");
    vi.doMock("../../manifest/host-install", () => ({
      readHostInstallRecord: () => ({
        version: "1.4.0",
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
    vi.doMock("../../host/pid-metadata", () => ({
      readHostPidMetadata: async () => null,
    }));
    vi.doMock("../../service", () => ({
      createServiceController: () => ({
        status: async () => ({
          state: "externally-managed",
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
    vi.doMock("../launchd-wedge", () => ({
      createRealLaunchdPrintRunner: () => async () => {
        throw new Error("real runner must not be invoked in this test");
      },
      probeMacosWedgedJob: async () => null,
    }));
    vi.doMock("../systemd-health", () => ({
      createRealSystemdProbeRunner: () => async () => {
        throw new Error("real runner must not be invoked in this test");
      },
      probeLinuxSystemdHealth: async () => [],
    }));
    const probeCalls: { lockPath: string }[] = [];
    vi.doMock("../update-marker-lock", () => ({
      MARKER_LOCK_RECHECK_DELAY_MS: 250,
      probeUpdateMarkerLock: async (opts: { lockPath: string }) => {
        probeCalls.push({ lockPath: opts.lockPath });
        return {
          code: "HOST_UPDATE_MARKER_LOCK_HELD",
          severity: "warning",
          title: "stubbed marker lock issue",
          message: "stubbed marker lock issue",
          fixAction: null,
          terminalCommand: null,
          details: { lockPath: opts.lockPath },
        };
      },
    }));

    const { runDoctor } = await import("../engine");
    const { hostUpdateProgressMarkerLockPath } =
      await import("../../store/paths");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });

    const issue = result.issues.find(
      (i) => i.code === "HOST_UPDATE_MARKER_LOCK_HELD",
    );
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(probeCalls).toEqual([
      { lockPath: hostUpdateProgressMarkerLockPath("production") },
    ]);
  });
});
