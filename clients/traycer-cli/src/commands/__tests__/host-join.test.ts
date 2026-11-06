import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `traycer host join <token>` leaves a team computer's one-time install token
// where the host enrolls from, then installs and starts the host. The files
// are real, in a temp HOME (the data root resolves from it); only
// `ensureHost`, the install/service boundary, is mocked.

const mocks = vi.hoisted(() => ({
  ensureHostMock: vi.fn(),
}));

vi.mock("../../host/ensure", () => ({
  ensureHost: (...callArgs: Parameters<typeof mocks.ensureHostMock>) =>
    mocks.ensureHostMock(...callArgs),
}));

import { buildHostJoinCommand } from "../host-join";
import type { CommandContext } from "../../runner/runner";
import type { HostEnsureResult } from "../../host/ensure";
import { CliError, CLI_ERROR_CODES } from "../../runner/errors";
import {
  hostEnrollmentRecordPath,
  hostTeamInstallTokenPath,
} from "../../store/paths";

const TOKEN = "tkn_AbC123._~+/=-xyz";
const POSIX_MODES = process.platform !== "win32";

let home = "";
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(`${tmpdir()}/traycer-host-join-test-`);
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  mocks.ensureHostMock.mockResolvedValue(ensureResult({}));
});

afterEach(async () => {
  restoreEnv("HOME", savedHome);
  restoreEnv("USERPROFILE", savedUserProfile);
  vi.resetAllMocks();
  await rm(home, { recursive: true, force: true });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function ensureResult(overrides: Partial<HostEnsureResult>): HostEnsureResult {
  return {
    installed: true,
    registered: true,
    running: true,
    version: "1.2.3",
    runtimeVersion: "1.2.3",
    action: "started",
    serviceLifecycle: null,
    postSwapError: null,
    installGeneration: "gen-1",
    ...overrides,
  };
}

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
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

function tokenPath(): string {
  return hostTeamInstallTokenPath("production");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function rejection(token: string): Promise<CliError> {
  try {
    await buildHostJoinCommand({ token })(fakeCtx());
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected host join to refuse");
}

describe("buildHostJoinCommand", () => {
  it("leaves the token in a private file before installing, and installs with no sign-in pre-flight", async () => {
    let tokenFileWhenEnsureRan: string | null = null;
    mocks.ensureHostMock.mockImplementation(async () => {
      tokenFileWhenEnsureRan = await readFile(tokenPath(), "utf8");
      return ensureResult({});
    });

    await buildHostJoinCommand({ token: TOKEN })(fakeCtx());

    expect(tokenFileWhenEnsureRan).toBe(`${TOKEN}\n`);
    expect(mocks.ensureHostMock).toHaveBeenCalledTimes(1);
    expect(mocks.ensureHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeMutate: null,
        enableLinger: true,
        keepInstalled: false,
        noServiceRegister: false,
      }),
    );
    expect(await readdir(dirname(tokenPath()))).toEqual(["team-install-token"]);
    if (POSIX_MODES) {
      expect((await stat(tokenPath())).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(tokenPath()))).mode & 0o777).toBe(0o700);
    }
  });

  it("trims whitespace around the token", async () => {
    await buildHostJoinCommand({ token: `  \t${TOKEN}\n` })(fakeCtx());

    expect(await readFile(tokenPath(), "utf8")).toBe(`${TOKEN}\n`);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["whitespace inside", "tkn abc"],
    ["a newline inside", "tkn\nabc"],
    ["longer than 4096 characters", "a".repeat(4097)],
    ["a shell metacharacter", "tkn;rm"],
  ])(
    "refuses a token that is %s, writing nothing and installing nothing",
    async (_name, token) => {
      const error = await rejection(token);

      expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      expect(error.details).toBeNull();
      expect(await exists(tokenPath())).toBe(false);
      expect(mocks.ensureHostMock).not.toHaveBeenCalled();
      if (token.trim().length > 0) {
        expect(error.message).not.toContain(token.trim());
      }
    },
  );

  it("accepts a token of exactly 4096 characters", async () => {
    const longest = "a".repeat(4096);

    await buildHostJoinCommand({ token: longest })(fakeCtx());

    expect(await readFile(tokenPath(), "utf8")).toBe(`${longest}\n`);
  });

  it("refuses a machine that is already enrolled, writing nothing and installing nothing", async () => {
    const enrollment = hostEnrollmentRecordPath("production");
    await mkdir(dirname(enrollment), { recursive: true });
    await writeFile(enrollment, "{}");

    const error = await rejection(TOKEN);

    expect(error.code).toBe(CLI_ERROR_CODES.FORBIDDEN);
    expect(error.message).not.toContain(TOKEN);
    expect(await exists(tokenPath())).toBe(false);
    expect(mocks.ensureHostMock).not.toHaveBeenCalled();
  });

  it("replaces an earlier token whole", async () => {
    await buildHostJoinCommand({ token: "first-token-which-is-longer" })(
      fakeCtx(),
    );
    await buildHostJoinCommand({ token: "second" })(fakeCtx());

    expect(await readFile(tokenPath(), "utf8")).toBe("second\n");
  });

  it("exits 1 when the host failed to start after the install", async () => {
    mocks.ensureHostMock.mockResolvedValue(
      ensureResult({
        postSwapError: "launchctl load failed",
        serviceLifecycle: {
          priorServiceState: "stopped",
          stoppedBeforeSwap: false,
          postSwapAction: "start",
          postSwapError: "launchctl load failed",
        },
      }),
    );

    const result = await buildHostJoinCommand({ token: TOKEN })(fakeCtx());

    expect(result.exitCode).toBe(1);
    expect(result.human).toContain("launchctl load failed");
  });

  it("tells the person to restart a host that was already running", async () => {
    mocks.ensureHostMock.mockResolvedValue(ensureResult({ action: "noop" }));

    const result = await buildHostJoinCommand({ token: TOKEN })(fakeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.human).toContain("traycer host restart");
  });

  it("never puts the token in the result", async () => {
    const result = await buildHostJoinCommand({ token: TOKEN })(fakeCtx());

    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
