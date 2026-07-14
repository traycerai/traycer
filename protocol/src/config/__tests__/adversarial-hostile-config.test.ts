import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Same seams as store.test.ts: temp home for the config file, pinned passwd
// login shell so defaultShellPath() is deterministic. os.platform() stays real
// (non-win32 on the runner).
const h = vi.hoisted(() => ({ home: "", passwdShell: "/bin/zsh" }));
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => h.home,
    userInfo: (...args: Parameters<typeof actual.userInfo>) => {
      const base = actual.userInfo(...args);
      return { ...base, shell: h.passwdShell };
    },
  };
});

import { cliConfigPath } from "../paths";
import {
  loadEffectiveShellConfig,
  readCliConfig,
  removeShell,
  resetShell,
  revertShellArgs,
  setShell,
} from "../store";

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-hostile-config-"));
  h.passwdShell = "/bin/zsh";
});

async function writeRaw(value: unknown): Promise<void> {
  const target = cliConfigPath();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value), "utf8");
}

describe("adversarial: canonicalisation on untouched entries", () => {
  it("FINDING: a write that touches only the selection persists a non-canonical entry verbatim", async () => {
    // A hand-edited config with an entry whose args are DEEP-EQUAL to the family
    // default (which the store's own writes would have stored as null). The
    // contract's canonicalisation invariant is absolute: "no write may store
    // entry args deep-equal to familyDefault". resetShell IS a write.
    await writeRaw({
      version: 1,
      shell: {
        path: null,
        args: null,
        entries: [{ path: "/bin/zsh", args: ["-i", "-l"] }],
      },
      envOverrides: {},
    });
    await resetShell(); // touches selection only; copies entries verbatim.
    const entry = (await readCliConfig()).shell.entries.find(
      (e) => e.path === "/bin/zsh",
    );
    // Contract wants the redundant deviation canonicalised to null on any write.
    // Actual: only the touched entry is canonicalised, so this one survives.
    expect(entry?.args).toBeNull();
  });

  it("FINDING: reverting a DIFFERENT shell leaves a sibling non-canonical entry untouched", async () => {
    await writeRaw({
      version: 1,
      shell: {
        path: null,
        args: null,
        entries: [
          { path: "/bin/bash", args: ["-i", "-l"] }, // == familyDefault(bash)
          { path: "/opt/homebrew/bin/nu", args: ["-x"] },
        ],
      },
      envOverrides: {},
    });
    await revertShellArgs("/opt/homebrew/bin/nu"); // writes; bash entry untouched
    const bash = (await readCliConfig()).shell.entries.find(
      (e) => e.path === "/bin/bash",
    );
    expect(bash?.args).toBeNull();
  });
});

describe("adversarial: hostile config content is tolerated (no crash)", () => {
  it("accepts duplicate exact entries; removeShell purges ALL copies", async () => {
    await writeRaw({
      version: 1,
      shell: {
        path: null,
        args: null,
        entries: [
          { path: "/opt/x/sh", args: ["-a"] },
          { path: "/opt/x/sh", args: ["-b"] },
        ],
      },
      envOverrides: {},
    });
    // loadEffective resolves without throwing.
    await expect(loadEffectiveShellConfig()).resolves.toBeDefined();
    // removeShell filters by path, so BOTH duplicate rows are dropped in one call.
    const result = await removeShell("/opt/x/sh");
    expect(result.removed).toBe(true);
    expect((await readCliConfig()).shell.entries).toEqual([]);
  });

  it("accepts relative and empty entry paths without crashing", async () => {
    await writeRaw({
      version: 1,
      shell: {
        path: null,
        args: null,
        entries: [
          { path: "relative/sh", args: null },
          { path: "", args: [] },
        ],
      },
      envOverrides: {},
    });
    const cfg = await readCliConfig();
    expect(cfg.shell.entries).toHaveLength(2);
    await expect(loadEffectiveShellConfig()).resolves.toBeDefined();
  });

  it("strips unknown top-level and shell keys, keeping the known shape", async () => {
    await writeRaw({
      version: 1,
      shell: { path: "/bin/zsh", args: ["-i"], entries: [], bogus: 42 },
      envOverrides: {},
      surpriseKey: { nested: true },
    });
    const cfg = await readCliConfig();
    expect(cfg.shell.path).toBe("/bin/zsh");
    expect("surpriseKey" in cfg).toBe(false);
    expect("bogus" in cfg.shell).toBe(false);
  });

  it("survives a 1000-entry array", async () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      path: `/opt/shell-${i}`,
      args: i % 2 === 0 ? null : ["-x"],
    }));
    await writeRaw({
      version: 1,
      shell: { path: null, args: null, entries },
      envOverrides: {},
    });
    const cfg = await readCliConfig();
    expect(cfg.shell.entries).toHaveLength(1000);
  });
});

describe("adversarial: legacy seeding seams", () => {
  it("seeds an entry for a reordered-default legacy file (order-sensitive)", async () => {
    // ["-l","-i"] is NOT deep-equal to zsh's ["-i","-l"] default, so it is a
    // genuine deviation and must be seeded on the first mutation.
    await writeRaw({
      version: 1,
      shell: { path: "/bin/zsh", args: ["-l", "-i"], entries: [] },
      envOverrides: {},
    });
    await setShell("/bin/cat", null); // switch away; seeding must preserve zsh flags
    const cfg = await readCliConfig();
    expect(cfg.shell.entries).toContainEqual({ path: "/bin/zsh", args: ["-l", "-i"] });
  });

  it("does NOT seed when legacy args are deep-equal to the family default", async () => {
    await writeRaw({
      version: 1,
      shell: { path: "/bin/zsh", args: ["-i", "-l"], entries: [] },
      envOverrides: {},
    });
    await setShell("/bin/cat", null);
    expect((await readCliConfig()).shell.entries).toEqual([]);
  });

  it("handles path:null + args:non-null without crashing or seeding", async () => {
    await writeRaw({
      version: 1,
      shell: { path: null, args: ["-i", "-l"], entries: [] },
      envOverrides: {},
    });
    // Resolution: path falls back to the default, args come from the middle rung,
    // synthesised is false (args is non-null).
    expect(await loadEffectiveShellConfig()).toEqual({
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: false,
    });
    // A mutation must not crash and must not seed (path is null).
    await setShell("/bin/cat", null);
    expect((await readCliConfig()).shell.entries).toEqual([]);
  });

  it("prefers an already-present entry over the legacy mirror when both exist", async () => {
    await writeRaw({
      version: 1,
      shell: {
        path: "/bin/bash",
        args: ["-i"], // legacy mirror deviation
        entries: [{ path: "/bin/bash", args: ["-x"] }], // remembered deviation wins
      },
      envOverrides: {},
    });
    await setShell("/bin/cat", null); // triggers seeding logic
    const cfg = await readCliConfig();
    // The existing entry must be preserved; the legacy mirror must NOT overwrite it.
    expect(cfg.shell.entries).toContainEqual({ path: "/bin/bash", args: ["-x"] });
    expect(
      cfg.shell.entries.filter((e) => e.path === "/bin/bash"),
    ).toHaveLength(1);
  });

  it("is idempotent across repeated read/mutate cycles (no entry duplication)", async () => {
    await writeRaw({
      version: 1,
      shell: { path: "/bin/bash", args: ["-i"], entries: [] },
      envOverrides: {},
    });
    for (let i = 0; i < 5; i++) {
      await setShell("/bin/bash", null);
      const cfg = await readCliConfig();
      expect(
        cfg.shell.entries.filter((e) => e.path === "/bin/bash"),
      ).toHaveLength(1);
      expect(cfg.shell.args).toEqual(["-i"]);
    }
  });
});
