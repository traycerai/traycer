import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import type { HostPidMetadata } from "../../host/pid-metadata";
import type { HostLifecycleMode } from "@traycer/protocol/config/host-lifecycle-policy";
import type { ServiceDefinitionRefreshOutcome } from "../service-refresh";

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

/** Writes the policy file directly, bypassing the command under test, so a
 * test can start from a chosen PREVIOUS effective mode without that setup
 * write itself counting as a refresh call. */
function seedPolicy(mode: HostLifecycleMode, rev: number): void {
  mkdirSync(dirname(lifecyclePolicyFilePath()), { recursive: true });
  writeFileSync(
    lifecyclePolicyFilePath(),
    JSON.stringify(
      {
        v: 1,
        rev,
        mode,
        updatedAt: "2026-01-01T00:00:00.000Z",
        updatedBy: "cli",
      },
      null,
      2,
    ),
    "utf8",
  );
}

function readPolicyModeFromDisk(): string {
  const raw = readFileSync(lifecyclePolicyFilePath(), "utf8");
  return (JSON.parse(raw) as { mode: string }).mode;
}

const FAKE_REFRESH_LABEL = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production" as const,
  devSlot: null,
};

/** A refresh stub that does nothing observable - the default for every test
 * that isn't itself exercising the M1 refresh-on-mode-change wiring. */
async function noopRefresh(): Promise<ServiceDefinitionRefreshOutcome> {
  return {
    label: FAKE_REFRESH_LABEL,
    result: { kind: "not-registered" },
  };
}

describe("host lifecycle get/set commands", () => {
  it("round-trips 'set linked' then 'get': mode linked, rev 1 after the first set", async () => {
    const { buildHostLifecycleSetCommand, hostLifecycleGetCommand } =
      await import("../host-lifecycle");

    const setResult = await buildHostLifecycleSetCommand({
      mode: "linked",
      refreshServiceDefinition: noopRefresh,
    })(makeCtx());
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

    const first = await buildHostLifecycleSetCommand({
      mode: "linked",
      refreshServiceDefinition: noopRefresh,
    })(makeCtx());
    expect((first.data as { policy: { rev: number } }).policy.rev).toBe(1);

    const second = await buildHostLifecycleSetCommand({
      mode: "ask",
      refreshServiceDefinition: noopRefresh,
    })(makeCtx());
    expect((second.data as { policy: { rev: number } }).policy.rev).toBe(2);
  });

  it("rejects an invalid mode string with E_INVALID_ARGUMENT and writes no file", async () => {
    const { buildHostLifecycleSetCommand, hostLifecycleGetCommand } =
      await import("../host-lifecycle");
    const { CliError, CLI_ERROR_CODES } = await import("../../runner/errors");

    const error = await buildHostLifecycleSetCommand({
      mode: "bogus",
      // An invalid mode must fail before this is ever read.
      refreshServiceDefinition: async () => {
        throw new Error("must not be called for an invalid mode");
      },
    })(makeCtx()).catch((err: unknown) => err);

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

    const result = await buildHostLifecycleSetCommand({
      mode: "none",
      refreshServiceDefinition: noopRefresh,
    })(makeCtx());

    expect(result.human).toContain("Nothing was stopped");
  });

  it("adds the 'restart the host to apply' note for a non-background mode when the host is running and no supervisor enforces the policy", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(LIVE_HOST_PID_METADATA);

    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");

    const result = await buildHostLifecycleSetCommand({
      mode: "linked",
      refreshServiceDefinition: noopRefresh,
    })(makeCtx());

    expect(result.human).toContain("restart the host to apply");
    expect(result.human).toContain("traycer host restart");
  });

  it("does not add the restart note when the host is not running", async () => {
    // Default mock: readHostPidMetadata resolves null (not running).
    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");

    const result = await buildHostLifecycleSetCommand({
      mode: "linked",
      refreshServiceDefinition: noopRefresh,
    })(makeCtx());

    expect(result.human).not.toContain("restart the host to apply");
  });
});

describe("host lifecycle set: service definition refresh on mode change (M1)", () => {
  it("absent policy (= background): 'set ask' calls refresh exactly once, and the policy file already reads 'ask' when it runs", async () => {
    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");
    const refreshServiceDefinition = vi.fn(
      async (): Promise<ServiceDefinitionRefreshOutcome> => {
        // The policy write must have landed on disk BEFORE the refresh is
        // invoked - this is the mechanism, not just the end state.
        expect(readPolicyModeFromDisk()).toBe("ask");
        return { label: FAKE_REFRESH_LABEL, result: { kind: "current" } };
      },
    );

    const result = await buildHostLifecycleSetCommand({
      mode: "ask",
      refreshServiceDefinition,
    })(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(refreshServiceDefinition).toHaveBeenCalledTimes(1);
    expect(refreshServiceDefinition).toHaveBeenCalledWith("production");
  });

  it("'ask' -> 'set ask' (re-setting the mode already in force): zero refresh calls", async () => {
    seedPolicy("ask", 1);
    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");
    const refreshServiceDefinition = vi.fn(noopRefresh);

    const result = await buildHostLifecycleSetCommand({
      mode: "ask",
      refreshServiceDefinition,
    })(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(refreshServiceDefinition).not.toHaveBeenCalled();
  });

  it("'ask' -> 'set background': zero refresh calls (background parks nothing)", async () => {
    seedPolicy("ask", 1);
    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");
    const refreshServiceDefinition = vi.fn(noopRefresh);

    const result = await buildHostLifecycleSetCommand({
      mode: "background",
      refreshServiceDefinition,
    })(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(refreshServiceDefinition).not.toHaveBeenCalled();
  });

  it("'background' -> 'set none': refresh called exactly once", async () => {
    seedPolicy("background", 1);
    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");
    const refreshServiceDefinition = vi.fn(noopRefresh);

    const result = await buildHostLifecycleSetCommand({
      mode: "none",
      refreshServiceDefinition,
    })(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(refreshServiceDefinition).toHaveBeenCalledTimes(1);
  });

  it("'linked' -> 'set stop-if-idle': refresh called exactly once", async () => {
    seedPolicy("linked", 1);
    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");
    const refreshServiceDefinition = vi.fn(noopRefresh);

    const result = await buildHostLifecycleSetCommand({
      mode: "stop-if-idle",
      refreshServiceDefinition,
    })(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(refreshServiceDefinition).toHaveBeenCalledTimes(1);
  });

  it("a refresh failure rejects with E_SERVICE_DEFINITION_REFRESH_FAILED, non-zero exit, names 'traycer host service refresh', and the policy write still stands", async () => {
    seedPolicy("background", 1);
    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");
    const { CliError, CLI_ERROR_CODES } = await import("../../runner/errors");
    const refreshServiceDefinition = vi.fn(async (): Promise<never> => {
      throw new Error("systemctl daemon-reload failed");
    });

    const error = await buildHostLifecycleSetCommand({
      mode: "ask",
      refreshServiceDefinition,
    })(makeCtx()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.SERVICE_DEFINITION_REFRESH_FAILED);
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("traycer host service refresh");
    // The policy write happened before the refresh attempt and is not
    // rolled back by a refresh failure.
    expect(readPolicyModeFromDisk()).toBe("ask");
  });

  it("human output of a 'refreshed'/'next-login' outcome mentions the next login", async () => {
    seedPolicy("background", 1);
    const { buildHostLifecycleSetCommand } = await import("../host-lifecycle");
    const refreshServiceDefinition =
      async (): Promise<ServiceDefinitionRefreshOutcome> => ({
        label: FAKE_REFRESH_LABEL,
        result: {
          kind: "refreshed",
          form: "launcher-file",
          appliesAt: "next-login",
        },
      });

    const result = await buildHostLifecycleSetCommand({
      mode: "ask",
      refreshServiceDefinition,
    })(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.human).toContain("applies at the next login");
  });
});
