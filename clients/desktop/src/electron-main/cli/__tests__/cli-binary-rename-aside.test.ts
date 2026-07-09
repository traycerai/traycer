import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: (): string => "/fake/app/path" },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { renameCliBinaryAside, sweepAsideCliBinaries } from "../cli-discovery";

describe("rename-aside CLI binary install (Windows lock workaround)", () => {
  let dir: string;
  let stablePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cli-rename-aside-"));
    stablePath = join(dir, "traycer.exe");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("moves the existing binary to a timestamped .old sibling", async () => {
    await writeFile(stablePath, "old-binary-bytes");
    await renameCliBinaryAside(stablePath);
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^traycer\.exe\.old-\d+$/);
    expect(await readFile(join(dir, names[0]), "utf8")).toBe(
      "old-binary-bytes",
    );
  });

  it("treats a missing binary as a no-op (fresh install / self-heal)", async () => {
    await expect(renameCliBinaryAside(stablePath)).resolves.toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it("sweeps .old leftovers but never the live binary or unrelated files", async () => {
    await writeFile(stablePath, "live");
    await writeFile(`${stablePath}.old-111`, "stale1");
    await writeFile(`${stablePath}.old-222`, "stale2");
    await writeFile(join(dir, "unrelated.txt"), "keep");
    await sweepAsideCliBinaries(stablePath);
    expect((await readdir(dir)).sort()).toEqual([
      "traycer.exe",
      "unrelated.txt",
    ]);
  });

  it("sweep tolerates a missing directory", async () => {
    await expect(
      sweepAsideCliBinaries(join(dir, "nope", "traycer.exe")),
    ).resolves.toBeUndefined();
  });

  it("rename-aside then sweep leaves only the aside copy it just made", async () => {
    // Simulates the install sequence: sweep old trash, rename current aside,
    // copy new binary in. The fresh .old must survive its own install pass
    // (it may still be a running image); only PRIOR leftovers are swept.
    await writeFile(`${stablePath}.old-111`, "ancient");
    await writeFile(stablePath, "current");
    await sweepAsideCliBinaries(stablePath);
    await renameCliBinaryAside(stablePath);
    await writeFile(stablePath, "new");
    const names = (await readdir(dir)).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain("traycer.exe");
    expect(names.some((name) => /^traycer\.exe\.old-\d+$/.test(name))).toBe(
      true,
    );
    expect(names).not.toContain("traycer.exe.old-111");
  });
});
