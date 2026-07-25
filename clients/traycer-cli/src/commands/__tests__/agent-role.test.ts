/**
 * `traycer agent role` command functions and Commander registration.
 *
 * Command-function tests pin: protocol-schema request validation BEFORE
 * transport (normalization, UUID checks, ZERO RPC calls on invalid input),
 * env-var defaulting with flag precedence, typed request construction, and
 * human output through the SHARED protocol formatters (byte-identical to the
 * GUI tool rendering for the same response).
 *
 * `buildProgram().parseAsync` tests pin the real Commander surface:
 * registration of all three subcommands, required-flag enforcement, help
 * discovery, and that `role list` accepts NO --agent-id (the wire request has
 * no agent field - a dead flag would be accepted-and-ignored).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatClaimRoleResponseV11,
  formatListRolesResponse,
  formatRelinquishRoleResponseV11,
} from "@traycer/protocol/agent/agent-roles-format";
import type {
  ClaimAgentRoleResponseV11,
  ListAgentRolesResponse,
  RelinquishAgentRoleResponseV11,
} from "@traycer/protocol/host/agent/roles";
import {
  buildAgentRoleClaimCommand,
  buildAgentRoleListCommand,
  buildAgentRoleRelinquishCommand,
} from "../agent-role";
import { callHostRpc } from "../../internal/host-rpc";
import { buildProgram } from "../../index";
import { CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";

const noopLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
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

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    callHostRpc: vi.fn(),
  };
});

const callHostRpcMock = vi.mocked(callHostRpc);

const CLAIM_ID = "11111111-1111-4111-8111-111111111111";

const CLAIM_RESPONSE: ClaimAgentRoleResponseV11 = {
  claim: {
    claimId: CLAIM_ID,
    agentId: "agent-1",
    role: "Planner",
    scope: "auth migration",
    claimedAt: 10,
  },
  created: true,
  overlapping: [],
  awareness: {
    deliveredTo: ["peer-1"],
    deferredToPrompt: [],
    unreachable: [],
    failed: [],
  },
};

const LIST_RESPONSE: ListAgentRolesResponse = {
  claims: [CLAIM_RESPONSE.claim],
};

const RELINQUISH_RESPONSE: RelinquishAgentRoleResponseV11 = {
  released: true,
  awareness: {
    deliveredTo: [],
    deferredToPrompt: [],
    unreachable: [],
    failed: [],
  },
};

beforeEach(() => {
  callHostRpcMock.mockReset();
  delete process.env.TRAYCER_EPIC_ID;
  delete process.env.TRAYCER_AGENT_ID;
});

afterEach(() => {
  delete process.env.TRAYCER_EPIC_ID;
  delete process.env.TRAYCER_AGENT_ID;
});

describe("agent role claim command function", () => {
  it("builds the typed request, parses the response, and renders via the SHARED formatter", async () => {
    callHostRpcMock.mockResolvedValue(CLAIM_RESPONSE);

    const result = await buildAgentRoleClaimCommand({
      epicId: "epic-1",
      agentId: "agent-1",
      role: "Planner",
      scope: "auth migration",
    })(makeCtx());

    expect(callHostRpcMock).toHaveBeenCalledWith("agent.roles.claim", {
      epicId: "epic-1",
      claimantAgentId: "agent-1",
      role: "Planner",
      scope: "auth migration",
    });
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual(CLAIM_RESPONSE);
    // Byte-identical to the GUI tool rendering: one formatter, two surfaces.
    expect(result.human).toBe(formatClaimRoleResponseV11(CLAIM_RESPONSE));
  });

  it("NORMALIZES role/scope through the protocol schema before transport", async () => {
    callHostRpcMock.mockResolvedValue(CLAIM_RESPONSE);

    await buildAgentRoleClaimCommand({
      epicId: "epic-1",
      agentId: "agent-1",
      role: "  Planner  agent  ",
      scope: " auth   migration ",
    })(makeCtx());

    // NFC + whitespace fold + trim happened CLIENT-side: the wire carries the
    // normalized text, so both surfaces persist identical claims for
    // identical raw input.
    expect(callHostRpcMock).toHaveBeenCalledWith("agent.roles.claim", {
      epicId: "epic-1",
      claimantAgentId: "agent-1",
      role: "Planner agent",
      scope: "auth migration",
    });
  });

  it("rejects invalid input with a typed E_INVALID_ARGUMENT and sends ZERO frames", async () => {
    const command = buildAgentRoleClaimCommand({
      epicId: "epic-1",
      agentId: "agent-1",
      role: "",
      scope: "auth migration",
    });

    await expect(command(makeCtx())).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof CliError)) return false;
      expect(error.code).toBe("E_INVALID_ARGUMENT");
      expect(error.message).toContain("role");
      return true;
    });
    expect(callHostRpcMock).not.toHaveBeenCalled();
  });

  it("defaults ids from $TRAYCER_EPIC_ID / $TRAYCER_AGENT_ID; explicit flags win", async () => {
    callHostRpcMock.mockResolvedValue(CLAIM_RESPONSE);
    process.env.TRAYCER_EPIC_ID = "epic-env";
    process.env.TRAYCER_AGENT_ID = "agent-env";

    await buildAgentRoleClaimCommand({
      epicId: null,
      agentId: null,
      role: "Planner",
      scope: "auth migration",
    })(makeCtx());
    expect(callHostRpcMock).toHaveBeenLastCalledWith(
      "agent.roles.claim",
      expect.objectContaining({
        epicId: "epic-env",
        claimantAgentId: "agent-env",
      }),
    );

    await buildAgentRoleClaimCommand({
      epicId: "epic-flag",
      agentId: "agent-flag",
      role: "Planner",
      scope: "auth migration",
    })(makeCtx());
    expect(callHostRpcMock).toHaveBeenLastCalledWith(
      "agent.roles.claim",
      expect.objectContaining({
        epicId: "epic-flag",
        claimantAgentId: "agent-flag",
      }),
    );
  });
});

describe("agent role list command function", () => {
  it("sends ONLY epicId (the wire request has no agent field) and renders via the shared formatter", async () => {
    callHostRpcMock.mockResolvedValue(LIST_RESPONSE);

    const result = await buildAgentRoleListCommand({ epicId: "epic-1" })(
      makeCtx(),
    );

    expect(callHostRpcMock).toHaveBeenCalledWith("agent.roles.list", {
      epicId: "epic-1",
    });
    expect(result.human).toBe(formatListRolesResponse(LIST_RESPONSE));
  });
});

describe("agent role relinquish command function", () => {
  it("validates the claimId as a UUID before transport - zero frames on garbage", async () => {
    const command = buildAgentRoleRelinquishCommand({
      epicId: "epic-1",
      agentId: "agent-1",
      claimId: "not-a-uuid",
    });

    await expect(command(makeCtx())).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof CliError)) return false;
      expect(error.code).toBe("E_INVALID_ARGUMENT");
      expect(error.message).toContain("claimId");
      return true;
    });
    expect(callHostRpcMock).not.toHaveBeenCalled();
  });

  it("sends the typed request and renders the release", async () => {
    callHostRpcMock.mockResolvedValue(RELINQUISH_RESPONSE);

    const result = await buildAgentRoleRelinquishCommand({
      epicId: "epic-1",
      agentId: "agent-1",
      claimId: CLAIM_ID,
    })(makeCtx());

    expect(callHostRpcMock).toHaveBeenCalledWith("agent.roles.relinquish", {
      epicId: "epic-1",
      claimantAgentId: "agent-1",
      claimId: CLAIM_ID,
    });
    expect(result.human).toBe(
      formatRelinquishRoleResponseV11(RELINQUISH_RESPONSE),
    );
  });
});

describe("Commander registration (buildProgram)", () => {
  function findRoleCommand() {
    const program = buildProgram();
    const agent = program.commands.find((cmd) => cmd.name() === "agent");
    expect(agent).toBeDefined();
    const role = agent?.commands.find((cmd) => cmd.name() === "role");
    expect(role).toBeDefined();
    return role;
  }

  it("registers the role subgroup with claim, list, and relinquish", () => {
    const role = findRoleCommand();
    const names = role?.commands.map((cmd) => cmd.name()) ?? [];
    expect(names).toContain("claim");
    expect(names).toContain("list");
    expect(names).toContain("relinquish");
  });

  it("claim requires --role and --scope; relinquish requires --claim-id", () => {
    const role = findRoleCommand();
    const claim = role?.commands.find((cmd) => cmd.name() === "claim");
    const relinquish = role?.commands.find(
      (cmd) => cmd.name() === "relinquish",
    );
    const requiredFlags = (cmd: typeof claim): string[] =>
      (cmd?.options ?? [])
        .filter((option) => option.required === true || option.mandatory)
        .map((option) => option.long ?? "");
    expect(requiredFlags(claim)).toEqual(
      expect.arrayContaining(["--role", "--scope"]),
    );
    expect(requiredFlags(relinquish)).toEqual(
      expect.arrayContaining(["--claim-id"]),
    );
  });

  it("role list accepts NO --agent-id - the wire request cannot represent one", () => {
    const role = findRoleCommand();
    const list = role?.commands.find((cmd) => cmd.name() === "list");
    const longs = (list?.options ?? []).map((option) => option.long);
    expect(longs).toContain("--epic-id");
    expect(longs).not.toContain("--agent-id");
  });

  it("help discovery: `agent role` lists the three subcommands", () => {
    const role = findRoleCommand();
    const help = role?.helpInformation() ?? "";
    expect(help).toContain("claim");
    expect(help).toContain("list");
    expect(help).toContain("relinquish");
  });
});
