import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentListHarnessesCommand } from "../agent-list-harnesses";
import { buildAgentListHarnessModelsCommand } from "../agent-list-harness-models";
import { callHostRpc } from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
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
  it("lists harness models without requiring epic or sender context", async () => {
    rpcMock.mockResolvedValue({
      harnessId: "codex",
      models: [],
    });

    const result = await buildAgentListHarnessModelsCommand({
      epicId: null,
      senderAgentId: null,
      harnessId: "codex",
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.listHarnessModels", {
      epicId: null,
      senderAgentId: null,
      harnessId: "codex",
    });
    expect(result.exitCode).toBe(0);
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
