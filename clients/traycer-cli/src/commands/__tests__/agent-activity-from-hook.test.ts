import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentActivityFromHookCommand } from "../agent-activity-from-hook";
import { callHostRpcFastFail } from "../../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../../runner/errors";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import { prepareRequestPayload } from "../../../../shared/host-transport/ws-rpc-client";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { TRAYCER_INBOX_MONITOR_DESCRIPTION } from "@traycer/protocol/host/agent/tui/unary-schemas";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const PREV_SPAWN_TOKEN = process.env.TRAYCER_TERMINAL_SPAWN_TOKEN;

beforeEach(() => {
  delete process.env.TRAYCER_TERMINAL_SPAWN_TOKEN;
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
  if (PREV_SPAWN_TOKEN === undefined) {
    delete process.env.TRAYCER_TERMINAL_SPAWN_TOKEN;
  } else process.env.TRAYCER_TERMINAL_SPAWN_TOKEN = PREV_SPAWN_TOKEN;
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
      notifyPayload: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("agent.tui.promptSubmitted", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      observedHarnessSessionId: "sess-live-9",
      spawnToken: null,
      turnId: null,
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
      notifyPayload: null,
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
      notifyPayload: null,
    });
    const result = await fn(makeCtx());

    expect(result.human).toBeNull();
    expect(result.data).toEqual({ accepted: true, reason: null });
  });

  it("reads the codex turn id from stdin but never an observed session id", async () => {
    // Codex's hook payload carries `session_id` too, but only claude/opencode
    // resync from it; codex contributes just its `turn_id`.
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ turn_id: "t-1", session_id: "ignored-sess" })],
    });
    const fn = buildAgentActivityFromHookCommand({
      provider: "codex",
      event: "start",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
      notifyPayload: null,
    });
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.promptSubmitted", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "codex",
      observedHarnessSessionId: null,
      spawnToken: null,
      turnId: "t-1",
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
      notifyPayload: null,
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
      spawnToken: null,
      turnId: null,
      inFlight: null,
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
      notifyPayload: null,
    });
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: null,
      tuiAgentId: null,
      harnessSessionId: "ses-oc-1",
      harnessId: "opencode",
      event: "start",
      observedHarnessSessionId: null,
      spawnToken: null,
      turnId: null,
      inFlight: null,
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
      notifyPayload: null,
    });
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.promptSubmitted", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      observedHarnessSessionId: null,
      spawnToken: null,
      turnId: null,
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
      notifyPayload: null,
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
      notifyPayload: null,
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
      notifyPayload: null,
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
      notifyPayload: null,
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
      notifyPayload: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock).toHaveBeenNthCalledWith(1, "agent.tui.promptSubmitted", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      observedHarnessSessionId: "sess-live-9",
      spawnToken: null,
      turnId: null,
    });
    expect(rpcMock).toHaveBeenNthCalledWith(2, "agent.tui.recordActivity", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      event: "start",
      observedHarnessSessionId: "sess-live-9",
      spawnToken: null,
      turnId: null,
      inFlight: null,
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
      notifyPayload: null,
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
      notifyPayload: null,
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
      notifyPayload: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.recordActivity", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      event: "stop",
      observedHarnessSessionId: "sess-live-stop",
      spawnToken: null,
      turnId: null,
      inFlight: null,
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
      notifyPayload: null,
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
      notifyPayload: null,
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
      notifyPayload: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      accepted: false,
      reason: "unknown-event",
    });
  });
});

type HookProvider = "claude" | "codex" | "opencode";

async function runHook(opts: {
  readonly provider: HookProvider;
  readonly event: string;
  readonly stdin: unknown;
  readonly harnessSessionId?: string | null;
  readonly notifyPayload?: string | null;
}) {
  stubStdin({
    isTTY: false,
    chunks: opts.stdin === undefined ? [] : [JSON.stringify(opts.stdin)],
  });
  const fn = buildAgentActivityFromHookCommand({
    provider: opts.provider,
    event: opts.event,
    epicId: null,
    agentId: null,
    harnessSessionId: opts.harnessSessionId ?? null,
    notifyPayload: opts.notifyPayload ?? null,
  });
  return fn(makeCtx());
}

function recordActivityBody(overrides: Record<string, unknown>) {
  return {
    epicId: "epic-1",
    tuiAgentId: "agent-1",
    harnessSessionId: null,
    observedHarnessSessionId: null,
    spawnToken: null,
    turnId: null,
    inFlight: null,
    ...overrides,
  };
}

const INBOX_MONITOR = {
  id: "mon-1",
  type: "shell",
  status: "running",
  description: TRAYCER_INBOX_MONITOR_DESCRIPTION,
  command: "/opt/traycer/bin/traycer monitor",
};
const DEV_SERVER = {
  id: "bg-2",
  type: "shell",
  status: "running",
  description: "dev server",
  command: "python3 -m http.server",
};

describe("spawn token", () => {
  it("rides every request from TRAYCER_TERMINAL_SPAWN_TOKEN, trimmed", async () => {
    process.env.TRAYCER_TERMINAL_SPAWN_TOKEN = "  spawn-abc \n";
    await runHook({ provider: "claude", event: "start", stdin: {} });
    await runHook({ provider: "claude", event: "stop", stdin: {} });

    expect(rpcMock).toHaveBeenNthCalledWith(
      1,
      "agent.tui.promptSubmitted",
      expect.objectContaining({ spawnToken: "spawn-abc" }),
    );
    expect(rpcMock).toHaveBeenNthCalledWith(
      2,
      "agent.tui.recordActivity",
      expect.objectContaining({ spawnToken: "spawn-abc" }),
    );
  });

  it("is null when the variable is blank", async () => {
    process.env.TRAYCER_TERMINAL_SPAWN_TOKEN = "   ";
    await runHook({ provider: "claude", event: "stop", stdin: {} });

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      expect.objectContaining({ spawnToken: null }),
    );
  });
});

describe("claude start edge - turn id", () => {
  it("sends the hook's prompt_id as turnId on promptSubmitted", async () => {
    await runHook({
      provider: "claude",
      event: "start",
      stdin: { session_id: "sess-1", prompt_id: "prompt-7" },
    });

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.promptSubmitted", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      observedHarnessSessionId: "sess-1",
      spawnToken: null,
      turnId: "prompt-7",
    });
  });

  it("carries the same turnId on the recordActivity fallback", async () => {
    rpcMock.mockRejectedValueOnce(
      new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message: "This host does not support 'agent.tui.promptSubmitted'.",
        requestId: "req-1",
        method: "agent.tui.promptSubmitted",
        fatalDetails: null,
      }),
    );
    rpcMock.mockResolvedValueOnce({ accepted: true });
    await runHook({
      provider: "claude",
      event: "start",
      stdin: { session_id: "sess-1", prompt_id: "prompt-7" },
    });

    expect(rpcMock).toHaveBeenNthCalledWith(
      2,
      "agent.tui.recordActivity",
      recordActivityBody({
        harnessId: "claude",
        event: "start",
        observedHarnessSessionId: "sess-1",
        turnId: "prompt-7",
        inFlight: null,
      }),
    );
  });
});

describe("claude stop edge - in-flight count", () => {
  async function stopWith(payload: Record<string, unknown>) {
    rpcMock.mockResolvedValue({ accepted: true });
    await runHook({
      provider: "claude",
      event: "stop",
      stdin: { prompt_id: "prompt-9", ...payload },
    });
    return rpcMock.mock.calls[0];
  }

  it.each([
    ["only the inbox monitor", [INBOX_MONITOR], [], 0],
    ["inbox monitor plus a dev server", [INBOX_MONITOR, DEV_SERVER], [], 1],
    [
      "a subagent entry",
      [INBOX_MONITOR, { id: "sa-1", type: "subagent", status: "running" }],
      [],
      1,
    ],
    ["one session cron", [INBOX_MONITOR], [{ id: "cron-1" }], 1],
    [
      "an inbox-description entry whose command does not end in ' monitor'",
      [{ ...INBOX_MONITOR, command: "/opt/traycer/bin/traycer inbox" }],
      [],
      1,
    ],
  ])("counts %s", async (_label, backgroundTasks, sessionCrons, count) => {
    const call = await stopWith({
      background_tasks: backgroundTasks,
      session_crons: sessionCrons,
    });

    expect(call).toEqual([
      "agent.tui.recordActivity",
      recordActivityBody({
        harnessId: "claude",
        event: "stop",
        turnId: "prompt-9",
        inFlight: { count },
      }),
    ]);
  });

  it.each([
    ["a StopFailure payload with neither array", {}],
    ["no session_crons array", { background_tasks: [] }],
    ["no background_tasks array", { session_crons: [] }],
    [
      "a non-array background_tasks",
      { background_tasks: "none", session_crons: [] },
    ],
  ])("reports inFlight null for %s", async (_label, payload) => {
    const call = await stopWith(payload);

    expect(call).toEqual([
      "agent.tui.recordActivity",
      recordActivityBody({
        harnessId: "claude",
        event: "stop",
        turnId: "prompt-9",
        inFlight: null,
      }),
    ]);
  });
});

describe("claude --event idle (Notification hook)", () => {
  it("reports idle-confirmed for an idle_prompt notification", async () => {
    rpcMock.mockResolvedValue({ accepted: true });
    const result = await runHook({
      provider: "claude",
      event: "idle",
      stdin: { notification_type: "idle_prompt", prompt_id: "prompt-3" },
    });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      recordActivityBody({
        harnessId: "claude",
        event: "idle-confirmed",
        turnId: "prompt-3",
        inFlight: null,
      }),
    );
    expect(result.exitCode).toBe(0);
  });

  it("makes no RPC for any other notification type", async () => {
    const result = await runHook({
      provider: "claude",
      event: "idle",
      stdin: { notification_type: "permission_prompt", prompt_id: "prompt-3" },
    });

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ accepted: false, reason: "not-idle-prompt" });
  });
});

describe("claude --event started (SessionStart hook)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "traycer-started-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function writeScheduledTasks(raw: string): void {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "scheduled_tasks.json"), raw);
  }

  async function started(source: string) {
    rpcMock.mockResolvedValue({ accepted: true });
    return runHook({
      provider: "claude",
      event: "started",
      stdin: { source, cwd },
    });
  }

  function startedBody(inFlight: { count: number } | null) {
    return recordActivityBody({
      harnessId: "claude",
      event: "started",
      turnId: null,
      inFlight,
    });
  }

  it.each(["startup", "resume"])(
    "counts 0 scheduled tasks when the file is absent (source %s)",
    async (source) => {
      await started(source);

      expect(rpcMock).toHaveBeenCalledWith(
        "agent.tui.recordActivity",
        startedBody({ count: 0 }),
      );
    },
  );

  it("counts the entries of scheduled_tasks.json", async () => {
    writeScheduledTasks(JSON.stringify({ tasks: [{ id: "a" }, { id: "b" }] }));
    await started("startup");

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      startedBody({ count: 2 }),
    );
  });

  it.each([
    ["unparseable JSON", "{not json"],
    ["an object without a tasks array", JSON.stringify({ tasks: "none" })],
  ])("reports inFlight null for %s", async (_label, raw) => {
    writeScheduledTasks(raw);
    await started("startup");

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      startedBody(null),
    );
  });

  it.each(["clear", "compact"])(
    "makes no RPC for source %s",
    async (source) => {
      const result = await started(source);

      expect(rpcMock).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
      expect(result.data).toEqual({ accepted: false, reason: "not-a-start" });
    },
  );
});

describe("started / idle-confirmed against a host too old for recordActivity@1.2", () => {
  function projectionMissOnOlderHost(event: string): HostRpcError {
    try {
      prepareRequestPayload(
        hostRpcRegistry["agent.tui.recordActivity"],
        { major: 1, minor: 2 },
        { major: 1, minor: 1 },
        recordActivityBody({ harnessId: "claude", event }),
        "req-x",
        "agent.tui.recordActivity",
      );
    } catch (cause) {
      if (cause instanceof HostRpcError) return cause;
      throw cause;
    }
    throw new Error(`the ${event} request projected onto 1.1 unexpectedly`);
  }

  it.each([
    ["started", { source: "startup", cwd: tmpdir() }],
    ["idle", { notification_type: "idle_prompt", prompt_id: "p" }],
  ])("noops (host-too-old) for --event %s", async (event, stdin) => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    rpcMock.mockRejectedValueOnce(
      projectionMissOnOlderHost(event === "idle" ? "idle-confirmed" : event),
    );
    const result = await runHook({ provider: "claude", event, stdin });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ accepted: false, reason: "host-too-old" });
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("opencode env-identified form", () => {
  it("sends the piped turn_id on the start edge", async () => {
    await runHook({
      provider: "opencode",
      event: "start",
      stdin: { session_id: "ses-oc-1", turn_id: "turn-oc-1" },
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      recordActivityBody({
        harnessId: "opencode",
        event: "start",
        observedHarnessSessionId: "ses-oc-1",
        turnId: "turn-oc-1",
      }),
    );
  });

  it("sends turn_id and in_flight on the stop edge", async () => {
    rpcMock.mockResolvedValue({ accepted: true });
    await runHook({
      provider: "opencode",
      event: "stop",
      stdin: {
        session_id: "ses-oc-1",
        turn_id: "turn-oc-1",
        in_flight: { count: 2 },
      },
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      recordActivityBody({
        harnessId: "opencode",
        event: "stop",
        observedHarnessSessionId: "ses-oc-1",
        turnId: "turn-oc-1",
        inFlight: { count: 2 },
      }),
    );
  });

  it.each([
    ["null", null],
    ["a non-object", "two"],
    ["a negative count", { count: -1 }],
    ["a non-integer count", { count: 1.5 }],
    ["a missing count", {}],
  ])("reports inFlight null for in_flight %s", async (_label, inFlight) => {
    rpcMock.mockResolvedValue({ accepted: true });
    await runHook({
      provider: "opencode",
      event: "stop",
      stdin: { session_id: "ses-oc-1", turn_id: "t", in_flight: inFlight },
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      expect.objectContaining({ inFlight: null }),
    );
  });

  it("reports started with the piped in_flight", async () => {
    rpcMock.mockResolvedValue({ accepted: true });
    await runHook({
      provider: "opencode",
      event: "started",
      stdin: { session_id: "ses-oc-1", in_flight: { count: 0 } },
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      recordActivityBody({
        harnessId: "opencode",
        event: "started",
        observedHarnessSessionId: "ses-oc-1",
        turnId: null,
        inFlight: { count: 0 },
      }),
    );
  });

  it("reads nothing from stdin in the session-id-keyed form", async () => {
    rpcMock.mockResolvedValue({ accepted: true });
    await runHook({
      provider: "opencode",
      event: "stop",
      harnessSessionId: "ses-oc-1",
      stdin: { turn_id: "ignored", in_flight: { count: 5 } },
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      recordActivityBody({
        epicId: null,
        tuiAgentId: null,
        harnessSessionId: "ses-oc-1",
        harnessId: "opencode",
        event: "stop",
      }),
    );
  });
});

describe("codex turn ids", () => {
  it("takes the stop turnId from the notify payload's turn-id", async () => {
    rpcMock.mockResolvedValue({ accepted: true });
    await runHook({
      provider: "codex",
      event: "stop",
      stdin: undefined,
      notifyPayload:
        '{"type":"agent-turn-complete","turn-id":"t-1","thread-id":"th-1"}',
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      recordActivityBody({
        harnessId: "codex",
        event: "stop",
        turnId: "t-1",
        inFlight: null,
      }),
    );
  });

  it.each([
    ["no payload", null],
    ["a garbage payload", "not json"],
  ])("sends a null stop turnId for %s", async (_label, notifyPayload) => {
    rpcMock.mockResolvedValue({ accepted: true });
    await runHook({
      provider: "codex",
      event: "stop",
      stdin: undefined,
      notifyPayload,
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      recordActivityBody({ harnessId: "codex", event: "stop", turnId: null }),
    );
  });

  it.each(["idle", "started"])("makes no RPC for --event %s", async (event) => {
    const result = await runHook({
      provider: "codex",
      event,
      stdin: { source: "startup", notification_type: "idle_prompt" },
    });

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      accepted: false,
      reason: "unknown-event",
    });
  });
});
