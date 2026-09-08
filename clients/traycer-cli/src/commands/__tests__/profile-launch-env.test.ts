import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
  noopLogger: loggerMock,
}));

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return {
    ...actual,
    callHostRpc: vi.fn(),
  };
});

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import { buildProfileLaunchEnvCommand } from "../profile-launch-env";
import { callHostRpc } from "../../internal/host-rpc";
import { constants as osConstants } from "node:os";
import { CLI_ERROR_CODES } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";

const rpcMock = vi.mocked(callHostRpc);

function makeRuntime(): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: loggerMock,
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

beforeEach(() => {
  rpcMock.mockReset();
  spawnSyncMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("profile launch-env", () => {
  it("without --exec, refuses before any host RPC and prints no env", async () => {
    await expect(
      buildProfileLaunchEnvCommand({
        provider: "claude-code",
        profile: "profile-1",
        exec: false,
        execArgs: [],
      })(makeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("with --exec, resolves the env via providers.resolveLaunchEnv, spawns with it merged onto process.env with inherited stdio, and propagates the child exit code", async () => {
    rpcMock.mockResolvedValue({
      command: "/profiles/work/bin/claude",
      args: [],
      env: { ANTHROPIC_API_KEY: "sk-test-secret-value" },
      unsetKeys: [],
      cwd: null,
    });
    spawnSyncMock.mockReturnValue({
      status: 7,
      signal: null,
      error: undefined,
    });

    const result = await buildProfileLaunchEnvCommand({
      provider: "claude-code",
      profile: "profile-1",
      exec: true,
      execArgs: ["--help"],
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "providers.resolveLaunchEnv",
      expect.objectContaining({
        providerId: "claude-code",
        profileId: "profile-1",
      }),
      null,
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/profiles/work/bin/claude",
      ["--help"],
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: "sk-test-secret-value",
        }),
      }),
    );
    expect(result.exitCode).toBe(7);
    // The whole point of `--exec`: the credential never reaches this
    // command's own returned data/human text - only the child's env block,
    // which nothing here captures (stdio is "inherit").
    expect(JSON.stringify(result.data)).not.toContain("sk-test-secret-value");
    expect(result.human).toBeNull();
  });

  it("deletes the profile's unset keys after the process.env spread (wave-5 review H7)", async () => {
    // `process.env` is the base because PATH/HOME are load-bearing, so a key
    // the profile UNSET is resurrected from the operator's own shell unless
    // it is deleted afterwards - which is how an ambient GH_TOKEN would
    // authenticate the wrapped CLI as the wrong identity.
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ambient-github-token";
    rpcMock.mockResolvedValue({
      command: "/profiles/work/bin/copilot",
      args: [],
      env: { COPILOT_PROVIDER_API_KEY: "sk-endpoint" },
      unsetKeys: ["GH_TOKEN"],
      cwd: null,
    });
    spawnSyncMock.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
    });

    try {
      await buildProfileLaunchEnvCommand({
        provider: "copilot",
        profile: "profile-1",
        exec: true,
        execArgs: [],
      })(makeCtx());
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }

    const spawnOptions = spawnSyncMock.mock.calls[0]?.[2] as {
      env: NodeJS.ProcessEnv;
    };
    expect("GH_TOKEN" in spawnOptions.env).toBe(false);
    expect(spawnOptions.env.COPILOT_PROVIDER_API_KEY).toBe("sk-endpoint");
    // The base is still there - dropping `process.env` outright would break
    // the exec.
    expect(spawnOptions.env.PATH).toBe(process.env.PATH);
  });

  it("reports a signalled child as 128+n, not as an ordinary failure (wave-5 review O8)", async () => {
    rpcMock.mockResolvedValue({
      command: "/profiles/work/bin/claude",
      args: [],
      env: { ANTHROPIC_API_KEY: "sk-test-should-not-leak" },
      unsetKeys: [],
      cwd: null,
    });
    // What `spawnSync` really returns for a killed child: `status: null`
    // WITH a signal. Collapsing that to 1 made a Ctrl-C'd wrapper look like
    // an ordinary failure to whatever script wraps it.
    spawnSyncMock.mockReturnValue({
      status: null,
      signal: "SIGINT",
      error: undefined,
    });

    const result = await buildProfileLaunchEnvCommand({
      provider: "claude-code",
      profile: "profile-1",
      exec: true,
      execArgs: [],
    })(makeCtx());

    expect(result.exitCode).toBe(128 + osConstants.signals.SIGINT);
    expect(JSON.stringify(result)).not.toContain("sk-test-should-not-leak");
  });

  it("surfaces a failure to launch the child as a CLI error, never the raw resolved env", async () => {
    rpcMock.mockResolvedValue({
      command: "/does/not/exist/claude",
      args: [],
      env: { ANTHROPIC_API_KEY: "sk-test-should-not-leak" },
      unsetKeys: [],
      cwd: null,
    });
    spawnSyncMock.mockReturnValue({
      status: null,
      signal: null,
      error: new Error("spawn ENOENT"),
    });

    await expect(
      buildProfileLaunchEnvCommand({
        provider: "claude-code",
        profile: "profile-1",
        exec: true,
        execArgs: [],
      })(makeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.UNEXPECTED });
  });
});
