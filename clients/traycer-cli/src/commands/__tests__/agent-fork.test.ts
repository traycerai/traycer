import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { A2A_PERMISSION_MODE_INSTRUCTION } from "@traycer/protocol/agent/agent-selection-guide-format";
import { buildProgram } from "../../index";
import { buildAgentForkCommand } from "../agent-fork";
import { parseForkProfileSelection } from "../../internal/profile-selection";
import { callHostRpc } from "../../internal/host-rpc";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
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
  };
});

const rpcMock = vi.mocked(callHostRpc);
const PREV_ENV = {
  epic: process.env.TRAYCER_EPIC_ID,
  agent: process.env.TRAYCER_AGENT_ID,
};

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

function createOpts(profile: string | null) {
  return {
    epicId: "epic_1",
    senderAgentId: "agent_parent",
    agentId: "agent_source",
    name: null,
    permissionMode: null,
    profile,
    cwd: null,
    workspacePaths: [],
    workspaceEntries: [],
  };
}

const forkResponse = {
  agentId: "agent_child",
  sourceAgentId: "agent_source",
  forkedFromMessageId: "msg_42",
  warnings: [],
  effectiveProfileId: "prof_work",
  profileOverrideApplied: true,
};

function findSubcommand(parent: Command, name: string): Command | null {
  return parent.commands.find((child) => child.name() === name) ?? null;
}

function expectAgentCommand(name: string): Command {
  const agent = findSubcommand(buildProgram(), "agent");
  expect(agent, "expected the 'agent' command group").not.toBeNull();
  if (agent === null) throw new Error("unreachable: no agent command group");
  const command = findSubcommand(agent, name);
  expect(
    command,
    `expected 'traycer agent ${name}' to be registered`,
  ).not.toBeNull();
  if (command === null) {
    throw new Error(`unreachable: 'agent ${name}' not registered`);
  }
  return command;
}

function optionFlags(command: Command): readonly (string | undefined)[] {
  return command.options.map((option) => option.long);
}

function requiredOptionFlags(
  command: Command,
): readonly (string | undefined)[] {
  return command.options
    .filter((option) => option.mandatory)
    .map((option) => option.long);
}

function optionDescription(command: Command, longFlag: string): string {
  const option = command.options.find((entry) => entry.long === longFlag);
  if (option === undefined) {
    throw new Error(`expected ${command.name()} to register ${longFlag}`);
  }
  return option.description;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TRAYCER_EPIC_ID;
  delete process.env.TRAYCER_AGENT_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (PREV_ENV.epic === undefined) delete process.env.TRAYCER_EPIC_ID;
  else process.env.TRAYCER_EPIC_ID = PREV_ENV.epic;
  if (PREV_ENV.agent === undefined) delete process.env.TRAYCER_AGENT_ID;
  else process.env.TRAYCER_AGENT_ID = PREV_ENV.agent;
});

describe("--profile parsing", () => {
  it("keeps omission (inherit), explicit ambient, and a managed id distinguishable", () => {
    expect(parseForkProfileSelection(null)).toEqual({ kind: "inherit" });
    expect(parseForkProfileSelection("ambient")).toEqual({ kind: "ambient" });
    expect(parseForkProfileSelection("prof_work")).toEqual({
      kind: "profile",
      profileId: "prof_work",
    });
  });

  it("rejects a blank explicit profile", () => {
    expect(() => parseForkProfileSelection("  ")).toThrow(CliError);
  });
});

describe("agent fork", () => {
  it("sends inherit when --profile is omitted", async () => {
    rpcMock.mockResolvedValue(forkResponse);

    await buildAgentForkCommand(createOpts(null))(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.fork",
      expect.objectContaining({ profileSelection: { kind: "inherit" } }),
    );
  });

  it("sends the ambient selection for --profile ambient", async () => {
    rpcMock.mockResolvedValue(forkResponse);

    await buildAgentForkCommand(createOpts("ambient"))(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.fork",
      expect.objectContaining({ profileSelection: { kind: "ambient" } }),
    );
  });

  it("sends a managed selection for any other --profile value", async () => {
    rpcMock.mockResolvedValue(forkResponse);

    await buildAgentForkCommand(createOpts("prof_work"))(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.fork",
      expect.objectContaining({
        profileSelection: { kind: "profile", profileId: "prof_work" },
      }),
    );
  });

  it("sends a null workspace (source inheritance) when no workspace flags are given", async () => {
    rpcMock.mockResolvedValue(forkResponse);

    await buildAgentForkCommand(createOpts(null))(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.fork",
      expect.objectContaining({ workspace: null }),
    );
  });

  it("builds an explicit workspace from --cwd/--workspace-path/--workspace-entry", async () => {
    rpcMock.mockResolvedValue(forkResponse);

    await buildAgentForkCommand({
      ...createOpts(null),
      cwd: "/tmp/traycer-test/worktrees/report",
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.fork",
      expect.objectContaining({
        workspace: {
          entries: [
            {
              path: "/tmp/traycer-test/worktrees/report",
              workspacePath: null,
            },
          ],
        },
      }),
    );
  });

  it("defaults permission mode to full_access and forwards an override", async () => {
    rpcMock.mockResolvedValue(forkResponse);

    await buildAgentForkCommand(createOpts(null))(makeCtx());
    expect(rpcMock).toHaveBeenLastCalledWith(
      "agent.fork",
      expect.objectContaining({ permissionMode: "full_access" }),
    );

    await buildAgentForkCommand({
      ...createOpts(null),
      permissionMode: "supervised",
    })(makeCtx());
    expect(rpcMock).toHaveBeenLastCalledWith(
      "agent.fork",
      expect.objectContaining({ permissionMode: "supervised" }),
    );
  });

  it("resolves epicId/senderAgentId from the environment when omitted", async () => {
    rpcMock.mockResolvedValue(forkResponse);
    process.env.TRAYCER_EPIC_ID = "epic_env";
    process.env.TRAYCER_AGENT_ID = "agent_env";

    await buildAgentForkCommand({
      ...createOpts(null),
      epicId: null,
      senderAgentId: null,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.fork",
      expect.objectContaining({
        epicId: "epic_env",
        senderAgentId: "agent_env",
      }),
    );
  });

  it("echoes agentId, sourceAgentId, forkedFromMessageId, warnings, and profile fields", async () => {
    rpcMock.mockResolvedValue(forkResponse);

    const result = await buildAgentForkCommand(createOpts(null))(makeCtx());

    expect(result.data).toEqual(forkResponse);
    expect(result.human).toContain("agent_child");
    expect(result.human).toContain("Forked from: agent_source");
    expect(result.human).toContain("Forked from message: msg_42");
    expect(result.human).toContain("Effective profile: prof_work");
    expect(result.human).toContain("Profile override applied: yes");
  });

  it("reports a null forkedFromMessageId for a terminal fork without failing", async () => {
    rpcMock.mockResolvedValue({
      ...forkResponse,
      forkedFromMessageId: null,
    });

    const result = await buildAgentForkCommand(createOpts(null))(makeCtx());

    expect(result.data).toEqual(
      expect.objectContaining({ forkedFromMessageId: null }),
    );
    expect(result.human).toContain("terminal fork");
  });

  // `null` is the ambient provider login, not the absence of a profile
  // (`forkAgentResponseSchema`). Reporting it as "(none)" misread a fork that
  // inherited or selected ambient as having no profile at all (PR #1077 review).
  it("reports a null effectiveProfileId as ambient, not as no profile", async () => {
    rpcMock.mockResolvedValue({
      ...forkResponse,
      effectiveProfileId: null,
      profileOverrideApplied: false,
    });

    const result = await buildAgentForkCommand(createOpts(null))(makeCtx());

    expect(result.human).toContain("Effective profile: ambient");
    expect(result.human).not.toContain("(none)");
  });

  it("surfaces warnings in human output", async () => {
    rpcMock.mockResolvedValue({
      ...forkResponse,
      warnings: ["Fast mode is not available for the forked agent's model."],
    });

    const result = await buildAgentForkCommand(createOpts(null))(makeCtx());

    expect(result.human).toContain(
      "- Fast mode is not available for the forked agent's model.",
    );
  });
});

describe("version skew", () => {
  function unsupportedMethodError(method: string): HostRpcError {
    return new HostRpcError({
      code: "E_HOST_UNSUPPORTED",
      message: `This host does not support '${method}'. Upgrade the host to use this feature.`,
      requestId: "req_1",
      method,
      fatalDetails: {
        code: "E_HOST_UNSUPPORTED",
        reason: `This host does not support '${method}'.`,
        incompatibleMethods: null,
        upgradeGuidance: {
          clientShouldUpgrade: false,
          hostShouldUpgrade: true,
        },
      },
    });
  }

  it("turns an absent agent.fork method into host-upgrade guidance, not a raw method-not-found", async () => {
    rpcMock.mockRejectedValue(unsupportedMethodError("agent.fork"));

    const error = await buildAgentForkCommand(createOpts(null))(
      makeCtx(),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNSUPPORTED);
    expect(error.message).toContain("Upgrade the host");
    expect(error.details).toEqual({
      hostShouldUpgrade: true,
      method: "agent.fork",
    });
  });
});

describe("command registration", () => {
  it("registers 'traycer agent fork' with the expected flags", () => {
    const fork = expectAgentCommand("fork");
    expect(requiredOptionFlags(fork)).toContain("--agent-id");
    expect(optionFlags(fork)).toEqual(
      expect.arrayContaining([
        "--name",
        "--permission-mode",
        "--profile",
        "--cwd",
        "--workspace-path",
        "--workspace-entry",
      ]),
    );
  });

  it("does not make --profile required, where omission means inherit", () => {
    expect(requiredOptionFlags(expectAgentCommand("fork"))).not.toContain(
      "--profile",
    );
  });

  it("documents the unambiguous --agent-id prefix, unlike stop/archive", () => {
    const description = optionDescription(
      expectAgentCommand("fork"),
      "--agent-id",
    );
    expect(description).toContain("unambiguous");
    expect(description.toLowerCase()).toContain("prefix");
  });

  it("states the profile omission semantics explicitly", () => {
    const description = optionDescription(
      expectAgentCommand("fork"),
      "--profile",
    );
    expect(description).toContain("Omit");
    expect(description).toContain("inherit the source agent's own profile");
  });

  it("reuses the shared permission-mode instruction and defaults to full_access", () => {
    const description = optionDescription(
      expectAgentCommand("fork"),
      "--permission-mode",
    );
    expect(description).toContain(A2A_PERMISSION_MODE_INSTRUCTION);
    expect(description).toContain("Omit this flag");
  });
});
