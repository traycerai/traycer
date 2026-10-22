/**
 * `traycer agent rename` command function.
 *
 * Pins: the rename reaches the host's `epic.renameChat@1.0` (GUI chat) or
 * `epic.renameTuiAgent@1.0` (terminal agent) with the agent id and the trimmed
 * name, the result is printed, and a blank name or an agent that runs on
 * another host is refused before anything is written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentRenameCommand } from "../agent-rename";
import { callHostRpc } from "../../internal/host-rpc";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import type { ListAgentsResponse } from "@traycer/protocol/host/agent/shared";
import { LEGACY_HOST_ID } from "@traycer/protocol/persistence/epic/chat";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    callHostRpc: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpc);

function makeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: noopLogger,
    },
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

const PREV_EPIC = process.env.TRAYCER_EPIC_ID;
const PREV_AGENT = process.env.TRAYCER_AGENT_ID;

beforeEach(() => {
  rpcMock.mockReset();
  delete process.env.TRAYCER_EPIC_ID;
  delete process.env.TRAYCER_AGENT_ID;
});

afterEach(() => {
  if (PREV_EPIC === undefined) delete process.env.TRAYCER_EPIC_ID;
  else process.env.TRAYCER_EPIC_ID = PREV_EPIC;
  if (PREV_AGENT === undefined) delete process.env.TRAYCER_AGENT_ID;
  else process.env.TRAYCER_AGENT_ID = PREV_AGENT;
});

function agentRow(overrides: {
  readonly id: string;
  readonly surface: "gui" | "tui";
  readonly isLocal: boolean;
}): ListAgentsResponse["agents"][number] {
  return {
    id: overrides.id,
    parentId: null,
    hostId: overrides.isLocal ? "host-1" : "host-2",
    isLocal: overrides.isLocal,
    surface: overrides.surface,
    harnessId: "codex" as const,
    isSelf: false,
    title: null,
    capabilities: { readTranscript: true, sendMessage: true },
    active: false,
    folderPaths: [],
    isWorktree: false,
    runConfig: null,
    sessionState: null,
    lastExit: null,
    archived: null,
    profile: null,
    permissionMode: null,
    reach: null,
    hostConnectivity: { kind: "unknown" as const },
  };
}

function listResponse(rows: ListAgentsResponse["agents"]): unknown {
  return {
    caller: { agentId: "agent-caller", canSendMessages: true },
    scope: "user" as const,
    agents: rows,
  };
}

function hostRpcError(code: "RPC_ERROR", message: string): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "req_1",
    method: "epic.renameTuiAgent",
    fatalDetails: null,
  });
}

function command(opts: { readonly agentId: string; readonly name: string }) {
  return buildAgentRenameCommand({
    epicId: "epic_1",
    senderAgentId: "agent-caller",
    agentId: opts.agentId,
    name: opts.name,
  })(makeCtx());
}

describe("agent rename command function", () => {
  it("renames a GUI chat through epic.renameChat with the trimmed name", async () => {
    rpcMock.mockImplementation((method: string) => {
      if (method === "agent.list") {
        return Promise.resolve(
          listResponse([
            agentRow({ id: "chat_1", surface: "gui", isLocal: true }),
          ]),
        );
      }
      return Promise.resolve({ updated: true });
    });

    const result = await command({
      agentId: "chat_1",
      name: "  Release prep  ",
    });

    expect(rpcMock).toHaveBeenCalledWith("epic.renameChat", {
      epicId: "epic_1",
      chatId: "chat_1",
      title: "Release prep",
    });
    expect(result.data).toEqual({
      agentId: "chat_1",
      name: "Release prep",
      updated: true,
    });
    expect(result.human).toBe('chat_1 renamed to "Release prep"');
    expect(result.exitCode).toBe(0);
  });

  it("renames a terminal agent through epic.renameTuiAgent", async () => {
    rpcMock.mockImplementation((method: string) => {
      if (method === "agent.list") {
        return Promise.resolve(
          listResponse([
            agentRow({ id: "chat_1", surface: "gui", isLocal: true }),
            agentRow({ id: "tui_1", surface: "tui", isLocal: true }),
          ]),
        );
      }
      return Promise.resolve({ updated: true });
    });

    const result = await command({ agentId: "tui_1", name: "Build watcher" });

    expect(rpcMock).toHaveBeenCalledWith("epic.renameTuiAgent", {
      epicId: "epic_1",
      tuiAgentId: "tui_1",
      title: "Build watcher",
    });
    expect(rpcMock).not.toHaveBeenCalledWith(
      "epic.renameChat",
      expect.anything(),
    );
    expect(result.human).toBe('tui_1 renamed to "Build watcher"');
  });

  it("reports no change when the terminal agent already carries the name", async () => {
    rpcMock.mockImplementation((method: string) => {
      if (method === "agent.list") {
        return Promise.resolve(
          listResponse([
            agentRow({ id: "tui_1", surface: "tui", isLocal: true }),
          ]),
        );
      }
      return Promise.resolve({ updated: false });
    });

    const result = await command({ agentId: "tui_1", name: "Build watcher" });

    expect(result.data).toEqual({
      agentId: "tui_1",
      name: "Build watcher",
      updated: false,
    });
    expect(result.human).toBe(
      'tui_1: no change (already named "Build watcher")',
    );
  });

  it("refuses a blank name before any host call", async () => {
    const error = await command({ agentId: "chat_1", name: "   " }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("refuses an agent that runs on another host without writing", async () => {
    rpcMock.mockResolvedValue(
      listResponse([
        agentRow({ id: "chat_1", surface: "gui", isLocal: false }),
      ]),
    );

    const error = await command({
      agentId: "chat_1",
      name: "Release prep",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.AGENT_NOT_LOCAL);
    expect(error.message).toContain("chat_1");
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("agent.list", expect.anything());
  });

  // A chat migrated from v1.0.0 carries `originHostId: "legacy"`, which
  // `agent.list` reports as `isLocal: false`; the host's own rename paths admit
  // that sentinel, so the CLI must not read it as another machine.
  it("renames a legacy-origin chat that agent.list reports as not local", async () => {
    rpcMock.mockImplementation((method: string) => {
      if (method === "agent.list") {
        return Promise.resolve(
          listResponse([
            {
              ...agentRow({
                id: "chat-legacy",
                surface: "gui",
                isLocal: false,
              }),
              hostId: LEGACY_HOST_ID,
            },
          ]),
        );
      }
      return Promise.resolve({ updated: true });
    });

    const result = await command({ agentId: "chat-legacy", name: "New" });

    expect(rpcMock).toHaveBeenCalledWith("epic.renameChat", {
      epicId: "epic_1",
      chatId: "chat-legacy",
      title: "New",
    });
    expect(result.exitCode).toBe(0);
  });

  it("remaps the host's TARGET_NOT_LOCAL refusal to E_AGENT_NOT_LOCAL", async () => {
    rpcMock.mockImplementation((method: string) => {
      if (method === "agent.list") {
        return Promise.resolve(
          listResponse([
            agentRow({ id: "tui_1", surface: "tui", isLocal: true }),
          ]),
        );
      }
      return Promise.reject(
        hostRpcError(
          "RPC_ERROR",
          "TARGET_NOT_LOCAL: epic.renameTuiAgent refused terminal agent 'tui_1' - it is bound to host 'host_other'.",
        ),
      );
    });

    const error = await command({
      agentId: "tui_1",
      name: "Build watcher",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.AGENT_NOT_LOCAL);
    expect(error.message).toContain("tui_1");
  });

  it("fails with E_AGENT_RECORD_NOT_FOUND when the epic lists no such agent", async () => {
    rpcMock.mockResolvedValue(
      listResponse([agentRow({ id: "chat_1", surface: "gui", isLocal: true })]),
    );

    const error = await command({
      agentId: "missing",
      name: "Release prep",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.AGENT_RECORD_NOT_FOUND);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("fails fast with E_INVALID_ARGUMENT and sends zero frames when the epic id is missing", async () => {
    const error = await buildAgentRenameCommand({
      epicId: null,
      senderAgentId: "agent-caller",
      agentId: "chat_1",
      name: "Release prep",
    })(makeCtx()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
