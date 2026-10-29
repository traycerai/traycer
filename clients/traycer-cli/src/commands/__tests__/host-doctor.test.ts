import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  acquireLock,
  type LockHandle,
} from "@traycer-clients/shared/host-lock/cross-process-lock";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { HostTransportFailureError } from "@traycer/protocol/host-transport/remote/rpc-types";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import type { DoctorIssueCode, DoctorResult } from "../../doctor";
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance";
import type { HostLifecycleSnapshot } from "../../host/lifecycle-snapshot";
import { config } from "../../config";
import { hostDoctorLeasePath, hostHomeDir } from "../../store/paths";

// `hostDoctorCommand` (`../host-doctor.ts`) is a thin wrapper: it calls
// `runDoctor` and renders `DoctorResult` (issues + the lifecycle facts) as
// human text. `runDoctor` itself is exercised end-to-end by
// `src/doctor/__tests__/engine-*.test.ts`; this file pins the command's own
// contract - the human report always carries the "Lifecycle" section the
// engine's facts are rendered into, and it names a corrupt policy file as
// corrupt - the same way `host-status-observational.test.ts` mocks
// `readHostLifecycleSnapshot` rather than re-deriving a `DoctorResult` from
// scratch.

// HOME is redirected to a private temp dir BEFORE anything reads it:
// `store/paths` binds `homedir()` at module load, so without this the suite
// would resolve this machine's REAL `~/.traycer`.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-host-doctor-test-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

const mocks = vi.hoisted(() => ({
  runDoctorMock: vi.fn(),
  readHostPidMetadataMock: vi.fn(),
  callHostRpcMock: vi.fn(),
}));

vi.mock("../../host/pid-metadata", async () => {
  const actual = await vi.importActual<
    typeof import("../../host/pid-metadata")
  >("../../host/pid-metadata");
  return { ...actual, readHostPidMetadata: mocks.readHostPidMetadataMock };
});

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return { ...actual, callHostRpcWithDispatch: mocks.callHostRpcMock };
});

vi.mock("../../doctor", async () => {
  const actual =
    await vi.importActual<typeof import("../../doctor")>("../../doctor");
  return {
    ...actual,
    runDoctor: mocks.runDoctorMock,
  };
});

import { hostDoctorCommand } from "../host-doctor";

function makeRuntime(): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
  };
}

function makeCtx(): CommandContext {
  return {
    runtime: makeRuntime(),
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

const quietLifecycleSnapshot: HostLifecycleSnapshot = {
  policy: {
    state: "absent",
    mode: "background",
    rev: null,
    updatedAt: null,
    updatedBy: null,
    path: "/tmp/lifecycle-policy.json",
  },
  presence: {
    state: "absent",
    pid: null,
    onExit: null,
    policyRev: null,
    liveness: null,
  },
  supervisor: {
    state: "absent",
    pid: null,
    cliVersion: null,
    capabilities: [],
    liveness: null,
    enforcesLifecyclePolicy: false,
  },
  run: null,
  owner: { kind: "unknown" },
};

function doctorResult(overrides: Partial<DoctorResult>): DoctorResult {
  return {
    issues: [],
    lifecycle: quietLifecycleSnapshot,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runDoctorMock.mockResolvedValue(doctorResult({}));
  mocks.readHostPidMetadataMock.mockResolvedValue(null);
  mocks.callHostRpcMock.mockRejectedValue(new Error("no host"));
  mkdirSync(hostHomeDir(config.environment), { recursive: true });
  rmSync(hostDoctorLeasePath(config.environment), { force: true });
});

describe("hostDoctorCommand human output", () => {
  it("includes the 'Lifecycle' section even with no issues", async () => {
    const result = await hostDoctorCommand(makeCtx());

    expect(result.human).toContain("Lifecycle:");
    expect(result.human).toContain("Lifecycle mode");
    expect(result.exitCode).toBe(0);
  });

  it("names a corrupt lifecycle policy file as corrupt in the report", async () => {
    mocks.runDoctorMock.mockResolvedValue(
      doctorResult({
        issues: [
          {
            code: "HOST_LIFECYCLE_POLICY_UNREADABLE",
            severity: "warning",
            title: "Host lifecycle policy file is corrupt",
            message:
              "/tmp/lifecycle-policy.json is not a valid lifecycle policy, so the host runs in Background mode.",
            fixAction: null,
            terminalCommand: "traycer host lifecycle set background",
            details: { path: "/tmp/lifecycle-policy.json", state: "invalid" },
          },
        ],
        lifecycle: {
          ...quietLifecycleSnapshot,
          policy: {
            ...quietLifecycleSnapshot.policy,
            state: "invalid",
            path: "/tmp/lifecycle-policy.json",
          },
        },
      }),
    );

    const result = await hostDoctorCommand(makeCtx());

    expect(result.human).toContain("Lifecycle:");
    // Pins the Lifecycle row's OWN rendered text (lifecycle-snapshot.ts
    // describePolicy's "invalid" branch), not just the substring "corrupt" -
    // which the injected issue's title also contains and would satisfy even
    // if this row stopped naming the policy file corrupt.
    expect(result.human).toContain("Lifecycle mode");
    expect(result.human).toContain(
      "(the policy file is corrupt and reads as background)",
    );
    // Also surfaced as a top-level issue, not just folded into the facts.
    expect(result.human).toContain("HOST_LIFECYCLE_POLICY_UNREADABLE");
    expect(result.exitCode).toBe(0);
  });

  it("exits non-zero when an issue is error or fatal severity", async () => {
    mocks.runDoctorMock.mockResolvedValue(
      doctorResult({
        issues: [
          {
            code: "HOST_NOT_INSTALLED",
            severity: "error",
            title: "Host not installed",
            message: "No host is installed.",
            fixAction: "host-install-latest",
            terminalCommand: "traycer host install",
            details: null,
          },
        ],
      }),
    );

    const result = await hostDoctorCommand(makeCtx());

    expect(result.exitCode).toBe(1);
  });
});

const LOCAL_ONLY_NOTICE =
  "Checked on this machine only; problems only the running host can see may be missing.";

function issue(
  code: DoctorIssueCode,
  severity: HostDoctorIssue["severity"],
): DoctorResult["issues"][number] {
  return { ...hostIssue(code, severity), code };
}

function hostIssue(
  code: string,
  severity: HostDoctorIssue["severity"],
): HostDoctorIssue {
  return {
    code,
    severity,
    title: `title of ${code}`,
    message: `message of ${code}`,
    fixAction: null,
    terminalCommand: null,
    details: null,
  };
}

function firstLine(human: string | null): string | undefined {
  return human?.split("\n")[0];
}

function hostMetadata(pid: number) {
  return {
    pid,
    hostId: "host-1",
    version: "1.0.0",
    websocketUrl: "ws://127.0.0.1:1",
    startedAt: "2026-01-01T00:00:00.000Z",
    processStartIdentity: null,
  };
}

function hostOk(issues: readonly HostDoctorIssue[]) {
  return { status: "ok", issues, triviallyGreenIssueCodes: [] };
}

const otherHostPid = process.ppid + 1;

describe("hostDoctorCommand asks the running host", () => {
  beforeEach(() => {
    mocks.readHostPidMetadataMock.mockResolvedValue(hostMetadata(otherHostPid));
  });

  it("reports an error only the host knows, with the local lifecycle and no notice", async () => {
    const lifecycle: HostLifecycleSnapshot = {
      ...quietLifecycleSnapshot,
      policy: { ...quietLifecycleSnapshot.policy, mode: "linked" },
    };
    mocks.runDoctorMock.mockResolvedValue(doctorResult({ lifecycle }));
    const credentialIssue = hostIssue("HOST_CREDENTIAL_SAVE_FAILED", "error");
    mocks.callHostRpcMock.mockResolvedValue(hostOk([credentialIssue]));

    const result = await hostDoctorCommand(makeCtx());

    expect(mocks.callHostRpcMock).toHaveBeenCalledWith(
      "host.doctor",
      {},
      expect.objectContaining({ failFast: true }),
    );
    expect(result.data).toEqual({ issues: [credentialIssue], lifecycle });
    expect(result.human).toContain("HOST_CREDENTIAL_SAVE_FAILED");
    expect(result.human).not.toContain(LOCAL_ONLY_NOTICE);
    expect(result.exitCode).toBe(1);
  });

  it("lets the host's warning-only list replace a local error", async () => {
    mocks.runDoctorMock.mockResolvedValue(
      doctorResult({ issues: [issue("HOST_NOT_INSTALLED", "error")] }),
    );
    const credentialIssue = hostIssue("HOST_CREDENTIAL_MISSING", "warning");
    mocks.callHostRpcMock.mockResolvedValue(hostOk([credentialIssue]));

    const result = await hostDoctorCommand(makeCtx());

    expect(result.data).toMatchObject({ issues: [credentialIssue] });
    expect(result.human).not.toContain("HOST_NOT_INSTALLED");
    expect(result.human).not.toContain(LOCAL_ONLY_NOTICE);
    expect(result.exitCode).toBe(0);
  });

  const requestFailure = new HostTransportFailureError({
    code: "RPC_ERROR",
    message: "socket closed",
    requestId: "r1",
    method: "host.doctor",
    fatalDetails: null,
  });
  const fallbacks: ReadonlyArray<{
    name: string;
    arrange: () => void;
  }> = [
    {
      name: "no host is running",
      arrange: () => mocks.readHostPidMetadataMock.mockResolvedValue(null),
    },
    {
      name: "the dial finds no host",
      arrange: () =>
        mocks.callHostRpcMock.mockRejectedValue(
          cliError({
            code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
            message: "not running",
            details: null,
            exitCode: 1,
          }),
        ),
    },
    {
      name: "the user is not signed in",
      arrange: () =>
        mocks.callHostRpcMock.mockRejectedValue(
          cliError({
            code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
            message: "sign in",
            details: null,
            exitCode: 1,
          }),
        ),
    },
    {
      name: "the transport fails",
      arrange: () => mocks.callHostRpcMock.mockRejectedValue(requestFailure),
    },
    {
      name: "the host does not support the method",
      arrange: () =>
        mocks.callHostRpcMock.mockRejectedValue(
          cliError({
            code: CLI_ERROR_CODES.HOST_UNSUPPORTED,
            message: "unsupported",
            details: null,
            exitCode: 1,
          }),
        ),
    },
    {
      name: "the host is incompatible",
      arrange: () =>
        mocks.callHostRpcMock.mockRejectedValue(
          cliError({
            code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
            message: "incompatible",
            details: null,
            exitCode: 1,
          }),
        ),
    },
    ...(["cli-unavailable", "cli-failed", "invalid-output"] as const).map(
      (status) => ({
        name: `the host reports ${status}`,
        arrange: () => mocks.callHostRpcMock.mockResolvedValue({ status }),
      }),
    ),
    {
      name: "the response fails the schema",
      arrange: () =>
        mocks.callHostRpcMock.mockResolvedValue({ status: "ok", issues: 7 }),
    },
    {
      name: "something unexpected is thrown",
      arrange: () => mocks.callHostRpcMock.mockRejectedValue(new Error("boom")),
    },
  ];

  it.each(fallbacks)(
    "reports the local verdict with the notice first when $name",
    async ({ arrange }) => {
      const localIssue = issue("HOST_NOT_INSTALLED", "error");
      mocks.runDoctorMock.mockResolvedValue(
        doctorResult({ issues: [localIssue] }),
      );
      arrange();

      const result = await hostDoctorCommand(makeCtx());

      expect(firstLine(result.human)).toBe(LOCAL_ONLY_NOTICE);
      expect(result.human).toContain("HOST_NOT_INSTALLED");
      expect(result.data).toEqual({
        issues: [localIssue],
        lifecycle: quietLifecycleSnapshot,
      });
      expect(JSON.stringify(result.data)).not.toContain(LOCAL_ONLY_NOTICE);
      expect(result.exitCode).toBe(1);
    },
  );

  it("takes the exit code from local warnings on a fallback", async () => {
    mocks.runDoctorMock.mockResolvedValue(
      doctorResult({
        issues: [issue("HOST_LIFECYCLE_POLICY_UNREADABLE", "warning")],
      }),
    );

    const result = await hostDoctorCommand(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(firstLine(result.human)).toBe(LOCAL_ONLY_NOTICE);
  });

  it("never dials when this run is the host's own spawn", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(hostMetadata(process.ppid));
    mocks.callHostRpcMock.mockResolvedValue(
      hostOk([hostIssue("HOST_CREDENTIAL_SAVE_FAILED", "error")]),
    );
    const localIssue = issue("HOST_LIFECYCLE_POLICY_UNREADABLE", "warning");
    mocks.runDoctorMock.mockResolvedValue(
      doctorResult({ issues: [localIssue] }),
    );

    const result = await hostDoctorCommand(makeCtx());

    expect(mocks.callHostRpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      issues: [localIssue],
      lifecycle: quietLifecycleSnapshot,
    });
    expect(firstLine(result.human)).toBe(LOCAL_ONLY_NOTICE);
    expect(result.exitCode).toBe(0);
  });
});

describe("hostDoctorCommand lease", () => {
  const leasePath = (): string => hostDoctorLeasePath(config.environment);

  beforeEach(() => {
    mocks.readHostPidMetadataMock.mockResolvedValue(hostMetadata(otherHostPid));
    mocks.callHostRpcMock.mockResolvedValue(hostOk([]));
  });

  async function leaseIsFree(): Promise<boolean> {
    const outcome = await acquireLock({
      lockPath: leasePath(),
      reason: "probe",
      waitMs: 0,
      pollIntervalMs: 0,
    });
    if (outcome.kind === "busy") return false;
    await outcome.handle.release();
    return true;
  }

  it("does not dial while a live run holds the lease", async () => {
    const outcome = await acquireLock({
      lockPath: leasePath(),
      reason: "another-host-doctor",
      waitMs: 0,
      pollIntervalMs: 0,
    });
    if (outcome.kind === "busy") throw new Error("lease was not free");
    const held: LockHandle = outcome.handle;
    const localIssue = issue("HOST_NOT_INSTALLED", "error");
    mocks.runDoctorMock.mockResolvedValue(
      doctorResult({ issues: [localIssue] }),
    );
    try {
      const result = await hostDoctorCommand(makeCtx());

      expect(mocks.callHostRpcMock).not.toHaveBeenCalled();
      expect(firstLine(result.human)).toBe(LOCAL_ONLY_NOTICE);
      expect(result.data).toEqual({
        issues: [localIssue],
        lifecycle: quietLifecycleSnapshot,
      });
    } finally {
      await held.release();
    }
  });

  it("takes over a lease left by a dead run and asks the host", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = child.pid;
    if (deadPid === undefined) throw new Error("child did not start");
    await new Promise((resolve) => child.once("exit", resolve));
    writeFileSync(
      leasePath(),
      JSON.stringify({
        pid: deadPid,
        reason: "host-doctor",
        startedAt: new Date().toISOString(),
        token: "dead-owner-token",
      }),
    );
    const hostReported = hostIssue("HOST_CREDENTIAL_MISSING", "warning");
    mocks.callHostRpcMock.mockResolvedValue(hostOk([hostReported]));

    const result = await hostDoctorCommand(makeCtx());

    expect(mocks.callHostRpcMock).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({ issues: [hostReported] });
    expect(result.human).not.toContain(LOCAL_ONLY_NOTICE);
  });

  it("releases the lease after a successful call", async () => {
    await hostDoctorCommand(makeCtx());

    expect(mocks.callHostRpcMock).toHaveBeenCalledTimes(1);
    expect(existsSync(leasePath())).toBe(false);
    await expect(leaseIsFree()).resolves.toBe(true);
  });

  it("releases the lease after a failed call", async () => {
    mocks.callHostRpcMock.mockRejectedValue(new Error("timed out"));

    const result = await hostDoctorCommand(makeCtx());

    expect(firstLine(result.human)).toBe(LOCAL_ONLY_NOTICE);
    expect(existsSync(leasePath())).toBe(false);
    await expect(leaseIsFree()).resolves.toBe(true);
  });
});
