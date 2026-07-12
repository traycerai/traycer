import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Detection is pure filesystem + env inspection, so the tests drive it against
// a virtual filesystem and a chosen platform rather than the host's real one.
// `os.platform()` is mocked so win32 detection can be exercised from a POSIX
// runner; `fs/promises` access/realpath/readFile are mocked to a controllable
// world. Everything else in the module (real file writes, etc.) is untouched.
const world = vi.hoisted(() => ({
  platform: "linux" as NodeJS.Platform,
  // path -> executable? A missing entry means "not found".
  files: new Map<string, boolean>(),
  // path -> resolved real path (for dedupe); missing falls back to identity.
  realpaths: new Map<string, string>(),
  etcShells: null as string | null,
  configJson: null as string | null,
}));

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return {
    ...actual,
    platform: () => world.platform,
    // Neutralise the passwd lookup so the POSIX default shell is driven purely
    // by the `$SHELL` each test sets, independent of the host's real passwd
    // entry (which would otherwise leak into detection here).
    userInfo: () => {
      throw new Error("no passwd entry in detection test");
    },
  };
});

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: async (path: string, mode: number) => {
      const executable = world.files.get(path);
      if (executable === undefined) throw enoent();
      // X_OK is bit 1; F_OK is 0 (existence only).
      if ((mode & 1) !== 0 && !executable) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
    },
    realpath: async (path: string) => {
      if (!world.files.has(path)) throw enoent();
      return world.realpaths.get(path) ?? path;
    },
    readFile: async (path: string) => {
      if (path === "/etc/shells") {
        if (world.etcShells === null) throw enoent();
        return world.etcShells;
      }
      if (world.configJson === null) throw enoent();
      return world.configJson;
    },
  };
});

import { detectShells, listShells, probeShellPath } from "../store";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  world.platform = "linux";
  world.files = new Map();
  world.realpaths = new Map();
  world.etcShells = null;
  world.configJson = null;
  // Start from a clean env so only what a test sets influences detection.
  for (const key of Object.keys(process.env)) delete process.env[key];
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

function names(shells: readonly { readonly name: string }[]): string[] {
  return shells.map((shell) => shell.name);
}

describe("detectShells - POSIX", () => {
  it("scans PATH directories for known shell names", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/opt/homebrew/bin:/usr/bin";
    world.files.set("/bin/zsh", true);
    world.files.set("/opt/homebrew/bin/fish", true);
    world.files.set("/opt/homebrew/bin/nu", true);
    world.files.set("/usr/bin/bash", true);

    const detected = await detectShells();
    const paths = detected.map((shell) => shell.path);
    expect(paths).toContain("/opt/homebrew/bin/fish");
    expect(paths).toContain("/opt/homebrew/bin/nu");
    expect(paths).toContain("/usr/bin/bash");
    expect(detected.every((shell) => shell.source === "detected")).toBe(true);
    // Default first, and it is marked.
    expect(detected[0]?.path).toBe("/bin/zsh");
    expect(detected[0]?.isDefault).toBe(true);
  });

  it("collapses paths that resolve to the same real file, preferring the default", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    world.files.set("/bin/zsh", true);
    world.files.set("/usr/bin/zsh", true);
    // usr-merged: both are the same file.
    world.realpaths.set("/bin/zsh", "/usr/bin/zsh");
    world.realpaths.set("/usr/bin/zsh", "/usr/bin/zsh");

    const detected = await detectShells();
    const zshEntries = detected.filter((shell) => shell.name === "zsh");
    expect(zshEntries).toHaveLength(1);
    expect(zshEntries[0]?.path).toBe("/bin/zsh");
    expect(zshEntries[0]?.isDefault).toBe(true);
  });

  it("never throws when /etc/shells and probes fail; still offers the default", async () => {
    process.env.SHELL = "/bin/zsh";
    // No files exist and /etc/shells is unreadable.
    const detected = await detectShells();
    expect(detected.map((shell) => shell.path)).toEqual(["/bin/zsh"]);
    expect(detected[0]?.isDefault).toBe(true);
  });
});

describe("detectShells - Windows (simulated)", () => {
  beforeEach(() => {
    world.platform = "win32";
    process.env.SystemRoot = "C:\\Windows";
    process.env.ProgramFiles = "C:\\Program Files";
    process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe";
  });

  it("finds env-var-built well-known shells with friendly names", async () => {
    world.files.set("C:\\Windows\\System32\\cmd.exe", true);
    world.files.set("C:\\Windows\\System32\\wsl.exe", true);
    world.files.set("C:\\Program Files\\Git\\bin\\bash.exe", true);
    world.files.set("C:\\Program Files\\PowerShell\\7\\pwsh.exe", true);

    const detected = await detectShells();
    expect(names(detected)).toContain("WSL");
    expect(names(detected)).toContain("Git Bash");
    expect(names(detected)).toContain("pwsh.exe");
    // Default (cmd.exe) is present and marked.
    const cmd = detected.find((shell) => shell.path === process.env.COMSPEC);
    expect(cmd?.isDefault).toBe(true);
  });

  it("scans PATH with the win32 delimiter", async () => {
    process.env.PATH = "C:\\tools;C:\\scoop\\shims";
    world.files.set("C:\\Windows\\System32\\cmd.exe", true);
    world.files.set("C:\\scoop\\shims\\nu.exe", true);

    const detected = await detectShells();
    expect(detected.map((shell) => shell.path)).toContain(
      "C:\\scoop\\shims\\nu.exe",
    );
  });

  it("labels a Git-install bash as Git Bash but a plain bash.exe by basename", async () => {
    process.env.PATH = "C:\\msys\\bin";
    world.files.set("C:\\Windows\\System32\\cmd.exe", true);
    world.files.set("C:\\msys\\bin\\bash.exe", true);

    const detected = await detectShells();
    const plainBash = detected.find(
      (shell) => shell.path === "C:\\msys\\bin\\bash.exe",
    );
    expect(plainBash?.name).toBe("bash.exe");
  });
});

describe("listShells - merged list", () => {
  function writeConfig(added: readonly string[]): void {
    world.configJson = JSON.stringify({
      version: 1,
      shell: { path: null, args: null, added },
      envOverrides: {},
      logs: { cliLogLevel: "info", hostLogLevel: "info" },
    });
  }

  it("unions detected with added, tagging each source", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    world.files.set("/bin/zsh", true);
    world.files.set("/usr/bin/bash", true);
    writeConfig(["/opt/custom/myshell"]);

    const list = await listShells();
    const added = list.find((shell) => shell.path === "/opt/custom/myshell");
    expect(added).toEqual({
      name: "myshell",
      path: "/opt/custom/myshell",
      isDefault: false,
      source: "added",
    });
    // Added entries are listed even though the file does not exist.
    expect(
      list.filter((shell) => shell.source === "detected").length,
    ).toBeGreaterThan(0);
    // Default still sorts first.
    expect(list[0]?.path).toBe("/bin/zsh");
  });

  it("does not duplicate an added path that is also detected; it stays detected", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    world.files.set("/bin/zsh", true);
    world.files.set("/usr/bin/bash", true);
    writeConfig(["/usr/bin/bash"]);

    const list = await listShells();
    const bashEntries = list.filter((shell) => shell.path === "/usr/bin/bash");
    expect(bashEntries).toHaveLength(1);
    expect(bashEntries[0]?.source).toBe("detected");
  });
});

describe("probeShellPath", () => {
  it("reports found + executable", async () => {
    world.files.set("/usr/local/bin/nu", true);
    expect(await probeShellPath("/usr/local/bin/nu")).toEqual({
      exists: true,
      executable: true,
    });
  });

  it("reports found but not executable", async () => {
    world.files.set("/etc/hosts", false);
    expect(await probeShellPath("/etc/hosts")).toEqual({
      exists: true,
      executable: false,
    });
  });

  it("reports not found", async () => {
    expect(await probeShellPath("/nope")).toEqual({
      exists: false,
      executable: false,
    });
  });
});
