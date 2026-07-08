import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentActivityFromHookCommand } from "../agent-activity-from-hook";
import { callHostRpcFastFail } from "../../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../../runner/errors";
import {
  makeCtx,
  restoreAgentIdentityEnv,
  restoreStdin,
  setAgentIdentityEnv,
  stubStdin,
} from "./hook-test-helpers";

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

describe("buildAgentActivityFromHookCommand", () => {
  it("sends the observed Claude session id read from the hook stdin payload", async () => {
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
    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      event: "start",
      observedHarnessSessionId: "sess-live-9",
    });
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ accepted: true, reason: null });
  });

  it("carries the observed id on the stop edge too", async () => {
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
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      event: "stop",
      observedHarnessSessionId: "sess-live-stop",
    });
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

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "codex",
      event: "start",
      observedHarnessSessionId: null,
    });
  });

  it("reads stdin for an env-identified opencode hook (root-session form)", async () => {
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
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "opencode",
      event: "start",
      observedHarnessSessionId: "ses-oc-live-2",
    });
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
      event: "stop",
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
      event: "stop",
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

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      event: "start",
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
      "agent.tui.recordActivity",
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
      "agent.tui.recordActivity",
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
