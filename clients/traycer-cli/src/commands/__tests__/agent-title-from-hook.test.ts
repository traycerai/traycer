import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { buildAgentTitleFromHookCommand } from "../agent-title-from-hook";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import { callHostRpcFastFail } from "../../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../../runner/errors";

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

const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");

function stubStdin(value: {
  isTTY: boolean;
  chunks: ReadonlyArray<string>;
}): void {
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: {
      isTTY: value.isTTY,
      async *[Symbol.asyncIterator]() {
        for (const chunk of value.chunks) yield Buffer.from(chunk);
      },
    },
  });
}

const PREV_ENV = {
  epic: process.env.TRAYCER_EPIC_ID,
  agent: process.env.TRAYCER_AGENT_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockResolvedValue({ accepted: true });
  process.env.TRAYCER_EPIC_ID = "epic-1";
  process.env.TRAYCER_AGENT_ID = "agent-1";
});

afterEach(() => {
  // Always reset timers + spies here so a failing assertion in any test
  // doesn't leak fake timers or installed spies into the next test.
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (realStdin !== undefined) {
    Object.defineProperty(process, "stdin", realStdin);
  }
  if (PREV_ENV.epic === undefined) delete process.env.TRAYCER_EPIC_ID;
  else process.env.TRAYCER_EPIC_ID = PREV_ENV.epic;
  if (PREV_ENV.agent === undefined) delete process.env.TRAYCER_AGENT_ID;
  else process.env.TRAYCER_AGENT_ID = PREV_ENV.agent;
});

describe("buildAgentTitleFromHookCommand", () => {
  it("extracts the prompt from a Claude hook payload and calls the host", async () => {
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ prompt: "explain this codebase" })],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("agent.tui.generateTitle", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      promptText: "explain this codebase",
    });
    expect(result.data).toEqual({ accepted: true, reason: null });
    expect(result.exitCode).toBe(0);
  });

  it("extracts the prompt from a Codex hook payload", async () => {
    stubStdin({
      isTTY: false,
      chunks: [
        JSON.stringify({ prompt: "fix the failing test", session_id: "s1" }),
      ],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "codex",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.generateTitle", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "codex",
      promptText: "fix the failing test",
    });
    expect(result.exitCode).toBe(0);
  });

  it("concatenates output.parts text entries for OpenCode payloads", async () => {
    stubStdin({
      isTTY: false,
      chunks: [
        JSON.stringify({
          output: {
            parts: [
              { type: "text", text: "rename the " },
              { type: "tool", text: "ignored" },
              { type: "text", text: "primary index" },
              { type: "text" },
            ],
          },
        }),
      ],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "opencode",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.generateTitle", {
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "opencode",
      promptText: "rename the primary index",
    });
  });

  it("uses an OpenCode harness session id without requiring per-agent env", async () => {
    delete process.env.TRAYCER_EPIC_ID;
    delete process.env.TRAYCER_AGENT_ID;
    stubStdin({
      isTTY: false,
      chunks: [
        JSON.stringify({
          output: {
            parts: [{ type: "text", text: "summarize this opencode turn" }],
          },
        }),
      ],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "opencode",
      epicId: null,
      agentId: null,
      harnessSessionId: "ses-opencode-1",
    });
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.generateTitle", {
      epicId: null,
      tuiAgentId: null,
      harnessSessionId: "ses-opencode-1",
      harnessId: "opencode",
      promptText: "summarize this opencode turn",
    });
  });

  it("exits cleanly without an RPC call when TRAYCER_EPIC_ID is missing", async () => {
    delete process.env.TRAYCER_EPIC_ID;
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ prompt: "hi" })],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      accepted: false,
      reason: "missing-context",
    });
  });

  it("exits cleanly without an RPC call when TRAYCER_AGENT_ID is missing", async () => {
    delete process.env.TRAYCER_AGENT_ID;
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ prompt: "hi" })],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      accepted: false,
      reason: "missing-context",
    });
  });

  it("exits cleanly when the prompt is empty", async () => {
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ prompt: "   " })],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      accepted: false,
      reason: "empty-prompt",
    });
    expect(result.exitCode).toBe(0);
  });

  it("exits cleanly when the OpenCode payload has no text parts", async () => {
    stubStdin({
      isTTY: false,
      chunks: [
        JSON.stringify({
          output: { parts: [{ type: "tool", text: "ignored" }] },
        }),
      ],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "opencode",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      accepted: false,
      reason: "empty-prompt",
    });
  });

  it("exits cleanly when stdin is empty", async () => {
    stubStdin({ isTTY: false, chunks: [] });
    const fn = buildAgentTitleFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      accepted: false,
      reason: "empty-stdin",
    });
  });

  it("exits cleanly when stdin is invalid JSON", async () => {
    stubStdin({ isTTY: false, chunks: ["not json at all"] });
    const fn = buildAgentTitleFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());

    // JSON parse returned null → indistinguishable from empty stdin.
    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      accepted: false,
      reason: "empty-stdin",
    });
  });

  it("noops with exit 0 on unknown provider (hook fires unconditionally)", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ prompt: "hi" })],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "bogus",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const result = await fn(makeCtx());
    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      accepted: false,
      reason: "unknown-provider",
    });
    expect(stderrSpy).not.toHaveBeenCalled();
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
      chunks: [JSON.stringify({ prompt: "explain" })],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
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
      chunks: [JSON.stringify({ prompt: "explain" })],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    await expect(fn(makeCtx())).rejects.toThrow(/bearer rejected/);
  });

  it("noops with exit 0 on stdin timeout (no chunks, no end)", async () => {
    vi.useFakeTimers();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    // Stdin that never yields and never ends.
    let stdinDestroyed = false;
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: {
        isTTY: false,
        async *[Symbol.asyncIterator]() {
          // Suspend forever (until destroy() rejects the await internally,
          // which Node's async iterator does - but for the unit test the
          // hard timeout is the path under exercise).
          await new Promise(() => {
            // never resolves
          });
        },
        destroy: () => {
          stdinDestroyed = true;
        },
      },
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const pending = fn(makeCtx());
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await pending;
    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      accepted: false,
      reason: "stdin-timeout",
    });
    expect(stdinDestroyed).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("prefers --epic-id and --agent-id flags over the env defaults", async () => {
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ prompt: "rename module" })],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "claude",
      epicId: "epic-flag",
      agentId: "agent-flag",
      harnessSessionId: null,
    });
    await fn(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.tui.generateTitle", {
      epicId: "epic-flag",
      tuiAgentId: "agent-flag",
      harnessSessionId: null,
      harnessId: "claude",
      promptText: "rename module",
    });
  });

  it("never includes the raw prompt in the human or data output", async () => {
    const secret = "SUPER SECRET PROMPT TEXT";
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ prompt: secret })],
    });
    const fn = buildAgentTitleFromHookCommand({
      provider: "claude",
      epicId: null,
      agentId: null,
      harnessSessionId: null,
    });
    const ctx = makeCtx();
    const result = await fn(ctx);
    expect(JSON.stringify(result)).not.toContain(secret);
    // Every output-channel mock the runtime exposes must never see the
    // raw prompt either - the returned-result check above is not enough
    // because the command could have logged via any of these channels
    // (the leak surface CodeRabbit flagged).
    const callsForChannel = (mock: Mock): string =>
      JSON.stringify(mock.mock.calls);
    expect(callsForChannel(ctx.output.progress as Mock)).not.toContain(secret);
    expect(callsForChannel(ctx.output.human as Mock)).not.toContain(secret);
    expect(callsForChannel(ctx.output.humanRequired as Mock)).not.toContain(
      secret,
    );
    expect(callsForChannel(ctx.output.emitResult as Mock)).not.toContain(
      secret,
    );
    expect(callsForChannel(ctx.output.emitError as Mock)).not.toContain(secret);
    expect(callsForChannel(ctx.progress as Mock)).not.toContain(secret);
  });
});
