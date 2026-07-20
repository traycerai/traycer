import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  home: "",
  platform: "win32" as NodeJS.Platform,
  renameCalls: 0,
  renameFailures: [] as string[],
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
    rename: async (source: string, target: string) => {
      h.renameCalls += 1;
      const code = h.renameFailures.shift();
      if (code !== undefined) {
        throw Object.assign(new Error(`${code}: simulated rename failure`), {
          code,
        });
      }
      await actual.rename(source, target);
    },
  };
});

import { cliConfigDir } from "../paths";
import { readCliConfig, setShell } from "../store";

const SHELL_PATH = "C:\\Windows\\System32\\wsl.exe";

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-config-rename-retry-"));
  h.platform = "win32";
  h.renameCalls = 0;
  h.renameFailures = [];
});

afterEach(async () => {
  await rm(h.home, { recursive: true, force: true });
});

describe("Windows config rename retry", () => {
  it("recovers from transient Windows rename failures", async () => {
    h.renameFailures = ["EPERM", "EBUSY", "EACCES"];

    await setShell(SHELL_PATH, []);

    expect(h.renameCalls).toBe(4);
    expect((await readCliConfig()).shell.path).toBe(SHELL_PATH);
    expect(await readdir(cliConfigDir())).toEqual(["config.json"]);
  });

  it("exhausts the bounded retry budget and removes the temp file", async () => {
    h.renameFailures = Array.from({ length: 6 }, () => "EPERM");

    await expect(setShell(SHELL_PATH, [])).rejects.toMatchObject({
      code: "EPERM",
    });

    expect(h.renameCalls).toBe(6);
    expect(await readdir(cliConfigDir())).toEqual([]);
  });

  it("does not retry a non-transient Windows failure", async () => {
    h.renameFailures = ["ENOENT"];

    await expect(setShell(SHELL_PATH, [])).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(h.renameCalls).toBe(1);
    expect(await readdir(cliConfigDir())).toEqual([]);
  });

  it("does not retry transient-looking errors outside Windows", async () => {
    h.platform = "linux";
    h.renameFailures = ["EPERM"];

    await expect(setShell(SHELL_PATH, [])).rejects.toMatchObject({
      code: "EPERM",
    });

    expect(h.renameCalls).toBe(1);
    expect(await readdir(cliConfigDir())).toEqual([]);
  });
});
