import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Breaking a dead lock, exercised with several acquirers in ONE process. The
// store's in-process queue would serialize them, so the first rows call
// `acquireCliConfigLock` directly. Two parks hold a breaker at the moments
// that decide who may remove a dead lock: just after it re-read the lock, and
// just after it moved the lock aside (only the earlier rename-aside
// implementation ever did, leaving the slot empty until it linked it back).
interface ParkSeam {
  readonly gate: Promise<void>;
  readonly open: () => void;
  readonly parked: Promise<void>;
  readonly markParked: () => void;
}

const h = vi.hoisted(() => ({
  home: "",
  readPark: null as ParkSeam | null,
  // Reads of the lock file since the read park was armed.
  lockReads: 0,
  renamePark: null as ParkSeam | null,
  linkPark: null as ParkSeam | null,
}));

vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => h.home };
});

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // Parks the SECOND read of the lock file after arming, once it has read.
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const seam = h.readPark;
      if (seam !== null && args[0] === lockPath()) {
        h.lockReads += 1;
        if (h.lockReads === 2) {
          h.readPark = null;
          const content = await actual.readFile(...args);
          seam.markParked();
          await seam.gate;
          return content;
        }
      }
      return actual.readFile(...args);
    },
    // Parks the first link into a break token, before it links.
    link: async (existing: string, linkPath: string) => {
      const seam = h.linkPark;
      if (seam !== null && linkPath.includes(".break-")) {
        h.linkPark = null;
        seam.markParked();
        await seam.gate;
      }
      await actual.link(existing, linkPath);
    },
    // Parks the first rename whose source is the lock file, once it moved.
    rename: async (source: string, target: string) => {
      const seam = h.renamePark;
      await actual.rename(source, target);
      if (seam !== null && source === lockPath()) {
        h.renamePark = null;
        seam.markParked();
        await seam.gate;
      }
    },
  };
});

import {
  acquireCliConfigLock,
  setCliConfigLockTimingForTests,
} from "../cli-config-lock";
import { queryPidStartFingerprintAsync } from "../credentials-lock";
import { cliConfigPath } from "../paths";
import { EMPTY_CLI_CONFIG, type CliConfig } from "../schema";
import { readCliConfig, setEnvOverride } from "../store";

const ONE_HOUR_MS = 60 * 60 * 1000;

const seams: ParkSeam[] = [];
const spawned: ChildProcess[] = [];

function lockPath(): string {
  return `${cliConfigPath()}.lock`;
}

function breakTokenPath(nonce: string, generation: number): string {
  const digest = createHash("sha256").update(nonce).digest("hex").slice(0, 32);
  return `${lockPath()}.break-${digest}.${generation}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeSeam(): ParkSeam {
  let open: () => void = () => {};
  let markParked: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const parked = new Promise<void>((resolve) => {
    markParked = resolve;
  });
  const seam: ParkSeam = { gate, open, parked, markParked };
  seams.push(seam);
  return seam;
}

async function seed(overrides: Partial<CliConfig>): Promise<void> {
  const config: CliConfig = { ...EMPTY_CLI_CONFIG, ...overrides };
  await mkdir(dirname(cliConfigPath()), { recursive: true });
  await writeFile(cliConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

/** Writes a lock or token file and backdates its mtime by `ageMs`. */
async function writeAged(
  path: string,
  pid: number,
  pidStartTime: string | null,
  nonce: string,
  ageMs: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ pid, pidStartTime, nonce, acquiredAt: 0 }),
  );
  const mtime = new Date(Date.now() - ageMs);
  await utimes(path, mtime, mtime);
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

/** Tokens for generations `0..count-1` of the dead record, each left by `pid`. */
async function writeDeadTokens(pid: number, count: number): Promise<void> {
  for (let generation = 0; generation < count; generation += 1) {
    await writeAged(
      breakTokenPath("dead-holder", generation),
      pid,
      null,
      `dead-breaker-${generation}`,
      ONE_HOUR_MS,
    );
  }
}

async function breakTokensLeft(): Promise<string[]> {
  return (await readdir(dirname(cliConfigPath()))).filter((name) =>
    name.includes(".break-"),
  );
}

interface HolderState {
  active: number;
  readonly failures: string[];
}

interface HolderHooks {
  // Called as soon as the lock is ours.
  readonly onAcquired: (() => void) | null;
  // Awaited between the temp write and the rename, so a test can keep this
  // holder mid-write; `null` for a short fixed pause.
  readonly beforeRename: Promise<void> | null;
}

const NO_HOOKS: HolderHooks = { onAcquired: null, beforeRename: null };

/**
 * Acquires the lock directly and does what the store does under it: read the
 * document, change one key, write a temp file, and rename it over config.json
 * only while the lock is still ours. The pause between write and rename is
 * where a second holder would revert it.
 */
async function holder(
  key: string,
  state: HolderState,
  hooks: HolderHooks,
): Promise<void> {
  const handle = await acquireCliConfigLock(lockPath());
  try {
    if (state.active !== 0) {
      state.failures.push(`${key}: another holder is active`);
    }
    state.active += 1;
    hooks.onAcquired?.();
    const doc = await readCliConfig();
    const next = {
      ...doc,
      envOverrides: { ...doc.envOverrides, [key]: key },
    };
    const tmp = `${cliConfigPath()}.${key}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n");
    await (hooks.beforeRename ?? delay(30));
    if (await handle.stillHeld()) {
      await rename(tmp, cliConfigPath());
    } else {
      state.failures.push(`${key}: lost the lock before the rename`);
      await rm(tmp, { force: true });
    }
  } finally {
    state.active -= 1;
    await handle.release();
  }
}

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-config-lock-breakers-"));
  h.readPark = null;
  h.lockReads = 0;
  h.renamePark = null;
  h.linkPark = null;
  setCliConfigLockTimingForTests({
    waitMs: 5000,
    pollMs: 10,
    staleAgeMs: 300,
  });
});

afterEach(async () => {
  for (const seam of seams.splice(0)) seam.open();
  for (const child of spawned.splice(0)) child.kill();
  h.readPark = null;
  h.renamePark = null;
  h.linkPark = null;
  setCliConfigLockTimingForTests(null);
  await rm(h.home, { recursive: true, force: true });
});

describe("breaking a dead settings lock", () => {
  it("lets one breaker remove a stale record while two others wait", async () => {
    await seed({ envOverrides: { SEED_KEY: "s" } });
    await writeAged(
      lockPath(),
      await deadPid(),
      null,
      "dead-holder",
      ONE_HOUR_MS,
    );
    const state: HolderState = { active: 0, failures: [] };
    const readSeam = makeSeam();
    const renameSeam = makeSeam();
    const aAcquired = makeSeam();
    const aMidWrite = makeSeam();
    const cAcquired = makeSeam();
    h.readPark = readSeam;
    h.lockReads = 0;

    // B has judged the record dead and stops at the re-read that decides
    // whether it may remove it.
    const b = holder("B", state, NO_HOOKS);
    await Promise.race([readSeam.parked, b]);
    // A wants the lock too. A breaker that cannot exclude B takes the lock
    // here and stays mid-write; an exclusive one waits for B.
    const a = holder("A", state, {
      onAcquired: aAcquired.markParked,
      beforeRename: aMidWrite.gate,
    });
    await Promise.race([aAcquired.parked, delay(300)]);
    // B resumes. Moving the lock aside (the earlier implementation) would
    // move A's live lock and leave the slot empty until B links it back.
    h.renamePark = renameSeam;
    readSeam.open();
    await Promise.race([renameSeam.parked, delay(300)]);
    // C arrives in that gap.
    const c = holder("C", state, {
      onAcquired: cAcquired.markParked,
      beforeRename: null,
    });
    await Promise.race([cAcquired.parked, delay(300)]);
    renameSeam.open();
    aMidWrite.open();
    await Promise.all([a, b, c]);

    expect(state.failures).toEqual([]);
    expect((await readCliConfig()).envOverrides).toEqual({
      SEED_KEY: "s",
      A: "A",
      B: "B",
      C: "C",
    });
    expect(existsSync(lockPath())).toBe(false);
  });

  it("removes nothing when a breaker wins the token after the record was replaced", async () => {
    await seed({ envOverrides: { SEED_KEY: "s" } });
    await writeAged(
      lockPath(),
      await deadPid(),
      null,
      "dead-holder",
      ONE_HOUR_MS,
    );
    const state: HolderState = { active: 0, failures: [] };
    const linkSeam = makeSeam();
    const aAcquired = makeSeam();
    const aMidWrite = makeSeam();
    h.linkPark = linkSeam;

    // B has judged the record dead and is about to create the generation-0
    // token.
    const b = holder("B", state, NO_HOOKS);
    await Promise.race([linkSeam.parked, b]);
    // A creates that token itself, breaks the record, removes its token and
    // takes the lock, then stays mid-write.
    const a = holder("A", state, {
      onAcquired: aAcquired.markParked,
      beforeRename: aMidWrite.gate,
    });
    const aFired = await Promise.race([
      aAcquired.parked.then(() => true),
      delay(1000).then(() => false),
    ]);
    expect(aFired).toBe(true);

    // B now wins generation 0, which A freed. The lock it judged dead is gone:
    // what it finds there is A's live record, and it must leave that alone.
    linkSeam.open();
    await delay(100);
    expect(existsSync(lockPath())).toBe(true);
    const record: unknown = JSON.parse(await readFile(lockPath(), "utf8"));
    expect(typeof record === "object" && record !== null).toBe(true);
    if (typeof record === "object" && record !== null) {
      expect(Reflect.get(record, "nonce")).not.toBe("dead-holder");
      expect(Reflect.get(record, "pid")).toBe(process.pid);
    }

    aMidWrite.open();
    await Promise.all([a, b]);

    expect(state.failures).toEqual([]);
    expect((await readCliConfig()).envOverrides).toEqual({
      SEED_KEY: "s",
      A: "A",
      B: "B",
    });
    expect(existsSync(lockPath())).toBe(false);
    expect(await breakTokensLeft()).toEqual([]);
  });

  it("does not let a dead break-token creator wedge the lock", async () => {
    const dead = await deadPid();
    await writeAged(lockPath(), dead, null, "dead-holder", ONE_HOUR_MS);
    await writeAged(
      breakTokenPath("dead-holder", 0),
      dead,
      null,
      "dead-breaker",
      ONE_HOUR_MS,
    );

    await setEnvOverride("K", "v");

    expect((await readCliConfig()).envOverrides).toEqual({ K: "v" });
    expect(await breakTokensLeft()).toEqual([]);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("respects a break token whose creator is alive", async () => {
    setCliConfigLockTimingForTests({
      waitMs: 800,
      pollMs: 10,
      staleAgeMs: 300,
    });
    const dead = await deadPid();
    const live = await liveChildPid();
    await writeAged(lockPath(), dead, null, "dead-holder", ONE_HOUR_MS);
    await writeAged(
      breakTokenPath("dead-holder", 0),
      live,
      await queryPidStartFingerprintAsync(live),
      "live-breaker",
      ONE_HOUR_MS,
    );
    const lockBefore = await readFile(lockPath());
    const tokenBefore = await readFile(breakTokenPath("dead-holder", 0));

    await expect(setEnvOverride("K", "v")).rejects.toThrow(/Timed out/);

    expect(await readFile(lockPath())).toEqual(lockBefore);
    expect(await readFile(breakTokenPath("dead-holder", 0))).toEqual(
      tokenBefore,
    );
    expect(existsSync(cliConfigPath())).toBe(false);
  });

  it("waits on a young break token even when its creator is dead", async () => {
    setCliConfigLockTimingForTests({
      waitMs: 600,
      pollMs: 10,
      staleAgeMs: 10_000,
    });
    const dead = await deadPid();
    // The lock is an hour old, so it qualifies for breaking; only the token is
    // young, which could be a breaker that has not finished writing it.
    await writeAged(lockPath(), dead, null, "dead-holder", ONE_HOUR_MS);
    await writeAged(
      breakTokenPath("dead-holder", 0),
      dead,
      null,
      "dead-breaker",
      0,
    );
    const lockBefore = await readFile(lockPath());
    const tokenBefore = await readFile(breakTokenPath("dead-holder", 0));

    await expect(setEnvOverride("K", "v")).rejects.toThrow(
      /Timed out after 600ms/,
    );

    expect(await readFile(lockPath())).toEqual(lockBefore);
    expect(await readFile(breakTokenPath("dead-holder", 0))).toEqual(
      tokenBefore,
    );
    expect(existsSync(cliConfigPath())).toBe(false);
  });

  it("sweeps break tokens left for records that are gone", async () => {
    const dead = await deadPid();
    await writeAged(
      breakTokenPath(randomUUID(), 0),
      dead,
      null,
      "gone-breaker-1",
      0,
    );
    await writeAged(
      breakTokenPath(randomUUID(), 3),
      dead,
      null,
      "gone-breaker-2",
      ONE_HOUR_MS,
    );

    await setEnvOverride("K", "v");

    expect((await readCliConfig()).envOverrides).toEqual({ K: "v" });
    expect(await breakTokensLeft()).toEqual([]);
  });

  // No fixed number of generations: however many breakers died mid-break, the
  // next one can still break.
  it.each([8, 9, 50])(
    "recovers a dead lock behind %i dead break-token generations",
    async (generations) => {
      const dead = await deadPid();
      await writeAged(lockPath(), dead, null, "dead-holder", ONE_HOUR_MS);
      await writeDeadTokens(dead, generations);

      await setEnvOverride("K", "v");

      expect((await readCliConfig()).envOverrides).toEqual({ K: "v" });
      expect(existsSync(lockPath())).toBe(false);
      expect(await breakTokensLeft()).toEqual([]);
    },
  );

  it("lets one of two breakers remove the lock at a high generation", async () => {
    await seed({ envOverrides: { SEED_KEY: "s" } });
    const dead = await deadPid();
    await writeAged(lockPath(), dead, null, "dead-holder", ONE_HOUR_MS);
    await writeDeadTokens(dead, 20);
    const state: HolderState = { active: 0, failures: [] };
    const readSeam = makeSeam();
    const aAcquired = makeSeam();
    h.readPark = readSeam;
    h.lockReads = 0;
    let aHasLock = false;
    void aAcquired.parked.then(() => {
      aHasLock = true;
    });

    // B claims generation 20 and stops at its re-read of the lock.
    const b = holder("B", state, NO_HOOKS);
    await Promise.race([readSeam.parked, b]);
    // B's token is young and its creator alive, so A has to wait for it.
    const a = holder("A", state, {
      onAcquired: aAcquired.markParked,
      beforeRename: null,
    });
    await Promise.race([aAcquired.parked, delay(300)]);
    expect(aHasLock).toBe(false);

    readSeam.open();
    await Promise.all([a, b]);

    expect(state.failures).toEqual([]);
    expect((await readCliConfig()).envOverrides).toEqual({
      SEED_KEY: "s",
      A: "A",
      B: "B",
    });
    expect(existsSync(lockPath())).toBe(false);
    expect(await breakTokensLeft()).toEqual([]);
  });

  it("still times out behind a live breaker at a high generation", async () => {
    setCliConfigLockTimingForTests({ waitMs: 800 });
    const dead = await deadPid();
    const live = await liveChildPid();
    await writeAged(lockPath(), dead, null, "dead-holder", ONE_HOUR_MS);
    await writeDeadTokens(dead, 10);
    await writeAged(
      breakTokenPath("dead-holder", 10),
      live,
      await queryPidStartFingerprintAsync(live),
      "live-breaker",
      ONE_HOUR_MS,
    );
    const lockBefore = await readFile(lockPath());
    const tokenBefore = await readFile(breakTokenPath("dead-holder", 10));

    const error = await setEnvOverride("K", "v").then(
      () => null,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toMatch(
      /Timed out after 800ms waiting for the settings lock/,
    );
    expect(message).toContain(lockPath());
    expect(await readFile(lockPath())).toEqual(lockBefore);
    expect(await readFile(breakTokenPath("dead-holder", 10))).toEqual(
      tokenBefore,
    );
    expect(existsSync(cliConfigPath())).toBe(false);
  });
});
