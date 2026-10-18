import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A park seam holds the setter that reads config.json first at the gate, after
// its read has completed, so a second setter can run its whole read-modify-write
// inside that window. On an unlocked store the second write lands first and the
// parked setter then overwrites it from its stale read; under the settings lock
// the second setter queues until the first has renamed.
interface ParkSeam {
  readonly gate: Promise<void>;
  readonly open: () => void;
  readonly parked: Promise<void>;
  readonly markParked: () => void;
}

const h = vi.hoisted(() => ({
  home: "",
  platform: process.platform as NodeJS.Platform,
  park: null as ParkSeam | null,
  // Like `park`, but for the next read of the settings lock file.
  lockReadPark: null as ParkSeam | null,
  configRenames: 0,
  // Counts links whose target is the settings lock, failed or not.
  lockLinks: 0,
  renameFailure: null as string | null,
  // Fails EVERY link while set, to force the exclusive-create fallback.
  linkFailure: null as string | null,
  // Fails the next links targeting the settings lock, one code per call.
  lockLinkFailures: [] as string[],
  // Counts unlinks of the settings lock, failed or not.
  lockUnlinks: 0,
  // Fails the next unlinks of the settings lock, one code per call.
  unlinkFailures: [] as string[],
  // Fails the next removals of the lock's temp record file, one code per call.
  lockTmpRmFailures: [] as string[],
  // Fails the next removals of a break token, one code per call.
  tokenRmFailures: [] as string[],
  // When set, a failed token removal first replaces the token with this
  // record, aged an hour: another breaker claiming the freed generation.
  tokenRmReplacement: null as string | null,
  // Fails the next reads of the lock file, one code per call.
  lockReadFailures: [] as string[],
  // Once set, the config rename arms this many lock-read failures (EBUSY).
  lockReadFailuresAfterRename: 0,
  // Every link into the lock fails EEXIST and every read of it ENOENT.
  lockAlwaysVanishing: false,
  // Fails the next `flag: "wx"` creates, one code per call.
  wxFailures: [] as string[],
}));

function simulatedError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated failure`), { code });
}

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
      if (args[0] === `${cliConfigPath()}.lock`) {
        if (h.lockAlwaysVanishing) throw simulatedError("ENOENT");
        const code = h.lockReadFailures.shift();
        if (code !== undefined) throw simulatedError(code);
      }
      const lockSeam = h.lockReadPark;
      if (lockSeam !== null && args[0] === `${cliConfigPath()}.lock`) {
        h.lockReadPark = null;
        const content = await actual.readFile(...args);
        lockSeam.markParked();
        await lockSeam.gate;
        return content;
      }
      const seam = h.park;
      if (seam !== null && args[0] === cliConfigPath()) {
        h.park = null;
        const content = await actual.readFile(...args);
        seam.markParked();
        await seam.gate;
        return content;
      }
      return actual.readFile(...args);
    },
    rename: async (source: string, target: string) => {
      if (target === cliConfigPath()) {
        h.configRenames += 1;
        const code = h.renameFailure;
        if (code !== null) {
          h.renameFailure = null;
          throw simulatedError(code);
        }
      }
      await actual.rename(source, target);
      if (target === cliConfigPath() && h.lockReadFailuresAfterRename > 0) {
        h.lockReadFailures = Array.from(
          { length: h.lockReadFailuresAfterRename },
          () => "EBUSY",
        );
        h.lockReadFailuresAfterRename = 0;
      }
    },
    link: async (existing: string, linkPath: string) => {
      if (linkPath === `${cliConfigPath()}.lock`) {
        h.lockLinks += 1;
        if (h.lockAlwaysVanishing) throw simulatedError("EEXIST");
        const code = h.lockLinkFailures.shift();
        if (code !== undefined) throw simulatedError(code);
      }
      if (h.linkFailure !== null) throw simulatedError(h.linkFailure);
      await actual.link(existing, linkPath);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const target = args[0];
      // The lock's own temp record (`config.json.lock.<uuid>.tmp`), not
      // config.json's tmp (`config.json.<pid>.<hex>.tmp`).
      if (
        typeof target === "string" &&
        target.startsWith(`${cliConfigPath()}.lock.`) &&
        target.endsWith(".tmp")
      ) {
        const code = h.lockTmpRmFailures.shift();
        if (code !== undefined) throw simulatedError(code);
      }
      if (
        typeof target === "string" &&
        target.includes(".break-") &&
        !target.endsWith(".tmp")
      ) {
        const code = h.tokenRmFailures.shift();
        if (code !== undefined) {
          if (h.tokenRmReplacement !== null) {
            await actual.writeFile(target, h.tokenRmReplacement);
            const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            await actual.utimes(target, anHourAgo, anHourAgo);
          }
          throw simulatedError(code);
        }
      }
      return actual.rm(...args);
    },
    unlink: async (path: string) => {
      if (path === `${cliConfigPath()}.lock`) {
        h.lockUnlinks += 1;
        const code = h.unlinkFailures.shift();
        if (code !== undefined) throw simulatedError(code);
      }
      await actual.unlink(path);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const options = args[2];
      if (
        typeof options === "object" &&
        options !== null &&
        "flag" in options &&
        options.flag === "wx"
      ) {
        const code = h.wxFailures.shift();
        if (code !== undefined) throw simulatedError(code);
      }
      return actual.writeFile(...args);
    },
  };
});

import { setCliConfigLockTimingForTests } from "../cli-config-lock";
import { queryPidStartFingerprintAsync } from "../credentials-lock";
import { cliConfigPath } from "../paths";
import {
  EMPTY_CLI_CONFIG,
  type CliConfig,
  type EnvOverrideValue,
  type VisualizationConfig,
} from "../schema";
import {
  addShell,
  deleteEnvOverride,
  readCliConfig,
  readVisualizationConfig,
  removeShell,
  resetShell,
  revertShellArgs,
  setAgentBrowserAccess,
  setAgentPages,
  setAgentRolesEnabled,
  setAgentWorktreeCreatePolicy,
  setCatalogProbeTimeoutOverride,
  setCatalogProbeTimeoutSeconds,
  setEnvOverride,
  setLogLevel,
  setLogLevels,
  setShell,
  writeCliConfig,
} from "../store";

const ZSH = "/opt/test/bin/zsh";
const FISH = "/opt/test/bin/fish";
const NU = "/opt/test/bin/nu";

let lastSeam: ParkSeam | null = null;
const spawned: ChildProcess[] = [];

function lockPath(): string {
  return `${cliConfigPath()}.lock`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function newSeam(): ParkSeam {
  let open: () => void = () => {};
  let markParked: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const parked = new Promise<void>((resolve) => {
    markParked = resolve;
  });
  const seam: ParkSeam = { gate, open, parked, markParked };
  lastSeam = seam;
  return seam;
}

function armPark(): ParkSeam {
  const seam = newSeam();
  h.park = seam;
  return seam;
}

function armLockReadPark(): ParkSeam {
  const seam = newSeam();
  h.lockReadPark = seam;
  return seam;
}

/** Writes config.json straight to disk, bypassing the store under test. */
async function seed(overrides: Partial<CliConfig>): Promise<void> {
  const config: CliConfig = { ...EMPTY_CLI_CONFIG, ...overrides };
  await mkdir(dirname(cliConfigPath()), { recursive: true });
  await writeFile(cliConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

// A shell entry whose args deviate from the zsh family default (`-i -l`), so
// revertShellArgs and removeShell have something real to change.
const SEED_WITH_SHELL: Partial<CliConfig> = {
  envOverrides: { SEED_KEY: "s", DEL_KEY: "d" },
  shell: {
    path: ZSH,
    args: ["-x"],
    entries: [{ path: ZSH, args: ["-x"] }],
  },
};

/**
 * `x` reads config.json and parks; `y` then runs to completion if the store
 * lets it (the 200ms race is long enough for an unlocked store to finish it, and
 * is simply the queue wait for a locked one); the gate opens and both settle.
 */
async function runInterleaved(
  x: () => Promise<unknown>,
  y: () => Promise<unknown>,
): Promise<void> {
  const seam = armPark();
  const xDone = x();
  await Promise.race([seam.parked, xDone]);
  const yDone = y();
  await Promise.race([yDone, delay(200)]);
  seam.open();
  await Promise.all([xDone, yDone]);
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

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-config-concurrent-"));
  h.platform = process.platform;
  h.park = null;
  h.lockReadPark = null;
  h.configRenames = 0;
  h.lockLinks = 0;
  h.renameFailure = null;
  h.lockUnlinks = 0;
  h.linkFailure = null;
  h.lockLinkFailures = [];
  h.unlinkFailures = [];
  h.lockTmpRmFailures = [];
  h.tokenRmFailures = [];
  h.tokenRmReplacement = null;
  h.lockReadFailures = [];
  h.lockReadFailuresAfterRename = 0;
  h.lockAlwaysVanishing = false;
  h.wxFailures = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  lastSeam?.open();
  lastSeam = null;
  h.park = null;
  h.lockReadPark = null;
  h.renameFailure = null;
  h.linkFailure = null;
  h.lockLinkFailures = [];
  h.unlinkFailures = [];
  h.lockTmpRmFailures = [];
  h.tokenRmFailures = [];
  h.tokenRmReplacement = null;
  h.lockReadFailures = [];
  h.lockReadFailuresAfterRename = 0;
  h.lockAlwaysVanishing = false;
  h.wxFailures = [];
  for (const child of spawned.splice(0)) child.kill();
  setCliConfigLockTimingForTests(null);
  await rm(h.home, { recursive: true, force: true });
});

describe("concurrent config writers", () => {
  it("keeps a concurrent setEnvOverride when setLogLevels read first (scratch proof)", async () => {
    await seed({ envOverrides: { SEED_KEY: "s" } });

    await runInterleaved(
      () => setLogLevels("warn", "warn"),
      () => setEnvOverride("LOST_ENV_KEY", "v"),
    );

    const config = await readCliConfig();
    expect(Object.keys(config.envOverrides).sort()).toEqual([
      "LOST_ENV_KEY",
      "SEED_KEY",
    ]);
    expect(config.logs).toEqual({ cliLogLevel: "warn", hostLogLevel: "warn" });
  });

  describe("every setter, parked after its read, keeps the interloper's change", () => {
    interface SetterRow {
      readonly name: string;
      readonly interloper: "env" | "logs";
      readonly run: () => Promise<unknown>;
      readonly check: (
        config: CliConfig,
        visualization: VisualizationConfig,
      ) => void;
    }

    const rows: readonly SetterRow[] = [
      {
        name: "setShell",
        interloper: "env",
        run: () => setShell(FISH, null),
        check: (config) => {
          expect(config.shell.path).toBe(FISH);
        },
      },
      {
        name: "addShell",
        interloper: "env",
        run: () => addShell(NU),
        check: (config) => {
          expect(config.shell.path).toBe(NU);
          expect(config.shell.entries.map((entry) => entry.path)).toContain(NU);
        },
      },
      {
        name: "revertShellArgs",
        interloper: "env",
        run: () => revertShellArgs(ZSH),
        check: (config) => {
          expect(config.shell.entries).toEqual([{ path: ZSH, args: null }]);
        },
      },
      {
        name: "removeShell",
        interloper: "env",
        run: () => removeShell(ZSH),
        check: (config) => {
          expect(config.shell.entries).toEqual([]);
          expect(config.shell.path).toBeNull();
        },
      },
      {
        name: "resetShell",
        interloper: "env",
        run: () => resetShell(),
        check: (config) => {
          expect(config.shell.path).toBeNull();
          expect(config.shell.args).toBeNull();
        },
      },
      {
        name: "setLogLevels",
        interloper: "env",
        run: () => setLogLevels("error", "debug"),
        check: (config) => {
          expect(config.logs).toEqual({
            cliLogLevel: "error",
            hostLogLevel: "debug",
          });
        },
      },
      {
        name: "setAgentRolesEnabled",
        interloper: "env",
        run: () => setAgentRolesEnabled(true),
        check: (config) => {
          expect(config.features.agentRoles).toBe(true);
        },
      },
      {
        name: "setAgentBrowserAccess",
        interloper: "env",
        run: () => setAgentBrowserAccess(false),
        check: (config) => {
          expect(config.browser.agentAccess).toBe(false);
        },
      },
      {
        name: "setAgentWorktreeCreatePolicy",
        interloper: "env",
        run: () => setAgentWorktreeCreatePolicy("never"),
        check: (config) => {
          expect(config.worktrees.agentCreate).toBe("never");
        },
      },
      {
        name: "setAgentPages",
        interloper: "env",
        run: () => setAgentPages(false),
        // `visualization` is not a modelled block, so read it the way the
        // product does.
        check: (_config, visualization) => {
          expect(visualization.agentPages).toBe(false);
        },
      },
      {
        name: "setCatalogProbeTimeoutSeconds",
        interloper: "env",
        run: () => setCatalogProbeTimeoutSeconds(90),
        check: (config) => {
          expect(config.catalog.probeTimeoutSeconds).toBe(90);
        },
      },
      {
        name: "setCatalogProbeTimeoutOverride",
        interloper: "env",
        run: () => setCatalogProbeTimeoutOverride("claude", 90),
        check: (config) => {
          expect(config.catalogOverrides).toEqual({ claude: 90 });
        },
      },
      {
        name: "setEnvOverride",
        interloper: "logs",
        run: () => setEnvOverride("X_KEY", "x"),
        check: (config) => {
          expect(config.envOverrides.X_KEY).toBe("x");
        },
      },
      {
        name: "deleteEnvOverride",
        interloper: "logs",
        run: () => deleteEnvOverride("DEL_KEY"),
        check: (config) => {
          expect(config.envOverrides).not.toHaveProperty("DEL_KEY");
        },
      },
    ];

    it.each(rows)("$name", async (row) => {
      await seed(SEED_WITH_SHELL);

      await runInterleaved(
        row.run,
        row.interloper === "env"
          ? () => setEnvOverride("LOST_ENV_KEY", "v")
          : () => setLogLevels("warn", "warn"),
      );

      const config = await readCliConfig();
      row.check(config, await readVisualizationConfig());
      expect(config.envOverrides.SEED_KEY).toBe("s");
      if (row.interloper === "env") {
        expect(config.envOverrides.LOST_ENV_KEY).toBe("v");
      } else {
        expect(config.logs).toEqual({
          cliLogLevel: "warn",
          hostLogLevel: "warn",
        });
      }
    });
  });

  describe("scoped log levels", () => {
    it("keeps a concurrent change to the other threshold", async () => {
      await seed({ envOverrides: { SEED_KEY: "s" } });

      await runInterleaved(
        () => setLogLevel("host", "debug"),
        () => setLogLevel("cli", "warn"),
      );

      expect((await readCliConfig()).logs).toEqual({
        cliLogLevel: "warn",
        hostLogLevel: "debug",
      });
    });

    it("changes one threshold and keeps the other as the file holds it", async () => {
      await seed({ logs: { cliLogLevel: "error", hostLogLevel: "trace" } });

      await setLogLevel("cli", "info");
      expect((await readCliConfig()).logs).toEqual({
        cliLogLevel: "info",
        hostLogLevel: "trace",
      });

      await setLogLevel("host", "warn");
      expect((await readCliConfig()).logs).toEqual({
        cliLogLevel: "info",
        hostLogLevel: "warn",
      });
    });
  });

  describe("two writers of the same block, different keys", () => {
    it("keeps both setEnvOverride keys", async () => {
      await seed(SEED_WITH_SHELL);

      await runInterleaved(
        () => setEnvOverride("A", "a"),
        () => setEnvOverride("B", "b"),
      );

      const { envOverrides } = await readCliConfig();
      expect(envOverrides).toEqual({
        SEED_KEY: "s",
        DEL_KEY: "d",
        A: "a",
        B: "b",
      });
    });

    it("keeps a set key while another writer deletes a different one", async () => {
      await seed(SEED_WITH_SHELL);

      await runInterleaved(
        () => deleteEnvOverride("DEL_KEY"),
        () => setEnvOverride("B", "b"),
      );

      const { envOverrides } = await readCliConfig();
      expect(envOverrides).toEqual({ SEED_KEY: "s", B: "b" });
    });

    it("keeps both catalogOverrides providers", async () => {
      await seed(SEED_WITH_SHELL);

      await runInterleaved(
        () => setCatalogProbeTimeoutOverride("claude", 30),
        () => setCatalogProbeTimeoutOverride("codex", 40),
      );

      const { catalogOverrides } = await readCliConfig();
      expect(catalogOverrides).toEqual({ claude: 30, codex: 40 });
    });

    it("keeps both shells when two addShell calls race", async () => {
      await seed(SEED_WITH_SHELL);

      await runInterleaved(
        () => addShell(NU),
        () => addShell(FISH),
      );

      const paths = (await readCliConfig()).shell.entries.map(
        (entry) => entry.path,
      );
      expect(paths).toEqual(expect.arrayContaining([ZSH, NU, FISH]));
    });
  });

  // These guard the lock lifecycle. The release and fallback rows also pass on
  // an unlocked store (nothing to release), so they are not part of the red set.
  describe("lock lifecycle", () => {
    it("releases the lock when the rename fails, so the next setter proceeds", async () => {
      await seed({ envOverrides: { SEED_KEY: "s" } });
      h.renameFailure = "EIO";

      await expect(setEnvOverride("X", "1")).rejects.toMatchObject({
        code: "EIO",
      });
      expect(existsSync(lockPath())).toBe(false);

      await setEnvOverride("Y", "2");

      const { envOverrides } = await readCliConfig();
      const expected: Record<string, EnvOverrideValue> = {
        SEED_KEY: "s",
        Y: "2",
      };
      expect(envOverrides).toEqual(expected);
      expect(existsSync(lockPath())).toBe(false);
    });

    it("queues in-process writers instead of polling the lock file", async () => {
      await seed({ envOverrides: { SEED_KEY: "s" } });
      const order: string[] = [];
      const seam = armPark();
      const first = setEnvOverride("FIRST", "1").then(() => {
        order.push("X");
      });
      await Promise.race([seam.parked, first]);

      const second = setEnvOverride("SECOND", "2").then(() => {
        order.push("Y");
      });
      const third = setLogLevels("warn", "warn").then(() => {
        order.push("Z");
      });
      await delay(200);
      // Without the queue, Y and Z would each retry the link every poll.
      expect(h.lockLinks).toBe(1);

      seam.open();
      await Promise.all([first, second, third]);

      expect(order).toEqual(["X", "Y", "Z"]);
      expect(h.lockLinks).toBe(3);
      const config = await readCliConfig();
      expect(config.envOverrides).toEqual({
        SEED_KEY: "s",
        FIRST: "1",
        SECOND: "2",
      });
      expect(config.logs).toEqual({
        cliLogLevel: "warn",
        hostLogLevel: "warn",
      });
    });

    // Windows answers a link over a file being deleted with access denied.
    it.each(["EACCES", "EBUSY"])(
      "retries a win32 link that fails %s instead of throwing",
      async (code) => {
        h.platform = "win32";
        h.lockLinkFailures = [code];

        await setEnvOverride("WIN", "1");

        expect((await readCliConfig()).envOverrides).toEqual({ WIN: "1" });
        expect(h.lockLinks).toBeGreaterThanOrEqual(2);
        expect(existsSync(lockPath())).toBe(false);
      },
    );

    it("keeps the lock it linked when its temp file cannot be removed", async () => {
      setCliConfigLockTimingForTests({
        waitMs: 1500,
        pollMs: 10,
        staleAgeMs: 300,
      });
      h.lockTmpRmFailures = ["EBUSY"];

      await setEnvOverride("K", "v");

      expect((await readCliConfig()).envOverrides).toEqual({ K: "v" });
      expect(h.lockTmpRmFailures).toEqual([]);
      expect(existsSync(lockPath())).toBe(false);

      // A leaked lock would name this live process and time this one out.
      await setEnvOverride("K2", "v2");

      expect((await readCliConfig()).envOverrides).toEqual({
        K: "v",
        K2: "v2",
      });
    });

    it("retries a win32 sharing violation while removing a dead lock", async () => {
      h.platform = "win32";
      setCliConfigLockTimingForTests({
        waitMs: 3000,
        pollMs: 10,
        staleAgeMs: 300,
      });
      await mkdir(dirname(lockPath()), { recursive: true });
      await writeFile(
        lockPath(),
        JSON.stringify({
          pid: await deadPid(),
          pidStartTime: null,
          nonce: "dead-holder",
          acquiredAt: 0,
        }),
      );
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(lockPath(), anHourAgo, anHourAgo);
      h.unlinkFailures = ["EBUSY"];

      await setEnvOverride("K", "v");

      expect((await readCliConfig()).envOverrides).toEqual({ K: "v" });
      // The refused removal, then the one that landed (and the release).
      expect(h.lockUnlinks).toBeGreaterThanOrEqual(2);
      expect(existsSync(lockPath())).toBe(false);
    });

    it("retries a release whose owner check a Windows filter blocks", async () => {
      h.platform = "win32";
      setCliConfigLockTimingForTests({
        waitMs: 1500,
        pollMs: 10,
        staleAgeMs: 300,
        backgroundReleaseDelaysMs: [60_000],
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // The three release attempts' owner-check reads are blocked; the reads
      // before the rename (the config read, the still-held check) are not.
      h.lockReadFailuresAfterRename = 3;

      await setEnvOverride("FIRST", "1");

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.flat().join(" ")).toContain(lockPath());

      await setEnvOverride("SECOND", "2");

      expect((await readCliConfig()).envOverrides).toEqual({
        FIRST: "1",
        SECOND: "2",
      });
      expect(existsSync(lockPath())).toBe(false);
    });

    it("keeps the wait bounded when the holder keeps vanishing", async () => {
      setCliConfigLockTimingForTests({ waitMs: 300, pollMs: 10 });
      h.lockAlwaysVanishing = true;

      const error = await setEnvOverride("K", "v").then(
        () => null,
        (rejection: unknown) => rejection,
      );

      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(
        /Timed out after 300ms waiting for the settings lock/,
      );
      expect(message).toContain(lockPath());
    }, 5000);

    it("removes its own break token when a Windows filter blocked both the break and the token's removal", async () => {
      h.platform = "win32";
      setCliConfigLockTimingForTests({
        waitMs: 3000,
        pollMs: 10,
        staleAgeMs: 300,
        backgroundReleaseDelaysMs: [60_000],
      });
      await mkdir(dirname(lockPath()), { recursive: true });
      await writeFile(
        lockPath(),
        JSON.stringify({
          pid: await deadPid(),
          pidStartTime: null,
          nonce: "dead-holder",
          acquiredAt: 0,
        }),
      );
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(lockPath(), anHourAgo, anHourAgo);
      h.unlinkFailures = ["EBUSY"];
      h.tokenRmFailures = ["EBUSY"];

      // The retained token names this live process, so only this process's own
      // retry of its removal lets the next attempt break the lock.
      await setEnvOverride("K", "v");

      expect((await readCliConfig()).envOverrides).toEqual({ K: "v" });
      expect(existsSync(lockPath())).toBe(false);
      const tokens = (await readdir(dirname(cliConfigPath()))).filter((name) =>
        name.includes(".break-"),
      );
      expect(tokens).toEqual([]);
    });

    it("never removes a retained token that another breaker now owns", async () => {
      h.platform = "win32";
      setCliConfigLockTimingForTests({
        waitMs: 800,
        pollMs: 10,
        staleAgeMs: 300,
        backgroundReleaseDelaysMs: [60_000],
      });
      const live = await liveChildPid();
      const foreignToken = JSON.stringify({
        pid: live,
        pidStartTime: await queryPidStartFingerprintAsync(live),
        nonce: "other-breaker",
        acquiredAt: 0,
      });
      await mkdir(dirname(lockPath()), { recursive: true });
      await writeFile(
        lockPath(),
        JSON.stringify({
          pid: await deadPid(),
          pidStartTime: null,
          nonce: "dead-holder",
          acquiredAt: 0,
        }),
      );
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(lockPath(), anHourAgo, anHourAgo);
      h.unlinkFailures = ["EBUSY"];
      h.tokenRmFailures = ["EBUSY"];
      h.tokenRmReplacement = foreignToken;

      await expect(setEnvOverride("K", "v")).rejects.toThrow(
        /Timed out after 800ms/,
      );

      // The retry of our token's removal finds another breaker's bytes there
      // and leaves them alone.
      const dir = dirname(cliConfigPath());
      const tokens = (await readdir(dir)).filter(
        (name) => name.includes(".break-") && !name.endsWith(".tmp"),
      );
      expect(tokens).toHaveLength(1);
      expect(await readFile(join(dir, tokens[0] ?? ""), "utf8")).toBe(
        foreignToken,
      );
      expect(existsSync(lockPath())).toBe(true);
      expect(existsSync(cliConfigPath())).toBe(false);
    });

    it("never drops a failed release silently", async () => {
      const secret = "s3cr3t-value-123";
      await seed({ envOverrides: { SECRET_KEY: secret } });
      setCliConfigLockTimingForTests({
        waitMs: 1500,
        pollMs: 10,
        staleAgeMs: 300,
        // Out of reach of this test: only the next acquire may land the release.
        backgroundReleaseDelaysMs: [60_000],
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      h.unlinkFailures = ["EBUSY", "EBUSY", "EBUSY"];

      await setEnvOverride("FIRST", "1");

      expect(warn).toHaveBeenCalledTimes(1);
      const warning = warn.mock.calls.flat().join(" ");
      expect(warning).toContain(lockPath());
      expect(warning).not.toContain(secret);
      expect(warning).not.toContain("SECRET_KEY");

      // The leaked lock names this live process, so only this process's own
      // retry of the release lets the next setter in.
      await setEnvOverride("SECOND", "2");

      expect((await readCliConfig()).envOverrides).toEqual({
        SECRET_KEY: secret,
        FIRST: "1",
        SECOND: "2",
      });
      expect(existsSync(lockPath())).toBe(false);
    });

    it("never lets two release retries race for one record", async () => {
      setCliConfigLockTimingForTests({
        waitMs: 3000,
        pollMs: 10,
        staleAgeMs: 300,
        backgroundReleaseDelaysMs: [100],
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      h.unlinkFailures = ["EBUSY", "EBUSY", "EBUSY"];

      // The release is pending now, with its background retry due shortly.
      await setEnvOverride("FIRST", "1");
      const seam = armLockReadPark();
      const second = setEnvOverride("SECOND", "2");
      // The acquire path's retry has read the record and is about to unlink it.
      await Promise.race([seam.parked, second]);

      // The background retry fires meanwhile. It must wait for the one in
      // flight: were it to unlink first, the in-flight one would then remove
      // whatever replaced the record.
      await delay(300);
      expect(existsSync(lockPath())).toBe(true);

      seam.open();
      await second;

      expect((await readCliConfig()).envOverrides).toEqual({
        FIRST: "1",
        SECOND: "2",
      });
      expect(existsSync(lockPath())).toBe(false);
    });

    it("lands a failed release in the background without another setter", async () => {
      setCliConfigLockTimingForTests({ backgroundReleaseDelaysMs: [50] });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      h.unlinkFailures = ["EBUSY", "EBUSY", "EBUSY"];

      await setEnvOverride("ONLY", "1");
      expect(existsSync(lockPath())).toBe(true);

      for (let i = 0; i < 200 && existsSync(lockPath()); i += 1) {
        await delay(10);
      }

      expect(existsSync(lockPath())).toBe(false);
    });

    it("falls back to an exclusive create when hard links are unsupported", async () => {
      h.linkFailure = "ENOTSUP";

      await setEnvOverride("K", "v");

      expect((await readCliConfig()).envOverrides).toEqual({ K: "v" });
      expect(existsSync(lockPath())).toBe(false);
    });

    it("writes nothing and retries when the lock was taken before the rename", async () => {
      await seed({ envOverrides: { SEED_KEY: "s" } });
      setCliConfigLockTimingForTests({
        waitMs: 3000,
        pollMs: 10,
        staleAgeMs: 200,
      });
      const seam = armPark();
      const mine = setEnvOverride("MINE", "1");
      await Promise.race([seam.parked, mine]);

      // A holder judged ours dead and took the lock over (so ours is a
      // stale-aged record of a dead pid), then wrote its own change.
      await writeFile(
        lockPath(),
        JSON.stringify({
          pid: await deadPid(),
          pidStartTime: null,
          nonce: "foreign",
          acquiredAt: 0,
        }),
      );
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(lockPath(), anHourAgo, anHourAgo);
      await seed({ envOverrides: { SEED_KEY: "s", THIEF: "t" } });

      seam.open();
      await mine;

      // The first attempt, working from the document read before the thief's
      // write, must not have renamed; only the retry did.
      expect(h.configRenames).toBe(1);
      expect((await readCliConfig()).envOverrides).toEqual({
        SEED_KEY: "s",
        THIEF: "t",
        MINE: "1",
      });
      expect(existsSync(lockPath())).toBe(false);
    });
  });

  // A whole replacement is how a user recovers from a corrupt file, so it must not read first.
  it("writeCliConfig still replaces a config.json that is not valid JSON", async () => {
    await mkdir(dirname(cliConfigPath()), { recursive: true });
    await writeFile(cliConfigPath(), "{ not json");

    await writeCliConfig({
      ...EMPTY_CLI_CONFIG,
      envOverrides: { REPLACED: "1" },
    });

    expect((await readCliConfig()).envOverrides).toEqual({ REPLACED: "1" });
    expect(existsSync(lockPath())).toBe(false);
  });

  describe("exclusive-create fallback errors", () => {
    it("treats EPERM on the exclusive create as a busy lock on win32", async () => {
      h.platform = "win32";
      // ENOTSUP, not EPERM: on win32 a link EPERM means a busy lock, not an
      // unsupported filesystem, so only ENOTSUP reaches the exclusive create.
      h.linkFailure = "ENOTSUP";
      h.wxFailures = ["EPERM"];

      await setEnvOverride("WIN", "1");

      expect((await readCliConfig()).envOverrides).toEqual({ WIN: "1" });
      expect(h.wxFailures).toEqual([]);
      expect(existsSync(lockPath())).toBe(false);
    });

    it("does not swallow EPERM on the exclusive create outside win32", async () => {
      h.platform = "linux";
      // Outside win32 a link EPERM is an unsupported filesystem, so this
      // reaches the exclusive create too.
      h.linkFailure = "EPERM";
      h.wxFailures = ["EPERM"];

      await expect(setEnvOverride("LINUX", "1")).rejects.toMatchObject({
        code: "EPERM",
      });

      expect(existsSync(cliConfigPath())).toBe(false);
      expect(existsSync(lockPath())).toBe(false);
    });
  });
});
