import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
    link: async (existing: string, linkPath: string) => {
      if (linkPath.includes(".break-")) {
        h.tokenLinks += 1;
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
});

afterEach(async () => {
  h.slowPids.clear();
  h.probeDelayMs = 0;
  h.forceTokenLinkCode = null;
  h.tokenLinkFailures = [];
  setCliConfigLockTimingForTests(null);
  await rm(h.home, { recursive: true, force: true });
});

describe("the settings lock wait while breaking a dead lock", () => {
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
