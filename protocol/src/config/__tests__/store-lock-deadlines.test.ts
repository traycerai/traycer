import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The wait is bounded by `waitMs` even when breaking a dead lock has slow or
// failing steps: a liveness probe that takes a while (Windows `tasklist`), and
// a token link a filter keeps refusing. The probe's delay and the link's
// failure are injected here, so the bound is measured rather than assumed.
const h = vi.hoisted(() => ({
  home: "",
  platform: process.platform as NodeJS.Platform,
  // Pids whose liveness probe waits `probeDelayMs`, then answers "dead".
  slowPids: new Set<number>(),
  probeDelayMs: 0,
  // How many times each pid's liveness was probed.
  probeCalls: new Map<number, number>(),
  // Links into a break token, failed or not.
  tokenLinks: 0,
  // Fails every link into a break token with this code while set.
  forceTokenLinkCode: null as string | null,
  // Fails the next links into a break token, one code per call, then passes.
  tokenLinkFailures: [] as string[],
  // Runs once, at the first link into a break token, before it fails or links.
  tokenLinkHook: null as (() => Promise<void>) | null,
  // The pid whose liveness probe answers dead once, then alive (a recycled pid).
  recycledPid: null as number | null,
  // Links into the lock file itself (not tokens or temp files), failed or not.
  lockLinks: 0,
  // Fails every link into the lock with this code while set.
  lockLinkAlways: null as string | null,
  // Fails the next links into the lock, one code per call, then passes.
  lockLinkFailures: [] as string[],
  // Pids whose liveness probe always answers alive.
  alivePids: new Set<number>(),
  // The pid whose liveness probe answers alive once, then dead.
  aliveOncePid: null as number | null,
  // The next reads of the lock file that fail EBUSY (Infinity: all of them).
  lockReadFailuresLeft: 0,
  // While set, every even-numbered read of the lock file fails EBUSY.
  lockReadAlternates: false,
  lockReads: 0,
}));

vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => h.home,
    platform: () => h.platform,
  };
});

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (h.lockReadFailuresLeft > 0 && args[0] === `${cliConfigPath()}.lock`) {
        h.lockReadFailuresLeft -= 1;
        throw Object.assign(new Error("EBUSY: simulated failure"), {
          code: "EBUSY",
        });
      }
      if (h.lockReadAlternates && args[0] === `${cliConfigPath()}.lock`) {
        h.lockReads += 1;
        if (h.lockReads % 2 === 0) {
          throw Object.assign(new Error("EBUSY: simulated failure"), {
            code: "EBUSY",
          });
        }
      }
      return actual.readFile(...args);
    },
    link: async (existing: string, linkPath: string) => {
      if (linkPath === `${cliConfigPath()}.lock`) {
        h.lockLinks += 1;
        const code = h.lockLinkAlways ?? h.lockLinkFailures.shift();
        if (code !== undefined) {
          throw Object.assign(new Error(`${code}: simulated failure`), {
            code,
          });
        }
      }
      if (linkPath.includes(".break-")) {
        h.tokenLinks += 1;
        const hook = h.tokenLinkHook;
        if (hook !== null) {
          h.tokenLinkHook = null;
          await hook();
        }
        const code = h.forceTokenLinkCode ?? h.tokenLinkFailures.shift();
        if (code !== undefined) {
          throw Object.assign(new Error(`${code}: simulated failure`), {
            code,
          });
        }
      }
      await actual.link(existing, linkPath);
    },
  };
});

vi.mock("../credentials-lock", async (importActual) => {
  const actual = await importActual<typeof import("../credentials-lock")>();
  return {
    ...actual,
    holderProvablyDead: async (
      pid: number,
      recordedFingerprint: string | null,
    ) => {
      h.probeCalls.set(pid, (h.probeCalls.get(pid) ?? 0) + 1);
      if (pid === h.recycledPid) return h.probeCalls.get(pid) === 1;
      if (h.alivePids.has(pid)) return false;
      if (pid === h.aliveOncePid) return (h.probeCalls.get(pid) ?? 0) > 1;
      if (h.slowPids.has(pid)) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, h.probeDelayMs);
        });
        return true;
      }
      return actual.holderProvablyDead(pid, recordedFingerprint);
    },
  };
});

import { setCliConfigLockTimingForTests } from "../cli-config-lock";
import { cliConfigPath } from "../paths";
import { setEnvOverride } from "../store";

const ONE_HOUR_MS = 60 * 60 * 1000;
const TOKEN_COUNT = 30;

function lockPath(): string {
  return `${cliConfigPath()}.lock`;
}

function breakTokenPath(nonce: string, generation: number): string {
  const digest = createHash("sha256").update(nonce).digest("hex").slice(0, 32);
  return `${lockPath()}.break-${digest}.${generation}`;
}

async function writeAged(
  path: string,
  pid: number,
  nonce: string,
  ageMs: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ pid, pidStartTime: null, nonce, acquiredAt: 0 }),
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

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-config-lock-deadlines-"));
  h.platform = process.platform;
  h.slowPids.clear();
  h.probeDelayMs = 0;
  h.tokenLinks = 0;
  h.probeCalls.clear();
  h.forceTokenLinkCode = null;
  h.tokenLinkFailures = [];
  h.tokenLinkHook = null;
  h.recycledPid = null;
  h.lockReadAlternates = false;
  h.lockReads = 0;
  h.lockLinks = 0;
  h.lockLinkAlways = null;
  h.lockLinkFailures = [];
  h.alivePids.clear();
  h.aliveOncePid = null;
  h.lockReadFailuresLeft = 0;
});

afterEach(async () => {
  h.slowPids.clear();
  h.probeDelayMs = 0;
  h.forceTokenLinkCode = null;
  h.tokenLinkFailures = [];
  h.tokenLinkHook = null;
  h.recycledPid = null;
  h.lockReadAlternates = false;
  h.lockLinkAlways = null;
  h.lockLinkFailures = [];
  h.alivePids.clear();
  h.aliveOncePid = null;
  h.lockReadFailuresLeft = 0;
  vi.restoreAllMocks();
  setCliConfigLockTimingForTests(null);
  await rm(lockPath(), { force: true });
  await rm(h.home, { recursive: true, force: true });
});

describe("the settings lock wait while breaking a dead lock", () => {
  it("does not break after the holder's own probe outlasts the wait", async () => {
    setCliConfigLockTimingForTests({
      waitMs: 300,
      pollMs: 10,
      staleAgeMs: 100,
    });
    const holderPid = 4_200_000;
    h.slowPids.add(holderPid);
    h.probeDelayMs = 600;
    await writeAged(lockPath(), holderPid, "dead-holder", ONE_HOUR_MS);
    const lockBefore = await readFile(lockPath());

    await expect(setEnvOverride("K", "v")).rejects.toThrow(
      /Timed out after 300ms/,
    );

    // The probe said dead, but too late: a write that timed out must not go on
    // to break the lock and mutate.
    expect(await readFile(lockPath())).toEqual(lockBefore);
    expect(existsSync(cliConfigPath())).toBe(false);
  });

  it("waits when a Windows filter blocks the breaker's re-read of the lock", async () => {
    h.platform = "win32";
    setCliConfigLockTimingForTests({
      waitMs: 300,
      pollMs: 10,
      staleAgeMs: 100,
    });
    await writeAged(lockPath(), await deadPid(), "dead-holder", ONE_HOUR_MS);
    // Per poll the lock is read twice: the acquire's holder read, which
    // passes, then the token winner's re-read, which a filter blocks.
    h.lockReadAlternates = true;

    await expect(setEnvOverride("K", "v")).rejects.toThrow(
      /Timed out after 300ms/,
    );

    expect(existsSync(lockPath())).toBe(true);
    // Waiting means sleeping a poll between attempts: at most two reads per
    // 10 ms poll over 300 ms, never a busy loop of immediate retries.
    expect(h.lockReads).toBeLessThanOrEqual(70);
  }, 5000);

  it("probes a new token afresh even when its creator's pid was proven dead", async () => {
    h.platform = "win32";
    setCliConfigLockTimingForTests({
      waitMs: 500,
      pollMs: 10,
      staleAgeMs: 100,
    });
    const recycled = 4_300_000;
    h.recycledPid = recycled;
    await writeAged(lockPath(), await deadPid(), "dead-holder", ONE_HOUR_MS);
    await writeAged(
      breakTokenPath("dead-holder", 0),
      recycled,
      "first-breaker",
      ONE_HOUR_MS,
    );
    // The first claim of generation 1 is refused by a filter, and in that
    // moment a live breaker that reused the pid writes generation 1 itself.
    h.tokenLinkFailures = ["EBUSY"];
    h.tokenLinkHook = async () => {
      await writeAged(
        breakTokenPath("dead-holder", 1),
        recycled,
        "recycled-breaker",
        ONE_HOUR_MS,
      );
    };

    await expect(setEnvOverride("K", "v")).rejects.toThrow(
      /Timed out after 500ms/,
    );

    // A Windows record has no start time, so only a fresh probe tells the new
    // token's creator apart from the dead one that held the pid before.
    expect(await readFile(breakTokenPath("dead-holder", 1), "utf8")).toBe(
      JSON.stringify({
        pid: recycled,
        pidStartTime: null,
        nonce: "recycled-breaker",
        acquiredAt: 0,
      }),
    );
    expect(existsSync(lockPath())).toBe(true);
  });

  it("polls while a Windows filter holds a released lock entry", async () => {
    h.platform = "win32";
    setCliConfigLockTimingForTests({
      waitMs: 300,
      pollMs: 10,
      staleAgeMs: 100,
    });
    // No lock file exists, but the create is refused: the filter still holds
    // the entry a peer's release just deleted.
    h.lockLinkAlways = "EBUSY";

    await expect(setEnvOverride("K", "v")).rejects.toThrow(
      /Timed out after 300ms/,
    );

    // One attempt per poll: about thirty, not a hot loop.
    expect(h.lockLinks).toBeLessThanOrEqual(40);
    expect(existsSync(cliConfigPath())).toBe(false);
  }, 5000);

  it("takes the lock once the filter lets go of the released entry", async () => {
    h.platform = "win32";
    setCliConfigLockTimingForTests({
      waitMs: 2000,
      pollMs: 10,
      staleAgeMs: 100,
    });
    h.lockLinkFailures = ["EBUSY", "EBUSY", "EBUSY"];

    await setEnvOverride("K", "v");

    expect(JSON.parse(await readFile(cliConfigPath(), "utf8"))).toMatchObject({
      envOverrides: { K: "v" },
    });
    expect(existsSync(lockPath())).toBe(false);
    expect(h.lockLinks).toBe(4);
  });

  it("retries at once when the holder released between the create and the read", async () => {
    h.platform = "linux";
    // A poll would take a second; the retry must not wait for one.
    setCliConfigLockTimingForTests({
      waitMs: 5000,
      pollMs: 1000,
      staleAgeMs: 100,
    });
    // EEXIST with no file behind it: the holder released right after.
    h.lockLinkFailures = ["EEXIST"];

    const started = Date.now();
    await setEnvOverride("K", "v");

    expect(Date.now() - started).toBeLessThan(500);
    expect(h.lockLinks).toBe(2);
  });

  it("reuses a live verdict on an unchanged break token instead of probing every poll", async () => {
    setCliConfigLockTimingForTests({
      waitMs: 500,
      pollMs: 10,
      staleAgeMs: 100,
    });
    const paused = 4_400_000;
    h.alivePids.add(paused);
    await writeAged(lockPath(), await deadPid(), "dead-holder", ONE_HOUR_MS);
    await writeAged(
      breakTokenPath("dead-holder", 0),
      paused,
      "paused-breaker",
      ONE_HOUR_MS,
    );
    const lockBefore = await readFile(lockPath());
    const tokenBefore = await readFile(breakTokenPath("dead-holder", 0));

    await expect(setEnvOverride("K", "v")).rejects.toThrow(
      /Timed out after 500ms/,
    );

    // About fifty polls fit in the wait; the creator is probed once, not each.
    expect(h.probeCalls.get(paused) ?? 0).toBeLessThanOrEqual(2);
    expect(await readFile(lockPath())).toEqual(lockBefore);
    expect(await readFile(breakTokenPath("dead-holder", 0))).toEqual(
      tokenBefore,
    );
  });

  it("probes a live break token again once the verdict expires", async () => {
    setCliConfigLockTimingForTests({
      waitMs: 3000,
      pollMs: 10,
      staleAgeMs: 100,
    });
    const paused = 4_400_001;
    h.aliveOncePid = paused;
    await writeAged(lockPath(), await deadPid(), "dead-holder", ONE_HOUR_MS);
    await writeAged(
      breakTokenPath("dead-holder", 0),
      paused,
      "paused-breaker",
      ONE_HOUR_MS,
    );

    const started = Date.now();
    await setEnvOverride("K", "v");
    const elapsed = Date.now() - started;

    expect(JSON.parse(await readFile(cliConfigPath(), "utf8"))).toMatchObject({
      envOverrides: { K: "v" },
    });
    expect(existsSync(lockPath())).toBe(false);
    // Alive once, then dead: exactly one re-probe, after the reuse window.
    expect(h.probeCalls.get(paused)).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2500);
  });

  it("keeps the lock when a Windows filter blocks one owner check before the rename", async () => {
    h.platform = "win32";
    setCliConfigLockTimingForTests({
      waitMs: 2000,
      pollMs: 10,
      staleAgeMs: 100,
    });
    // The first lock read is the still-held check after the temp write.
    h.lockReadFailuresLeft = 1;

    await setEnvOverride("K", "v");

    expect(JSON.parse(await readFile(cliConfigPath(), "utf8"))).toMatchObject({
      envOverrides: { K: "v" },
    });
    expect(existsSync(lockPath())).toBe(false);
    // One create: the blocked check was retried, not read as "not ours" and
    // answered with a release and a second acquire.
    expect(h.lockLinks).toBe(1);
  });

  it("never renames while every owner check is blocked", async () => {
    h.platform = "win32";
    setCliConfigLockTimingForTests({
      waitMs: 300,
      pollMs: 10,
      staleAgeMs: 100,
      backgroundReleaseDelaysMs: [],
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.lockReadFailuresLeft = Infinity;

    const started = Date.now();
    await expect(setEnvOverride("K", "v")).rejects.toThrow();

    // Owner unknown: nothing may be written over config.json.
    expect(existsSync(cliConfigPath())).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
    // `afterEach` stops the failing reads and removes the leftover lock.
  }, 10_000);

  it("probes each dead break-token creator once per acquire", async () => {
    h.platform = "win32";
    setCliConfigLockTimingForTests({
      waitMs: 3000,
      pollMs: 10,
      staleAgeMs: 300,
    });
    await writeAged(lockPath(), await deadPid(), "dead-holder", ONE_HOUR_MS);
    const pids = Array.from({ length: 5 }, (_unused, i) => 4_100_000 + i);
    for (const [generation, pid] of pids.entries()) {
      h.slowPids.add(pid);
      await writeAged(
        breakTokenPath("dead-holder", generation),
        pid,
        `dead-breaker-${generation}`,
        ONE_HOUR_MS,
      );
    }
    // The acquire polls several times before it can claim generation 5.
    h.tokenLinkFailures = ["EBUSY", "EBUSY", "EBUSY"];

    await setEnvOverride("K", "v");

    expect(h.tokenLinks).toBeGreaterThanOrEqual(4);
    for (const pid of pids) expect(h.probeCalls.get(pid)).toBe(1);
  });

  it("stops scanning break tokens at the deadline", async () => {
    setCliConfigLockTimingForTests({
      waitMs: 500,
      pollMs: 10,
      staleAgeMs: 300,
    });
    await writeAged(lockPath(), await deadPid(), "dead-holder", ONE_HOUR_MS);
    // Each token names its own creator, so each needs its own (slow) probe.
    h.probeDelayMs = 100;
    for (let i = 0; i < TOKEN_COUNT; i += 1) {
      const pid = 4_000_000 + i;
      h.slowPids.add(pid);
      await writeAged(
        breakTokenPath("dead-holder", i),
        pid,
        `dead-breaker-${i}`,
        ONE_HOUR_MS,
      );
    }

    const started = Date.now();
    await expect(setEnvOverride("K", "v")).rejects.toThrow(
      /Timed out after 500ms/,
    );

    // Probing all thirty would take about three seconds.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(existsSync(lockPath())).toBe(true);
  });

  it("backs off while a Windows filter holds the break token's link", async () => {
    h.platform = "win32";
    setCliConfigLockTimingForTests({
      waitMs: 500,
      pollMs: 50,
      staleAgeMs: 300,
    });
    await writeAged(lockPath(), await deadPid(), "dead-holder", ONE_HOUR_MS);
    h.forceTokenLinkCode = "EBUSY";

    await expect(setEnvOverride("K", "v")).rejects.toThrow(
      /Timed out after 500ms/,
    );

    // One attempt per poll: about ten, not a tight loop of hundreds.
    expect(h.tokenLinks).toBeGreaterThanOrEqual(1);
    expect(h.tokenLinks).toBeLessThanOrEqual(20);
  });
});
