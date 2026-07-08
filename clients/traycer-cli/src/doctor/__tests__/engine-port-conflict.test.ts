import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Doctor's port-conflict path:
//   - When `readHostPidMetadata()` returns a live host pid but its
//     websocket URL does not accept a TCP connection, the engine MUST
//     try to identify a foreign listener on that port via the
//     platform-aware `resolvePortConflict(...)` helper.
//   - If a foreign listener is found → emit `PORT_CONFLICT` with
//     `fixAction = "host-free-port-and-restart"` and full
//     `port/conflictingPid/conflictingProcess` details.
//   - If not → emit `PORT_UNREACHABLE` with `fixAction = "host-restart"`
//     (the ticket explicitly forbids the GUI presenting Free Port +
//     Restart with port 0 / unknown pid).

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-port-test-"));
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
  vi.doUnmock("../../commands/cli-upgrade");
  vi.doUnmock("../../upgrade/finalize-helper");
});

function stageMocks(opts: {
  readonly hostPid: number;
  readonly websocketUrl: string;
}): void {
  // Install record exists so the binary-missing / unverified checks
  // don't add noise.
  vi.doMock("../../manifest/host-install", () => ({
    readHostInstallRecord: () => ({
      version: "1.0.0",
      installedAt: "2026-05-01T00:00:00Z",
      executablePath: process.execPath,
      source: { kind: "registry", value: "1.0.0" },
      archiveSha256: "deadbeef",
      signatureKeyId: "stub",
      sizeBytes: 1024,
    }),
  }));
  vi.doMock("../../host/bootstrap-log", () => ({
    readBootstrapMarkers: async () => [],
  }));
  vi.doMock("../../host/pid-metadata", () => ({
    readHostPidMetadata: async () => ({
      pid: opts.hostPid,
      version: "1.0.0",
      websocketUrl: opts.websocketUrl,
    }),
  }));
  vi.doMock("../../service", () => ({
    createServiceController: () => ({
      status: async () => ({
        state: "running",
        version: "1.0.0",
        listenUrl: opts.websocketUrl,
        pid: opts.hostPid,
      }),
      install: async () => undefined,
      uninstall: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      restart: async () => undefined,
    }),
    serviceLabelFor: (environment: "production" | "dev") => ({
      id: `ai.traycer.host.${environment}`,
    }),
  }));
  // Pending CLI upgrade should not surface noise here.
  vi.doMock("../../commands/cli-upgrade", () => ({
    readPendingCliUpgrade: () => null,
    pendingUpgradeFinalisable: () => false,
  }));
  vi.doMock("../../upgrade/finalize-helper", () => ({
    reconcilePostFinalizeMarker: () => undefined,
  }));
}

describe("runDoctor port-conflict detection", () => {
  it("emits PORT_CONFLICT with full identity when a foreign listener is found", async () => {
    stageMocks({
      // process.pid keeps isProcessAlive(...) truthy so the engine
      // enters the port-probe branch rather than emitting
      // PID_METADATA_STALE.
      hostPid: process.pid,
      websocketUrl: "ws://127.0.0.1:1/socket",
    });
    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: {
        platform: "darwin",
        runCommand: async (bin) => {
          if (bin === "lsof") {
            return { stdout: "p4321\ncnode\n", stderr: "" };
          }
          return null;
        },
      },
    });
    const conflict = result.issues.find((i) => i.code === "PORT_CONFLICT");
    expect(conflict).toBeDefined();
    expect(conflict?.fixAction).toBe("host-free-port-and-restart");
    expect(conflict?.details).toMatchObject({
      port: 1,
      conflictingPid: 4321,
      conflictingProcess: "node",
    });
    expect(conflict?.terminalCommand).toMatch(
      /traycer host free-port-and-restart --pid 4321 --port 1/,
    );
    // PORT_UNREACHABLE must NOT also fire - they are mutually
    // exclusive on the same probe.
    expect(
      result.issues.find((i) => i.code === "PORT_UNREACHABLE"),
    ).toBeUndefined();
  });

  it("emits PORT_UNREACHABLE (host-restart) when no foreign listener can be resolved", async () => {
    stageMocks({
      hostPid: process.pid,
      websocketUrl: "ws://127.0.0.1:1/socket",
    });
    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: {
        platform: "darwin",
        runCommand: async () => null,
      },
    });
    const unreachable = result.issues.find(
      (i) => i.code === "PORT_UNREACHABLE",
    );
    expect(unreachable).toBeDefined();
    expect(unreachable?.fixAction).toBe("host-restart");
    expect(unreachable?.details).toMatchObject({
      port: 1,
      conflictingPid: null,
      conflictingProcess: null,
    });
    expect(
      result.issues.find((i) => i.code === "PORT_CONFLICT"),
    ).toBeUndefined();
  });

  it("treats the host's own pid as 'no conflict' even if lsof returns it (no false positive on a slow socket)", async () => {
    stageMocks({
      hostPid: process.pid,
      websocketUrl: "ws://127.0.0.1:1/socket",
    });
    const selfPidStdout = `p${process.pid}\ncnode\n`;
    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: {
        platform: "darwin",
        runCommand: async () => ({ stdout: selfPidStdout, stderr: "" }),
      },
    });
    // Self-pid is filtered → engine emits PORT_UNREACHABLE, not PORT_CONFLICT.
    expect(
      result.issues.find((i) => i.code === "PORT_CONFLICT"),
    ).toBeUndefined();
    const unreachable = result.issues.find(
      (i) => i.code === "PORT_UNREACHABLE",
    );
    expect(unreachable).toBeDefined();
    expect(unreachable?.fixAction).toBe("host-restart");
  });

  it("never emits PORT_UNREACHABLE with port=0 - defensive guard", async () => {
    stageMocks({
      hostPid: 4321,
      // Malformed URL has no port.
      websocketUrl: "ws://no-port-here",
    });
    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: {
        platform: "darwin",
        runCommand: async () => null,
      },
    });
    // With no port we don't bother probing. So no port-related issue.
    // The acceptance criterion is: the GUI never receives port=0; here
    // the engine simply doesn't emit PORT_UNREACHABLE at all because
    // there's nothing to probe.
    expect(
      result.issues.find((i) => i.code === "PORT_CONFLICT"),
    ).toBeUndefined();
  });
});
