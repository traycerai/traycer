import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentCreateCommand } from "../agent-create";
import { callHostRpc, callHostRpcWithDispatch } from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";

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
    callHostRpcWithDispatch: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpc);

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

function createCommand(surface: string, harness: string) {
  return buildAgentCreateCommand({
    epicId: "epic-1",
    senderAgentId: "agent-1",
    name: null,
    surface,
    harness,
    model: null,
    reasoningEffort: null,
    fast: false,
    serviceTier: null,
    permissionMode: null,
    profile: null,
    cwd: "/repo",
    workspacePaths: [],
    workspaceEntries: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/**
 * Antigravity is a valid TUI harness id (staging) but has no inbox transport
 * yet, so `agent create --surface tui --harness antigravity` must be refused
 * locally with the allowed-values list — exactly as Cursor/Codex/OpenCode are,
 * because the CLI's terminal admission set is `canReceiveA2AMessages`-filtered.
 * This guards the inertness guarantee at the CLI boundary.
 */
describe("agent create: terminal surface/harness admission", () => {
  it("rejects antigravity on the terminal surface (no inbox transport yet)", async () => {
    let thrown: unknown;
    try {
      await createCommand("tui", "antigravity")(makeCtx());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    if (thrown instanceof CliError) {
      expect(thrown.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      expect(thrown.message).toContain("does not support the tui surface");
      // The allowed-values list must not offer antigravity as a terminal
      // harness (the message does name the rejected harness itself).
      const allowed = thrown.message.match(/one of: ([^)]*)\)/)?.[1] ?? "";
      expect(allowed).toContain("claude");
      expect(allowed).not.toContain("antigravity");
    }
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("admits claude on the terminal surface (positive control)", async () => {
    rpcMock.mockResolvedValue({ agentId: "agt-1", warnings: [] });
    await expect(createCommand("tui", "claude")(makeCtx())).resolves.toEqual(
      expect.objectContaining({ exitCode: 0 }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "agent.create",
      expect.objectContaining({ surface: "tui", harnessId: "claude" }),
    );
  });
});
