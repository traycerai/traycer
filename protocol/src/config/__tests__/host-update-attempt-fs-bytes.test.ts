import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setBeforeRecordOpenHookForTest,
  __setRecordOpenPlatformForTest,
  readRegularFileBytesNoFollow,
  readRegularFileBytesNoFollowSync,
  type RegularFileBytesRead,
} from "../host-update-attempt-fs";

const execFileAsync = promisify(execFile);

interface BytesReaderVariant {
  readonly name: string;
  readonly read: (path: string) => Promise<RegularFileBytesRead>;
}

const variants: readonly BytesReaderVariant[] = [
  { name: "async", read: readRegularFileBytesNoFollow },
  { name: "sync", read: async (p) => readRegularFileBytesNoFollowSync(p) },
];

const isWindows = process.platform === "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const dirs: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "host-update-fs-bytes-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  __setBeforeRecordOpenHookForTest(null);
  __setRecordOpenPlatformForTest(null);
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.each(variants)("readRegularFileBytesNoFollow ($name)", ({ read }) => {
  it("returns the exact bytes of a regular file, including non-UTF-8 bytes", async () => {
    const path = join(await freshDir(), "record.bin");
    const bytes = Buffer.from([0xff, 0x00, 0xfe]);
    await writeFile(path, bytes);

    expect(await read(path)).toEqual({ kind: "bytes", bytes });
  });

  it("reports a missing path as absent", async () => {
    const path = join(await freshDir(), "missing.bin");

    expect(await read(path)).toEqual({ kind: "absent" });
  });

  it.skipIf(isWindows)(
    "does not follow a symlink to a regular file",
    async () => {
      const dir = await freshDir();
      const target = join(dir, "target.bin");
      const link = join(dir, "link.bin");
      await writeFile(target, Buffer.from([1, 2, 3]));
      await symlink(target, link);

      expect(await read(link)).toEqual({ kind: "not-regular" });
    },
  );

  it.skipIf(isWindows)(
    "reports a dangling symlink as not-regular, not absent",
    async () => {
      const dir = await freshDir();
      const link = join(dir, "dangling.bin");
      await symlink(join(dir, "nowhere.bin"), link);

      expect(await read(link)).toEqual({ kind: "not-regular" });
    },
  );

  it("reports a directory as not-regular", async () => {
    const path = join(await freshDir(), "a-directory");
    await mkdir(path);

    expect(await read(path)).toEqual({ kind: "not-regular" });
  });

  it.skipIf(isWindows)(
    "reports a FIFO as not-regular without blocking on it",
    async () => {
      const path = join(await freshDir(), "pipe.bin");
      await execFileAsync("mkfifo", [path]);

      expect(await read(path)).toEqual({ kind: "not-regular" });
    },
  );

  // `open` on a socket fails (ENXIO on Linux, an unnamed errno on macOS), so
  // only the classification after the failed open can report it. The name is
  // short because a socket path is capped near 104 bytes.
  it.skipIf(isWindows)("reports a Unix socket as not-regular", async () => {
    const path = join(await freshDir(), "s.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });

    try {
      expect(await read(path)).toEqual({ kind: "not-regular" });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it.skipIf(isWindows || isRoot)(
    "throws a failure other than absence as Node raised it",
    async () => {
      const path = join(await freshDir(), "locked.bin");
      await writeFile(path, Buffer.from([1]));
      await chmod(path, 0o000);

      await expect(read(path)).rejects.toMatchObject({ code: "EACCES" });
    },
  );

  describe.skipIf(isWindows)("without O_NOFOLLOW and O_NONBLOCK", () => {
    it("still returns the bytes of a regular file", async () => {
      __setRecordOpenPlatformForTest({ noFollow: 0, nonBlock: 0 });
      const path = join(await freshDir(), "record.bin");
      const bytes = Buffer.from([0xff, 0x00, 0xfe]);
      await writeFile(path, bytes);

      expect(await read(path)).toEqual({ kind: "bytes", bytes });
    });

    it("still refuses a symlink", async () => {
      __setRecordOpenPlatformForTest({ noFollow: 0, nonBlock: 0 });
      const dir = await freshDir();
      const target = join(dir, "target.bin");
      const link = join(dir, "link.bin");
      await writeFile(target, Buffer.from([1, 2, 3]));
      await symlink(target, link);

      expect(await read(link)).toEqual({ kind: "not-regular" });
    });
  });
});

// Without the descriptor flags the open follows a link, so only the checks
// around it can refuse one swapped in after the first lstat.
describe.skipIf(isWindows)("readRegularFileBytesNoFollow swap at open", () => {
  // The link names the same file, so the descriptor's identity matches the
  // first lstat: only the lstat after the open sees the link.
  it("refuses the same file moved aside and linked back in its place", async () => {
    __setRecordOpenPlatformForTest({ noFollow: 0, nonBlock: 0 });
    const dir = await freshDir();
    const path = join(dir, "record.bin");
    const moved = join(dir, "moved.bin");
    await writeFile(path, Buffer.from([1, 2, 3]));
    __setBeforeRecordOpenHookForTest(async () => {
      await rename(path, moved);
      await symlink(moved, path);
    });

    expect(await readRegularFileBytesNoFollow(path)).toEqual({
      kind: "not-regular",
    });
  });

  it("refuses a regular file replaced by a dangling symlink, not as absent", async () => {
    __setRecordOpenPlatformForTest({ noFollow: 0, nonBlock: 0 });
    const dir = await freshDir();
    const path = join(dir, "record.bin");
    await writeFile(path, Buffer.from([1, 2, 3]));
    __setBeforeRecordOpenHookForTest(async () => {
      await rm(path);
      await symlink(join(dir, "nowhere.bin"), path);
    });

    expect(await readRegularFileBytesNoFollow(path)).toEqual({
      kind: "not-regular",
    });
  });
});
