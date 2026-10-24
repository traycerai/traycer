import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentSessionObservedFromHookCommand } from "../agent-session-observed-from-hook";
import { callHostRpcFastFail } from "../../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../../runner/errors";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import { RetryEpisodeOutcomeUnknownError } from "../../../../shared/host-transport/retrying-messenger";
import { prepareRequestPayload } from "../../../../shared/host-transport/ws-rpc-client";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  makeCtx,
  restoreAgentIdentityEnv,
  restoreStdin,
  setAgentIdentityEnv,
  stubStdin,
} from "./hook-test-helpers";

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
    callHostRpcFastFail: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpcFastFail);

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockResolvedValue({ accepted: true });
  setAgentIdentityEnv();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  restoreStdin();
  restoreAgentIdentityEnv();
});

describe("buildAgentSessionObservedFromHookCommand", () => {
  it("resyncs the observed id via a recordActivity resync edge", async () => {
    stubStdin({
      isTTY: false,
      chunks: [
        JSON.stringify({ session_id: "sess-fresh-1", source: "resume" }),
      ],
    });
    const fn = buildAgentSessionObservedFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      event: "resync",
      observedHarnessSessionId: "sess-fresh-1",
      spawnToken: null,
      turnId: null,
      inFlight: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ accepted: true, reason: null });
  });

  it("allows explicit command context to override env", async () => {
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "sess-flag" })],
    });
    const fn = buildAgentSessionObservedFromHookCommand({
      provider: "claude",
      epicId: "epic-flag",
      agentId: "agent-flag",
    });
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: "epic-flag",
      tuiAgentId: "agent-flag",
      harnessSessionId: null,
      harnessId: "claude",
      event: "resync",
      observedHarnessSessionId: "sess-flag",
      spawnToken: null,
      turnId: null,
      inFlight: null,
    });
  });

  it("noops when the payload has no session id (nothing to resync)", async () => {
    stubStdin({ isTTY: false, chunks: [JSON.stringify({ source: "clear" })] });
    const fn = buildAgentSessionObservedFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({ accepted: false, reason: "no-session" });
    expect(result.exitCode).toBe(0);
  });

  it("noops on empty stdin", async () => {
    stubStdin({ isTTY: false, chunks: [] });
    const fn = buildAgentSessionObservedFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({ accepted: false, reason: "no-session" });
  });

  it("resyncs the observed opencode root-session id too", async () => {
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "ses-oc-fresh-1" })],
    });
    const fn = buildAgentSessionObservedFromHookCommand({
      provider: "opencode",
      epicId: null,
      agentId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "opencode",
      event: "resync",
      observedHarnessSessionId: "ses-oc-fresh-1",
      spawnToken: null,
      turnId: null,
      inFlight: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ accepted: true, reason: null });
  });

  it("noops for a non-resync provider without reading its stdin payload", async () => {
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "ignored" })],
    });
    const fn = buildAgentSessionObservedFromHookCommand({
      provider: "codex",
      epicId: null,
      agentId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({ accepted: false, reason: "no-session" });
  });

  it("noops with exit 0 on unknown provider", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "s" })],
    });
    const fn = buildAgentSessionObservedFromHookCommand({
      provider: "bogus",
      epicId: null,
      agentId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      accepted: false,
      reason: "unknown-provider",
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("noops when identity context is missing", async () => {
    delete process.env.TRAYCER_AGENT_ID;
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "s" })],
    });
    const fn = buildAgentSessionObservedFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      accepted: false,
      reason: "missing-context",
    });
  });

  it.each([
    ["directly", false],
    [
      "on the retry that ended an episode whose earlier attempt may have run",
      true,
    ],
  ] as const)(
    "noops (host-too-old) when the request cannot project onto an older host, raised %s",
    async (_label, endedRetryEpisode) => {
      // A newer CLI negotiated recordActivity@1.1, but the running host only
      // speaks @1.0, whose event enum has no "resync": the transport fails to
      // project the request locally (before sending). The error is the one the
      // transport's own projection raises for this request.
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const projectionMiss = resyncProjectionMissOnOlderHost();
      rpcMock.mockRejectedValueOnce(
        endedRetryEpisode
          ? new RetryEpisodeOutcomeUnknownError(projectionMiss)
          : projectionMiss,
      );
      stubStdin({
        isTTY: false,
        chunks: [JSON.stringify({ session_id: "sess-x" })],
      });
      const fn = buildAgentSessionObservedFromHookCommand({
        provider: "claude",
        epicId: null,
        agentId: null,
      });
      const result = await fn(makeCtx());

      expect(rpcMock).toHaveBeenCalledTimes(1);
      expect(result.exitCode).toBe(0);
      expect(result.data).toEqual({
        accepted: false,
        reason: "host-too-old",
      });
      expect(stderrSpy).not.toHaveBeenCalled();
    },
  );

  it("still surfaces a genuine host RPC_ERROR (distinct from a projection miss)", async () => {
    // A real host-side RPC_ERROR (e.g. resolver failure) must NOT be swallowed
    // as host-too-old - only the specific request-projection message is benign.
    rpcMock.mockRejectedValueOnce(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "terminal agent not found",
        requestId: "req-y",
        method: "agent.tui.recordActivity",
        fatalDetails: null,
      }),
    );
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "sess-y" })],
    });
    const fn = buildAgentSessionObservedFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
    });
    await expect(fn(makeCtx())).rejects.toThrow(/terminal agent not found/);
  });

  it("noops with exit 0 when the host is not running", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    rpcMock.mockRejectedValueOnce(
      cliError({
        code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
        message: "traycer: host not running",
        details: null,
        exitCode: 1,
      }),
    );
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "sess-x" })],
    });
    const fn = buildAgentSessionObservedFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      accepted: false,
      reason: "host-unreachable",
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("still surfaces non-benign host errors (e.g. auth rejected)", async () => {
    rpcMock.mockRejectedValueOnce(
      cliError({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: "traycer: bearer rejected",
        details: null,
        exitCode: 1,
      }),
    );
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "sess-x" })],
    });
    const fn = buildAgentSessionObservedFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
    });
    await expect(fn(makeCtx())).rejects.toThrow(/bearer rejected/);
  });
});

/**
 * What the transport raises when this hook's resync request is prepared for a
 * host on `agent.tui.recordActivity@1.0`, produced by the transport's real
 * projection over the real registry rather than written by hand.
 */
function resyncProjectionMissOnOlderHost(): HostRpcError {
  try {
    prepareRequestPayload(
      hostRpcRegistry["agent.tui.recordActivity"],
      { major: 1, minor: 1 },
      { major: 1, minor: 0 },
      {
        epicId: "epic-x",
        tuiAgentId: "tui-x",
        harnessSessionId: null,
        harnessId: "claude",
        event: "resync",
        observedHarnessSessionId: "sess-x",
      },
      "req-x",
      "agent.tui.recordActivity",
    );
  } catch (cause) {
    if (cause instanceof HostRpcError) return cause;
    throw cause;
  }
  throw new Error("the resync request projected onto 1.0 unexpectedly");
}
