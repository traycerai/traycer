import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { CliError, CLI_ERROR_CODES } from "../../runner/errors";
import { MAX_INSTALL_TOKEN_LENGTH, readInstallToken } from "../host-join-token";

// `readInstallToken` is read against real streams: a PassThrough that says it
// is a terminal and records raw-mode switches, or a plain one for a pipe.

const TOKEN = "tkn_AbC123._~+/=-xyz";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";

class FakeTerminal extends PassThrough {
  readonly isTTY = true;
  readonly rawModes: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    return this;
  }
}

class PromptSink extends Writable {
  text = "";

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: () => void,
  ): void {
    this.text += chunk.toString();
    callback();
  }
}

/** A terminal that is given `typed` once the read is waiting for it. */
async function readFromTerminal(typed: string): Promise<string> {
  const terminal = new FakeTerminal();
  const reading = readInstallToken(terminal, new PromptSink(), true);
  terminal.write(typed);
  return reading;
}

async function refusalOf(reading: Promise<string>): Promise<CliError> {
  try {
    await reading;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected the read to be refused");
}

async function readFromPipe(
  chunks: readonly string[],
  canPrompt: boolean,
): Promise<{ readonly token: string; readonly prompt: PromptSink }> {
  const pipe = new PassThrough();
  const prompt = new PromptSink();
  const reading = readInstallToken(pipe, prompt, canPrompt);
  for (const chunk of chunks) pipe.write(chunk);
  pipe.end();
  return { token: await reading, prompt };
}

describe("readInstallToken on a terminal", () => {
  it("prompts, reads in raw mode without echoing, and puts the terminal back with a newline", async () => {
    const terminal = new FakeTerminal();
    const prompt = new PromptSink();

    const reading = readInstallToken(terminal, prompt, true);

    expect(prompt.text).toBe("Install token: ");
    expect(terminal.rawModes).toEqual([true]);

    terminal.write(`${TOKEN}\r`);

    expect(await reading).toBe(TOKEN);
    expect(terminal.rawModes).toEqual([true, false]);
    expect(prompt.text).toBe("Install token: \n");
    expect(prompt.text).not.toContain(TOKEN);
  });

  it("cancels on Ctrl-C and still puts the terminal back", async () => {
    const terminal = new FakeTerminal();
    const prompt = new PromptSink();
    const reading = refusalOf(readInstallToken(terminal, prompt, true));

    terminal.write(`${TOKEN.slice(0, 4)}${CTRL_C}`);
    const error = await reading;

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(terminal.rawModes).toEqual([true, false]);
    expect(prompt.text).toBe("Install token: \n");
  });

  it.each([
    ["Enter", "\r"],
    ["a line feed", "\n"],
    ["Enter as CRLF", "\r\n"],
    ["Ctrl-D", CTRL_D],
  ])("ends the line on %s", async (_name, ending) => {
    expect(await readFromTerminal(`${TOKEN}${ending}`)).toBe(TOKEN);
  });

  it.each([
    ["backspace", "\b"],
    ["DEL", "\u007f"],
  ])("%s removes the last character typed", async (_name, key) => {
    expect(await readFromTerminal(`abx${key}c\r`)).toBe("abc");
  });

  it("refuses to prompt when told not to, asking for stdin instead", async () => {
    const terminal = new FakeTerminal();
    const prompt = new PromptSink();

    const error = await refusalOf(readInstallToken(terminal, prompt, false));

    expect(error.message).toContain("stdin");
    expect(prompt.text).toBe("");
    expect(terminal.rawModes).toEqual([]);
  });
});

describe("readInstallToken on a pipe", () => {
  it("reads only the first line and prompts for nothing", async () => {
    const { token, prompt } = await readFromPipe(
      [`${TOKEN}\nsecond line\n`],
      true,
    );

    expect(token).toBe(TOKEN);
    expect(prompt.text).toBe("");
  });

  it("takes a line that ends at end of input, though the run may not prompt", async () => {
    const { token } = await readFromPipe(
      [TOKEN.slice(0, 5), TOKEN.slice(5)],
      false,
    );

    expect(token).toBe(TOKEN);
  });
});

describe("readInstallToken past the cap", () => {
  it("keeps a token of exactly the cap whole", async () => {
    const longest = "a".repeat(MAX_INSTALL_TOKEN_LENGTH);

    const { token } = await readFromPipe([`${longest}\n`], false);

    expect(token).toBe(longest);
  });

  it("drops what is typed past the cap, leaving a line too long for the token check", async () => {
    const chunk = "a".repeat(MAX_INSTALL_TOKEN_LENGTH);

    const { token } = await readFromPipe([chunk, chunk, chunk, "\n"], false);

    expect(token.length).toBeGreaterThan(MAX_INSTALL_TOKEN_LENGTH);
    expect(token.length).toBeLessThan(2 * MAX_INSTALL_TOKEN_LENGTH);
  });
});
