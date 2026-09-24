import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import type { HostPidMetadata } from "../../host/pid-metadata";

// `traycer host lifecycle get | set <mode>` - the CLI half of the host
// lifecycle setting. These tests exercise the commands against a REAL temp
// host home (write/read `lifecycle-policy.json` for real), and only mock the
// pid-metadata read that decides `hostRunning`, the same way
// `host-status-observational.test.ts` mocks it for `host status`.

// `store/paths` binds its home root from `os.homedir()` at module load.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  readHostPidMetadataMock: vi.fn(),
}));

vi.mock("../../host/pid-metadata", async () => {
  // Only the read is stubbed; `publishedHostProcessGone` stays real so
  // `hostRunning` follows the (mocked) metadata's pid liveness exactly as
  // the command does.
  const actual = await vi.importActual<
    typeof import("../../host/pid-metadata")
  >("../../host/pid-metadata");
  return {
    ...actual,
    readHostPidMetadata: mocks.readHostPidMetadataMock,
  };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-cli-lifecycle-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  mocks.readHostPidMetadataMock.mockReset();
  mocks.readHostPidMetadataMock.mockResolvedValue(null);
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
});

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

const LIVE_HOST_PID_METADATA: HostPidMetadata = {
  pid: process.pid,
  hostId: "host-under-test",
  version: "1.7.2",
  websocketUrl: "ws://127.0.0.1:9876",
  startedAt: "2026-08-01T00:00:00.000Z",
  processStartIdentity: null,
  processStartIdentityRead: "absent",
  layer0: null,
  layer0Slot: null,
};

function lifecyclePolicyFilePath(): string {
  return join(workHome, ".traycer", "host", "lifecycle-policy.json");
}

describe("host lifecycle get/set commands", () => {
  it("round-trips 'set linked' then 'get': mode linked, rev 1 after the first set", async () => {
    const { buildHostLifecycleSetCommand, hostLifecycleGetCommand } =
      await import("../host-lifecycle");

    const setResult = await buildHostLifecycleSetCommand({ mode: "linked" })(
      makeCtx(),
    );
    expect(setResult.exitCode).toBe(0);
    const setData = setResult.data as { policy: { mode: string; rev: number } };
    expect(setData.policy.mode).toBe("linked");
    expect(setData.policy.rev).toBe(1);

    const getResult = await hostLifecycleGetCommand(makeCtx());
    const getData = getResult.data as {
      lifecycle: {
        policy: { state: string; mode: string; rev: number | null };
      };
    };
    expect(getData.lifecycle.policy.state).toBe("valid");
    expect(getData.lifecycle.policy.mode).toBe("linked");
    expect(getData.lifecycle.policy.rev).toBe(1);
  });

  it("increments rev to 2 on a second 'set'", async () => {
    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");

    const first = await buildHostLifecycleSetCommand({ mode: "linked" })(
      makeCtx(),
    );
    expect((first.data as { policy: { rev: number } }).policy.rev).toBe(1);

    const second = await buildHostLifecycleSetCommand({ mode: "ask" })(
      makeCtx(),
    );
    expect((second.data as { policy: { rev: number } }).policy.rev).toBe(2);
  });

  it("rejects an invalid mode string with E_INVALID_ARGUMENT and writes no file", async () => {
    const { buildHostLifecycleSetCommand, hostLifecycleGetCommand } =
      await import("../host-lifecycle");
    const { CliError, CLI_ERROR_CODES } = await import("../../runner/errors");

    const error = await buildHostLifecycleSetCommand({ mode: "bogus" })(
      makeCtx(),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);

    expect(existsSync(lifecyclePolicyFilePath())).toBe(false);

    const getResult = await hostLifecycleGetCommand(makeCtx());
    const getData = getResult.data as {
      lifecycle: { policy: { state: string } };
    };
    expect(getData.lifecycle.policy.state).toBe("absent");
  });

  it("reports policy state 'invalid' and effective mode 'background' for a corrupt policy file on disk", async () => {
    mkdirSync(join(workHome, ".traycer", "host"), { recursive: true });
    writeFileSync(lifecyclePolicyFilePath(), "{ not valid json", "utf8");

    const { hostLifecycleGetCommand } = await import("../host-lifecycle");
    const getResult = await hostLifecycleGetCommand(makeCtx());
    const getData = getResult.data as {
      lifecycle: { policy: { state: string; mode: string } };
    };
    expect(getData.lifecycle.policy.state).toBe("invalid");
    expect(getData.lifecycle.policy.mode).toBe("background");
  });

  it("mode 'none' note says nothing was stopped", async () => {
    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");

    const result = await buildHostLifecycleSetCommand({ mode: "none" })(
      makeCtx(),
    );

    expect(result.human).toContain("Nothing was stopped");
  });

  it("adds the 'restart the host to apply' note for a non-background mode when the host is running and no supervisor enforces the policy", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(LIVE_HOST_PID_METADATA);

    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");

    const result = await buildHostLifecycleSetCommand({ mode: "linked" })(
      makeCtx(),
    );

    expect(result.human).toContain("restart the host to apply");
    expect(result.human).toContain("traycer host restart");
  });

  it("does not add the restart note when the host is not running", async () => {
    // Default mock: readHostPidMetadata resolves null (not running).
    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");

    const result = await buildHostLifecycleSetCommand({ mode: "linked" })(
      makeCtx(),
    );

    expect(result.human).not.toContain("restart the host to apply");
  });
});
