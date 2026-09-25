import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  A2A_MESSAGE_MAX_UTF8_BYTES,
  utf8ByteLength,
} from "@traycer/protocol/host/agent/shared";
import { buildAgentSendCommand } from "../agent-send";
import { callHostRpc } from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext, CommandFn } from "../../runner/runner";

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
  return { ...actual, callHostRpc: vi.fn() };
});

const rpcMock = vi.mocked(callHostRpc);
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");
const tempDirs: string[] = [];

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

function buildCommand(
  prompt: Partial<{
    readonly message: string | null;
    readonly messageFile: string | null;
    readonly stdin: boolean;
  }>,
) {
  return buildAgentSendCommand({
    epicId: "epic-1",
    senderAgentId: "agent-sender",
    to: "agent-receiver",
    message: null,
    messageFile: null,
    stdin: false,
    expectReply: false,
    responseId: null,
    ...prompt,
  });
}

function stubStdin(value: {
  readonly isTTY: boolean;
  readonly chunks?: readonly (Buffer | string)[];
  readonly onChunkRead?: (index: number) => void;
  readonly reject?: boolean;
}): Mock {
  const destroy = vi.fn();
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: {
      isTTY: value.isTTY,
      destroy,
      async *[Symbol.asyncIterator]() {
        for (const [index, chunk] of (value.chunks ?? []).entries()) {
          value.onChunkRead?.(index);
          yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        }
        if (value.reject === true) throw new Error("private stream failure");
      },
    },
  });
  return destroy;
}

async function captureError(command: CommandFn): Promise<CliError> {
  const error = await command(makeCtx()).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(CliError);
  if (!(error instanceof CliError)) throw new Error("unreachable");
  return error;
}

function expectNoPromptLeak(prompt: string, value: unknown): void {
  expect(String(value)).not.toContain(prompt);
  expect(JSON.stringify(value)).not.toContain(prompt);
  expect(
    JSON.stringify(Object.values(loggerMock).map((mock) => mock.mock.calls)),
  ).not.toContain(prompt);
}

function lastSentPrompt(): string {
  const request: unknown = rpcMock.mock.lastCall?.[1];
  if (typeof request !== "object" || request === null) {
    throw new Error("agent.sendMessage request was not recorded");
  }
  const prompt = Reflect.get(request, "prompt");
  if (typeof prompt !== "string") {
    throw new Error("agent.sendMessage request has no prompt");
  }
  return prompt;
}

const TOO_LARGE_MESSAGE = `traycer agent send: prompt exceeds the ${A2A_MESSAGE_MAX_UTF8_BYTES}-byte UTF-8 limit.`;

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockResolvedValue({ responseId: null });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (realStdin !== undefined)
    Object.defineProperty(process, "stdin", realStdin);
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("agent send prompt sources", () => {
  it("preserves the existing --message request without returning or logging the prompt", async () => {
    const prompt = "inline prompt: do not disclose";
    const result = await buildCommand({ message: prompt })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.sendMessage", {
      senderAgentId: "agent-sender",
      epicId: "epic-1",
      receiverAgentId: "agent-receiver",
      prompt,
      responseId: null,
      expectReply: false,
    });
    expect(result).toEqual({
      data: { responseId: null },
      human: "sent to agent-receiver",
      exitCode: 0,
    });
    expectNoPromptLeak(prompt, result);
  });

  it("accepts a --message-file exactly at the canonical UTF-8 byte limit", async () => {
    const prompt = "f".repeat(A2A_MESSAGE_MAX_UTF8_BYTES);
    const directory = await mkdtemp(join(tmpdir(), "traycer-agent-send-"));
    tempDirs.push(directory);
    const path = join(directory, "prompt.txt");
    await writeFile(path, prompt, "utf8");

    const result = await buildCommand({ messageFile: path })(makeCtx());

    expect(utf8ByteLength(lastSentPrompt())).toBe(A2A_MESSAGE_MAX_UTF8_BYTES);
    expectNoPromptLeak(prompt, result);
  });

  it("stops and rejects a --message-file at limit plus one byte", async () => {
    const privatePrefix = "private file prompt";
    const prompt = `${privatePrefix}${"f".repeat(
      A2A_MESSAGE_MAX_UTF8_BYTES + 1 - privatePrefix.length,
    )}`;
    const directory = await mkdtemp(join(tmpdir(), "traycer-agent-send-"));
    tempDirs.push(directory);
    const path = join(directory, "prompt.txt");
    await writeFile(path, prompt, "utf8");

    const error = await captureError(buildCommand({ messageFile: path }));

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: TOO_LARGE_MESSAGE,
      details: null,
    });
    expect(rpcMock).not.toHaveBeenCalled();
    expectNoPromptLeak(privatePrefix, error);
  });

  it("rejects malformed UTF-8 from --message-file without echoing content or path", async () => {
    const privatePrefix = "private malformed file prompt";
    const directory = await mkdtemp(join(tmpdir(), "traycer-agent-send-"));
    tempDirs.push(directory);
    const privatePath = join(directory, "private-prompt-name.txt");
    await writeFile(
      privatePath,
      Buffer.concat([Buffer.from(privatePrefix), Buffer.from([0xc3, 0x28])]),
    );

    const error = await captureError(
      buildCommand({ messageFile: privatePath }),
    );

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "traycer agent send: --message-file must contain valid UTF-8.",
      details: null,
      exitCode: 1,
    });
    expect(rpcMock).not.toHaveBeenCalled();
    expectNoPromptLeak(privatePrefix, error);
    expectNoPromptLeak(privatePath, error);
  });

  it("preserves a leading UTF-8 BOM from --message-file", async () => {
    const prompt = "\uFEFFprompt whose leading marker must survive";
    const directory = await mkdtemp(join(tmpdir(), "traycer-agent-send-"));
    tempDirs.push(directory);
    const path = join(directory, "prompt.txt");
    await writeFile(path, prompt, "utf8");

    const result = await buildCommand({ messageFile: path })(makeCtx());

    expect(lastSentPrompt()).toBe(prompt);
    expectNoPromptLeak(prompt, result);
  });

  it("reads --stdin exactly and does not return or log its prompt", async () => {
    const prompt = "piped prompt\nwith formatting";
    stubStdin({ isTTY: false, chunks: ["piped ", "prompt\nwith formatting"] });

    const result = await buildCommand({ stdin: true })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.sendMessage",
      expect.objectContaining({ prompt }),
    );
    expectNoPromptLeak(prompt, result);
  });

  it("stops and rejects --stdin at limit plus one byte", async () => {
    const privatePrefix = "private stdin prompt";
    const prompt = Buffer.concat([
      Buffer.from(privatePrefix),
      Buffer.alloc(A2A_MESSAGE_MAX_UTF8_BYTES + 1 - privatePrefix.length, 0x73),
    ]);
    const onChunkRead = vi.fn();
    const destroy = stubStdin({
      isTTY: false,
      chunks: [prompt, "sentinel chunk must not be consumed"],
      onChunkRead,
    });

    const error = await captureError(buildCommand({ stdin: true }));

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: TOO_LARGE_MESSAGE,
      details: null,
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(onChunkRead).toHaveBeenCalledTimes(1);
    expect(onChunkRead).toHaveBeenCalledWith(0);
    expect(rpcMock).not.toHaveBeenCalled();
    expectNoPromptLeak(privatePrefix, error);
  });

  it("accepts a multibyte character split across chunks at the exact byte limit", async () => {
    stubStdin({
      isTTY: false,
      chunks: [
        Buffer.alloc(A2A_MESSAGE_MAX_UTF8_BYTES - 2, 0x61),
        Buffer.from([0xc3]),
        Buffer.from([0xa9]),
      ],
    });

    await buildCommand({ stdin: true })(makeCtx());

    const prompt = lastSentPrompt();
    expect(prompt.endsWith("é")).toBe(true);
    expect(utf8ByteLength(prompt)).toBe(A2A_MESSAGE_MAX_UTF8_BYTES);
  });

  it("rejects malformed UTF-8 split across stdin chunks without echoing content", async () => {
    const privatePrefix = "private malformed stdin prompt";
    stubStdin({
      isTTY: false,
      chunks: [
        Buffer.from(privatePrefix),
        Buffer.from([0xe2]),
        Buffer.from([0x28, 0xa1]),
      ],
    });

    const error = await captureError(buildCommand({ stdin: true }));

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "traycer agent send: the prompt from stdin must contain valid UTF-8.",
      details: null,
      exitCode: 1,
    });
    expect(rpcMock).not.toHaveBeenCalled();
    expectNoPromptLeak(privatePrefix, error);
  });

  it("rejects a multibyte character that crosses the byte limit", async () => {
    const destroy = stubStdin({
      isTTY: false,
      chunks: [
        Buffer.alloc(A2A_MESSAGE_MAX_UTF8_BYTES - 1, 0x61),
        Buffer.from([0xc3]),
        Buffer.from([0xa9]),
      ],
    });

    const error = await captureError(buildCommand({ stdin: true }));

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: TOO_LARGE_MESSAGE,
      details: null,
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no source", {}],
    [
      "message and file",
      { message: "private-inline", messageFile: "/private-file" },
    ],
    ["message and stdin", { message: "private-inline", stdin: true }],
    ["file and stdin", { messageFile: "/private-file", stdin: true }],
    [
      "all sources",
      { message: "private-inline", messageFile: "/private-file", stdin: true },
    ],
  ])(
    "rejects %s before reading input or calling the host",
    async (_label, prompt) => {
      const iterator = vi.fn(() => {
        throw new Error("stdin must not be read");
      });
      Object.defineProperty(process, "stdin", {
        configurable: true,
        value: { isTTY: false, [Symbol.asyncIterator]: iterator },
      });

      const error = await captureError(buildCommand(prompt));

      expect(error).toMatchObject({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "traycer agent send: exactly one of --message, --message-file, or --stdin is required.",
        details: null,
        exitCode: 1,
      });
      expect(iterator).not.toHaveBeenCalled();
      expect(rpcMock).not.toHaveBeenCalled();
      expectNoPromptLeak("private-inline", error);
    },
  );

  it("reports an unreadable message file without echoing its path", async () => {
    const privatePath = "/missing/private-prompt-name";

    const error = await captureError(
      buildCommand({ messageFile: privatePath }),
    );

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "traycer agent send: could not read --message-file.",
      details: null,
    });
    expect(rpcMock).not.toHaveBeenCalled();
    expectNoPromptLeak(privatePath, error);
  });

  it("refuses a TTY for --stdin instead of waiting interactively", async () => {
    stubStdin({ isTTY: true });

    const error = await captureError(buildCommand({ stdin: true }));

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "traycer agent send: --stdin requires piped input.",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("maps stdin stream failures to a prompt-free error", async () => {
    const partialPrompt = "partially read private prompt";
    stubStdin({ isTTY: false, chunks: [partialPrompt], reject: true });

    const error = await captureError(buildCommand({ stdin: true }));

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "traycer agent send: could not read the prompt from stdin.",
    });
    expectNoPromptLeak(partialPrompt, error);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
