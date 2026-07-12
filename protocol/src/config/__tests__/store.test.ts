import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import { EMPTY_CLI_CONFIG } from "../schema";
import {
  addShell,
  applyEnvOverrides,
  defaultShellArgs,
  defaultShellPath,
  listEnvOverrides,
  loadEffectiveShellConfig,
  migrateCliConfig,
  readCliConfig,
  readLogLevels,
  readLogLevelsSync,
  removeShell,
  resetShell,
  setEnvOverride,
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

  it("round-trips a written config through the schema", async () => {
    const cfg = {
      version: 1 as const,
      shell: { path: "/bin/fish", args: ["-l"], added: [] },
      envOverrides: { FOO: "bar" },
      logs: { cliLogLevel: "info" as const, hostLogLevel: "info" as const },
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
      args: defaultShellArgs(),
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
      shell: { path: "/bin/zsh", args: null, added: [] },
      envOverrides: {},
      logs: { cliLogLevel: "info", hostLogLevel: "info" },
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

describe("added shells", () => {
  it("remembers an added shell and selects it", async () => {
    const result = await addShell("/opt/homebrew/bin/nu");
    expect(result).toEqual({
      path: "/opt/homebrew/bin/nu",
      added: ["/opt/homebrew/bin/nu"],
    });
    const cfg = await readCliConfig();
    expect(cfg.shell.path).toBe("/opt/homebrew/bin/nu");
    expect(cfg.shell.added).toEqual(["/opt/homebrew/bin/nu"]);
  });

  it("dedupes an already-added path while re-selecting it", async () => {
    await addShell("/opt/homebrew/bin/nu");
    await setShell("/bin/bash", null);
    await addShell("/opt/homebrew/bin/nu");
    const cfg = await readCliConfig();
    expect(cfg.shell.added).toEqual(["/opt/homebrew/bin/nu"]);
    expect(cfg.shell.path).toBe("/opt/homebrew/bin/nu");
  });

  it("preserves the added list across shell/reset/env writes", async () => {
    await addShell("/opt/homebrew/bin/nu");
    await setShell("/bin/bash", ["-l"]);
    await resetShell();
    await setEnvOverride("FOO", "bar");
    expect((await readCliConfig()).shell.added).toEqual([
      "/opt/homebrew/bin/nu",
    ]);
  });

  it("removing the selected added shell falls back to the OS default", async () => {
    await addShell("/opt/homebrew/bin/nu");
    const result = await removeShell("/opt/homebrew/bin/nu");
    expect(result).toEqual({ removed: true, path: null });
    const cfg = await readCliConfig();
    expect(cfg.shell.added).toEqual([]);
    expect(cfg.shell.path).toBeNull();
  });

  it("removing a non-selected added shell keeps the current selection", async () => {
    await addShell("/opt/homebrew/bin/nu");
    await setShell("/bin/bash", null);
    const result = await removeShell("/opt/homebrew/bin/nu");
    expect(result).toEqual({ removed: true, path: "/bin/bash" });
    expect((await readCliConfig()).shell.added).toEqual([]);
  });

  it("removing a path that was never added is a no-op success", async () => {
    const result = await removeShell("/never/added");
    expect(result).toEqual({ removed: false, path: null });
  });
});

// POSIX-only: on win32 `defaultShellPath` takes the COMSPEC branch and never
// consults passwd, so these assertions are meaningless there.
describe.skipIf(process.platform === "win32")("defaultShellPath - POSIX", () => {
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
});

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
