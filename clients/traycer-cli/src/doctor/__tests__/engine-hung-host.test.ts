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
import type { DoctorResult } from "..";
import type { HostNotYetErrors } from "./host-not-yet-errors";

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
 * What the host answers `host.status` on each attempt, given the attempt's
 * index. The errors are built inside the staged module registry, so the
 * classes are the ones the engine tests against.
 */
type HostStatusScript = (
  attempt: number,
  errors: HostNotYetErrors,
) => Promise<unknown>;

/**
 * `transport`: nothing answered (the wedged host). `envelope`: the host
 * answered the RPC with an error, so it is serving.
 */
function stageWedgedHost(
  websocketUrl: string,
  failure: ProbeFailure | HostStatusScript,
): void {
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
    let attempt = 0;
    return {
      ...actual,
      callHostRpcAtEndpoint: async () => {
        if (typeof failure === "function") {
          const { hostNotYetErrors } = await import("./host-not-yet-errors");
          return failure(attempt++, hostNotYetErrors);
        }
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

const FORCE_RESTART_COMMAND = "traycer host restart --force";

/**
 * Runs doctor on a clock the test drives: the retry wait is a faked timer, and
 * everything else doctor reads (files, the listening socket) answers on real
 * macrotask turns between the steps.
 */
async function runDoctorOnFakeClock(): Promise<DoctorResult> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { runDoctor } = await import("../engine");
  let settled = false;
  const pending = runDoctor({
    environment: "production",
    portConflictDeps: { platform: "darwin", runCommand: async () => null },
  }).finally(() => {
    settled = true;
  });
  for (let step = 0; step < 400 && !settled; step += 1) {
    await vi.advanceTimersByTimeAsync(50);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  return pending;
}

function probeIssueCodes(
  issues: readonly { readonly code: string }[],
): readonly string[] {
  return issues
    .map((issue) => issue.code)
    .filter((code) =>
      [
        "HOST_RPC_UNRESPONSIVE",
        "HOST_RPC_UNAUTHORIZED",
        "PORT_UNREACHABLE",
      ].includes(code),
    );
}

describe("runDoctor against a host that answers not yet", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { form: "a retryable error on a request", pick: "notYetOnRequest" },
    { form: "a retryable refusal at the open", pick: "notYetAtOpen" },
  ] as const)(
    "asks again every half second while the host answers $form, and reports nothing of the probe once it is ready",
    async ({ pick }) => {
      const attempts: number[] = [];
      stageWedgedHost(`ws://127.0.0.1:${port}/rpc`, async (attempt, errors) => {
        attempts.push(Date.now());
        if (attempt < 2) throw errors[pick]("host.status");
        return { crossHostMessaging: null };
      });

      const result = await runDoctorOnFakeClock();

      expect(attempts).toHaveLength(3);
      expect(attempts[1] - attempts[0]).toBe(500);
      expect(attempts[2] - attempts[1]).toBe(500);
      expect(probeIssueCodes(result.issues)).toEqual([]);
    },
  );

  it.each([
    { form: "a retryable error on a request", pick: "notYetOnRequest" },
    { form: "a retryable refusal at the open", pick: "notYetAtOpen" },
    { form: "a post-open request timeout", pick: "requestTimeout" },
  ] as const)(
    "stops asking five seconds after the first attempt when the host still answers $form, and raises no issue for the probe",
    async ({ pick }) => {
      const attempts: number[] = [];
      stageWedgedHost(
        `ws://127.0.0.1:${port}/rpc`,
        async (_attempt, errors) => {
          attempts.push(Date.now());
          throw errors[pick]("host.status");
        },
      );

      const result = await runDoctorOnFakeClock();

      // Ten asks, half a second apart; none starts at or after the bound.
      expect(attempts).toHaveLength(10);
      expect(attempts[9] - attempts[0]).toBe(4_500);
      expect(probeIssueCodes(result.issues)).toEqual([]);
      expect(JSON.stringify(result.issues)).not.toContain(
        FORCE_RESTART_COMMAND,
      );
    },
  );

  it("measures the bound from the first attempt, so a first attempt that takes 4.8 s is the last", async () => {
    const attempts: number[] = [];
    stageWedgedHost(`ws://127.0.0.1:${port}/rpc`, async (_attempt, errors) => {
      attempts.push(Date.now());
      vi.setSystemTime(Date.now() + 4_800);
      throw errors.notYetOnRequest("host.status");
    });

    const result = await runDoctorOnFakeClock();

    expect(attempts).toHaveLength(1);
    expect(probeIssueCodes(result.issues)).toEqual([]);
  });

  it.each([
    { name: "did not answer", pick: "silent" },
    {
      name: "timed out after the open as a host through 1.1.9 says it",
      pick: "legacyRequestTimeout",
    },
  ] as const)(
    "still reports a host that $name as unresponsive, after one attempt and no wait",
    async ({ pick }) => {
      const attempts: number[] = [];
      stageWedgedHost(
        `ws://127.0.0.1:${port}/rpc`,
        async (_attempt, errors) => {
          attempts.push(Date.now());
          throw errors[pick]("host.status");
        },
      );

      const result = await runDoctorOnFakeClock();

      expect(attempts).toHaveLength(1);
      const hung = result.issues.find(
        (issue) => issue.code === "HOST_RPC_UNRESPONSIVE",
      );
      expect(hung?.message).toContain(`pid=${process.pid}`);
      expect(hung?.message).toContain("is not responding");
      expect(hung?.terminalCommand).toBe(FORCE_RESTART_COMMAND);
      expect(hung?.fixAction).toBe("host-restart");
    },
  );

  it("reports a final refusal as the host rejecting the credentials, after one attempt and no wait", async () => {
    const attempts: number[] = [];
    stageWedgedHost(`ws://127.0.0.1:${port}/rpc`, async (_attempt, errors) => {
      attempts.push(Date.now());
      throw errors.unauthorized("host.status");
    });

    const result = await runDoctorOnFakeClock();

    expect(attempts).toHaveLength(1);
    expect(probeIssueCodes(result.issues)).toEqual(["HOST_RPC_UNAUTHORIZED"]);
  });
});
