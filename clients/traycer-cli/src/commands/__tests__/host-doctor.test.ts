import { rmSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import type { DoctorResult } from "../../doctor";
import type { HostLifecycleSnapshot } from "../../host/lifecycle-snapshot";
import { hostHomeDir } from "../../store/paths";

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
}));

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
