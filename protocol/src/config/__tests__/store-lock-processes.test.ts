import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real filesystem and real processes: only the home directory is redirected.
// The platform stays real, so liveness and start-time fingerprints are the
// ones the lock sees in production.
const h = vi.hoisted(() => ({ home: "" }));

const hostProbe = vi.hoisted(() => ({
  next: null as null | {
    readonly entered: () => void;
    readonly wait: Promise<void>;
    readonly verdict: "alive" | "indeterminate";
  },
}));

vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => h.home };
});

vi.mock("../process-liveness", async (importActual) => {
  const actual = await importActual<typeof import("../process-liveness")>();
  return {
    ...actual,
    probeProcessLivenessAsync: async (pid: number) => {
      const next = hostProbe.next;
      if (next === null) return actual.probeProcessLivenessAsync(pid);
      hostProbe.next = null;
      next.entered();
      await next.wait;
      return next.verdict;
    },
  };
});

import { setCliConfigLockTimingForTests } from "../cli-config-lock";
import { queryPidStartFingerprintAsync } from "../credentials-lock";
import { cliConfigPath } from "../paths";
import { EMPTY_CLI_CONFIG, type CliConfig } from "../schema";
import {
  readCliConfig,
  setEnvOverride,
  withHostCliConfigFileLock,
} from "../store";

const HOLDER_CHILD = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "config-lock-holder-child.ts",
);
const WRITER_CHILD = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "config-writer-child.ts",
);
const ONE_HOUR_MS = 60 * 60 * 1000;

const spawned: ChildProcess[] = [];

function lockPath(): string {
  return `${cliConfigPath()}.lock`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function seed(overrides: Partial<CliConfig>): Promise<void> {
  const config: CliConfig = { ...EMPTY_CLI_CONFIG, ...overrides };
  await mkdir(dirname(cliConfigPath()), { recursive: true });
  await writeFile(cliConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

/** Writes the lock file and backdates its mtime by `ageMs`. */
async function writeLock(content: unknown, ageMs: number): Promise<void> {
  await mkdir(dirname(lockPath()), { recursive: true });
  await writeFile(
    lockPath(),
    typeof content === "string" ? content : JSON.stringify(content),
  );
  const mtime = new Date(Date.now() - ageMs);
  await utimes(lockPath(), mtime, mtime);
}

function lockRecord(pid: number, pidStartTime: string | null): object {
  return { pid, pidStartTime, nonce: "someone-else", acquiredAt: 0 };
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("could not spawn a helper process");
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => {
      resolve();
    });
  });
  return pid;
}

/** A child that stays alive until the test ends, once it reports ready. */
async function liveChildPid(): Promise<number> {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1 << 30)"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  spawned.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("could not spawn a helper process");
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => {
      reject(new Error("live helper exited early"));
    });
    child.stdout?.once("data", () => {
      resolve();
    });
  });
  return pid;
}

interface TrackedChild {
  readonly process: ChildProcess;
  readonly exit: Promise<number | null>;
  readonly stderr: () => string;
  readonly waitForOutput: (token: string) => Promise<void>;
}

function spawnTracked(
  script: string,
  envOverrides: NodeJS.ProcessEnv,
): TrackedChild {
  const child = spawn("bun", [script], {
    env: {
      ...process.env,
      HOME: h.home,
      USERPROFILE: h.home,
      ...envOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  spawned.push(child);
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const exit = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });
  const waitForOutput = (token: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const onData = (): void => {
        if (out.includes(token)) {
          child.stdout?.off("data", onData);
          resolve();
        }
      };
      child.stdout?.on("data", onData);
      onData();
      void exit.then((code) => {
        child.stdout?.off("data", onData);
        if (!out.includes(token)) {
          reject(
            new Error(
              `child exited with ${code} before printing ${token}: ${err}`,
            ),
          );
        }
      });
    });
  return { process: child, exit, stderr: () => err, waitForOutput };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function awaitWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const safety = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, 10_000);
  });
  try {
    return await Promise.race([promise, safety]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

function expectAbortError(error: unknown): void {
  expect(error).toBeInstanceOf(DOMException);
  expect(error).toHaveProperty("name", "AbortError");
}

interface HeldConfigLock {
  readonly configBefore: Buffer;
  readonly lockBefore: Buffer;
  readonly stderr: () => string;
  readonly release: () => Promise<number | null>;
}

async function withLiveConfigHolder(
  run: (held: HeldConfigLock) => Promise<void>,
): Promise<void> {
  await seed({ envOverrides: { SEED_KEY: "s" } });
  const child = spawnTracked(HOLDER_CHILD, {});
  let exit: Promise<number | null> | undefined;
  const release = (): Promise<number | null> => {
    if (exit === undefined) {
      child.process.stdin?.write("go\n");
      exit = awaitWithin(child.exit, "CLI holder exit");
    }
    return exit;
  };

  try {
    await awaitWithin(child.waitForOutput("locked"), "CLI lock holder");
    await run({
      configBefore: await readFile(cliConfigPath()),
      lockBefore: await readFile(lockPath()),
      stderr: child.stderr,
      release,
    });
  } finally {
    await release();
  }
}

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-config-lock-procs-"));
  hostProbe.next = null;
  setCliConfigLockTimingForTests({ waitMs: 1500, pollMs: 10, staleAgeMs: 300 });
});

afterEach(async () => {
  hostProbe.next = null;
  setCliConfigLockTimingForTests(null);
  for (const child of spawned.splice(0)) child.kill();
  await rm(h.home, { recursive: true, force: true });
});

describe("config lock across processes", () => {
  it("makes a setter wait for another process that holds the lock", async () => {
    // A cold `bun` start can outlast the short default of these tests.
    setCliConfigLockTimingForTests({
      waitMs: 10_000,
      pollMs: 10,
      staleAgeMs: 300,
    });
    await seed({ envOverrides: { SEED_KEY: "s" } });
    const child = spawnTracked(HOLDER_CHILD, {});
    await child.waitForOutput("locked");

    const parent = setEnvOverride("PARENT_KEY", "p");
    // On an unlocked store the parent writes inside this window, and the
    // child's rename then reverts it.
    await Promise.race([parent, delay(300)]);
    child.process.stdin?.write("go\n");

    expect(await child.exit, child.stderr()).toBe(0);
    await parent;
    expect((await readCliConfig()).envOverrides).toEqual({
      SEED_KEY: "s",
      CHILD_KEY: "c",
      PARENT_KEY: "p",
    });
    expect(existsSync(lockPath())).toBe(false);
  }, 30_000);

  async function hostWaitsBehindBoundedCli(
    verdict: "alive" | "indeterminate",
  ): Promise<void> {
    setCliConfigLockTimingForTests({ waitMs: 0, pollMs: 10, staleAgeMs: 0 });
    const probeEntered = deferred<void>();
    const releaseProbe = deferred<void>();
    const unknownNotified = deferred<void>();
    const unknownPaths: string[] = [];
    let boundedWriter: TrackedChild | undefined;
    let boundedWriterExited = false;
    let hostSettled = false;
    let hostWrite: Promise<void> | undefined;

    try {
      await withLiveConfigHolder(async (held) => {
        hostProbe.next = {
          entered: () => probeEntered.resolve(),
          wait: releaseProbe.promise,
          verdict,
        };
        hostWrite = withHostCliConfigFileLock(
          () => setEnvOverride("HOST_KEY", "h"),
          (reportedPath) => {
            unknownPaths.push(reportedPath);
            unknownNotified.resolve();
          },
          new AbortController().signal,
        ).then(
          () => {
            hostSettled = true;
          },
          (error: unknown) => {
            hostSettled = true;
            throw error;
          },
        );
        const hostOutcome = hostWrite.then(
          () => "settled" as const,
          () => "settled" as const,
        );
        const phase = await awaitWithin(
          Promise.race([
            probeEntered.promise.then(() => "probing" as const),
            hostOutcome,
          ]),
          "host lock probe or completion",
        );
        expect(phase).toBe("probing");

        boundedWriter = spawnTracked(WRITER_CHILD, {
          PREFIX: "BOUNDED",
          COUNT: "1",
          TRAYCER_CONFIG_TEST_WAIT_MS: "0",
        });
        const writerExit = await awaitWithin(
          boundedWriter.exit,
          "bounded CLI writer",
        );
        boundedWriterExited = true;
        expect(writerExit, boundedWriter.stderr()).toBe(1);
        expect(boundedWriter.stderr()).toContain(
          "Timed out after 0ms waiting for the settings lock",
        );
        expect(hostSettled).toBe(false);
        expect(await readFile(lockPath())).toEqual(held.lockBefore);
        expect(await readFile(cliConfigPath())).toEqual(held.configBefore);

        releaseProbe.resolve();
        if (verdict === "indeterminate") {
          await awaitWithin(
            unknownNotified.promise,
            "unknown-holder notification",
          );
        }
        expect(unknownPaths).toEqual(
          verdict === "indeterminate" ? [lockPath()] : [],
        );

        expect(await held.release(), held.stderr()).toBe(0);
        await awaitWithin(hostWrite, "host config write");
        expect((await readCliConfig()).envOverrides).toEqual({
          SEED_KEY: "s",
          CHILD_KEY: "c",
          HOST_KEY: "h",
        });
        expect(existsSync(lockPath())).toBe(false);
      });
    } finally {
      releaseProbe.resolve();
      if (boundedWriter !== undefined && !boundedWriterExited) {
        boundedWriter.process.kill();
        await awaitWithin(boundedWriter.exit, "bounded writer cleanup");
      }
      if (hostWrite !== undefined) {
        await awaitWithin(
          hostWrite.catch(() => undefined),
          "host config cleanup",
        );
      }
    }
  }

  it.each([
    { kind: "live", verdict: "alive" as const },
    { kind: "indeterminate", verdict: "indeterminate" as const },
  ])(
    "lets the host wait behind a $kind holder while a bounded CLI write is refused",
    async ({ verdict }) => {
      await hostWaitsBehindBoundedCli(verdict);
    },
    30_000,
  );

  it("aborts a host write waiting behind a live CLI holder", async () => {
    setCliConfigLockTimingForTests({ waitMs: 0, pollMs: 10, staleAgeMs: 0 });
    const probeEntered = deferred<void>();
    const releaseProbe = deferred<void>();
    const controller = new AbortController();
    let hostRun = false;
    let hostWrite: Promise<void> | undefined;

    try {
      await withLiveConfigHolder(async (held) => {
        try {
          hostProbe.next = {
            entered: () => probeEntered.resolve(),
            wait: releaseProbe.promise,
            verdict: "alive",
          };
          hostWrite = withHostCliConfigFileLock(
            () => {
              hostRun = true;
              return setEnvOverride("HOST_KEY", "h");
            },
            () => undefined,
            controller.signal,
          );
          const hostOutcome = hostWrite.then(
            () => "settled" as const,
            () => "settled" as const,
          );
          expect(
            await awaitWithin(
              Promise.race([
                probeEntered.promise.then(() => "probing" as const),
                hostOutcome,
              ]),
              "host probe or completion",
            ),
          ).toBe("probing");

          controller.abort();
          const error = await rejectionOf(
            awaitWithin(hostWrite, "aborted host write"),
          );
          expectAbortError(error);
          expect(hostRun).toBe(false);
          expect(await readFile(cliConfigPath())).toEqual(held.configBefore);
          expect(await readFile(lockPath())).toEqual(held.lockBefore);

          releaseProbe.resolve();
          expect(await held.release(), held.stderr()).toBe(0);
          expect((await readCliConfig()).envOverrides).toEqual({
            SEED_KEY: "s",
            CHILD_KEY: "c",
          });
          expect(existsSync(lockPath())).toBe(false);
        } finally {
          releaseProbe.resolve();
        }
      });
    } finally {
      controller.abort();
      releaseProbe.resolve();
      if (hostWrite !== undefined) {
        await awaitWithin(
          hostWrite.catch(() => undefined),
          "host write cleanup",
        );
      }
    }
  }, 30_000);

  it.each([
    { kind: "empty", content: "" },
    { kind: "malformed", content: '{"garbage":' },
  ])(
    "aborts a host wait on a lock record with $kind contents",
    async ({ content }) => {
      setCliConfigLockTimingForTests({ waitMs: 0, pollMs: 10, staleAgeMs: 0 });
      await seed({ envOverrides: { SEED_KEY: "s" } });
      await writeLock(content, ONE_HOUR_MS);
      const configBefore = await readFile(cliConfigPath());
      const lockBefore = await readFile(lockPath());
      const controller = new AbortController();
      const unknownNotified = deferred<void>();
      const unknownPaths: string[] = [];
      let hostRun = false;
      let hostWrite: Promise<void> | undefined;

      try {
        hostWrite = withHostCliConfigFileLock(
          () => {
            hostRun = true;
            return setEnvOverride("HOST_KEY", "h");
          },
          (reportedPath) => {
            unknownPaths.push(reportedPath);
            unknownNotified.resolve();
          },
          controller.signal,
        );
        await awaitWithin(
          unknownNotified.promise,
          "unknown-holder notification",
        );
        controller.abort();
        const error = await rejectionOf(
          awaitWithin(hostWrite, "aborted unknown-holder wait"),
        );
        expectAbortError(error);
        expect(unknownPaths).toEqual([lockPath()]);
        expect(await readFile(cliConfigPath())).toEqual(configBefore);
        expect(await readFile(lockPath())).toEqual(lockBefore);

        await rm(lockPath(), { force: true });
        expect(hostRun).toBe(false);
        expect(await readFile(cliConfigPath())).toEqual(configBefore);
      } finally {
        controller.abort();
        await rm(lockPath(), { force: true });
        if (hostWrite !== undefined) {
          await awaitWithin(
            hostWrite.catch(() => undefined),
            "unknown-holder cleanup",
          );
        }
      }
    },
    30_000,
  );

  it("removes an aborted host reservation queued behind its incumbent", async () => {
    setCliConfigLockTimingForTests({ waitMs: 0, pollMs: 10, staleAgeMs: 0 });
    await seed({ envOverrides: { SEED_KEY: "s" } });
    const probeEntered = deferred<void>();
    const releaseProbe = deferred<void>();
    const controller = new AbortController();
    let queuedRun = false;
    let incumbentWrite: Promise<void> | undefined;
    let queuedWrite: Promise<void> | undefined;

    try {
      await withLiveConfigHolder(async (held) => {
        hostProbe.next = {
          entered: () => probeEntered.resolve(),
          wait: releaseProbe.promise,
          verdict: "alive",
        };
        incumbentWrite = withHostCliConfigFileLock(
          () => setEnvOverride("INCUMBENT_KEY", "i"),
          () => undefined,
          new AbortController().signal,
        );
        const incumbentOutcome = incumbentWrite.then(
          () => "settled" as const,
          () => "settled" as const,
        );
        expect(
          await awaitWithin(
            Promise.race([
              probeEntered.promise.then(() => "probing" as const),
              incumbentOutcome,
            ]),
            "incumbent probe or completion",
          ),
        ).toBe("probing");

        queuedWrite = withHostCliConfigFileLock(
          () => {
            queuedRun = true;
            return setEnvOverride("QUEUED_KEY", "q");
          },
          () => undefined,
          controller.signal,
        );
        controller.abort();
        const error = await rejectionOf(
          awaitWithin(queuedWrite, "queued reservation completion"),
        );
        expectAbortError(error);
        expect(queuedRun).toBe(false);
        expect(await readFile(lockPath())).toEqual(held.lockBefore);
        expect(await readFile(cliConfigPath())).toEqual(held.configBefore);

        releaseProbe.resolve();
        expect(await held.release(), held.stderr()).toBe(0);
        await awaitWithin(incumbentWrite, "incumbent release");
        expect((await readCliConfig()).envOverrides).toEqual({
          SEED_KEY: "s",
          CHILD_KEY: "c",
          INCUMBENT_KEY: "i",
        });
        expect(existsSync(lockPath())).toBe(false);
      });
    } finally {
      controller.abort();
      releaseProbe.resolve();
      if (incumbentWrite !== undefined) {
        await awaitWithin(
          incumbentWrite.catch(() => undefined),
          "incumbent cleanup",
        );
      }
      if (queuedWrite !== undefined) {
        await awaitWithin(
          queuedWrite.catch(() => undefined),
          "queued write cleanup",
        );
      }
    }
  }, 30_000);

  describe("a holder that is provably dead", () => {
    it("loses a stale lock to the next setter", async () => {
      await writeLock(lockRecord(await deadPid(), null), ONE_HOUR_MS);

      await setEnvOverride("K", "v");

      expect((await readCliConfig()).envOverrides).toEqual({ K: "v" });
      expect(existsSync(lockPath())).toBe(false);
    });

    it("keeps a young lock, so the age guard holds", async () => {
      setCliConfigLockTimingForTests({
        waitMs: 400,
        pollMs: 10,
        staleAgeMs: 10_000,
      });
      await writeLock(lockRecord(await deadPid(), null), 0);

      await expect(setEnvOverride("K", "v")).rejects.toThrow(
        /Timed out after 400ms waiting for the settings lock/,
      );

      expect(existsSync(lockPath())).toBe(true);
      expect(existsSync(cliConfigPath())).toBe(false);
    });

    it.skipIf(process.platform === "win32")(
      "recognizes a recycled pid by its start-time fingerprint",
      async () => {
        // A live pid, but not the process that recorded the lock.
        const pid = await liveChildPid();
        await writeLock(
          lockRecord(pid, "not-the-real-start-time"),
          ONE_HOUR_MS,
        );

        await setEnvOverride("K", "v");

        expect((await readCliConfig()).envOverrides).toEqual({ K: "v" });
        expect(existsSync(lockPath())).toBe(false);
      },
    );
  });

  describe("a holder that may be alive", () => {
    it("never breaks the lock of a live pid, however old", async () => {
      const secret = "s3cr3t-value-123";
      await seed({ envOverrides: { SECRET_KEY: secret } });
      const pid = await liveChildPid();
      await writeLock(
        lockRecord(pid, await queryPidStartFingerprintAsync(pid)),
        ONE_HOUR_MS,
      );
      const configBefore = await readFile(cliConfigPath());
      const lockBefore = await readFile(lockPath());

      const error = await rejectionOf(setEnvOverride("K", "v"));

      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain(lockPath());
      expect(message).not.toContain(secret);
      expect(message).not.toContain("SECRET_KEY");
      expect(await readFile(cliConfigPath())).toEqual(configBefore);
      expect(await readFile(lockPath())).toEqual(lockBefore);
    });

    it("returns the live-lock timeout without writing, then recovers on the next write", async () => {
      setCliConfigLockTimingForTests({
        waitMs: 0,
        pollMs: 10,
        staleAgeMs: 0,
      });
      await withLiveConfigHolder(async (held) => {
        await expect(setEnvOverride("REFUSED_KEY", "v")).rejects.toThrow(
          /Timed out after 0ms waiting for the settings lock/,
        );
        expect(
          await readCliConfig().then((config) => config.envOverrides),
        ).toEqual({
          SEED_KEY: "s",
        });
        expect(await readFile(lockPath())).toEqual(held.lockBefore);

        expect(await held.release(), held.stderr()).toBe(0);
        await setEnvOverride("RECOVERED_KEY", "v");

        expect((await readCliConfig()).envOverrides).toEqual({
          SEED_KEY: "s",
          CHILD_KEY: "c",
          RECOVERED_KEY: "v",
        });
        expect(existsSync(lockPath())).toBe(false);
      });
    });

    it("writes nothing, not even a new config.json, when it times out", async () => {
      const pid = await liveChildPid();
      await writeLock(
        lockRecord(pid, await queryPidStartFingerprintAsync(pid)),
        ONE_HOUR_MS,
      );

      await expect(setEnvOverride("K", "v")).rejects.toThrow(/Timed out/);

      expect(existsSync(cliConfigPath())).toBe(false);
    });

    // A holder stopped between creating the lock and writing its record leaves
    // a lock that names nobody. Nothing proves it dead, so it is never broken.
    it.each([
      ["empty", ""],
      ["unparseable", '{"garbage":'],
    ])("never breaks an %s lock, however old", async (_label, content) => {
      await seed({ envOverrides: { SEED_KEY: "s" } });
      await writeLock(content, ONE_HOUR_MS);
      const configBefore = await readFile(cliConfigPath());

      const error = await rejectionOf(setEnvOverride("K", "v"));

      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(/Timed out/);
      expect(message).toContain(lockPath());
      expect(existsSync(lockPath())).toBe(true);
      expect((await stat(lockPath())).size).toBe(content.length);
      expect(await readFile(lockPath(), "utf8")).toBe(content);
      expect(await readFile(cliConfigPath())).toEqual(configBefore);
    });
  });
});
