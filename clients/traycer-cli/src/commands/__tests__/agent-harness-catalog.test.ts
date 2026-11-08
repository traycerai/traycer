import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentListHarnessesCommand } from "../agent-list-harnesses";
import { buildAgentListHarnessModelsCommand } from "../agent-list-harness-models";
import { AGENT_LIST_HARNESS_MODELS_PROFILE_REQUIRED_HOST_VERSION } from "@traycer/protocol/host/registry";
import { buildProgram } from "../../index";
import { callHostRpc, callHostRpcWithDispatch } from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
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
const dispatchMock = vi.mocked(callHostRpcWithDispatch);
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

describe("agent harness catalog commands", () => {
  it("registers a profile selector for model catalogs", () => {
    const agent = buildProgram().commands.find(
      (command) => command.name() === "agent",
    );
    expect(
      agent?.commands
        .find((command) => command.name() === "list-harness-models")
        ?.options.map((option) => option.long),
    ).toContain("--profile");
  });
  it("lists harness models without requiring epic or sender context", async () => {
    rpcMock.mockResolvedValue({
      harnessId: "codex",
      profileId: null,
      models: [],
    });

    const result = await buildAgentListHarnessModelsCommand({
      epicId: null,
      senderAgentId: null,
      harnessId: "codex",
      profileId: null,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.listHarnessModels", {
      epicId: null,
      senderAgentId: null,
      harnessId: "codex",
      profileId: undefined,
    });
    expect(result.exitCode).toBe(0);
  });

  it("lists models for a named profile and requires the 2.1 catalog line", async () => {
    dispatchMock.mockResolvedValue({
      harnessId: "codex",
      profileId: "profile-work",
      models: [
        {
          id: "gpt-5.6-codex",
          reasoningEfforts: ["high"],
          fastModeAvailable: true,
          serviceTiers: ["priority"],
        },
      ],
    });
    const result = await buildAgentListHarnessModelsCommand({
      epicId: null,
      senderAgentId: null,
      harnessId: "codex",
      profileId: "profile-work",
    })(makeCtx());
    expect(result.human).toContain("[serviceTier: priority]");
    expect(dispatchMock).toHaveBeenCalledWith(
      "agent.listHarnessModels",
      expect.objectContaining({ profileId: "profile-work" }),
      expect.objectContaining({
        requiredHostMethodVersion:
          AGENT_LIST_HARNESS_MODELS_PROFILE_REQUIRED_HOST_VERSION,
      }),
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("uses the ambient catalog without requiring a newer host", async () => {
    rpcMock.mockResolvedValue({
      harnessId: "codex",
      profileId: null,
      models: [],
    });
    await buildAgentListHarnessModelsCommand({
      epicId: null,
      senderAgentId: null,
      harnessId: "codex",
      profileId: "ambient",
    })(makeCtx());
    expect(rpcMock).toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("lists enabled harnesses without fetching every model catalog", async () => {
    rpcMock.mockImplementation(async (method) => {
      if (method === "agent.gui.listHarnesses") {
        return {
          harnesses: [
            {
              id: "codex",
              label: "Codex",
              enabled: true,
              available: true,
              error: null,
              modes: ["gui", "tui"],
              requiresApiKey: false,
              supportedPermissionModes: [],
              availabilityPending: false,
            },
            {
              id: "openrouter",
              label: "OpenRouter",
              enabled: true,
              available: false,
              error: "Missing API key",
              modes: ["gui"],
              requiresApiKey: true,
              supportedPermissionModes: [],
              availabilityPending: false,
            },
            {
              id: "grok",
              label: "Grok",
              enabled: false,
              available: false,
              error: "Disabled in Settings -> Providers",
              modes: ["gui"],
              requiresApiKey: false,
              supportedPermissionModes: [],
              availabilityPending: false,
            },
          ],
        };
      }
      if (method === "agent.listHarnessModels") {
        throw new Error("list-harnesses must not fetch models");
      }
      return {
        harnessId: "unexpected",
        models: [],
      };
    });

    const result = await buildAgentListHarnessesCommand()(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.gui.listHarnesses", {});
    expect(rpcMock).not.toHaveBeenCalledWith(
      "agent.listHarnessModels",
      expect.anything(),
    );
    expect(result.data).toMatchObject({
      harnesses: [
        {
          id: "codex",
          label: "Codex",
          available: true,
        },
        {
          id: "openrouter",
          label: "OpenRouter",
          available: false,
          error: "Missing API key",
        },
      ],
    });
    expect(result.human).not.toContain("grok");
    expect(result.human).toContain("codex - Codex");
    expect(result.human).toContain("openrouter - OpenRouter [unavailable");
  });
});
