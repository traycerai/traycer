import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// traycer#1563 D3c: a host whose event loop is wedged still owns its port.
// The kernel completes the TCP accept, the WebSocket upgrade never answers,
// and every product path that needs the host's RPC stalls with it. Doctor
// runs in its own process and must name that state for what it is - the pid
// alive, the RPC unresponsive and for how long - and hand the person the one
// command that ends it: the force restart, which escalates to SIGKILL. Today
// it reports a generic "not answering RPC" and suggests a plain
// `traycer host restart`.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;
let server: Server;
const sockets: Socket[] = [];
let port = 0;

beforeEach(async () => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-hung-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  // Accepts and stays silent, as the wedged host's listener does.
  server = createServer((socket) => {
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
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
  vi.doUnmock("../../internal/host-auth");
  vi.doUnmock("../../internal/host-rpc");
});

type ProbeFailure = "transport" | "envelope";

/**
 * `transport`: nothing answered (the wedged host). `envelope`: the host
 * answered the RPC with an error, so it is serving.
 */
function stageWedgedHost(websocketUrl: string, failure: ProbeFailure): void {
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
  vi.doMock("../../host/pid-metadata", async () => {
    const actual = await vi.importActual<
      typeof import("../../host/pid-metadata")
    >("../../host/pid-metadata");
    return {
      ...actual,
      readHostPidMetadata: async () => ({
        pid: process.pid,
        version: "1.0.0",
        websocketUrl,
      }),
    };
  });
  vi.doMock("../../service", () => ({
    createServiceController: () => ({
      status: async () => ({
        state: "running",
        version: "1.0.0",
        listenUrl: websocketUrl,
        pid: process.pid,
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
  vi.doMock("../../commands/cli-upgrade", () => ({
    readPendingCliUpgrade: () => null,
    pendingUpgradeFinalisable: () => false,
  }));
  vi.doMock("../../upgrade/finalize-helper", () => ({
    readPostFinalizeMarker: async () => ({ status: "absent" }),
  }));
  vi.doMock("../../internal/host-auth", () => ({
    resolveHostAuth: async () => ({
      token: "bearer",
      authnBaseUrl: "http://127.0.0.1:1",
      userId: "u",
    }),
  }));
  // The dial and frame budgets take tens of seconds against a silent
  // listener; the probe's outcome is the same failure, delivered now.
  vi.doMock("../../internal/host-rpc", async () => {
    const actual = await vi.importActual<
      typeof import("../../internal/host-rpc")
    >("../../internal/host-rpc");
    const { HostRpcError, HostTransportFailureError } =
      await import("../../../../shared/host-transport/host-messenger");
    const FailureError =
      failure === "transport" ? HostTransportFailureError : HostRpcError;
    return {
      ...actual,
      callHostRpcAtEndpoint: async () => {
        throw new FailureError({
          code: "RPC_ERROR",
          message: "frame timeout",
          requestId: "r1",
          method: "host.status",
          fatalDetails: null,
        });
      },
    };
  });
}

describe("runDoctor against a wedged host (traycer#1563 D3c)", () => {
  it("control: the harness reaches the RPC branch (today's generic verdict)", async () => {
    stageWedgedHost(`ws://127.0.0.1:${port}/rpc`, "transport");
    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: {
        platform: "darwin",
        runCommand: async () => null,
      },
    });

    // Before the fix this branch reported "Host endpoint not answering RPC";
    // either way an error issue for the endpoint is present.
    expect(
      result.issues.find(
        (issue) =>
          issue.title === "Host endpoint not answering RPC" ||
          issue.code === "HOST_RPC_UNRESPONSIVE",
      ),
    ).toBeDefined();
  });

  it("reports the pid alive not responding and its log last changed N min ago, and names the force restart", async () => {
    stageWedgedHost(`ws://127.0.0.1:${port}/rpc`, "transport");
    // The wedged host stopped writing its log twelve minutes ago.
    const { hostLogPath } = await import("../../store/paths");
    const logPath = hostLogPath("production");
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "last line\n");
    const silentSince = new Date(Date.now() - 12 * 60_000 - 5_000);
    utimesSync(logPath, silentSince, silentSince);
    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: {
        platform: "darwin",
        runCommand: async () => null,
      },
    });

    const hung = result.issues.find(
      (issue) =>
        issue.message.includes(`pid=${process.pid}`) ||
        issue.message.includes(`PID ${process.pid}`),
    );
    expect(hung).toBeDefined();
    expect(hung?.code).toBe("HOST_RPC_UNRESPONSIVE");
    expect(hung?.message).toContain(
      "is not responding (its log last changed 12 min ago)",
    );
    expect(hung?.terminalCommand).toBe("traycer host restart --force");
    expect(hung?.fixAction).toBe("host-restart");
  });

  it("says the log changed under a minute ago when it was just written", async () => {
    stageWedgedHost(`ws://127.0.0.1:${port}/rpc`, "transport");
    const { hostLogPath } = await import("../../store/paths");
    const logPath = hostLogPath("production");
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "last line\n");
    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: {
        platform: "darwin",
        runCommand: async () => null,
      },
    });

    const hung = result.issues.find(
      (issue) => issue.code === "HOST_RPC_UNRESPONSIVE",
    );
    expect(hung?.message).toContain(
      "is not responding (its log last changed under 1 min ago)",
    );
  });

  it("still reports the unresponsive host, without a duration, when its log cannot be read", async () => {
    stageWedgedHost(`ws://127.0.0.1:${port}/rpc`, "transport");
    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: {
        platform: "darwin",
        runCommand: async () => null,
      },
    });

    const hung = result.issues.find(
      (issue) => issue.code === "HOST_RPC_UNRESPONSIVE",
    );
    expect(hung?.message).toContain(`pid=${process.pid}`);
    expect(hung?.message).toContain("is not responding");
    expect(hung?.message).not.toContain("log last changed");
    expect(hung?.terminalCommand).toBe("traycer host restart --force");
  });

  it("keeps the generic restart advice when the host answered the RPC with an error", async () => {
    stageWedgedHost(`ws://127.0.0.1:${port}/rpc`, "envelope");
    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: {
        platform: "darwin",
        runCommand: async () => null,
      },
    });

    expect(
      result.issues.find((issue) => issue.code === "HOST_RPC_UNRESPONSIVE"),
    ).toBeUndefined();
    const generic = result.issues.find(
      (issue) => issue.title === "Host endpoint not answering RPC",
    );
    expect(generic?.code).toBe("PORT_UNREACHABLE");
    expect(generic?.terminalCommand).toBe("traycer host restart");
    expect(generic?.message).not.toContain("--force");
  });
});
