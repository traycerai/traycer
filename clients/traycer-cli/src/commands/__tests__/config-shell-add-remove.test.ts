import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Redirect `~/.traycer/cli/config.json` to a per-test temp home by mocking
// `os.homedir()` (the protocol config paths derive from it). Everything else
// (fs probes of real temp files) stays real, so the executable gate is
// exercised honestly.
const h = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => h.home };
});

import { buildConfigShellAddCommand } from "../config-shell-add";
import { buildConfigShellRemoveCommand } from "../config-shell-remove";
import { readCliConfig, setShell } from "../../store/config-store";
import { makeCtx } from "./hook-test-helpers";

// `fs.access(X_OK)` collapses to a plain existence check on Windows, so a
// non-executable fixture reads as executable there. Only the case that hinges on
// that distinction is skipped; the rest (path validation, remove semantics) is
// platform-independent and stays enabled everywhere.
const skipOnWindows = process.platform === "win32";

let workdir = "";

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-cli-shell-home-"));
  workdir = await mkdtemp(join(tmpdir(), "traycer-cli-shell-bin-"));
});

async function makeExecutable(name: string): Promise<string> {
  const path = join(workdir, name);
  await writeFile(path, "#!/bin/sh\n", "utf8");
  await chmod(path, 0o755);
  return path;
}

async function makeNonExecutable(name: string): Promise<string> {
  const path = join(workdir, name);
  await writeFile(path, "not a program", "utf8");
  await chmod(path, 0o644);
  return path;
}

describe("config shell add", () => {
  it("rejects a relative path", async () => {
    await expect(
      buildConfigShellAddCommand({ path: "relative/sh" })(makeCtx()),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID_VALUE" });
  });

  it("rejects a path that does not exist", async () => {
    await expect(
      buildConfigShellAddCommand({ path: join(workdir, "missing") })(makeCtx()),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID_VALUE" });
  });

  it.skipIf(skipOnWindows)(
    "rejects a path that exists but is not executable",
    async () => {
      const path = await makeNonExecutable("notexec");
      await expect(
        buildConfigShellAddCommand({ path })(makeCtx()),
      ).rejects.toMatchObject({ code: "E_CONFIG_INVALID_VALUE" });
    },
  );

  it("remembers and selects an executable path", async () => {
    const path = await makeExecutable("myshell");
    const result = await buildConfigShellAddCommand({ path })(makeCtx());
    // A freshly-added program runs its factory flags, so its entry has no
    // deviation (args canonicalised to null).
    expect(result.data).toEqual({ path, entries: [{ path, args: null }] });
    const cfg = await readCliConfig();
    expect(cfg.shell.path).toBe(path);
    expect(cfg.shell.entries).toEqual([{ path, args: null }]);
  });
});

describe("config shell remove", () => {
  it("drops an added shell and falls back to default when it was selected", async () => {
    const path = await makeExecutable("myshell");
    await buildConfigShellAddCommand({ path })(makeCtx());
    const result = await buildConfigShellRemoveCommand({ path })(makeCtx());
    expect(result.data).toEqual({ removed: true, path: null });
    const cfg = await readCliConfig();
    expect(cfg.shell.entries).toEqual([]);
    expect(cfg.shell.path).toBeNull();
  });

  it("keeps the current selection when removing a non-selected added shell", async () => {
    const path = await makeExecutable("myshell");
    await buildConfigShellAddCommand({ path })(makeCtx());
    await setShell("/bin/bash", null);
    const result = await buildConfigShellRemoveCommand({ path })(makeCtx());
    expect(result.data).toEqual({ removed: true, path: "/bin/bash" });
  });

  it("is a no-op success when the path was never added", async () => {
    const result = await buildConfigShellRemoveCommand({
      path: "/opt/never/added",
    })(makeCtx());
    expect(result.data).toEqual({ removed: false, path: null });
  });

  it("rejects a relative path", async () => {
    await expect(
      buildConfigShellRemoveCommand({ path: "relative/sh" })(makeCtx()),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID_VALUE" });
  });
});
