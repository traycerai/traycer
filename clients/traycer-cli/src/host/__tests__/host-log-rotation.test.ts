import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameFaults = vi.hoisted(() => {
  const codes: Array<string | null> = [];
  return { codes };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: PathLike, newPath: PathLike): Promise<void> => {
      const code = renameFaults.codes.shift();
      if (code !== undefined && code !== null) {
        throw Object.assign(new Error(`injected rename failure: ${code}`), {
          code,
        });
      }
      await actual.rename(oldPath, newPath);
    },
  };
});

// `hostLogPath` resolves under the real `homedir()`, so redirect both paths into
// a temp dir and let the rotation run against a real filesystem - the `rename` /
// `rm` sequencing is the whole behavior under test and a mocked fs would prove
// nothing about it.
let logDir = "";

vi.mock("../../store/paths", () => ({
  hostLogPath: () => join(logDir, "host.log"),
  hostLogBackupPath: () => join(logDir, "host.log.1"),
}));

// The start path skips rotation while a host is live (it holds an open append fd
// on the file). Default to "no host running"; the guard test overrides it.
let livePid: number | null = null;

vi.mock("../pid-metadata", () => ({
  readHostPidMetadata: async () =>
    livePid === null
      ? null
      : {
          pid: livePid,
          hostId: "host-1",
          version: "1.0.0",
          websocketUrl: "ws://127.0.0.1:7100/rpc",
          startedAt: new Date(0).toISOString(),
        },
}));

const { MAX_HOST_LOG_BYTES, rotateHostLogForPurge, rotateHostLogIfOversized } =
  await import("../host-log-rotation");

const LOG = () => join(logDir, "host.log");
const BACKUP = () => join(logDir, "host.log.1");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  renameFaults.codes.length = 0;
  logDir = await mkdtemp(join(tmpdir(), "traycer-host-log-"));
  await mkdir(logDir, { recursive: true });
  livePid = null;
});

afterEach(async () => {
  await rm(logDir, { recursive: true, force: true });
});

describe("rotateHostLogIfOversized (host start)", () => {
  it("leaves a log under the cap alone, so consecutive starts share one file", async () => {
    await writeFile(LOG(), "session one\n");

    expect(await rotateHostLogIfOversized("dev")).toBe("skipped");

    // Unchanged and un-rotated: this is what keeps a restart's markers readable
    // in the context of the run that preceded them.
    expect(await readFile(LOG(), "utf8")).toBe("session one\n");
    expect(await exists(BACKUP())).toBe(false);
  });

  it("rotates a log past the cap into host.log.1 and starts the live file fresh", async () => {
    await writeFile(LOG(), "x".repeat(MAX_HOST_LOG_BYTES + 1));

    expect(await rotateHostLogIfOversized("dev")).toBe("rotated");

    // The live log is gone (the next append recreates it); the previous
    // generation is intact.
    expect(await exists(LOG())).toBe(false);
    expect((await stat(BACKUP())).size).toBe(MAX_HOST_LOG_BYTES + 1);
  });

  it("keeps exactly one generation - a second rotation overwrites the older backup", async () => {
    await writeFile(BACKUP(), "ancient");
    await writeFile(LOG(), "y".repeat(MAX_HOST_LOG_BYTES + 1));

    expect(await rotateHostLogIfOversized("dev")).toBe("rotated");

    const backup = await readFile(BACKUP(), "utf8");
    expect(backup).not.toContain("ancient");
    expect(backup.startsWith("y")).toBe(true);
  });

  it("is a no-op when no log exists yet (first start on a machine)", async () => {
    expect(await rotateHostLogIfOversized("dev")).toBe("skipped");
    expect(await exists(BACKUP())).toBe(false);
  });

  it("refuses to rotate under a LIVE host, however big the log has grown", async () => {
    // The live host holds the append fd the supervisor handed it. An fd follows
    // the inode across a rename, so rotating here would send that host's stdout
    // into host.log.1 while fresh markers went to host.log - one session torn
    // across two files. Growing past the cap is the lesser evil.
    livePid = process.pid;
    await writeFile(LOG(), "z".repeat(MAX_HOST_LOG_BYTES + 1));

    expect(await rotateHostLogIfOversized("dev")).toBe("skipped");

    expect((await stat(LOG())).size).toBe(MAX_HOST_LOG_BYTES + 1);
    expect(await exists(BACKUP())).toBe(false);
  });

  it("rotates when the recorded pid is stale (host died without cleaning up)", async () => {
    // A pid that cannot exist: the guard must fall through rather than wedge
    // rotation forever behind a leftover pid file.
    livePid = 2147483646;
    await writeFile(LOG(), "w".repeat(MAX_HOST_LOG_BYTES + 1));

    expect(await rotateHostLogIfOversized("dev")).toBe("rotated");

    expect(await exists(LOG())).toBe(false);
    expect((await stat(BACKUP())).size).toBe(MAX_HOST_LOG_BYTES + 1);
  });

  it("keeps the previous generation when the rotation itself cannot happen", async () => {
    // Rename-before-remove: a rotation that fails must not have already
    // destroyed the evidence it was supposed to preserve. Point the backup at a
    // DIRECTORY so `rename` onto it fails on every platform.
    await mkdir(BACKUP(), { recursive: true });
    await writeFile(join(BACKUP(), "prior-evidence.txt"), "keep me");
    await writeFile(LOG(), "v".repeat(MAX_HOST_LOG_BYTES + 1));

    expect(await rotateHostLogIfOversized("dev")).toBe("skipped");

    // The live log is untouched and the prior generation still exists.
    expect((await stat(LOG())).size).toBe(MAX_HOST_LOG_BYTES + 1);
    expect(await readFile(join(BACKUP(), "prior-evidence.txt"), "utf8")).toBe(
      "keep me",
    );
  });

  it("restores the previous generation when Windows replacement fails after displacement", async () => {
    await writeFile(BACKUP(), "prior evidence");
    await writeFile(LOG(), "n".repeat(MAX_HOST_LOG_BYTES + 1));

    // Simulate Windows refusing the initial replace because host.log.1 exists,
    // then an unrelated failure promoting host.log after the prior backup has
    // been moved aside. The fourth rename is the rollback.
    renameFaults.codes.push("EPERM", null, "EACCES", null);

    expect(await rotateHostLogIfOversized("dev")).toBe("skipped");

    expect(await readFile(BACKUP(), "utf8")).toBe("prior evidence");
    expect((await stat(LOG())).size).toBe(MAX_HOST_LOG_BYTES + 1);
    expect((await readdir(logDir)).sort()).toEqual(["host.log", "host.log.1"]);
  });
});

describe("rotateHostLogForPurge (host uninstall --all / dev teardown)", () => {
  it("preserves the session in host.log.1 instead of deleting it", async () => {
    // The regression this closes: `make dev-desktop` runs `host uninstall --all`
    // on every Ctrl-C, which used to `rm` this file - so the session you wanted
    // to investigate was routinely gone before you could read it.
    await writeFile(LOG(), "the session worth investigating\n");

    expect(await rotateHostLogForPurge("dev")).toBe("rotated");

    // The purge still clears the live log...
    expect(await exists(LOG())).toBe(false);
    // ...but the evidence survives.
    expect(await readFile(BACKUP(), "utf8")).toBe(
      "the session worth investigating\n",
    );
  });

  it("rotates regardless of size - a purge is not size-gated", async () => {
    await writeFile(LOG(), "tiny");

    expect(await rotateHostLogForPurge("dev")).toBe("rotated");

    expect(await readFile(BACKUP(), "utf8")).toBe("tiny");
  });

  it("cannot accumulate generations across repeated teardowns", async () => {
    await writeFile(LOG(), "run one\n");
    await rotateHostLogForPurge("dev");
    await writeFile(LOG(), "run two\n");
    await rotateHostLogForPurge("dev");

    // Still exactly one backup, holding the most recent run.
    expect(await readFile(BACKUP(), "utf8")).toBe("run two\n");
    expect(await exists(join(logDir, "host.log.2"))).toBe(false);
  });

  it("leaves no stragglers when the log is empty", async () => {
    await writeFile(LOG(), "");

    expect(await rotateHostLogForPurge("dev")).toBe("skipped");

    expect(await exists(LOG())).toBe(false);
    expect(await exists(BACKUP())).toBe(false);
  });

  it("is a no-op when there is no log to purge", async () => {
    expect(await rotateHostLogForPurge("dev")).toBe("skipped");
    expect(await exists(BACKUP())).toBe(false);
  });
});
