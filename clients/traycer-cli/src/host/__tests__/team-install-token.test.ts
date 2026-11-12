import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as credentialsLock from "@traycer/protocol/config/credentials-lock";
import * as processLiveness from "@traycer/protocol/config/process-liveness";
import {
  mkdtemp,
  mkdir,
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
  withTeamTokenInstall,
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
  vi.restoreAllMocks();
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
  const prepared = await withTeamTokenInstall(
    environment,
    environmentId,
    true,
    pipe.readToken,
    (prepared) => Promise.resolve(prepared),
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

describe("withTeamTokenInstall", () => {
  const environment: Environment = "production";
  const environmentId = "env_team-caseSensitive";

  it("does not read stdin or create a token file when input is not piped", async () => {
    const readToken = vi.fn(async () => TOKEN);

    await expect(
      withTeamTokenInstall(
        environment,
        environmentId,
        false,
        readToken,
        (prepared) => Promise.resolve(prepared),
      ),
    ).resolves.toBeNull();

    expect(readToken).not.toHaveBeenCalled();
    await expectNoStagedToken(environment);
  });

  it("trims and validates piped input, stages its target unchanged, and returns only its hash", async () => {
    const pipe = pipeReader(`  ${TOKEN}  \nignored input\n`);
    const identityDir = join(home, ".traycer", "host", "identity");

    const result = await withTeamTokenInstall(
      environment,
      environmentId,
      true,
      pipe.readToken,
      (prepared) => Promise.resolve(prepared),
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

  it("accepts a token exactly at the length cap through the callback boundary", async () => {
    const longest = "a".repeat(MAX_INSTALL_TOKEN_LENGTH);
    const pipe = pipeReader(`${longest}\n`);

    const result = await withTeamTokenInstall(
      environment,
      environmentId,
      true,
      pipe.readToken,
      (prepared) => Promise.resolve(prepared),
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
    "rejects %s through the callback seam without staging or reflecting input",
    async (_name, invalidToken) => {
      const pipe = pipeReader(`${invalidToken}\n`);

      const error = await rejectedCliErrorOf(
        withTeamTokenInstall(
          environment,
          environmentId,
          true,
          pipe.readToken,
          (prepared) => Promise.resolve(prepared),
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
      withTeamTokenInstall(
        environment,
        environmentId,
        true,
        pipe.readToken,
        (prepared) => Promise.resolve(prepared),
      ),
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

    await withTeamTokenInstall(
      environment,
      environmentId,
      true,
      oldPipe.readToken,
      (prepared) => Promise.resolve(prepared),
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

    await withTeamTokenInstall(
      environment,
      environmentId,
      true,
      newPipe.readToken,
      (prepared) => Promise.resolve(prepared),
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

describe("team install operation serialization", () => {
  const environment: Environment = "production";
  const environmentId = "env_first-team";
  const teamSlug = "first-team";
  const hostId = "0b6f6a3e-6f4c-4a0e-9d6e-0d7a4c1f2a11";

  function operationPath(): string {
    return `${hostTeamInstallTokenPath(environment)}.operation.lock`;
  }

  it("does not stage a competing install until the first receipt is confirmed", async () => {
    const firstStarted = Promise.withResolvers<PreparedTeamTokenInstall>();
    const contended = Promise.withResolvers<void>();
    const order: string[] = [];
    const receiptPath = identityFile(
      environment,
      "team-install-completed.json",
    );
    const first = observeSettlement(
      withTeamTokenInstall(
        environment,
        environmentId,
        true,
        pipeReader(`${TOKEN}\n`).readToken,
        async (prepared) => {
          if (prepared === null) throw new Error("expected the first token");
          order.push("first staged");
          firstStarted.resolve(prepared);
          const receipt = await waitForTeamTokenInstall(
            environment,
            prepared,
            10_000,
          );
          order.push("first confirmed");
          return receipt;
        },
      ),
    );
    const prepared = await firstStarted.promise;
    const realProbe = processLiveness.probeProcessLivenessAsync;
    const probe = vi
      .spyOn(processLiveness, "probeProcessLivenessAsync")
      .mockImplementation(async (pid) => {
        const verdict = await realProbe(pid);
        if (pid === process.pid && verdict === "alive") contended.resolve();
        return verdict;
      });
    const second = observeSettlement(
      withTeamTokenInstall(
        environment,
        "env_second-team",
        true,
        pipeReader("second-install-token\n").readToken,
        (next) => {
          order.push("second staged");
          return Promise.resolve(next);
        },
      ),
    );
    let receiptWritten = false;
    try {
      const state = await Promise.race([
        contended.promise.then(() => "contended"),
        second.then(() => "completed"),
      ]);
      expect(
        JSON.parse(
          await readFile(hostTeamInstallTokenPath(environment), "utf8"),
        ),
      ).toEqual({ token: TOKEN, environmentId });
      expect(state).toBe("contended");
      await writeFile(receiptPath, JSON.stringify({ ...prepared, hostId }), {
        mode: 0o600,
      });
      receiptWritten = true;
      expect(await first).toEqual({
        status: "fulfilled",
        value: { hostId, environmentId },
      });
      expect(await second).toEqual({
        status: "fulfilled",
        value: {
          environmentId: "env_second-team",
          tokenHash: createHash("sha256")
            .update("second-install-token")
            .digest("hex"),
        },
      });
      expect(order).toEqual([
        "first staged",
        "first confirmed",
        "second staged",
      ]);
    } finally {
      if (!receiptWritten) {
        await writeFile(receiptPath, JSON.stringify({ ...prepared, hostId }), {
          mode: 0o600,
        });
      }
      await first;
      await second;
      probe.mockRestore();
    }
  }, 15_000);

  it("releases the operation lock when the install callback throws", async () => {
    const failure = new Error("the install failed before receipt wait");
    await expect(
      withTeamTokenInstall(
        environment,
        environmentId,
        true,
        pipeReader(`${TOKEN}\n`).readToken,
        async () => {
          const contender = await credentialsLock.acquireCredentialsLock({
            lockPath: operationPath(),
            reason: "probe-held-install",
            waitMs: 0,
            pollIntervalMs: 50,
            signal: null,
          });
          if (contender.acquired) await contender.handle.release();
          expect(contender.acquired).toBe(false);
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    const afterFailure = await credentialsLock.acquireCredentialsLock({
      lockPath: operationPath(),
      reason: "probe-released-install",
      waitMs: 0,
      pollIntervalMs: 50,
      signal: null,
    });
    try {
      expect(afterFailure.acquired).toBe(true);
    } finally {
      if (afterFailure.acquired) await afterFailure.handle.release();
    }
  });

  it.each([
    { label: "a null team", target: null, input: TOKEN, reads: false },
    {
      label: "an empty pipe",
      target: environmentId,
      input: " \n",
      reads: true,
    },
  ])(
    "takes neither lock for $label even while both are busy",
    async ({ target, input, reads }) => {
      const held = await credentialsLock.acquireCredentialsLock({
        lockPath: operationPath(),
        reason: "held-operation-fixture",
        waitMs: 0,
        pollIntervalMs: 50,
        signal: null,
      });
      if (!held.acquired) throw new Error("the fixture operation lock is busy");
      let hostLock: credentialsLock.CredentialsLockHandle | null = null;
      try {
        const stagePath = `${hostTeamInstallTokenPath(environment)}.lock`;
        const stage = await credentialsLock.acquireCredentialsLock({
          lockPath: stagePath,
          reason: "held-host-fixture",
          waitMs: 0,
          pollIntervalMs: 50,
          signal: null,
        });
        if (!stage.acquired) throw new Error("the fixture host lock is busy");
        hostLock = stage.handle;
        const operationBytes = await readFile(operationPath(), "utf8");
        const stageBytes = await readFile(stagePath, "utf8");
        const realAcquire = credentialsLock.acquireCredentialsLock;
        const bounded = vi
          .spyOn(credentialsLock, "acquireCredentialsLock")
          .mockImplementation((options) =>
            realAcquire({ ...options, waitMs: 0 }),
          );
        try {
          const reader = vi.fn(pipeReader(input).readToken);
          await expect(
            withTeamTokenInstall(
              environment,
              target,
              true,
              reader,
              (prepared) => Promise.resolve(prepared),
            ),
          ).resolves.toBeNull();
          if (reads) expect(reader).toHaveBeenCalledWith(false);
          else expect(reader).not.toHaveBeenCalled();
          await expectNoStagedToken(environment);
          expect(await readFile(operationPath(), "utf8")).toBe(operationBytes);
          expect(await readFile(stagePath, "utf8")).toBe(stageBytes);
        } finally {
          bounded.mockRestore();
        }
      } finally {
        await hostLock?.release();
        await held.handle.release();
      }
    },
  );

  it("keeps the CLI operation locked while the host takes its short file lock and confirms adoption", async () => {
    await expect(
      withTeamTokenInstall(
        environment,
        teamSlug,
        true,
        pipeReader(`${TOKEN}\n`).readToken,
        async (prepared) => {
          if (prepared === null) throw new Error("expected the install token");
          const contender = await credentialsLock.acquireCredentialsLock({
            lockPath: operationPath(),
            reason: "probe-operation-during-adoption",
            waitMs: 0,
            pollIntervalMs: 50,
            signal: null,
          });
          if (contender.acquired) await contender.handle.release();
          expect(contender.acquired).toBe(false);
          const hostLock = await credentialsLock.acquireCredentialsLock({
            lockPath: `${hostTeamInstallTokenPath(environment)}.lock`,
            reason: "host-receipt-fixture",
            waitMs: 0,
            pollIntervalMs: 50,
            signal: null,
          });
          if (!hostLock.acquired)
            throw new Error("the CLI blocked the host receipt lock");
          try {
            await writeFile(
              identityFile(environment, "team-install-completed.json"),
              JSON.stringify({ ...prepared, hostId }),
              { mode: 0o600 },
            );
          } finally {
            await hostLock.handle.release();
          }
          return waitForTeamTokenInstall(environment, prepared, 1_000);
        },
      ),
    ).resolves.toEqual({ hostId, environmentId: teamSlug });
  });

  it("reclaims an operation lock whose recorded process was killed", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      env: {},
      stdio: ["pipe", "ignore", "ignore"],
    });
    const exited = once(child, "exit");
    await once(child, "spawn");
    const deadPid = child.pid;
    child.kill("SIGKILL");
    await exited;
    if (deadPid === undefined)
      throw new Error("the fixture process never started");
    await mkdir(dirname(operationPath()), { recursive: true, mode: 0o700 });
    await writeFile(
      operationPath(),
      JSON.stringify({
        pid: deadPid,
        pidStartTime: null,
        acquisitionNonce: randomUUID(),
        acquiredAt: Date.now(),
        reason: "killed-team-install",
      }),
      { mode: 0o600 },
    );
    await expect(
      withTeamTokenInstall(
        environment,
        environmentId,
        true,
        pipeReader(`${TOKEN}\n`).readToken,
        (prepared) => Promise.resolve(prepared),
      ),
    ).resolves.toEqual({
      environmentId,
      tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
    });
    await expect(stat(operationPath())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
