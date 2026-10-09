import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect `~/.traycer/cli/config.json` to a per-test temp home by mocking
// `os.homedir()` (paths.ts derives the config path from it). `os.platform()`
// stays real so the OS-default shell logic is exercised honestly. `userInfo`
// is mockable so the passwd-vs-$SHELL precedence in `defaultShellPath` can be
// driven deterministically; `passwdShell: undefined` delegates to the real
// implementation, a string overrides it, and `passwdThrows` simulates no
// passwd entry.
const h = vi.hoisted(() => ({
  home: "",
  passwdShell: undefined as string | undefined,
  passwdThrows: false,
}));
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => h.home,
    userInfo: (...args: Parameters<typeof actual.userInfo>) => {
      if (h.passwdThrows) throw new Error("no passwd entry");
      const base = actual.userInfo(...args);
      return h.passwdShell === undefined
        ? base
        : { ...base, shell: h.passwdShell };
    },
  };
});

import { cliConfigPath } from "../paths";
import { EMPTY_CLI_CONFIG, type CliConfig } from "../schema";
import {
  addShell,
  applyEnvOverrides,
  defaultShellArgs,
  defaultShellPath,
  listEnvOverrides,
  loadEffectiveShellConfig,
  migrateCliConfig,
  readBrowserConfig,
  readBrowserConfigSync,
  readCliConfig,
  readFeatureSettings,
  readFeatureSettingsSync,
  readLogLevels,
  readLogLevelsSync,
  readWorktreesConfig,
  readWorktreesConfigSync,
  readCatalogConfig,
  readCatalogConfigSync,
  setCatalogProbeTimeoutSeconds,
  removeShell,
  resetShell,
  revertShellArgs,
  setEnvOverride,
  setAgentBrowserAccess,
  setAgentRolesEnabled,
  setAgentWorktreeCreatePolicy,
  setLogLevels,
  setShell,
  writeCliConfig,
} from "../store";
import { CLI_CONFIG_VERSION } from "../schema";

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-cli-config-"));
  h.passwdShell = undefined;
  h.passwdThrows = false;
});

async function writeRaw(contents: string): Promise<void> {
  const target = cliConfigPath();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

describe("cli config store", () => {
  it("returns the empty config when no file exists", async () => {
    expect(await readCliConfig()).toEqual(EMPTY_CLI_CONFIG);
  });

  it("defaults feature settings off when they are missing", async () => {
    expect(await readFeatureSettings()).toEqual({
      agentRoles: false,
      artifactVersioning: false,
    });
    expect(readFeatureSettingsSync()).toEqual({
      agentRoles: false,
      artifactVersioning: false,
    });
  });

  it("round-trips a written config through the schema", async () => {
    const cfg = {
      version: 1 as const,
      shell: {
        path: "/bin/fish",
        args: ["-l"],
        entries: [{ path: "/bin/fish", args: ["-l"] }],
      },
      envOverrides: { FOO: "bar" },
      logs: { cliLogLevel: "info" as const, hostLogLevel: "info" as const },
      features: { agentRoles: false, artifactVersioning: false },
      browser: { agentAccess: true },
      worktrees: { agentCreate: "allow" as const },
      catalog: { probeTimeoutSeconds: 60 },
    };
    await writeCliConfig(cfg);
    expect(await readCliConfig()).toEqual(cfg);
  });

  it("defaults both log levels to info when the file omits them", async () => {
    await writeRaw(
      JSON.stringify({
        version: 1,
        shell: { path: null, args: null },
        envOverrides: {},
      }),
    );
    expect(await readLogLevels()).toEqual({
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
  });

  it("persists explicit client + host log levels", async () => {
    await setLogLevels("debug", "warn");
    expect(await readLogLevels()).toEqual({
      cliLogLevel: "debug",
      hostLogLevel: "warn",
    });
  });

  it("preserves log levels across an unrelated shell write", async () => {
    await setLogLevels("trace", "debug");
    await setShell("/bin/fish", ["-l"]);
    expect(await readLogLevels()).toEqual({
      cliLogLevel: "trace",
      hostLogLevel: "debug",
    });
  });

  it("preserves log levels across an env-override write", async () => {
    await setLogLevels("warn", "error");
    await setEnvOverride("FOO", "bar");
    expect(await readLogLevels()).toEqual({
      cliLogLevel: "warn",
      hostLogLevel: "error",
    });
  });

  it("readLogLevelsSync falls back to info defaults on a missing or corrupt file", async () => {
    expect(readLogLevelsSync()).toEqual({
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
    await writeRaw("{ not json");
    expect(readLogLevelsSync()).toEqual({
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
  });

  it("readLogLevelsSync reads persisted levels", async () => {
    await setLogLevels("debug", "trace");
    expect(readLogLevelsSync()).toEqual({
      cliLogLevel: "debug",
      hostLogLevel: "trace",
    });
  });

  it("fails closed for malformed and future-version feature config reads", async () => {
    await writeRaw("{ not json");
    expect(readFeatureSettingsSync()).toEqual({
      agentRoles: false,
      artifactVersioning: false,
    });

    await writeRaw(
      JSON.stringify({
        version: 999,
        shell: { path: null, args: null },
        envOverrides: {},
        features: { agentRoles: true },
      }),
    );
    expect(readFeatureSettingsSync()).toEqual({
      agentRoles: false,
      artifactVersioning: false,
    });

    await writeRaw(
      JSON.stringify({
        version: 1,
        shell: { path: null, args: null },
        envOverrides: {},
        features: { agentRoles: "yes" },
      }),
    );
    expect(readFeatureSettingsSync()).toEqual({
      agentRoles: false,
      artifactVersioning: false,
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails closed when feature config is unreadable",
    async () => {
      await writeRaw(
        JSON.stringify({
          version: 1,
          features: { agentRoles: true },
        }),
      );
      await chmod(cliConfigPath(), 0o000);
      try {
        expect(readFeatureSettingsSync()).toEqual({
          agentRoles: false,
          artifactVersioning: false,
        });
      } finally {
        await chmod(cliConfigPath(), 0o600);
      }
    },
  );

  it("sets agent roles without changing shell, env, or log settings", async () => {
    await setShell("/bin/fish", ["-l"]);
    await setEnvOverride("FOO", "bar");
    await setLogLevels("debug", "warn");

    await setAgentRolesEnabled(true);
    expect(await readFeatureSettings()).toEqual({
      agentRoles: true,
      artifactVersioning: false,
    });
    expect(await readCliConfig()).toMatchObject({
      shell: {
        path: "/bin/fish",
        args: ["-l"],
      },
      envOverrides: { FOO: "bar" },
      logs: { cliLogLevel: "debug", hostLogLevel: "warn" },
      features: { agentRoles: true },
    });

    await setAgentRolesEnabled(false);
    expect(await readFeatureSettings()).toEqual({
      agentRoles: false,
      artifactVersioning: false,
    });
    expect(await readCliConfig()).toMatchObject({
      shell: {
        path: "/bin/fish",
        args: ["-l"],
      },
      envOverrides: { FOO: "bar" },
      logs: { cliLogLevel: "debug", hostLogLevel: "warn" },
      features: { agentRoles: false, artifactVersioning: false },
    });
  });

  it("reads agent browser access as on from a pre-feature file", async () => {
    await writeRaw(
      JSON.stringify({
        version: 1,
        shell: { path: null, args: null },
        envOverrides: {},
      }),
    );
    expect(await readBrowserConfig()).toEqual({ agentAccess: true });
    expect(readBrowserConfigSync()).toEqual({ agentAccess: true });
  });

  it("sets agent browser access without changing shell, env, or log settings", async () => {
    await setShell("/bin/fish", ["-l"]);
    await setEnvOverride("FOO", "bar");
    await setLogLevels("debug", "warn");

    await setAgentBrowserAccess(false);
    expect(await readBrowserConfig()).toEqual({ agentAccess: false });
    expect(readBrowserConfigSync()).toEqual({ agentAccess: false });
    expect(await readCliConfig()).toMatchObject({
      shell: { path: "/bin/fish", args: ["-l"] },
      envOverrides: { FOO: "bar" },
      logs: { cliLogLevel: "debug", hostLogLevel: "warn" },
      browser: { agentAccess: false },
    });

    await setAgentBrowserAccess(true);
    expect(await readBrowserConfig()).toEqual({ agentAccess: true });
  });

  it("surfaces a malformed browser block to the async reader", async () => {
    await writeRaw(
      JSON.stringify({
        version: 1,
        shell: { path: null, args: null },
        envOverrides: {},
        browser: { agentAccess: "no" },
      }),
    );
    await expect(readBrowserConfig()).rejects.toThrow(
      /does not match the expected schema/,
    );
  });

  it("fails OPEN for malformed and unreadable browser reads", async () => {
    // The opposite of the feature-gate reader: agents already have browser
    // access, so a config we cannot read must not revoke it.
    await writeRaw("{ not json");
    expect(readBrowserConfigSync()).toEqual({ agentAccess: true });

    await writeRaw(
      JSON.stringify({
        version: 1,
        shell: { path: null, args: null },
        envOverrides: {},
        browser: { agentAccess: "no" },
      }),
    );
    expect(readBrowserConfigSync()).toEqual({ agentAccess: true });

    // A readable block with no `agentAccess` is the pre-switch shape, not a
    // revocation.
    await writeRaw(
      JSON.stringify({
        version: 1,
        shell: { path: null, args: null },
        envOverrides: {},
        browser: {},
      }),
    );
    expect(readBrowserConfigSync()).toEqual({ agentAccess: true });
  });

  it("honours an explicit agentAccess:false the whole document cannot validate", async () => {
    // Failing open is for a block we cannot read. A `version` this binary
    // predates - or any unrelated block a newer writer reshaped - fails
    // `cliConfigSchema` while the `browser` block is perfectly readable, and
    // re-granting the capability there would undo a deliberate choice.
    await writeRaw(
      JSON.stringify({
        version: 999,
        shell: { path: null, args: null },
        envOverrides: {},
        browser: { agentAccess: false },
      }),
    );
    expect(readBrowserConfigSync()).toEqual({ agentAccess: false });

    await writeRaw(
      JSON.stringify({
        version: 1,
        shell: { path: null, args: null },
        envOverrides: {},
        logs: { cliLogLevel: "shouty" },
        browser: { agentAccess: false },
      }),
    );
    expect(readBrowserConfigSync()).toEqual({ agentAccess: false });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails open when the browser config is unreadable",
    async () => {
      await setAgentBrowserAccess(false);
      await chmod(cliConfigPath(), 0o000);
      try {
        expect(readBrowserConfigSync()).toEqual({ agentAccess: true });
      } finally {
        await chmod(cliConfigPath(), 0o600);
      }
    },
  );

  it("preserves an unknown top-level block across a read-modify-write", async () => {
    // `.passthrough()` on the top level: a block written by a newer binary must
    // survive this one's next write, or two binaries sharing the file would
    // delete each other's settings.
    await writeRaw(
      JSON.stringify({
        version: 1,
        shell: { path: null, args: null },
        envOverrides: {},
        futureBlock: { nested: true },
      }),
    );
    await setAgentBrowserAccess(false);
    const raw: unknown = JSON.parse(await readFile(cliConfigPath(), "utf8"));
    expect(raw).toMatchObject({
      browser: { agentAccess: false },
      futureBlock: { nested: true },
    });
  });

  it("stores explicit unsets as null env overrides", async () => {
    await setEnvOverride("OPENAI_API_KEY", null);
    expect(await listEnvOverrides()).toEqual({
      OPENAI_API_KEY: null,
    });
  });

  it("applies null env overrides by deleting inherited values", () => {
    expect(
      applyEnvOverrides(
        { OPENAI_API_KEY: "inherited", ANTHROPIC_API_KEY: "kept" },
        { OPENAI_API_KEY: null, GEMINI_API_KEY: "set" },
      ),
    ).toEqual({
      ANTHROPIC_API_KEY: "kept",
      GEMINI_API_KEY: "set",
    });
  });

  it("synthesises OS defaults when shell is unset", async () => {
    const eff = await loadEffectiveShellConfig();
    expect(eff).toEqual({
      path: defaultShellPath(),
      args: defaultShellArgs(defaultShellPath()),
      synthesised: true,
    });
  });

  it("reflects an explicit shell override (not synthesised)", async () => {
    await setShell("/bin/bash", ["-i"]);
    expect(await loadEffectiveShellConfig()).toEqual({
      path: "/bin/bash",
      args: ["-i"],
      synthesised: false,
    });
  });

  it("throws on a file that is not valid JSON", async () => {
    await writeRaw("{ not json");
    await expect(readCliConfig()).rejects.toThrow(/not valid JSON/);
  });

  it("throws when the file violates the schema", async () => {
    await writeRaw(
      JSON.stringify({
        version: 1,
        shell: { path: 1, args: null },
        envOverrides: {},
      }),
    );
    await expect(readCliConfig()).rejects.toThrow(
      /does not match the expected schema/,
    );
  });

  it("stamps the current version on every write", async () => {
    await setShell("/bin/bash", null);
    expect((await readCliConfig()).version).toBe(CLI_CONFIG_VERSION);
  });

  it("tolerates a partial file, defaulting missing sections", async () => {
    // Only shell.path set - no args, no envOverrides. The old hand-rolled
    // reader accepted this; the schema must too (defaults fill the gaps).
    await writeRaw(JSON.stringify({ version: 1, shell: { path: "/bin/zsh" } }));
    expect(await readCliConfig()).toEqual({
      version: CLI_CONFIG_VERSION,
      shell: { path: "/bin/zsh", args: null, entries: [] },
      envOverrides: {},
      logs: { cliLogLevel: "info", hostLogLevel: "info" },
      features: { agentRoles: false, artifactVersioning: false },
      browser: { agentAccess: true },
      worktrees: { agentCreate: "allow" },
      catalog: { probeTimeoutSeconds: 60 },
    });
  });

  it("reads a versionless legacy file as the current version", async () => {
    await writeRaw(JSON.stringify({ shell: { path: "/bin/zsh", args: [] } }));
    const cfg = await readCliConfig();
    expect(cfg.version).toBe(CLI_CONFIG_VERSION);
    expect(cfg.shell.path).toBe("/bin/zsh");
  });

  it("rejects a future-version file rather than misreading it", async () => {
    await writeRaw(
      JSON.stringify({
        version: 999,
        shell: { path: null, args: null },
        envOverrides: {},
      }),
    );
    await expect(readCliConfig()).rejects.toThrow(
      /does not match the expected schema/,
    );
  });
});

describe("agent worktree create policy", () => {
  const BASE = {
    version: 1,
    shell: { path: null, args: null },
    envOverrides: {},
  };

  it("reads allow from a pre-feature file", async () => {
    await writeRaw(JSON.stringify(BASE));
    expect(await readWorktreesConfig()).toEqual({ agentCreate: "allow" });
    expect(readWorktreesConfigSync()).toEqual({ agentCreate: "allow" });
  });

  it("reads allow for a worktrees block that omits agentCreate", async () => {
    await writeRaw(JSON.stringify({ ...BASE, worktrees: {} }));
    expect(await readWorktreesConfig()).toEqual({ agentCreate: "allow" });
    expect(readWorktreesConfigSync()).toEqual({ agentCreate: "allow" });
  });

  it("sync read fails OPEN to allow when the file is missing", () => {
    expect(readWorktreesConfigSync()).toEqual({ agentCreate: "allow" });
  });

  it("sync read fails OPEN to allow on malformed JSON", async () => {
    // Agents could create worktrees before the policy existed, so a config we
    // cannot read must not revoke it.
    await writeRaw("{ not json");
    expect(readWorktreesConfigSync()).toEqual({ agentCreate: "allow" });
  });

  it("sync read fails OPEN to allow on an invalid agentCreate value", async () => {
    for (const agentCreate of ["sometimes", "", 3, null, true]) {
      await writeRaw(JSON.stringify({ ...BASE, worktrees: { agentCreate } }));
      expect(readWorktreesConfigSync()).toEqual({ agentCreate: "allow" });
    }
  });

  it("sync read fails OPEN to allow when the worktrees block is not an object", async () => {
    for (const worktrees of ["never", 7, ["never"]]) {
      await writeRaw(JSON.stringify({ ...BASE, worktrees }));
      expect(readWorktreesConfigSync()).toEqual({ agentCreate: "allow" });
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "sync read fails OPEN to allow when the config file is unreadable",
    async () => {
      await setAgentWorktreeCreatePolicy("never");
      await chmod(cliConfigPath(), 0o000);
      try {
        expect(readWorktreesConfigSync()).toEqual({ agentCreate: "allow" });
      } finally {
        await chmod(cliConfigPath(), 0o600);
      }
    },
  );

  it("sync read honours an explicit never or ask beside an invalid browser block", async () => {
    // Failing open is for a worktrees block we cannot read. A defect in an
    // unrelated block must not re-grant a capability the user restricted.
    for (const agentCreate of ["never", "ask"] as const) {
      await writeRaw(
        JSON.stringify({
          ...BASE,
          browser: { agentAccess: "no" },
          worktrees: { agentCreate },
        }),
      );
      expect(readWorktreesConfigSync()).toEqual({ agentCreate });
    }
  });

  it("sync read honours an explicit never or ask beside an invalid version", async () => {
    for (const agentCreate of ["never", "ask"] as const) {
      await writeRaw(
        JSON.stringify({
          ...BASE,
          version: 999,
          worktrees: { agentCreate },
        }),
      );
      expect(readWorktreesConfigSync()).toEqual({ agentCreate });
    }
  });

  it("sync read honours an explicit never beside other unrelated defects", async () => {
    await writeRaw(
      JSON.stringify({
        ...BASE,
        logs: { cliLogLevel: "shouty" },
        shell: { path: 1, args: null },
        worktrees: { agentCreate: "never" },
      }),
    );
    expect(readWorktreesConfigSync()).toEqual({ agentCreate: "never" });
  });

  it("async read throws on a malformed file", async () => {
    // The Settings chip shows an error rather than a false "Allow".
    await writeRaw("{ not json");
    await expect(readWorktreesConfig()).rejects.toThrow(/not valid JSON/);
  });

  it("async read throws on a malformed worktrees block", async () => {
    await writeRaw(
      JSON.stringify({ ...BASE, worktrees: { agentCreate: "sometimes" } }),
    );
    await expect(readWorktreesConfig()).rejects.toThrow(
      /does not match the expected schema/,
    );
  });

  it("sets the policy and round-trips it through both readers", async () => {
    for (const agentCreate of ["ask", "never", "allow"] as const) {
      await setAgentWorktreeCreatePolicy(agentCreate);
      expect(await readWorktreesConfig()).toEqual({ agentCreate });
      expect(readWorktreesConfigSync()).toEqual({ agentCreate });
    }
  });

  it("sets the policy without changing shell, env, log, feature, or browser settings", async () => {
    await setShell("/bin/fish", ["-l"]);
    await setEnvOverride("FOO", "bar");
    await setLogLevels("debug", "warn");
    await setAgentRolesEnabled(true);
    await setAgentBrowserAccess(false);

    await setAgentWorktreeCreatePolicy("never");

    expect(await readCliConfig()).toMatchObject({
      shell: { path: "/bin/fish", args: ["-l"] },
      envOverrides: { FOO: "bar" },
      logs: { cliLogLevel: "debug", hostLogLevel: "warn" },
      features: { agentRoles: true },
      browser: { agentAccess: false },
      worktrees: { agentCreate: "never" },
    });
  });

  it("other writers preserve the worktrees policy", async () => {
    await setAgentWorktreeCreatePolicy("ask");
    await setShell("/bin/fish", ["-l"]);
    await setEnvOverride("FOO", "bar");
    await setLogLevels("debug", "warn");
    await setAgentBrowserAccess(false);
    expect(await readWorktreesConfig()).toEqual({ agentCreate: "ask" });
  });

  it("preserves an unknown top-level block across a policy write", async () => {
    await writeRaw(JSON.stringify({ ...BASE, futureBlock: { nested: true } }));
    await setAgentWorktreeCreatePolicy("never");
    const raw: unknown = JSON.parse(await readFile(cliConfigPath(), "utf8"));
    expect(raw).toMatchObject({
      worktrees: { agentCreate: "never" },
      futureBlock: { nested: true },
    });
  });
});

describe("catalog probe timeout", () => {
  const BASE = {
    version: 1,
    shell: { path: null, args: null },
    envOverrides: {},
  };

  it("defaults to 60 for a file without the block, from both readers", async () => {
    await writeRaw(JSON.stringify(BASE));
    expect(await readCatalogConfig()).toEqual({ probeTimeoutSeconds: 60 });
    expect(readCatalogConfigSync()).toEqual({ probeTimeoutSeconds: 60 });
  });

  it("defaults to 60 for a catalog block that omits the value", async () => {
    await writeRaw(JSON.stringify({ ...BASE, catalog: {} }));
    expect(await readCatalogConfig()).toEqual({ probeTimeoutSeconds: 60 });
    expect(readCatalogConfigSync()).toEqual({ probeTimeoutSeconds: 60 });
  });

  it("round-trips a written value through both readers", async () => {
    await setCatalogProbeTimeoutSeconds(120);
    expect(await readCatalogConfig()).toEqual({ probeTimeoutSeconds: 120 });
    expect(readCatalogConfigSync()).toEqual({ probeTimeoutSeconds: 120 });
  });

  it("sets the value without changing the other blocks", async () => {
    await setShell("/bin/fish", ["-l"]);
    await setEnvOverride("FOO", "bar");
    await setLogLevels("debug", "warn");
    await setAgentBrowserAccess(false);
    await setAgentWorktreeCreatePolicy("never");

    await setCatalogProbeTimeoutSeconds(120);

    expect(await readCliConfig()).toMatchObject({
      shell: { path: "/bin/fish", args: ["-l"] },
      envOverrides: { FOO: "bar" },
      logs: { cliLogLevel: "debug", hostLogLevel: "warn" },
      browser: { agentAccess: false },
      worktrees: { agentCreate: "never" },
      catalog: { probeTimeoutSeconds: 120 },
    });
  });

  it("survives a read-modify-write that does not touch it", async () => {
    await setCatalogProbeTimeoutSeconds(120);
    await setAgentWorktreeCreatePolicy("ask");
    await setShell("/bin/fish", ["-l"]);
    expect(await readCatalogConfig()).toEqual({ probeTimeoutSeconds: 120 });
    expect(readCatalogConfigSync()).toEqual({ probeTimeoutSeconds: 120 });
  });

  it("clamps a stored value into [60, 180] on read, in both readers", async () => {
    for (const [stored, read] of [
      [30, 60],
      [1, 60],
      [600, 180],
      [181, 180],
      [75, 75],
      [180, 180],
    ] as const) {
      await writeRaw(
        JSON.stringify({ ...BASE, catalog: { probeTimeoutSeconds: stored } }),
      );
      expect(await readCatalogConfig()).toEqual({ probeTimeoutSeconds: read });
      expect(readCatalogConfigSync()).toEqual({ probeTimeoutSeconds: read });
    }
  });

  it("sync read returns 60 for a missing file", () => {
    expect(readCatalogConfigSync()).toEqual({ probeTimeoutSeconds: 60 });
  });

  it("sync read returns 60 for invalid JSON", async () => {
    await writeRaw("{ not json");
    expect(readCatalogConfigSync()).toEqual({ probeTimeoutSeconds: 60 });
  });

  it("sync read returns 60 for a non-integer, negative, zero or non-number value", async () => {
    for (const probeTimeoutSeconds of [90.5, -5, 0, "120", null]) {
      await writeRaw(
        JSON.stringify({ ...BASE, catalog: { probeTimeoutSeconds } }),
      );
      expect(readCatalogConfigSync()).toEqual({ probeTimeoutSeconds: 60 });
    }
  });

  it("sync read returns 60 when the catalog block is not an object", async () => {
    for (const catalog of ["120", 7, ["120"], null]) {
      await writeRaw(JSON.stringify({ ...BASE, catalog }));
      expect(readCatalogConfigSync()).toEqual({ probeTimeoutSeconds: 60 });
    }
  });

  it("sync read honours a valid value beside an unrelated defect elsewhere", async () => {
    await writeRaw(
      JSON.stringify({
        ...BASE,
        worktrees: { agentCreate: "sometimes" },
        logs: { cliLogLevel: "shouty" },
        catalog: { probeTimeoutSeconds: 120 },
      }),
    );
    expect(readCatalogConfigSync()).toEqual({ probeTimeoutSeconds: 120 });
  });

  it("async read throws on a malformed file", async () => {
    await writeRaw("{ not json");
    await expect(readCatalogConfig()).rejects.toThrow(/not valid JSON/);
  });

  it("async read throws on a malformed catalog block", async () => {
    await writeRaw(
      JSON.stringify({ ...BASE, catalog: { probeTimeoutSeconds: "soon" } }),
    );
    await expect(readCatalogConfig()).rejects.toThrow(
      /does not match the expected schema/,
    );
  });

  it("async read throws beside an unrelated defect, unlike the sync read", async () => {
    await writeRaw(
      JSON.stringify({
        ...BASE,
        worktrees: { agentCreate: "sometimes" },
        catalog: { probeTimeoutSeconds: 120 },
      }),
    );
    await expect(readCatalogConfig()).rejects.toThrow(
      /does not match the expected schema/,
    );
  });
});

describe("familyDefault (defaultShellArgs)", () => {
  it("gives login shells -i -l and everything else no flags", () => {
    for (const path of [
      "/bin/zsh",
      "/bin/bash",
      "/usr/bin/fish",
      "/bin/sh",
      "/bin/ksh",
      "/usr/bin/tcsh",
      "/usr/bin/dash",
    ]) {
      expect(defaultShellArgs(path)).toEqual(["-i", "-l"]);
    }
    for (const path of [
      "/bin/cat",
      "/opt/homebrew/bin/nu",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Windows\\System32\\wsl.exe",
      "/opt/custom/myshell",
    ]) {
      expect(defaultShellArgs(path)).toEqual([]);
    }
  });
});

describe("shell entries + mirror invariant", () => {
  // The compat contract: outside the one pure-system-default state, `shell.args`
  // always equals the resolved args for `shell.path`, materialised - so an old
  // host binary never applies its own family default to the wrong program.
  async function expectMirror(): Promise<void> {
    const cfg = await readCliConfig();
    if (cfg.shell.path === null && cfg.shell.args === null) return;
    const path = cfg.shell.path ?? defaultShellPath();
    const deviation = cfg.shell.entries.find((e) => e.path === path)?.args;
    // A null-args entry (or no entry) resolves to the family default.
    expect(cfg.shell.args).toEqual(deviation ?? defaultShellArgs(path));
  }

  it("addShell records a no-deviation entry, selects it, and mirrors", async () => {
    const result = await addShell("/opt/homebrew/bin/nu");
    // A freshly-added program runs factory flags, so its entry has no deviation.
    expect(result).toEqual({
      path: "/opt/homebrew/bin/nu",
      entries: [{ path: "/opt/homebrew/bin/nu", args: null }],
    });
    const cfg = await readCliConfig();
    expect(cfg.shell.path).toBe("/opt/homebrew/bin/nu");
    expect(cfg.shell.args).toEqual([]); // mirror materialises the resolved args
    expect(cfg.shell.entries).toEqual([
      { path: "/opt/homebrew/bin/nu", args: null },
    ]);
    await expectMirror();
  });

  it("re-adding a shell clears any flag deviation back to null", async () => {
    await addShell("/opt/homebrew/bin/nu");
    await setShell(null, ["--login"]); // customise the selected shell's flags
    expect((await readCliConfig()).shell.entries).toEqual([
      { path: "/opt/homebrew/bin/nu", args: ["--login"] },
    ]);
    await addShell("/opt/homebrew/bin/nu");
    expect((await readCliConfig()).shell.entries).toEqual([
      { path: "/opt/homebrew/bin/nu", args: null },
    ]);
  });

  it("picking a shell materialises its args and creates NO entry", async () => {
    await setShell("/bin/bash", null); // login shell -> family default -i -l
    let cfg = await readCliConfig();
    expect(cfg.shell.path).toBe("/bin/bash");
    expect(cfg.shell.args).toEqual(["-i", "-l"]);
    expect(cfg.shell.entries).toEqual([]);
    await expectMirror();

    await setShell("/bin/cat", null); // non-shell -> no flags
    cfg = await readCliConfig();
    expect(cfg.shell.args).toEqual([]);
    expect(cfg.shell.entries).toEqual([]);
    await expectMirror();
  });

  it("switching shells swaps the mirror to the new shell's resolved args", async () => {
    await setShell(null, ["-x"]); // customise the login shell while on auto
    const defaultPath = defaultShellPath();
    const autoState = await readCliConfig();
    // The mirror stays pure-auto (System default row stays checked); the flags
    // are remembered against the login shell's entry.
    expect(autoState.shell.path).toBeNull();
    expect(autoState.shell.args).toBeNull();
    expect(autoState.shell.entries).toEqual([
      { path: defaultPath, args: ["-x"] },
    ]);

    await setShell("/bin/cat", null); // pick a non-shell: mirror materialises to []
    const cfg = await readCliConfig();
    expect(cfg.shell.args).toEqual([]);
    // The customised login shell keeps its entry for when we return to it.
    expect(cfg.shell.entries).toEqual([{ path: defaultPath, args: ["-x"] }]);
    await expectMirror();
  });

  it("configuring flags on the system default keeps it checked and inherits them", async () => {
    await setShell(null, ["-x"]); // flag edit while synthesised
    const defaultPath = defaultShellPath();
    const cfg = await readCliConfig();
    expect(cfg.shell.path).toBeNull();
    expect(cfg.shell.args).toBeNull(); // still pure system default
    expect(cfg.shell.entries).toEqual([{ path: defaultPath, args: ["-x"] }]);
    // The System default row stays checked (synthesised) yet inherits the flags.
    expect(await loadEffectiveShellConfig()).toEqual({
      path: defaultPath,
      args: ["-x"],
      synthesised: true,
    });
  });

  it("customising flags upserts the selected shell's entry", async () => {
    await setShell("/bin/bash", null);
    await setShell(null, ["-l"]);
    const cfg = await readCliConfig();
    expect(cfg.shell.entries).toEqual([{ path: "/bin/bash", args: ["-l"] }]);
    expect(cfg.shell.args).toEqual(["-l"]);
    await expectMirror();
  });

  it("removing the selected shell resets the mirror to pure system default", async () => {
    await addShell("/opt/homebrew/bin/nu");
    const result = await removeShell("/opt/homebrew/bin/nu");
    expect(result).toEqual({ removed: true, path: null });
    const cfg = await readCliConfig();
    expect(cfg.shell.entries).toEqual([]);
    expect(cfg.shell.path).toBeNull();
    expect(cfg.shell.args).toBeNull();
  });

  it("removing a non-selected shell keeps the current selection and mirror", async () => {
    await addShell("/opt/homebrew/bin/nu");
    await setShell("/bin/bash", null);
    const result = await removeShell("/opt/homebrew/bin/nu");
    expect(result).toEqual({ removed: true, path: "/bin/bash" });
    const cfg = await readCliConfig();
    expect(cfg.shell.entries).toEqual([]);
    expect(cfg.shell.path).toBe("/bin/bash");
    await expectMirror();
  });

  it("removing a path that was never remembered is a no-op success", async () => {
    const result = await removeShell("/never/added");
    expect(result).toEqual({ removed: false, path: null });
  });

  it("reset clears only the selection and keeps every entry", async () => {
    await addShell("/opt/homebrew/bin/nu"); // entry nu, selected nu
    await setShell("/bin/bash", ["-l"]); // entry bash, selected bash
    await resetShell();
    await setEnvOverride("FOO", "bar");
    const cfg = await readCliConfig();
    // Nothing is forgotten by reset - both entries survive (nu has no deviation).
    expect(cfg.shell.entries).toEqual([
      { path: "/opt/homebrew/bin/nu", args: null },
      { path: "/bin/bash", args: ["-l"] },
    ]);
    expect(cfg.shell.path).toBeNull();
    expect(cfg.shell.args).toBeNull();
  });

  it("System default inherits the login shell's entry flags after reset", async () => {
    const defaultPath = defaultShellPath();
    // Explicitly select and customise the login shell, then reset.
    await setShell(defaultPath, ["-x"]);
    await resetShell();
    const cfg = await readCliConfig();
    expect(cfg.shell.path).toBeNull();
    expect(cfg.shell.args).toBeNull();
    expect(cfg.shell.entries).toEqual([{ path: defaultPath, args: ["-x"] }]);
    // Back on the system default, but resolution inherits the login shell entry.
    expect(await loadEffectiveShellConfig()).toEqual({
      path: defaultPath,
      args: ["-x"],
      synthesised: true,
    });
  });
});

describe("flag deviations - canonicalisation + revert", () => {
  function entryArgs(
    cfg: CliConfig,
    path: string,
  ): string[] | null | undefined {
    return cfg.shell.entries.find((e) => e.path === path)?.args;
  }

  it("stores null when a flag edit lands back on the family default", async () => {
    await setShell("/bin/zsh", null); // login shell, family default -i -l
    await setShell(null, ["-i"]); // deviate
    expect(entryArgs(await readCliConfig(), "/bin/zsh")).toEqual(["-i"]);
    await setShell(null, ["-i", "-l"]); // edit back to the family default
    expect(entryArgs(await readCliConfig(), "/bin/zsh")).toBeNull();
    // The entry itself survives - only ✕ deletes.
    expect(
      (await readCliConfig()).shell.entries.some((e) => e.path === "/bin/zsh"),
    ).toBe(true);
  });

  it("stores [] on a login shell (differs from its -i -l default)", async () => {
    await setShell("/bin/zsh", null);
    await setShell(null, []); // empty flags != zsh family default
    expect(entryArgs(await readCliConfig(), "/bin/zsh")).toEqual([]);
  });

  it("canonicalises [] to null on a non-login program (its default IS [])", async () => {
    await setShell("/bin/cat", null);
    await setShell(null, []); // empty flags == cat family default
    expect(entryArgs(await readCliConfig(), "/bin/cat")).toBeNull();
  });

  it("reverts a detected-customised shell to its family default, keeping the entry", async () => {
    await setShell("/bin/zsh", null);
    await setShell(null, ["-i"]);
    const result = await revertShellArgs("/bin/zsh");
    expect(result).toEqual({ path: "/bin/zsh", reverted: true });
    const cfg = await readCliConfig();
    expect(entryArgs(cfg, "/bin/zsh")).toBeNull(); // deviation cleared
    expect(cfg.shell.args).toEqual(["-i", "-l"]); // mirror re-materialised
  });

  it("reverts an added shell's flags but keeps it in the list", async () => {
    await addShell("/opt/homebrew/bin/nu");
    await setShell(null, ["-x"]); // deviate the selected added shell
    await revertShellArgs("/opt/homebrew/bin/nu");
    const cfg = await readCliConfig();
    // Entry stays (still listable), deviation gone, mirror back to [].
    expect(cfg.shell.entries).toEqual([
      { path: "/opt/homebrew/bin/nu", args: null },
    ]);
    expect(cfg.shell.args).toEqual([]);
  });

  it("is a no-op when reverting a shell with no entry", async () => {
    const result = await revertShellArgs("/never/added");
    expect(result).toEqual({ path: "/never/added", reverted: false });
    expect((await readCliConfig()).shell.entries).toEqual([]);
  });

  it("keeps the System default checked when reverting the login shell on auto", async () => {
    const defaultPath = defaultShellPath();
    await setShell(null, ["-x"]); // configure login shell flags while synthesised
    await revertShellArgs(defaultPath);
    const cfg = await readCliConfig();
    expect(cfg.shell.path).toBeNull();
    expect(cfg.shell.args).toBeNull(); // still pure system default
    expect(entryArgs(cfg, defaultPath)).toBeNull();
    expect(await loadEffectiveShellConfig()).toEqual({
      path: defaultPath,
      args: defaultShellArgs(defaultPath),
      synthesised: true,
    });
  });
});

describe("legacy (pre-entries) shell resolution", () => {
  function writeLegacy(path: string, args: readonly string[]): Promise<void> {
    return writeRaw(
      JSON.stringify({ version: 1, shell: { path, args }, envOverrides: {} }),
    );
  }

  it("resolves legacy customised args via the middle rung (no entry yet)", async () => {
    await writeLegacy("/bin/bash", ["-i"]);
    expect(await loadEffectiveShellConfig()).toEqual({
      path: "/bin/bash",
      args: ["-i"],
      synthesised: false,
    });
  });

  it("first write seeds an entry from legacy args before mutating", async () => {
    await writeLegacy("/bin/bash", ["-i"]); // custom, differs from -i -l
    // Switch away: without seeding the customisation would be lost.
    await setShell("/bin/cat", null);
    const cfg = await readCliConfig();
    expect(cfg.shell.entries).toContainEqual({
      path: "/bin/bash",
      args: ["-i"],
    });
    // Returning to bash restores the seeded flags rather than the family default.
    await setShell("/bin/bash", null);
    expect((await readCliConfig()).shell.args).toEqual(["-i"]);
  });

  it("does not seed a legacy file whose args already equal the family default", async () => {
    await writeLegacy("/bin/bash", ["-i", "-l"]); // == familyDefault(bash)
    await setShell("/bin/cat", null);
    expect((await readCliConfig()).shell.entries).toEqual([]);
  });
});

// POSIX-only: on win32 `defaultShellPath` takes the COMSPEC branch and never
// consults passwd, so these assertions are meaningless there.
describe.skipIf(process.platform === "win32")(
  "defaultShellPath - POSIX",
  () => {
    const originalShell = process.env.SHELL;
    afterEach(() => {
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
    });

    it("prefers the passwd login shell over a leaked $SHELL", () => {
      h.passwdShell = "/usr/bin/fish";
      process.env.SHELL = "/bin/bash";
      expect(defaultShellPath()).toBe("/usr/bin/fish");
    });

    it("falls back to $SHELL when there is no passwd entry", () => {
      h.passwdThrows = true;
      process.env.SHELL = "/bin/bash";
      expect(defaultShellPath()).toBe("/bin/bash");
    });

    it("falls back to $SHELL when the passwd shell field is empty", () => {
      h.passwdShell = "";
      process.env.SHELL = "/bin/bash";
      expect(defaultShellPath()).toBe("/bin/bash");
    });

    it("falls back to the platform default when passwd and $SHELL are both absent", () => {
      h.passwdThrows = true;
      delete process.env.SHELL;
      expect(defaultShellPath()).toBe(
        process.platform === "darwin" ? "/bin/zsh" : "/bin/bash",
      );
    });
  },
);

describe("migrateCliConfig", () => {
  it("passes a current-version config through unchanged", () => {
    const current = {
      version: CLI_CONFIG_VERSION,
      shell: { path: null, args: null },
      envOverrides: {},
    };
    expect(migrateCliConfig(current)).toEqual(current);
  });

  it("passes non-object inputs through so the schema reports the error", () => {
    expect(migrateCliConfig(42)).toBe(42);
    expect(migrateCliConfig(null)).toBe(null);
    expect(migrateCliConfig(["x"])).toEqual(["x"]);
  });
});
