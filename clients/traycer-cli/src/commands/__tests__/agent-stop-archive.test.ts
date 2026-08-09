/**
 * `traycer agent stop` and `traycer agent archive` command functions.
 *
 * Pins: typed request construction over the existing `agent.stop@1.0` /
 * `epic.setChatArchived@1.0` contracts, env-var epic-id defaulting, and the
 * CLI-side remap of the host's `AGENT_BUSY:` / `RECORD_NOT_FOUND:` message
 * prefixes (the only signal available - the 409-vs-500 split never crosses
 * the wire) into typed `CliError`s with actionable messages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentStopCommand } from "../agent-stop";
import { buildAgentArchiveCommand } from "../agent-archive";
import { callHostRpc } from "../../internal/host-rpc";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    callHostRpc: vi.fn(),
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

const PREV_EPIC = process.env.TRAYCER_EPIC_ID;

beforeEach(() => {
  rpcMock.mockReset();
  delete process.env.TRAYCER_EPIC_ID;
});

afterEach(() => {
  if (PREV_EPIC === undefined) delete process.env.TRAYCER_EPIC_ID;
  else process.env.TRAYCER_EPIC_ID = PREV_EPIC;
});

function rpcError(code: RpcErrorCode, message: string): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "req_1",
    method: "epic.setChatArchived",
    fatalDetails: null,
  });
}

describe("agent stop command function", () => {
  it("sends the typed request with the resolved epic id and cascade default", async () => {
    rpcMock.mockResolvedValue({ stoppedAgentIds: ["agent_1"] });

    const result = await buildAgentStopCommand({
      epicId: "epic_1",
      agentId: "agent_1",
      cascade: false,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.stop", {
      epicId: "epic_1",
      agentId: "agent_1",
      cascade: false,
    });
    expect(result.data).toEqual({ stoppedAgentIds: ["agent_1"] });
    expect(result.human).toBe("agent_1");
    expect(result.exitCode).toBe(0);
  });

  it("maps --cascade to cascade: true", async () => {
    rpcMock.mockResolvedValue({ stoppedAgentIds: ["agent_1", "agent_2"] });

    const result = await buildAgentStopCommand({
      epicId: "epic_1",
      agentId: "agent_1",
      cascade: true,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.stop",
      expect.objectContaining({ cascade: true }),
    );
    expect(result.human).toBe("agent_1\nagent_2");
  });

  it("prints a plain message when nothing was stopped", async () => {
    rpcMock.mockResolvedValue({ stoppedAgentIds: [] });

    const result = await buildAgentStopCommand({
      epicId: "epic_1",
      agentId: "agent_1",
      cascade: false,
    })(makeCtx());

    expect(result.human).toBe("no agents stopped");
  });

  it("resolves epicId from $TRAYCER_EPIC_ID when the flag is omitted", async () => {
    process.env.TRAYCER_EPIC_ID = "epic-env";
    rpcMock.mockResolvedValue({ stoppedAgentIds: [] });

    await buildAgentStopCommand({
      epicId: null,
      agentId: "agent_1",
      cascade: false,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.stop",
      expect.objectContaining({ epicId: "epic-env" }),
    );
  });

  it("fails fast with E_INVALID_ARGUMENT and sends zero frames when epicId is missing", async () => {
    const error = await buildAgentStopCommand({
      epicId: null,
      agentId: "agent_1",
      cascade: false,
    })(makeCtx()).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("agent archive command function", () => {
  it("sends archived: true by default and reports the update", async () => {
    rpcMock.mockResolvedValue({ updated: true });

    const result = await buildAgentArchiveCommand({
      epicId: "epic_1",
      agentId: "agent_1",
      unarchive: false,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("epic.setChatArchived", {
      epicId: "epic_1",
      chatId: "agent_1",
      archived: true,
    });
    expect(result.data).toEqual({ updated: true });
    expect(result.human).toBe("agent_1 archived");
    expect(result.exitCode).toBe(0);
  });

  it("sends archived: false with --unarchive", async () => {
    rpcMock.mockResolvedValue({ updated: true });

    const result = await buildAgentArchiveCommand({
      epicId: "epic_1",
      agentId: "agent_1",
      unarchive: true,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "epic.setChatArchived",
      expect.objectContaining({ archived: false }),
    );
    expect(result.human).toBe("agent_1 unarchived");
  });

  // `updated: false` is not proof the record exists: the @1.0 response contract
  // also permits it for an id that matched nothing, so the copy stays
  // noncommittal rather than claiming success for a mistyped id (PR #1076
  // review).
  it("reports updated:false noncommittally, without asserting the record exists", async () => {
    rpcMock.mockResolvedValue({ updated: false });

    const archived = await buildAgentArchiveCommand({
      epicId: "epic_1",
      agentId: "agent_1",
      unarchive: false,
    })(makeCtx());
    expect(archived.human).toBe(
      "agent_1: no change (already archived, or no such record)",
    );

    rpcMock.mockResolvedValue({ updated: false });
    const unarchived = await buildAgentArchiveCommand({
      epicId: "epic_1",
      agentId: "agent_1",
      unarchive: true,
    })(makeCtx());
    expect(unarchived.human).toBe(
      "agent_1: no change (already unarchived, or no such record)",
    );
  });

  it("remaps a TARGET_NOT_LOCAL: refusal to E_AGENT_NOT_LOCAL with owning-host guidance", async () => {
    rpcMock.mockRejectedValue(
      rpcError(
        "RPC_ERROR",
        "TARGET_NOT_LOCAL: epic.setChatArchived refused to archive agent 'agent_1' - it runs on host 'host_other'.",
      ),
    );

    const error = await buildAgentArchiveCommand({
      epicId: "epic_1",
      agentId: "agent_1",
      unarchive: false,
    })(makeCtx()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.AGENT_NOT_LOCAL);
    expect(error.message).toContain("runs on another host");
    expect(error.message).not.toContain("TARGET_NOT_LOCAL");
  });

  it("remaps a running-turn AGENT_BUSY: message to E_AGENT_ARCHIVE_BUSY, keeping the host's stop remedy", async () => {
    rpcMock.mockRejectedValue(
      rpcError(
        "RPC_ERROR",
        "AGENT_BUSY: epic.setChatArchived refused to archive agent 'agent_1' - " +
          "nothing was changed. A turn is in progress, or one is about to start. " +
          "Stopping the agent clears a turn - but NOT a detached subagent, workflow " +
          "or scheduled wake, which all survive a stop. Wait for it to go idle - or " +
          "stop the agent - and retry.",
      ),
    );

    const error = await buildAgentArchiveCommand({
      epicId: "epic_1",
      agentId: "agent_1",
      unarchive: false,
    })(makeCtx()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.AGENT_ARCHIVE_BUSY);
    expect(error.message).toContain("A turn is in progress");
    expect(error.message).toContain("Stopping the agent clears a turn");
    // The wire-level reason prefix is an internal signal, not user copy.
    expect(error.message).not.toContain("AGENT_BUSY");
  });

  // Regression: the host's OTHER busy arm prescribes the opposite remedy -
  // stopping cannot clear background items. An earlier revision substituted a
  // single "stop it first" line for every busy case, which walked this arm
  // into a retry loop (PR #1076 review).
  it("preserves the background-items AGENT_BUSY: arm instead of advising a stop", async () => {
    rpcMock.mockRejectedValue(
      rpcError(
        "RPC_ERROR",
        "AGENT_BUSY: epic.setChatArchived refused to archive agent 'agent_1' - " +
          "nothing was changed. It has items still running in the background. " +
          "Stopping the agent will NOT clear these - stop stops a turn, and there " +
          "is no turn running. Wait for the background items to finish, or stop " +
          "them individually from the agent's chat, then retry.",
      ),
    );

    const error = await buildAgentArchiveCommand({
      epicId: "epic_1",
      agentId: "agent_1",
      unarchive: false,
    })(makeCtx()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.AGENT_ARCHIVE_BUSY);
    expect(error.message).toContain("items still running in the background");
    expect(error.message).toContain("will NOT clear these");
    expect(error.message).not.toContain("AGENT_BUSY");
  });

  it("remaps a RECORD_NOT_FOUND: message to a missing-agent E_AGENT_RECORD_NOT_FOUND error", async () => {
    rpcMock.mockRejectedValue(
      rpcError(
        "RPC_ERROR",
        "RECORD_NOT_FOUND: epic.setChatArchived found no chat or terminal-agent 'agent_missing' in epic 'epic_1'.",
      ),
    );

    const error = await buildAgentArchiveCommand({
      epicId: "epic_1",
      agentId: "agent_missing",
      unarchive: false,
    })(makeCtx()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.AGENT_RECORD_NOT_FOUND);
    expect(error.message).toBe(
      "traycer: no agent with id agent_missing in this epic.",
    );
  });

  it("does not gate --unarchive on a busy target: a RECORD_NOT_FOUND still remaps", async () => {
    rpcMock.mockRejectedValue(
      rpcError(
        "RPC_ERROR",
        "RECORD_NOT_FOUND: epic.setChatArchived found no chat or terminal-agent 'agent_missing' in epic 'epic_1'.",
      ),
    );

    const error = await buildAgentArchiveCommand({
      epicId: "epic_1",
      agentId: "agent_missing",
      unarchive: true,
    })(makeCtx()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.AGENT_RECORD_NOT_FOUND);
  });

  it("leaves an unrelated RPC failure untouched", async () => {
    rpcMock.mockRejectedValue(
      rpcError("RPC_ERROR", "something else went wrong"),
    );

    const error = await buildAgentArchiveCommand({
      epicId: "epic_1",
      agentId: "agent_1",
      unarchive: false,
    })(makeCtx()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.UNEXPECTED);
    expect(error.message).toBe("something else went wrong");
  });

  it("surfaces host-unsupported guidance against an old host (non-floor RPC)", async () => {
    rpcMock.mockRejectedValue(
      new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message:
          "This host does not support 'epic.setChatArchived'. Upgrade the host to use this feature.",
        requestId: "req_1",
        method: "epic.setChatArchived",
        fatalDetails: {
          code: "E_HOST_UNSUPPORTED",
          reason: "This host does not support 'epic.setChatArchived'.",
          incompatibleMethods: null,
          upgradeGuidance: {
            clientShouldUpgrade: false,
            hostShouldUpgrade: true,
          },
        },
      }),
    );

    const error = await buildAgentArchiveCommand({
      epicId: "epic_1",
      agentId: "agent_1",
      unarchive: false,
    })(makeCtx()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNSUPPORTED);
  });

  it("resolves epicId from $TRAYCER_EPIC_ID when the flag is omitted", async () => {
    process.env.TRAYCER_EPIC_ID = "epic-env";
    rpcMock.mockResolvedValue({ updated: true });

    await buildAgentArchiveCommand({
      epicId: null,
      agentId: "agent_1",
      unarchive: false,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "epic.setChatArchived",
      expect.objectContaining({ epicId: "epic-env" }),
    );
  });
});
