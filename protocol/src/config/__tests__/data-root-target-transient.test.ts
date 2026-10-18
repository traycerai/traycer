import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A transient bootstrap entry (an admission entry, a lock file, an atomic-write
// temp) can disappear between `readdir` listing it and `lstat` / `chmod`
// reaching it. A real filesystem cannot be made to do that on demand, so the
// two calls are intercepted by NAME: the file still exists and is still
// listed, but the named call answers ENOENT. This file holds only that
// interception, so it cannot affect `data-root-target.test.ts`.
const vanishing = vi.hoisted(() => ({
  lstat: new Set<string>(),
  chmod: new Set<string>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  function enoent(path: string): Error {
    return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  }
  return {
    ...actual,
    lstat: (path: string) =>
      vanishing.lstat.has(basename(path))
        ? Promise.reject(enoent(path))
        : actual.lstat(path),
    chmod: (path: string, mode: number) =>
      vanishing.chmod.has(basename(path))
        ? Promise.reject(enoent(path))
        : actual.chmod(path, mode),
  };
});

import {
  ensurePrivateBootstrapDir,
  type DataRootTargetResult,
  type WindowsDataRootCommands,
} from "../data-root-target";

const UUID = "0b9f6d1e-5c34-4a8e-9f1d-2a7c3e8b4d10";

const posixCommands: WindowsDataRootCommands = {
  probeVolume: () => Promise.reject(new Error("not used on posix")),
  applyPrivateAcl: () => Promise.reject(new Error("not used on posix")),
  readAcl: () => Promise.reject(new Error("not used on posix")),
  securePrivateChildren: () => Promise.reject(new Error("not used on posix")),
};

const dirs: string[] = [];

afterEach(async () => {
  vanishing.lstat.clear();
  vanishing.chmod.clear();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function bootstrapWith(names: readonly string[]): Promise<string> {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "traycer-transient-")),
  );
  dirs.push(base);
  const dir = join(base, ".traycer-bootstrap");
  await mkdir(dir, { mode: 0o700 });
  for (const name of names) {
    await writeFile(join(dir, name), "{}", "utf8");
    await chmod(join(dir, name), 0o666);
  }
  return dir;
}

function ensure(dir: string): Promise<DataRootTargetResult> {
  return ensurePrivateBootstrapDir({
    bootstrapDir: dir,
    platform: "posix",
    commands: posixCommands,
  });
}

describe.skipIf(process.platform === "win32")(
  "ensurePrivateBootstrapDir POSIX transient disappearance",
  () => {
    it.each([`admission-${UUID}.json`, "admission.lock", `x.json.${UUID}.tmp`])(
      "tolerates %s vanishing between readdir and lstat",
      async (name) => {
        const dir = await bootstrapWith(["location.json", name]);
        vanishing.lstat.add(name);
        const result = await ensure(dir);
        expect(result).toMatchObject({ ok: true, root: dir });
      },
    );

    it.each([`admission-${UUID}.json`, "admission.lock", `x.json.${UUID}.tmp`])(
      "tolerates %s vanishing between lstat and chmod",
      async (name) => {
        const dir = await bootstrapWith(["location.json", name]);
        vanishing.chmod.add(name);
        const result = await ensure(dir);
        expect(result).toMatchObject({ ok: true, root: dir });
      },
    );

    it.each(["location.json", "migration.json", `migration-m-${UUID}.json`])(
      "refuses when the persistent record %s vanishes",
      async (name) => {
        const dir = await bootstrapWith([name]);
        vanishing.lstat.add(name);
        const result = await ensure(dir);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("unsupported-entry");
      },
    );

    it("still tightens the records that did not vanish", async () => {
      const dir = await bootstrapWith([
        "location.json",
        `admission-${UUID}.json`,
      ]);
      vanishing.lstat.add(`admission-${UUID}.json`);
      const result = await ensure(dir);
      expect(result.ok).toBe(true);
      vanishing.lstat.clear();
      const stats = await lstat(join(dir, "location.json"));
      expect(stats.mode & 0o077).toBe(0);
    });
  },
);
