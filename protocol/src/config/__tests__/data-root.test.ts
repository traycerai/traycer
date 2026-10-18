import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DATA_BOOTSTRAP_DIRNAME,
  DATA_LOCATION_RECORD_FILENAME,
  DataRootError,
  currentDataRootResolution,
  dataRootPathsOverlap,
  resolveDataRoot,
  traycerDataRoot,
  validateDataRootSelection,
  type DataRootErrorCode,
} from "../data-root";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixtureDir(): Promise<string> {
  // macOS tmpdir sits behind a /var symlink; compare against real paths.
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "traycer-data-root-test-")),
  );
  dirs.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function recordPathOf(home: string): string {
  return join(home, DATA_BOOTSTRAP_DIRNAME, DATA_LOCATION_RECORD_FILENAME);
}

async function writeRecord(
  home: string,
  record: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(home, DATA_BOOTSTRAP_DIRNAME), { recursive: true });
  await writeFile(recordPathOf(home), JSON.stringify(record), "utf8");
}

function validRecord(root: string): Record<string, unknown> {
  return { version: 1, generation: 1, root, migrationId: null };
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

function expectDataRootError(
  run: () => unknown,
  code: DataRootErrorCode,
  forbiddenInMessage: readonly string[],
): DataRootError {
  const error = captureError(run);
  if (!(error instanceof DataRootError)) {
    throw new Error("expected a DataRootError");
  }
  expect(error.code).toBe(code);
  for (const text of forbiddenInMessage) {
    expect(error.message).not.toContain(text);
  }
  return error;
}

describe.skipIf(process.platform === "win32")("resolveDataRoot", () => {
  it("returns the default root and creates nothing when no record exists", async () => {
    const home = await fixtureDir();
    const resolution = resolveDataRoot(home, "posix");
    expect(resolution.kind).toBe("default");
    expect(resolution.root).toBe(join(home, ".traycer"));
    expect(resolution.bootstrapDir).toBe(join(home, DATA_BOOTSTRAP_DIRNAME));
    expect(await exists(join(home, DATA_BOOTSTRAP_DIRNAME))).toBe(false);
    expect(await exists(join(home, ".traycer"))).toBe(false);
  });

  it("returns the configured root for a valid record, with spaces and Unicode", async () => {
    const home = await fixtureDir();
    const root = join(home, "Traycer Data ✓ データ");
    await mkdir(root);
    const record = validRecord(root);
    await writeRecord(home, record);
    const resolution = resolveDataRoot(home, "posix");
    if (resolution.kind !== "configured") {
      throw new Error("expected a configured resolution");
    }
    expect(resolution.root).toBe(root);
    expect(resolution.record).toEqual(record);
    expect(await exists(join(home, ".traycer"))).toBe(false);
  });

  it("carries a migration id through the record", async () => {
    const home = await fixtureDir();
    const root = join(home, "data");
    await mkdir(root);
    await writeRecord(home, {
      version: 1,
      generation: 3,
      root,
      migrationId: "mig-1",
    });
    const resolution = resolveDataRoot(home, "posix");
    if (resolution.kind !== "configured") {
      throw new Error("expected a configured resolution");
    }
    expect(resolution.record.generation).toBe(3);
    expect(resolution.record.migrationId).toBe("mig-1");
  });

  it("ignores TRAYCER_DATA_DIR at runtime", async () => {
    const home = await fixtureDir();
    const stale = await fixtureDir();
    const previous = process.env.TRAYCER_DATA_DIR;
    process.env.TRAYCER_DATA_DIR = stale;
    try {
      expect(resolveDataRoot(home, "posix").root).toBe(join(home, ".traycer"));
      const root = join(home, "configured");
      await mkdir(root);
      await writeRecord(home, validRecord(root));
      expect(resolveDataRoot(home, "posix").root).toBe(root);
    } finally {
      if (previous === undefined) delete process.env.TRAYCER_DATA_DIR;
      else process.env.TRAYCER_DATA_DIR = previous;
    }
  });

  it("fails with record-unreadable when the record cannot be read", async () => {
    const home = await fixtureDir();
    // A directory in place of the file reads as EISDIR, not ENOENT.
    await mkdir(recordPathOf(home), { recursive: true });
    expectDataRootError(
      () => resolveDataRoot(home, "posix"),
      "record-unreadable",
      [home],
    );
    expect(await exists(join(home, ".traycer"))).toBe(false);
  });

  it("fails with record-malformed on invalid JSON", async () => {
    const home = await fixtureDir();
    await mkdir(join(home, DATA_BOOTSTRAP_DIRNAME));
    await writeFile(recordPathOf(home), "{not json", "utf8");
    expectDataRootError(
      () => resolveDataRoot(home, "posix"),
      "record-malformed",
      [home],
    );
    expect(await exists(join(home, ".traycer"))).toBe(false);
  });

  it.each([
    [
      "version 2",
      { version: 2, generation: 1, root: "/x/y", migrationId: null },
    ],
    [
      "generation 0",
      { version: 1, generation: 0, root: "/x/y", migrationId: null },
    ],
    [
      "an extra key",
      { version: 1, generation: 1, root: "/x/y", migrationId: null, extra: 1 },
    ],
    ["a missing migrationId", { version: 1, generation: 1, root: "/x/y" }],
    [
      "an empty root",
      { version: 1, generation: 1, root: "", migrationId: null },
    ],
  ])("fails with record-malformed for %s", async (_name, record) => {
    const home = await fixtureDir();
    await writeRecord(home, record);
    expectDataRootError(
      () => resolveDataRoot(home, "posix"),
      "record-malformed",
      [home],
    );
  });

  it("fails with root-invalid for a relative root", async () => {
    const home = await fixtureDir();
    await writeRecord(home, validRecord("relative/dir"));
    const error = expectDataRootError(
      () => resolveDataRoot(home, "posix"),
      "root-invalid",
      [home, "relative/dir"],
    );
    expect(error.root).toBe("relative/dir");
  });

  it.each([
    ["a trailing slash", (home: string) => `${join(home, "data")}/`],
    ["a non-normalized path", (home: string) => `${home}/a/../b`],
  ])("fails with root-invalid for %s", async (_name, rootFor) => {
    const home = await fixtureDir();
    const root = rootFor(home);
    await mkdir(join(home, "data"));
    await writeRecord(home, validRecord(root));
    expectDataRootError(() => resolveDataRoot(home, "posix"), "root-invalid", [
      home,
    ]);
  });

  it("fails with root-invalid when the root is the home directory", async () => {
    const home = await fixtureDir();
    await writeRecord(home, validRecord(home));
    expectDataRootError(() => resolveDataRoot(home, "posix"), "root-invalid", [
      home,
    ]);
  });

  it("fails with root-invalid when the root is inside the bootstrap directory", async () => {
    const home = await fixtureDir();
    const root = join(home, DATA_BOOTSTRAP_DIRNAME, "data");
    await mkdir(root, { recursive: true });
    await writeRecord(home, validRecord(root));
    expectDataRootError(() => resolveDataRoot(home, "posix"), "root-invalid", [
      home,
    ]);
  });

  it("fails with root-unavailable and creates nothing when the root does not exist", async () => {
    const home = await fixtureDir();
    const root = join(home, "missing-drive", "data");
    await writeRecord(home, validRecord(root));
    const error = expectDataRootError(
      () => resolveDataRoot(home, "posix"),
      "root-unavailable",
      [home, root],
    );
    expect(error.root).toBe(root);
    expect(await exists(root)).toBe(false);
    expect(await exists(join(home, "missing-drive"))).toBe(false);
    expect(await exists(join(home, ".traycer"))).toBe(false);
  });

  it("fails with root-unavailable when the root is a regular file", async () => {
    const home = await fixtureDir();
    const root = join(home, "a-file");
    await writeFile(root, "x", "utf8");
    await writeRecord(home, validRecord(root));
    expectDataRootError(
      () => resolveDataRoot(home, "posix"),
      "root-unavailable",
      [home, root],
    );
    expect(await exists(join(home, ".traycer"))).toBe(false);
  });
});

function withTempHome<T>(home: string, run: () => T): T {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return run();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  }
}

describe.skipIf(process.platform === "win32")(
  "resolveDataRoot refuses links and non-regular entries",
  () => {
    async function expectRefusedEverywhere(
      home: string,
      untouched: readonly string[],
    ): Promise<void> {
      expectDataRootError(
        () => resolveDataRoot(home, "posix"),
        "record-unreadable",
        [home],
      );
      // The process-wide resolver throws too, and caches no default.
      withTempHome(home, () => {
        expectDataRootError(
          () => currentDataRootResolution(),
          "record-unreadable",
          [home],
        );
        expectDataRootError(() => traycerDataRoot(), "record-unreadable", [
          home,
        ]);
      });
      expect(await exists(join(home, ".traycer"))).toBe(false);
      for (const path of untouched) expect(await exists(path)).toBe(false);
    }

    it("refuses a dangling location.json symlink", async () => {
      const home = await fixtureDir();
      await mkdir(join(home, DATA_BOOTSTRAP_DIRNAME));
      const target = join(home, "nowhere.json");
      await symlink(target, recordPathOf(home));
      await expectRefusedEverywhere(home, [target]);
    });

    it("refuses a dangling .traycer-bootstrap symlink", async () => {
      const home = await fixtureDir();
      const target = join(home, "missing-bootstrap");
      await symlink(target, join(home, DATA_BOOTSTRAP_DIRNAME));
      await expectRefusedEverywhere(home, [target]);
    });

    it("refuses a .traycer-bootstrap symlink even when it resolves to a valid record", async () => {
      const home = await fixtureDir();
      const root = join(home, "data");
      await mkdir(root);
      const real = join(home, "real-bootstrap");
      await mkdir(real);
      await writeFile(
        join(real, DATA_LOCATION_RECORD_FILENAME),
        JSON.stringify(validRecord(root)),
        "utf8",
      );
      await symlink(real, join(home, DATA_BOOTSTRAP_DIRNAME));
      await expectRefusedEverywhere(home, []);
    });

    it("refuses a location.json symlink even when it resolves to a valid record", async () => {
      const home = await fixtureDir();
      const root = join(home, "data");
      await mkdir(root);
      await mkdir(join(home, DATA_BOOTSTRAP_DIRNAME));
      const realRecord = join(home, DATA_BOOTSTRAP_DIRNAME, "real.json");
      await writeFile(realRecord, JSON.stringify(validRecord(root)), "utf8");
      await symlink(realRecord, recordPathOf(home));
      await expectRefusedEverywhere(home, []);
    });

    it("refuses a location.json that is a directory", async () => {
      const home = await fixtureDir();
      await mkdir(recordPathOf(home), { recursive: true });
      await expectRefusedEverywhere(home, []);
    });

    it("still selects the default for an empty .traycer-bootstrap directory", async () => {
      const home = await fixtureDir();
      await mkdir(join(home, DATA_BOOTSTRAP_DIRNAME));
      const resolution = resolveDataRoot(home, "posix");
      expect(resolution.kind).toBe("default");
      expect(resolution.root).toBe(join(home, ".traycer"));
      expect(await exists(join(home, ".traycer"))).toBe(false);
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "currentDataRootResolution / traycerDataRoot",
  () => {
    function withHome<T>(home: string, run: () => T): T {
      const previousHome = process.env.HOME;
      const previousProfile = process.env.USERPROFILE;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try {
        return run();
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousProfile;
      }
    }

    it("resolves the default root for a home without a record", async () => {
      const home = await fixtureDir();
      withHome(home, () => {
        const resolution = currentDataRootResolution();
        expect(resolution.kind).toBe("default");
        expect(traycerDataRoot()).toBe(join(home, ".traycer"));
      });
    });

    it("re-resolves for a different home and returns its configured root", async () => {
      const first = await fixtureDir();
      withHome(first, () => {
        expect(traycerDataRoot()).toBe(join(first, ".traycer"));
      });
      const second = await fixtureDir();
      const root = join(second, "Traycer Data");
      await mkdir(root);
      await writeRecord(second, validRecord(root));
      withHome(second, () => {
        expect(currentDataRootResolution().kind).toBe("configured");
        expect(traycerDataRoot()).toBe(root);
      });
    });

    it("resolves once per process: a record written later does not change the answer", async () => {
      const home = await fixtureDir();
      withHome(home, () => {
        expect(traycerDataRoot()).toBe(join(home, ".traycer"));
      });
      const root = join(home, "later");
      await mkdir(root);
      await writeRecord(home, validRecord(root));
      withHome(home, () => {
        expect(traycerDataRoot()).toBe(join(home, ".traycer"));
        expect(currentDataRootResolution().kind).toBe("default");
      });
    });

    it("does not cache an error", async () => {
      const home = await fixtureDir();
      await mkdir(join(home, DATA_BOOTSTRAP_DIRNAME));
      await writeFile(recordPathOf(home), "{broken", "utf8");
      withHome(home, () => {
        expectDataRootError(() => traycerDataRoot(), "record-malformed", [
          home,
        ]);
        expectDataRootError(() => traycerDataRoot(), "record-malformed", [
          home,
        ]);
      });
      const root = join(home, "fixed");
      await mkdir(root);
      await writeRecord(home, validRecord(root));
      withHome(home, () => {
        expect(traycerDataRoot()).toBe(root);
      });
    });
  },
);

describe("validateDataRootSelection (win32)", () => {
  it.each([
    ["D:\\TraycerData", "D:\\TraycerData"],
    ["d:/Traycer Data/ü", "D:\\Traycer Data\\ü"],
    ["D:\\TraycerData\\", "D:\\TraycerData"],
    ["D:/a/b/", "D:\\a\\b"],
    ["D:\\データ ✓", "D:\\データ ✓"],
  ])("accepts %s", (value, expected) => {
    expect(validateDataRootSelection(value, "win32")).toEqual({
      ok: true,
      root: expected,
    });
  });

  it.each([
    ["an empty value", ""],
    ["leading whitespace", " D:\\x"],
    ["trailing whitespace", "D:\\x "],
    ["a drive-relative path", "D:foo"],
    ["a drive-less rooted path", "\\foo"],
    ["a UNC path", "\\\\server\\share\\x"],
    ["a forward-slash UNC path", "//server/share"],
    ["the extended-length namespace", "\\\\?\\D:\\x"],
    ["the device namespace", "\\\\.\\D:\\x"],
    ["a drive root", "D:\\"],
    ["a device name segment", "D:\\a\\CON"],
    ["a device name with extension", "D:\\a\\nul.txt"],
    ["a trailing dot", "D:\\a."],
    ["a trailing space in a segment", "D:\\a \\b"],
    ["a reserved character", "D:\\a<b"],
    ["a control character", "D:\\x\u0001"],
    ["a relative path", "relative\\x"],
  ])("refuses %s", (_name, value) => {
    const check = validateDataRootSelection(value, "win32");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason.length).toBeGreaterThan(0);
  });
});

describe("validateDataRootSelection (posix)", () => {
  it("accepts an absolute path with spaces", () => {
    expect(validateDataRootSelection("/data/Traycer Data", "posix")).toEqual({
      ok: true,
      root: "/data/Traycer Data",
    });
  });

  it("strips a trailing separator", () => {
    expect(validateDataRootSelection("/data/x/", "posix")).toEqual({
      ok: true,
      root: "/data/x",
    });
  });

  it.each([
    ["a relative path", "relative/x"],
    ["the filesystem root", "/"],
    ["a double-slash path", "//x"],
    ["trailing whitespace", "/data/x "],
    ["an empty value", ""],
    ["a control character", "/data/\u0001x"],
  ])("refuses %s", (_name, value) => {
    expect(validateDataRootSelection(value, "posix").ok).toBe(false);
  });
});

describe("dataRootPathsOverlap", () => {
  it("is true for equal, ancestor and descendant paths", () => {
    expect(dataRootPathsOverlap("/a/b", "/a/b", "posix")).toBe(true);
    expect(dataRootPathsOverlap("/a", "/a/b", "posix")).toBe(true);
    expect(dataRootPathsOverlap("/a/b/c", "/a/b", "posix")).toBe(true);
  });

  it("is false for a sibling that shares a name prefix", () => {
    expect(dataRootPathsOverlap("/a/b", "/a/bc", "posix")).toBe(false);
    expect(dataRootPathsOverlap("/a/bc", "/a/b", "posix")).toBe(false);
  });

  it("compares POSIX paths case-sensitively", () => {
    expect(dataRootPathsOverlap("/a/B", "/a/b", "posix")).toBe(false);
  });

  it("compares win32 paths case-insensitively", () => {
    expect(dataRootPathsOverlap("D:\\X", "d:\\x\\y", "win32")).toBe(true);
    expect(dataRootPathsOverlap("D:\\X", "d:\\xy", "win32")).toBe(false);
  });
});
