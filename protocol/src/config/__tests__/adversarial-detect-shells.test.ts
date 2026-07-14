import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Virtual filesystem + platform, mirroring the sibling detect-shells.test.ts,
// with two extra hostile seams: realpath can be made to throw a chosen errno
// (symlink loops / files disappearing after a successful probe), and access
// can be made to throw on a specific path (permission errors mid-scan).
const world = vi.hoisted(() => ({
  platform: "linux" as NodeJS.Platform,
  files: new Map<string, boolean>(),
  realpaths: new Map<string, string>(),
  realpathThrows: new Map<string, NodeJS.ErrnoException>(),
  accessThrowsHard: new Map<string, Error>(),
  etcShells: null as string | null,
  configJson: null as string | null,
}));

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return {
    ...actual,
    platform: () => world.platform,
    userInfo: () => {
      throw new Error("no passwd entry in detection test");
    },
  };
});

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (path: string) => {
      if (!world.files.has(path)) throw errno("ENOENT");
      return { isFile: () => true };
    },
    access: async (path: string, mode: number) => {
      const hard = world.accessThrowsHard.get(path);
      if (hard !== undefined) throw hard;
      const executable = world.files.get(path);
      if (executable === undefined) throw errno("ENOENT");
      if ((mode & 1) !== 0 && !executable) throw errno("EACCES");
    },
    realpath: async (path: string) => {
      const thrown = world.realpathThrows.get(path);
      if (thrown !== undefined) throw thrown;
      if (!world.files.has(path)) throw errno("ENOENT");
      return world.realpaths.get(path) ?? path;
    },
    readFile: async (path: string) => {
      if (path === "/etc/shells") {
        if (world.etcShells === null) throw errno("ENOENT");
        return world.etcShells;
      }
      if (world.configJson === null) throw errno("ENOENT");
      return world.configJson;
    },
  };
});

import { detectShells, listShells } from "../store";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  world.platform = "linux";
  world.files = new Map();
  world.realpaths = new Map();
  world.realpathThrows = new Map();
  world.accessThrowsHard = new Map();
  world.etcShells = null;
  world.configJson = null;
  for (const key of Object.keys(process.env)) delete process.env[key];
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("adversarial: detectShells never throws under hostile filesystems", () => {
  it("survives a realpath ELOOP (symlink loop) on a candidate", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    world.files.set("/bin/zsh", true);
    world.files.set("/usr/bin/bash", true);
    // A symlink loop: realpath explodes with ELOOP. resolveRealPath must swallow
    // it and fall back to the literal path rather than propagating.
    world.realpathThrows.set("/usr/bin/bash", errno("ELOOP"));

    const detected = await detectShells();
    expect(detected.map((s) => s.path)).toContain("/bin/zsh");
    expect(detected.map((s) => s.path)).toContain("/usr/bin/bash");
    expect(detected[0]?.isDefault).toBe(true);
  });

  it("survives realpath ENOENT after a successful regular-file probe", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    world.files.set("/bin/zsh", true);
    world.files.set("/usr/bin/fish", true);
    world.realpathThrows.set("/usr/bin/fish", errno("ENOENT"));

    const detected = await detectShells();
    expect(detected.map((s) => s.path)).toContain("/usr/bin/fish");
  });

  it("survives a hard access() failure (EPERM) on a probe path", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    world.files.set("/bin/zsh", true);
    // /usr/bin/bash access throws a non-ENOENT/EACCES error mid-scan.
    world.accessThrowsHard.set("/usr/bin/bash", errno("EPERM"));

    const detected = await detectShells();
    // Does not throw, default still offered.
    expect(detected.map((s) => s.path)).toContain("/bin/zsh");
  });

  it("survives a huge PATH with empty and duplicate segments", async () => {
    process.env.SHELL = "/bin/zsh";
    const dirs = [""];
    for (let i = 0; i < 1000; i++) dirs.push(`/opt/d${i}`, "", "/usr/bin");
    process.env.PATH = dirs.join(":");
    world.files.set("/bin/zsh", true);
    world.files.set("/usr/bin/bash", true);

    const detected = await detectShells();
    expect(detected.map((s) => s.path)).toContain("/usr/bin/bash");
    // The default appears exactly once despite /usr/bin repeating in PATH.
    expect(detected.filter((s) => s.path === "/bin/zsh")).toHaveLength(1);
  });

  it("offers the bare default even when nothing on disk is executable", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin:/bin";
    // No files exist; /etc/shells unreadable; realpath of the default throws.
    world.realpathThrows.set("/bin/zsh", errno("ENOENT"));
    const detected = await detectShells();
    expect(detected.map((s) => s.path)).toEqual(["/bin/zsh"]);
    expect(detected[0]?.isDefault).toBe(true);
  });
});

describe("adversarial: listShells dedupe against hostile config entries", () => {
  function writeConfig(
    entries: { path: string; args: string[] | null }[],
  ): void {
    world.configJson = JSON.stringify({
      version: 1,
      shell: { path: null, args: null, entries },
      envOverrides: {},
      logs: { cliLogLevel: "info", hostLogLevel: "info" },
    });
  }

  it("FINDING: duplicate entry paths in the config yield duplicate 'added' rows", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    world.files.set("/bin/zsh", true);
    // Two identical remembered entries for the same non-detected path. The
    // store's own writes can never produce this (upsert dedupes), but a
    // hand-edited config.json can - the schema accepts it. The contract for
    // listShells says the merged list is deduped; here it is not deduped
    // against itself, so the picker would show two identical removable rows.
    writeConfig([
      { path: "/opt/custom/mysh", args: null },
      { path: "/opt/custom/mysh", args: null },
    ]);

    const list = await listShells();
    const rows = list.filter((s) => s.path === "/opt/custom/mysh");
    // Contract expectation would be exactly one row. The implementation returns
    // two because entryRows are not deduped among themselves.
    expect(rows).toHaveLength(1);
  });

  it("FINDING (win32): case-variant duplicate entries both survive as rows", async () => {
    world.platform = "win32";
    process.env.SystemRoot = "C:\\Windows";
    process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe";
    world.files.set("C:\\Windows\\System32\\cmd.exe", true);
    // Same physical file, two spellings. On win32 the FS is case-insensitive, so
    // these name one program; the contract dedupes case-insensitively on win32.
    writeConfig([
      { path: "C:\\Tools\\MyShell.exe", args: null },
      { path: "c:\\tools\\myshell.exe", args: null },
    ]);

    const list = await listShells();
    const rows = list.filter(
      (s) => s.path.toLowerCase() === "c:\\tools\\myshell.exe",
    );
    expect(rows).toHaveLength(1);
  });
});
