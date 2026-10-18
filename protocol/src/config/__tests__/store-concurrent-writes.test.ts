import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
  configRenames: 0,
  // Counts links whose target is the settings lock, failed or not.
  lockLinks: 0,
  renameFailure: null as string | null,
  // Fails EVERY link while set, to force the exclusive-create fallback.
  linkFailure: null as string | null,
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
    },
    link: async (existing: string, linkPath: string) => {
      if (linkPath === `${cliConfigPath()}.lock`) h.lockLinks += 1;
      if (h.linkFailure !== null) throw simulatedError(h.linkFailure);
      await actual.link(existing, linkPath);
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
  setLogLevels,
  setShell,
  writeCliConfig,
} from "../store";

const ZSH = "/opt/test/bin/zsh";
const FISH = "/opt/test/bin/fish";
const NU = "/opt/test/bin/nu";

let lastSeam: ParkSeam | null = null;

function lockPath(): string {
  return `${cliConfigPath()}.lock`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function armPark(): ParkSeam {
  let open: () => void = () => {};
  let markParked: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const parked = new Promise<void>((resolve) => {
    markParked = resolve;
  });
  const seam: ParkSeam = { gate, open, parked, markParked };
  h.park = seam;
  lastSeam = seam;
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

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-config-concurrent-"));
  h.platform = process.platform;
  h.park = null;
  h.configRenames = 0;
  h.lockLinks = 0;
  h.renameFailure = null;
  h.linkFailure = null;
  h.wxFailures = [];
});

afterEach(async () => {
  lastSeam?.open();
  lastSeam = null;
  h.park = null;
  h.renameFailure = null;
  h.linkFailure = null;
  h.wxFailures = [];
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
      h.linkFailure = "EPERM";
      h.wxFailures = ["EPERM"];

      await setEnvOverride("WIN", "1");

      expect((await readCliConfig()).envOverrides).toEqual({ WIN: "1" });
      expect(h.wxFailures).toEqual([]);
      expect(existsSync(lockPath())).toBe(false);
    });

    it("does not swallow EPERM on the exclusive create outside win32", async () => {
      h.platform = "linux";
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
