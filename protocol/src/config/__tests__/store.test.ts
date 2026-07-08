import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Redirect `~/.traycer/cli/config.json` to a per-test temp home by mocking
// `os.homedir()` (paths.ts derives the config path from it). `os.platform()`
// stays real so the OS-default shell logic is exercised honestly.
const h = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => h.home };
});

import { cliConfigPath } from "../paths";
import { EMPTY_CLI_CONFIG } from "../schema";
import {
  applyEnvOverrides,
  defaultShellArgs,
  defaultShellPath,
  listEnvOverrides,
  loadEffectiveShellConfig,
  migrateCliConfig,
  readCliConfig,
  readLogLevels,
  readLogLevelsSync,
  setEnvOverride,
  setLogLevels,
  setShell,
  writeCliConfig,
} from "../store";
import { CLI_CONFIG_VERSION } from "../schema";

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-cli-config-"));
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
      shell: { path: "/bin/fish", args: ["-l"] },
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
      shell: { path: "/bin/zsh", args: null },
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
