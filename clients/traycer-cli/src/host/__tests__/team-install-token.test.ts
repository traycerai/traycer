import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readInstallToken } from "../../commands/host-join-token";
import { CliError, CLI_ERROR_CODES } from "../../runner/errors";
import type { Environment } from "../../runner/environment";
import { hostTeamInstallTokenPath } from "../../store/paths";
import {
  MAX_INSTALL_TOKEN_LENGTH,
  prepareTeamTokenInstall,
  waitForTeamTokenInstall,
  type PreparedTeamTokenInstall,
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
  vi.useRealTimers();
  restoreEnv("HOME", savedHome);
  restoreEnv("USERPROFILE", savedUserProfile);
  await rm(home, { recursive: true, force: true });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function identityFile(environment: Environment, name: string): string {
  return join(dirname(hostTeamInstallTokenPath(environment)), name);
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

function errorPipeReader(error: Error): {
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
      input.emit("error", error);
      return reading;
    },
    prompt,
    promptFlags,
  };
}

async function preparePipedToken(
  environment: Environment,
  environmentId: string,
  token: string,
): Promise<PreparedTeamTokenInstall> {
  const pipe = pipeReader(`${token}\n`);
  const prepared = await prepareTeamTokenInstall(
    environment,
    environmentId,
    true,
    pipe.readToken,
  );
  if (prepared === null) throw new Error("expected a piped install token");
  return prepared;
}

async function rejectedCliErrorOf<T>(reading: Promise<T>): Promise<CliError> {
  try {
    await reading;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected the operation to return a CLI error");
}

type PromiseSettlement<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

function observeSettlement<T>(
  operation: Promise<T>,
): Promise<PromiseSettlement<T>> {
  return operation.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

function cliErrorFromSettlement<T>(settlement: PromiseSettlement<T>): CliError {
  if (settlement.status === "fulfilled") {
    throw new Error("expected the operation to return a CLI error");
  }
  if (settlement.reason instanceof CliError) return settlement.reason;
  throw settlement.reason;
}

async function expectNoStagedToken(environment: Environment): Promise<void> {
  await expect(
    stat(hostTeamInstallTokenPath(environment)),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
}

describe("prepareTeamTokenInstall", () => {
  const environment: Environment = "production";
  const environmentId = "env_team-caseSensitive";

  it("does not read stdin or create a token file when input is not piped", async () => {
    const readToken = vi.fn(async () => TOKEN);

    await expect(
      prepareTeamTokenInstall(environment, environmentId, false, readToken),
    ).resolves.toBeNull();

    expect(readToken).not.toHaveBeenCalled();
    await expectNoStagedToken(environment);
  });

  it("treats an empty pipe as no install token and creates no file", async () => {
    const pipe = pipeReader(" \n");

    await expect(
      prepareTeamTokenInstall(environment, environmentId, true, pipe.readToken),
    ).resolves.toBeNull();

    expect(pipe.promptFlags).toEqual([false]);
    expect(pipe.prompt.text).toBe("");
    await expectNoStagedToken(environment);
  });

  it("trims and validates piped input, stages its target unchanged, and returns only its hash", async () => {
    const pipe = pipeReader(`  ${TOKEN}  \nignored input\n`);
    const identityDir = join(home, ".traycer", "host", "identity");

    const result = await prepareTeamTokenInstall(
      environment,
      environmentId,
      true,
      pipe.readToken,
    );

    expect(result).toEqual({
      environmentId,
      tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(pipe.promptFlags).toEqual([false]);
    expect(pipe.prompt.text).toBe("");
    expect(
      JSON.parse(await readFile(hostTeamInstallTokenPath(environment), "utf8")),
    ).toEqual({
      token: TOKEN,
      environmentId,
    });
    expect(await readdir(identityDir)).toEqual(["team-install-token"]);
    if (POSIX_MODES) {
      expect((await stat(identityDir)).mode & 0o777).toBe(0o700);
      expect(
        (await stat(hostTeamInstallTokenPath(environment))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("accepts a token exactly at the length cap through the prepare boundary", async () => {
    const longest = "a".repeat(MAX_INSTALL_TOKEN_LENGTH);
    const pipe = pipeReader(`${longest}\n`);

    const result = await prepareTeamTokenInstall(
      environment,
      environmentId,
      true,
      pipe.readToken,
    );

    expect(result).toEqual({
      environmentId,
      tokenHash: createHash("sha256").update(longest).digest("hex"),
    });
    expect(
      JSON.parse(await readFile(hostTeamInstallTokenPath(environment), "utf8")),
    ).toEqual({
      token: longest,
      environmentId,
    });
    expect(pipe.promptFlags).toEqual([false]);
    expect(pipe.prompt.text).toBe("");
  });

  it.each([
    ["an invalid character", "not a valid install token"],
    ["a token over the cap", "a".repeat(MAX_INSTALL_TOKEN_LENGTH + 1)],
  ])(
    "rejects %s through prepare without staging or reflecting input",
    async (_name, invalidToken) => {
      const pipe = pipeReader(`${invalidToken}\n`);

      const error = await rejectedCliErrorOf(
        prepareTeamTokenInstall(
          environment,
          environmentId,
          true,
          pipe.readToken,
        ),
      );
      const diagnostic = JSON.stringify({
        code: error.code,
        message: error.message,
        details: error.details,
      });

      expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      expect(diagnostic).not.toContain(invalidToken);
      expect(pipe.promptFlags).toEqual([false]);
      expect(pipe.prompt.text).toBe("");
      await expectNoStagedToken(environment);
    },
  );

  it("keeps a stream error that contains the token out of the CLI diagnostic", async () => {
    const pipe = errorPipeReader(new Error(`stream failed: ${TOKEN}`));

    const error = await rejectedCliErrorOf(
      prepareTeamTokenInstall(environment, environmentId, true, pipe.readToken),
    );
    const diagnostic = JSON.stringify({
      code: error.code,
      message: error.message,
      details: error.details,
    });

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(diagnostic).not.toContain(TOKEN);
    expect(pipe.promptFlags).toEqual([false]);
    expect(pipe.prompt.text).toBe("");
    await expectNoStagedToken(environment);
  });

  it("replaces the staged token and clears an earlier receipt and recovery marker", async () => {
    const receiptPath = identityFile(
      environment,
      "team-install-completed.json",
    );
    const recoveryPath = identityFile(
      environment,
      "team-install-recovery-attempted.json",
    );
    const oldPipe = pipeReader("old-token\n");
    const newPipe = pipeReader(`${TOKEN}\n`);

    await prepareTeamTokenInstall(
      environment,
      environmentId,
      true,
      oldPipe.readToken,
    );
    await writeFile(
      receiptPath,
      JSON.stringify({
        tokenHash: "a".repeat(64),
        environmentId,
        hostId: "0b6f6a3e-6f4c-4a0e-9d6e-0d7a4c1f2a11",
      }),
    );
    await writeFile(recoveryPath, "{}");

    await prepareTeamTokenInstall(
      environment,
      environmentId,
      true,
      newPipe.readToken,
    );

    await expect(stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(recoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      JSON.parse(await readFile(hostTeamInstallTokenPath(environment), "utf8")),
    ).toEqual({
      token: TOKEN,
      environmentId,
    });
    expect(oldPipe.promptFlags).toEqual([false]);
    expect(newPipe.promptFlags).toEqual([false]);
  });
});

describe("waitForTeamTokenInstall", () => {
  const environment: Environment = "production";
  const environmentId = "env_team-target";
  const tokenHash = createHash("sha256").update(TOKEN).digest("hex");
  const hostId = "0b6f6a3e-6f4c-4a0e-9d6e-0d7a4c1f2a11";
  const timeoutMs = 1_000;

  it("returns the host id from a matching private receipt", async () => {
    const prepared = await preparePipedToken(environment, environmentId, TOKEN);
    await writeFile(
      identityFile(environment, "team-install-completed.json"),
      JSON.stringify({ tokenHash, environmentId, hostId }),
      { mode: 0o600 },
    );

    await expect(
      waitForTeamTokenInstall(environment, prepared, timeoutMs),
    ).resolves.toEqual({ hostId, environmentId });
  });

  it("refuses a matching real receipt when the install deadline is zero", async () => {
    const prepared = await preparePipedToken(environment, environmentId, TOKEN);
    await writeFile(
      identityFile(environment, "team-install-completed.json"),
      JSON.stringify({ tokenHash, environmentId, hostId }),
      { mode: 0o600 },
    );

    const error = await rejectedCliErrorOf(
      waitForTeamTokenInstall(environment, prepared, 0),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.AUTH_REJECTED);
    expect(error.message).toBe(
      "host install: couldn't confirm that this computer joined the team.",
    );
    expect(
      JSON.stringify({ message: error.message, details: error.details }),
    ).not.toContain(TOKEN);
  });

  it.each([
    ["environment", { tokenHash, environmentId: "env_another-team", hostId }],
    ["token hash", { tokenHash: "b".repeat(64), environmentId, hostId }],
  ])(
    "does not accept a receipt with a mismatched %s",
    async (_field, receipt) => {
      const prepared = await preparePipedToken(
        environment,
        environmentId,
        TOKEN,
      );
      await writeFile(
        identityFile(environment, "team-install-completed.json"),
        JSON.stringify(receipt),
        { mode: 0o600 },
      );
      vi.useFakeTimers();
      const waiting = observeSettlement(
        waitForTeamTokenInstall(environment, prepared, timeoutMs),
      );

      await vi.advanceTimersByTimeAsync(timeoutMs);

      const error = cliErrorFromSettlement(await waiting);
      const diagnostic = JSON.stringify({
        code: error.code,
        message: error.message,
        details: error.details,
      });
      expect(error.code).toBe(CLI_ERROR_CODES.AUTH_REJECTED);
      expect(diagnostic).not.toContain(TOKEN);
    },
  );

  it("does not treat the staged token file being absent as a completed install", async () => {
    const prepared = await preparePipedToken(environment, environmentId, TOKEN);
    await rm(hostTeamInstallTokenPath(environment));
    vi.useFakeTimers();
    const waiting = observeSettlement(
      waitForTeamTokenInstall(environment, prepared, timeoutMs),
    );

    await vi.advanceTimersByTimeAsync(timeoutMs);

    const error = cliErrorFromSettlement(await waiting);
    expect(error.code).toBe(CLI_ERROR_CODES.AUTH_REJECTED);
    expect(error.message).toBe(
      "host install: couldn't confirm that this computer joined the team.",
    );
    expect(
      JSON.stringify({ message: error.message, details: error.details }),
    ).not.toContain(TOKEN);
  });
});
