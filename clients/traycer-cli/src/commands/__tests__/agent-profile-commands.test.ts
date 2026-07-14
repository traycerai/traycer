import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { agentCreateDowngradeV20ToV10 } from "@traycer/protocol/host/agent/contracts";
import { createAgentRequestSchemaV20 } from "@traycer/protocol/host/agent/shared";
import { buildProgram } from "../../index";
import { buildAgentConfigureCommand } from "../agent-configure";
import { buildAgentCreateCommand } from "../agent-create";
import { buildAgentListProfilesCommand } from "../agent-list-profiles";
import { buildAgentProfileRateLimitsCommand } from "../agent-profile-rate-limits";
import {
  parseConcreteProfileSelection,
  parseCreateProfileSelection,
} from "../../internal/profile-selection";
import { callHostRpc } from "../../internal/host-rpc";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";

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
    name: null,
    surface: "gui",
    harness: "codex",
    model: null,
    agentMode: null,
    reasoningEffort: null,
    fast: false,
    profile,
    cwd: null,
    workspacePaths: [],
    workspaceEntries: [],
  };
}

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

// `mandatory` is commander's flag for `.requiredOption(...)` - the option must
// be SUPPLIED. (`required` only means the option takes a value argument, which
// every `--profile <ambient|id>` does whether or not it is mandatory.)
function requiredOptionFlags(
  command: Command,
): readonly (string | undefined)[] {
  return command.options
    .filter((option) => option.mandatory)
    .map((option) => option.long);
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
  it("keeps omission, explicit ambient, and a managed id distinguishable", () => {
    expect(parseCreateProfileSelection(null)).toEqual({ kind: "last_used" });
    expect(parseCreateProfileSelection("ambient")).toEqual({ kind: "ambient" });
    expect(parseCreateProfileSelection("prof_work")).toEqual({
      kind: "profile",
      profileId: "prof_work",
    });
  });

  it("has no last-used arm where a concrete selection is required", () => {
    expect(parseConcreteProfileSelection("ambient")).toEqual({
      kind: "ambient",
    });
    expect(parseConcreteProfileSelection(" prof_work ")).toEqual({
      kind: "profile",
      profileId: "prof_work",
    });
    expect(() => parseConcreteProfileSelection("  ")).toThrow(CliError);
  });
});

describe("agent create profile selection", () => {
  it("sends last_used when --profile is omitted", async () => {
    rpcMock.mockResolvedValue({ agentId: "agent_child", warnings: [] });

    await buildAgentCreateCommand(createOpts(null))(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.create",
      expect.objectContaining({ profileSelection: { kind: "last_used" } }),
    );
  });

  it("sends the ambient selection for --profile ambient", async () => {
    rpcMock.mockResolvedValue({ agentId: "agent_child", warnings: [] });

    await buildAgentCreateCommand(createOpts("ambient"))(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.create",
      expect.objectContaining({ profileSelection: { kind: "ambient" } }),
    );
  });

  it("sends a managed selection for any other --profile value", async () => {
    rpcMock.mockResolvedValue({ agentId: "agent_child", warnings: [] });

    await buildAgentCreateCommand(createOpts("prof_work"))(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.create",
      expect.objectContaining({
        profileSelection: { kind: "profile", profileId: "prof_work" },
      }),
    );
  });

  it("never sends the legacy profileId field", async () => {
    rpcMock.mockResolvedValue({ agentId: "agent_child", warnings: [] });

    await buildAgentCreateCommand(createOpts("prof_work"))(makeCtx());

    expect(rpcMock.mock.calls[0]?.[1]).not.toHaveProperty("profileId");
  });
});

describe("agent list-profiles", () => {
  const response = {
    providerId: "codex",
    profiles: [
      {
        selection: { kind: "ambient" },
        label: "Terminal login",
        authStatus: "authenticated",
        rateLimitStatus: "ok",
        usageUpdatedAt: 1_752_400_000_000,
        isEffectiveLastUsed: true,
      },
    ],
  };

  it("requests the harness's profiles with the caller's epic and agent context", async () => {
    rpcMock.mockResolvedValue(response);

    const result = await buildAgentListProfilesCommand({
      epicId: "epic_1",
      senderAgentId: "agent_1",
      harnessId: "codex",
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.listProviderProfiles", {
      epicId: "epic_1",
      senderAgentId: "agent_1",
      harnessId: "codex",
    });
    expect(result.exitCode).toBe(0);
  });

  it("passes the RPC DTO through unchanged for --json", async () => {
    rpcMock.mockResolvedValue(response);

    const result = await buildAgentListProfilesCommand({
      epicId: "epic_1",
      senderAgentId: "agent_1",
      harnessId: "codex",
    })(makeCtx());

    expect(result.data).toEqual(response);
  });

  it("keeps the reusable --profile token in human output", async () => {
    rpcMock.mockResolvedValue(response);

    const result = await buildAgentListProfilesCommand({
      epicId: "epic_1",
      senderAgentId: "agent_1",
      harnessId: "codex",
    })(makeCtx());

    expect(result.human).toContain("--profile ambient - Terminal login");
    expect(result.human).toContain("[last-used]");
  });
});

describe("agent profile-rate-limits", () => {
  const response = {
    rateLimits: {
      provider: "codex",
      available: false,
      reason: "cli_not_found",
    },
    usageUpdatedAt: null,
  };

  it("requires a concrete profile selection on the wire", async () => {
    rpcMock.mockResolvedValue(response);

    await buildAgentProfileRateLimitsCommand({
      epicId: "epic_1",
      senderAgentId: "agent_1",
      harnessId: "codex",
      profile: "prof_work",
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.getProviderProfileRateLimits", {
      epicId: "epic_1",
      senderAgentId: "agent_1",
      harnessId: "codex",
      profileSelection: { kind: "profile", profileId: "prof_work" },
    });
  });

  it("reports an unavailable provider read without failing the command", async () => {
    rpcMock.mockResolvedValue(response);

    const result = await buildAgentProfileRateLimitsCommand({
      epicId: "epic_1",
      senderAgentId: "agent_1",
      harnessId: "codex",
      profile: "ambient",
    })(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual(response);
    expect(result.human).toContain("unavailable (cli_not_found)");
  });
});

describe("agent configure", () => {
  const response = {
    settings: {
      harnessId: "codex",
      model: "gpt-5.6-codex",
      profileSelection: { kind: "ambient" },
      reasoningEffort: "high",
      fastMode: false,
      permissionMode: "supervised",
      agentMode: "regular",
    },
    warnings: ["Fast mode is not available for 'gpt-5.6-codex'."],
  };

  it("sends the complete future run tuple the RPC requires", async () => {
    rpcMock.mockResolvedValue(response);

    const result = await buildAgentConfigureCommand({
      epicId: "epic_1",
      senderAgentId: "agent_1",
      agentId: "agent_target",
      harness: "codex",
      model: "gpt-5.6-codex",
      profile: "ambient",
      reasoningEffort: "high",
      fast: false,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.configure", {
      epicId: "epic_1",
      senderAgentId: "agent_1",
      agentId: "agent_target",
      harnessId: "codex",
      model: "gpt-5.6-codex",
      profileSelection: { kind: "ambient" },
      reasoningEffort: "high",
      fastMode: false,
    });
    expect(result.data).toEqual(response);
    expect(result.human).toContain("profile: --profile ambient");
    expect(result.human).toContain(
      "- Fast mode is not available for 'gpt-5.6-codex'.",
    );
  });

  it("sends the omitted reasoning-effort and fast-mode inputs explicitly", async () => {
    rpcMock.mockResolvedValue(response);

    await buildAgentConfigureCommand({
      epicId: "epic_1",
      senderAgentId: "agent_1",
      agentId: "agent_target",
      harness: "codex",
      model: "gpt-5.6-codex",
      profile: "prof_work",
      reasoningEffort: null,
      fast: false,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.configure",
      expect.objectContaining({ reasoningEffort: null, fastMode: false }),
    );
  });

  it("rejects a non-GUI harness before reaching the host", async () => {
    await expect(
      buildAgentConfigureCommand({
        epicId: "epic_1",
        senderAgentId: "agent_1",
        agentId: "agent_target",
        harness: "not-a-harness",
        model: "gpt-5.6-codex",
        profile: "ambient",
        reasoningEffort: null,
        fast: false,
      })(makeCtx()),
    ).rejects.toBeInstanceOf(CliError);
    expect(rpcMock).not.toHaveBeenCalled();
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

  it("turns an absent optional method into host-upgrade guidance", async () => {
    rpcMock.mockRejectedValue(
      unsupportedMethodError("agent.listProviderProfiles"),
    );

    const error = await buildAgentListProfilesCommand({
      epicId: "epic_1",
      senderAgentId: "agent_1",
      harnessId: "codex",
    })(makeCtx()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNSUPPORTED);
    expect(error.message).toContain("Upgrade the host");
    expect(error.details).toEqual({
      hostShouldUpgrade: true,
      method: "agent.listProviderProfiles",
    });
  });

  it("surfaces upgrade guidance for configure against a host without it", async () => {
    rpcMock.mockRejectedValue(unsupportedMethodError("agent.configure"));

    const error = await buildAgentConfigureCommand({
      epicId: "epic_1",
      senderAgentId: "agent_1",
      agentId: "agent_target",
      harness: "codex",
      model: "gpt-5.6-codex",
      profile: "ambient",
      reasoningEffort: null,
      fast: false,
    })(makeCtx()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNSUPPORTED);
  });

  // The requests the CLI actually builds, run through the REAL v2→v1 create
  // downgrade an old host's manifest triggers in the transport: an omitted
  // --profile (`last_used`) and an explicit `--profile ambient` must both fail
  // with upgrade guidance rather than project onto v1.0's `profileId: null`,
  // which that host would read as "inherit the sender's profile".
  function cliCreateRequest(profile: string | null) {
    return createAgentRequestSchemaV20.parse({
      senderAgentId: "agent_parent",
      epicId: "epic_1",
      name: null,
      surface: "gui",
      harnessId: "codex",
      model: null,
      agentMode: null,
      reasoningEffort: null,
      fastMode: null,
      workspace: null,
      profileSelection: parseCreateProfileSelection(profile),
    });
  }

  it("refuses to downgrade an omitted --profile onto an old host", () => {
    const downgraded = agentCreateDowngradeV20ToV10.downgradeRequest(
      cliCreateRequest(null),
    );

    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) throw new Error("unreachable");
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
    expect(downgraded.error.message).toContain("newer Traycer host");
  });

  it("refuses to downgrade an explicit --profile ambient onto an old host", () => {
    const downgraded = agentCreateDowngradeV20ToV10.downgradeRequest(
      cliCreateRequest("ambient"),
    );

    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) throw new Error("unreachable");
    expect(downgraded.error.message).toContain("upgrade the host");
  });

  it("still downgrades an explicit managed profile onto an old host", () => {
    const downgraded = agentCreateDowngradeV20ToV10.downgradeRequest(
      cliCreateRequest("prof_work"),
    );

    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) throw new Error("unreachable");
    expect(downgraded.value.profileId).toBe("prof_work");
  });
});

describe("command registration", () => {
  it("registers the profile-aware agent commands alongside the existing family", () => {
    expect(optionFlags(expectAgentCommand("create"))).toContain("--profile");
    expect(optionFlags(expectAgentCommand("list-profiles"))).toContain(
      "--epic-id",
    );
    expect(
      requiredOptionFlags(expectAgentCommand("profile-rate-limits")),
    ).toContain("--profile");
    expect(requiredOptionFlags(expectAgentCommand("configure"))).toEqual(
      expect.arrayContaining([
        "--agent-id",
        "--harness",
        "--model",
        "--profile",
      ]),
    );
    expect(optionFlags(expectAgentCommand("configure"))).toEqual(
      expect.arrayContaining(["--reasoning-effort", "--fast", "--json"]),
    );
  });

  it("does not make --profile required on create, where omission means last-used", () => {
    expect(requiredOptionFlags(expectAgentCommand("create"))).not.toContain(
      "--profile",
    );
  });
});
