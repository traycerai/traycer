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

vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => h.home };
});

import { setCliConfigLockTimingForTests } from "../cli-config-lock";
import { queryPidStartFingerprintAsync } from "../credentials-lock";
import { cliConfigPath } from "../paths";
import { EMPTY_CLI_CONFIG, type CliConfig } from "../schema";
import { readCliConfig, setEnvOverride } from "../store";

const HOLDER_CHILD = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "config-lock-holder-child.ts",
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

function spawnTracked(script: string): TrackedChild {
  const child = spawn("bun", [script], {
    env: { ...process.env, HOME: h.home, USERPROFILE: h.home },
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
      const poll = setInterval(() => {
        if (out.includes(token)) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
      void exit.then((code) => {
        clearInterval(poll);
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

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-config-lock-procs-"));
  setCliConfigLockTimingForTests({ waitMs: 1500, pollMs: 10, staleAgeMs: 300 });
});

afterEach(async () => {
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
    const child = spawnTracked(HOLDER_CHILD);
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
