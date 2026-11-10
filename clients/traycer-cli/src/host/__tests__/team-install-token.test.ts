import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInstallToken } from "../../commands/host-join-token";
import { CliError, CLI_ERROR_CODES } from "../../runner/errors";
import type { Environment } from "../../runner/environment";
import { hostTeamInstallTokenPath } from "../../store/paths";
import {
  MAX_INSTALL_TOKEN_LENGTH,
  readTeamInstallToken,
  stageTeamInstallToken,
} from "../team-install-token";

const TOKEN = "tkn_AbC123._~+/=-xyz";
const POSIX_MODES = process.platform !== "win32";

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

let home = "";
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "team-install-token-test-"));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(async () => {
  restoreEnv("HOME", savedHome);
  restoreEnv("USERPROFILE", savedUserProfile);
  await rm(home, { recursive: true, force: true });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function pipeReader(text: string): {
  readonly readToken: (canPrompt: boolean) => Promise<string>;
  readonly prompt: PromptSink;
  readonly promptFlags: boolean[];
} {
  const input = new PassThrough();
  const prompt = new PromptSink();
  const promptFlags: boolean[] = [];
  return {
    readToken: async (canPrompt) => {
      promptFlags.push(canPrompt);
      const reading = readInstallToken(input, prompt, canPrompt);
      input.end(text);
      return reading;
    },
    prompt,
    promptFlags,
  };
}

async function invalidArgumentOf(reading: Promise<string>): Promise<CliError> {
  try {
    await reading;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected the token to be refused");
}

describe("readTeamInstallToken", () => {
  it("reads a pipe without prompting and trims a valid token", async () => {
    const pipe = pipeReader(`  ${TOKEN}  \nignored input\n`);

    await expect(readTeamInstallToken(pipe.readToken, false)).resolves.toBe(
      TOKEN,
    );

    expect(pipe.promptFlags).toEqual([false]);
    expect(pipe.prompt.text).toBe("");
  });

  it("accepts a token exactly at the length cap", async () => {
    const longest = "a".repeat(MAX_INSTALL_TOKEN_LENGTH);
    const pipe = pipeReader(`${longest}\n`);

    await expect(readTeamInstallToken(pipe.readToken, false)).resolves.toBe(
      longest,
    );
    expect(pipe.prompt.text).toBe("");
  });

  it("redacts a stream error that contains the token", async () => {
    const input = new PassThrough();
    const prompt = new PromptSink();
    const reading = readTeamInstallToken(
      (canPrompt) => readInstallToken(input, prompt, canPrompt),
      false,
    );
    input.emit("error", new Error(`stream failed: ${TOKEN}`));

    const error = await invalidArgumentOf(reading);
    const serialized = JSON.stringify({
      code: error.code,
      message: error.message,
      details: error.details,
    });

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(serialized).not.toContain(TOKEN);
    expect(prompt.text).toBe("");
  });

  it.each([
    ["empty input", ""],
    ["an invalid character", "token with spaces"],
    ["a token over the cap", "a".repeat(MAX_INSTALL_TOKEN_LENGTH + 1)],
  ])("rejects %s with a generic CLI argument error", async (_name, value) => {
    const pipe = pipeReader(`${value}\n`);

    const error = await invalidArgumentOf(
      readTeamInstallToken(pipe.readToken, false),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    if (value.length > 0) expect(error.message).not.toContain(value);
    expect(pipe.prompt.text).toBe("");
  });
});

describe("stageTeamInstallToken", () => {
  it("stores the complete replacement privately at the host token path", async () => {
    const environment: Environment = "production";
    const path = hostTeamInstallTokenPath(environment);
    const identityDir = join(home, ".traycer", "host", "identity");

    await stageTeamInstallToken(environment, "old-token");
    await stageTeamInstallToken(environment, TOKEN);

    expect(await readFile(path, "utf8")).toBe(`${TOKEN}\n`);
    expect(await readdir(identityDir)).toEqual(["team-install-token"]);
    if (POSIX_MODES) {
      expect((await stat(identityDir)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
});
