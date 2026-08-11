import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentActivityFromHookCommand } from "../agent-activity-from-hook";
import { callHostRpcFastFail } from "../../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../../runner/errors";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
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
  rpcMock.mockResolvedValue({ accepted: true, pendingPromptContext: null });
  setAgentIdentityEnv();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  restoreStdin();
  restoreAgentIdentityEnv();
});

describe("buildAgentActivityFromHookCommand - start edge (promptSubmitted)", () => {
  it("calls promptSubmitted with the observed Claude session id read from stdin", async () => {
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "sess-live-9", cwd: "/tmp" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("agent.tui.promptSubmitted", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      observedHarnessSessionId: "sess-live-9",
    });
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ accepted: true, reason: null });
    expect(result.human).toBeNull();
  });

  it("emits the UserPromptSubmit additionalContext envelope when pendingPromptContext is non-null", async () => {
    rpcMock.mockResolvedValue({
      accepted: true,
      pendingPromptContext: "Traycer role registry update:\n- role= scope=",
    });
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "sess-live-9" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ accepted: true, reason: null });
    expect(result.human).toBe(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "Traycer role registry update:\n- role= scope=",
        },
      }),
    );
  });

  it("emits no stdout when pendingPromptContext is null", async () => {
    rpcMock.mockResolvedValue({ accepted: true, pendingPromptContext: null });
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "sess-live-9" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(result.human).toBeNull();
    expect(result.data).toEqual({ accepted: true, reason: null });
  });

  it("never reads stdin for a non-claude provider (observed id stays null)", async () => {
    // A payload IS present on stdin, but a codex activity edge must not consume
    // it - only claude stamps a resumable session id.
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "should-be-ignored" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "codex",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.promptSubmitted", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "codex",
      observedHarnessSessionId: null,
    });
  });

  it("routes an opencode start through recordActivity, never promptSubmitted", async () => {
    // OpenCode's in-process plugin consumes no hook stdout, so the pull path
    // would let the host advance its roles cursor for a snapshot the model
    // never receives. The start edge must stay a plain activity edge - with
    // no stdout, since anything printed may surface back into the TUI.
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "ses-oc-live-2" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "opencode",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "opencode",
      event: "start",
      observedHarnessSessionId: "ses-oc-live-2",
    });
    expect(result.human).toBeNull();
  });

  it("never reads stdin for a session-id-keyed opencode hook", async () => {
    // The shared-server plugin instance identifies the agent by session id and
    // never pipes a payload; a stray one must not become an observed id (the
    // host refuses resyncs from session-id-keyed requests anyway).
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "should-be-ignored" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "opencode",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: "ses-oc-1",
    });
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: null,
      tuiAgentId: null,
      harnessSessionId: "ses-oc-1",
      harnessId: "opencode",
      event: "start",
      observedHarnessSessionId: null,
    });
  });

  it("sends a null observed id when the payload has no session_id", async () => {
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ cwd: "/tmp" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.promptSubmitted", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      observedHarnessSessionId: null,
    });
  });

  it("sends a null observed id when stdin is non-JSON", async () => {
    stubStdin({ isTTY: false, chunks: ["not json"] });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.promptSubmitted",
      expect.objectContaining({ observedHarnessSessionId: null }),
    );
  });

  it("sends a null observed id when stdin is a TTY", async () => {
    stubStdin({ isTTY: true, chunks: [] });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.promptSubmitted",
      expect.objectContaining({ observedHarnessSessionId: null }),
    );
  });

  it("exits cleanly without an RPC call when identity context is missing", async () => {
    delete process.env.TRAYCER_EPIC_ID;
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "s" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      accepted: false,
      reason: "missing-context",
    });
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
      chunks: [JSON.stringify({ session_id: "s" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      accepted: false,
      reason: "host-unreachable",
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("buildAgentActivityFromHookCommand - start edge fallback (host too old)", () => {
  it("falls back to recordActivity silently when the host doesn't support promptSubmitted", async () => {
    rpcMock.mockRejectedValueOnce(
      new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message:
          "This host does not support 'agent.tui.promptSubmitted'. Upgrade the host to use this feature.",
        requestId: "req-1",
        method: "agent.tui.promptSubmitted",
        fatalDetails: null,
      }),
    );
    rpcMock.mockResolvedValueOnce({ accepted: true });
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "sess-live-9" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock).toHaveBeenNthCalledWith(1, "agent.tui.promptSubmitted", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      observedHarnessSessionId: "sess-live-9",
    });
    expect(rpcMock).toHaveBeenNthCalledWith(2, "agent.tui.recordActivity", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      event: "start",
      observedHarnessSessionId: "sess-live-9",
    });
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ accepted: true, reason: null });
    expect(result.human).toBeNull();
  });

  it("noops with exit 0 if the recordActivity fallback also hits a dead host", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    rpcMock.mockRejectedValueOnce(
      new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message: "This host does not support 'agent.tui.promptSubmitted'.",
        requestId: "req-1",
        method: "agent.tui.promptSubmitted",
        fatalDetails: null,
      }),
    );
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
      chunks: [JSON.stringify({ session_id: "s" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      accepted: false,
      reason: "host-unreachable",
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("still surfaces a genuine host RPC_ERROR from promptSubmitted (not swallowed as a fallback trigger)", async () => {
    rpcMock.mockRejectedValueOnce(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "terminal agent not found",
        requestId: "req-2",
        method: "agent.tui.promptSubmitted",
        fatalDetails: null,
      }),
    );
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "s" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    await expect(fn(makeCtx())).rejects.toThrow(/terminal agent not found/);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});

describe("buildAgentActivityFromHookCommand - stop edge (recordActivity, unchanged)", () => {
  it("carries the observed id on the stop edge via recordActivity", async () => {
    rpcMock.mockResolvedValue({ accepted: true });
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ session_id: "sess-live-stop" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "stop",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      event: "stop",
      observedHarnessSessionId: "sess-live-stop",
    });
    expect(result.data).toEqual({ accepted: true, reason: null });
    expect(result.human).toBeNull();
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
      chunks: [JSON.stringify({ session_id: "s" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "stop",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      accepted: false,
      reason: "host-unreachable",
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("buildAgentActivityFromHookCommand - shared identity/event parsing", () => {
  it("noops on unknown provider without an RPC call", async () => {
    const fn = buildAgentActivityFromHookCommand({
      provider: "bogus",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      accepted: false,
      reason: "unknown-provider",
    });
  });

  it("noops on an unknown event without an RPC call", async () => {
    const fn = buildAgentActivityFromHookCommand({
      provider: "claude",
      event: "resume",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      accepted: false,
      reason: "unknown-event",
    });
  });
});
