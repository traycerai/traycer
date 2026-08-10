import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

type PruneModule = typeof import("../crash-dump-prune");

const CRASH_DUMPS_ROOT = "/tmp/traycer-test-crash-dumps";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("electron");
  vi.doUnmock("../logger");
});

describe("selectCrashDumpsToPrune", () => {
  it("returns nothing when at or under the retention cap", async () => {
    const { prune } = await loadPrune({ files: [], readdirFails: false });
    const files = [
      { path: "/dumps/a.dmp", mtimeMs: 3 },
      { path: "/dumps/b.dmp", mtimeMs: 2 },
      { path: "/dumps/c.dmp", mtimeMs: 1 },
    ];

    expect(prune.selectCrashDumpsToPrune(files, 3)).toEqual([]);
    expect(prune.selectCrashDumpsToPrune([], 3)).toEqual([]);
  });

  it("keeps the newest maxRetained files and returns the older remainder", async () => {
    const { prune } = await loadPrune({ files: [], readdirFails: false });
    const files = [
      { path: "/dumps/oldest.dmp", mtimeMs: 1 },
      { path: "/dumps/newest.dmp", mtimeMs: 4 },
      { path: "/dumps/older.dmp", mtimeMs: 2 },
      { path: "/dumps/newer.dmp", mtimeMs: 3 },
    ];

    expect(prune.selectCrashDumpsToPrune(files, 2)).toEqual([
      "/dumps/older.dmp",
      "/dumps/oldest.dmp",
    ]);
  });

  it("does not mutate the input ordering", async () => {
    const { prune } = await loadPrune({ files: [], readdirFails: false });
    const files = [
      { path: "/dumps/a.dmp", mtimeMs: 1 },
      { path: "/dumps/b.dmp", mtimeMs: 2 },
    ];

    prune.selectCrashDumpsToPrune(files, 1);

    expect(files.map((file) => file.path)).toEqual([
      "/dumps/a.dmp",
      "/dumps/b.dmp",
    ]);
  });
});

describe("pruneStaleCrashDumps", () => {
  it("unlinks only the oldest dumps beyond the cap, ignoring non-dump files", async () => {
    const dumpFiles = Array.from({ length: 12 }, (_, index) => ({
      name: `report-${index}.dmp`,
      dir: join(CRASH_DUMPS_ROOT, "completed"),
      // index 0 is the oldest, index 11 the newest.
      mtimeMs: 1_000 + index,
      isFile: true,
    }));
    const { prune, unlinkMock } = await loadPrune({
      files: [
        ...dumpFiles,
        {
          name: "settings.dat",
          dir: CRASH_DUMPS_ROOT,
          mtimeMs: 1,
          isFile: true,
        },
        { name: "completed", dir: CRASH_DUMPS_ROOT, mtimeMs: 1, isFile: false },
      ],
      readdirFails: false,
    });

    await prune.pruneStaleCrashDumps();

    expect(unlinkMock.mock.calls.map((call) => call[0]).sort()).toEqual([
      join(CRASH_DUMPS_ROOT, "completed", "report-0.dmp"),
      join(CRASH_DUMPS_ROOT, "completed", "report-1.dmp"),
    ]);
  });

  it("does nothing when the dump count is within the cap", async () => {
    const { prune, unlinkMock } = await loadPrune({
      files: Array.from({ length: 10 }, (_, index) => ({
        name: `report-${index}.dmp`,
        dir: CRASH_DUMPS_ROOT,
        mtimeMs: 1_000 + index,
        isFile: true,
      })),
      readdirFails: false,
    });

    await prune.pruneStaleCrashDumps();

    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("resolves quietly when the crash-dumps directory does not exist yet", async () => {
    const { prune, unlinkMock } = await loadPrune({
      files: [],
      readdirFails: true,
    });

    await expect(prune.pruneStaleCrashDumps()).resolves.toBeUndefined();
    expect(unlinkMock).not.toHaveBeenCalled();
  });
});

interface FakeDumpEntry {
  readonly name: string;
  readonly dir: string;
  readonly mtimeMs: number;
  readonly isFile: boolean;
}

async function loadPrune(opts: {
  readonly files: readonly FakeDumpEntry[];
  readonly readdirFails: boolean;
}): Promise<{
  readonly prune: PruneModule;
  readonly unlinkMock: Mock;
}> {
  vi.resetModules();

  const unlinkMock: Mock = vi.fn(() => Promise.resolve());
  const fsPromises = {
    readdir: vi.fn(() =>
      opts.readdirFails
        ? Promise.reject(new Error("ENOENT: no such file or directory"))
        : Promise.resolve(
            opts.files.map((file) => ({
              name: file.name,
              parentPath: file.dir,
              isFile: () => file.isFile,
            })),
          ),
    ),
    stat: vi.fn((path: string) => {
      const match = opts.files.find(
        (file) => join(file.dir, file.name) === path,
      );
      return match === undefined
        ? Promise.reject(new Error(`unexpected stat: ${path}`))
        : Promise.resolve({ mtimeMs: match.mtimeMs });
    }),
    unlink: unlinkMock,
  };
  vi.doMock("node:fs/promises", () => ({ ...fsPromises, default: fsPromises }));

  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => CRASH_DUMPS_ROOT) },
  }));
  vi.doMock("../logger", () => ({
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  return {
    prune: await import("../crash-dump-prune"),
    unlinkMock,
  };
}
