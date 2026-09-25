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

// `hostLogPath` resolves under the real `homedir()`, so redirect all three
// paths into a temp dir and let the rotation run against a real filesystem -
// the `rename` / `rm` sequencing that shifts host.log -> .1 -> .2 (two
// retained generations, matching the host's own in-process rotator) is the
// whole behavior under test and a mocked fs would prove nothing about it.
let logDir = "";

vi.mock("../../store/paths", () => ({
  hostLogPath: () => join(logDir, "host.log"),
  hostLogBackupPath: () => join(logDir, "host.log.1"),
  hostLogOldestBackupPath: () => join(logDir, "host.log.2"),
}));

// The start path skips rotation while a host is live (it holds an open append fd
// on the file). Default to "no host running"; the guard test overrides it.
let livePid: number | null = null;

vi.mock("../pid-metadata", async () => {
  // Only the read is stubbed; `publishedHostProcessGone` stays real so the
  // guard judges `livePid` by the real liveness probe.
  const actual =
    await vi.importActual<typeof import("../pid-metadata")>("../pid-metadata");
  return {
    ...actual,
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
  };
});

const {
  MAX_HOST_LOG_BYTES,
  rotateHostLogForPurge,
  rotateHostLogForPurgeWithVerifier,
  rotateHostLogIfOversized,
} = await import("../host-log-rotation");

const LOG = () => join(logDir, "host.log");
const BACKUP = () => join(logDir, "host.log.1");
const OLDEST = () => join(logDir, "host.log.2");

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

  it("shifts the previous backup into host.log.2 instead of overwriting it", async () => {
    await writeFile(BACKUP(), "ancient");
    await writeFile(LOG(), "y".repeat(MAX_HOST_LOG_BYTES + 1));

    expect(await rotateHostLogIfOversized("dev")).toBe("rotated");

    const backup = await readFile(BACKUP(), "utf8");
    expect(backup.startsWith("y")).toBe(true);
    expect(await readFile(OLDEST(), "utf8")).toBe("ancient");
  });

  it("shifts two existing generations forward, dropping the oldest", async () => {
    await writeFile(BACKUP(), "gen one");
    await writeFile(OLDEST(), "gen two");
    await writeFile(LOG(), "z".repeat(MAX_HOST_LOG_BYTES + 1));

    expect(await rotateHostLogIfOversized("dev")).toBe("rotated");

    // The live log is gone until the next append; exactly two generations
    // remain, shifted forward by one.
    expect((await readFile(BACKUP(), "utf8")).startsWith("z")).toBe(true);
    expect(await readFile(OLDEST(), "utf8")).toBe("gen one");
    expect(await exists(join(logDir, "host.log.3"))).toBe(false);
    expect((await readdir(logDir)).sort()).toEqual([
      "host.log.1",
      "host.log.2",
    ]);
  });

  it("leaves an orphaned host.log.2 untouched when there is no host.log.1 to shift", async () => {
    await writeFile(OLDEST(), "orphan");
    await writeFile(LOG(), "w".repeat(MAX_HOST_LOG_BYTES + 1));

    expect(await rotateHostLogIfOversized("dev")).toBe("rotated");

    // Nothing existed at host.log.1, so there was nothing to shift into
    // host.log.2 - it is left exactly as it was.
    expect((await readFile(BACKUP(), "utf8")).startsWith("w")).toBe(true);
    expect(await readFile(OLDEST(), "utf8")).toBe("orphan");
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
    await writeFile(OLDEST(), "older evidence");
    await writeFile(LOG(), "n".repeat(MAX_HOST_LOG_BYTES + 1));

    // The host.log.1 -> host.log.2 shift runs first, and it is the one that
    // hits the Windows-shaped failure. Rename call order derived from
    // `rotate`:
    //   1. rename(host.log.1, host.log.2)  -> EPERM  (host.log.2 exists)
    //   2. rename(host.log.2, <displaced>) -> ok     (displace it aside)
    //   3. rename(host.log.1, host.log.2)  -> EACCES (promote fails)
    //   4. rename(<displaced>, host.log.2) -> ok     (rollback restores it)
    // That shift's own rotate() call returns "skipped", leaving host.log.1
    // exactly as it was. This is the documented degradation: a failed shift
    // must not block the live log from rotating, so the second move -
    // host.log -> host.log.1 - still runs (call 5, no fault needed:
    // host.log.1 exists as a regular file, and POSIX rename replaces an
    // existing destination in one atomic call).
    renameFaults.codes.push("EPERM", null, "EACCES", null);

    expect(await rotateHostLogIfOversized("dev")).toBe("rotated");

    expect(await readFile(OLDEST(), "utf8")).toBe("older evidence");
    expect((await readFile(BACKUP(), "utf8")).startsWith("n")).toBe(true);
    expect(await exists(LOG())).toBe(false);
    expect(
      (await readdir(logDir)).some((name) => name.includes("replace-")),
    ).toBe(false);
  });

  it("shifts host.log.1 into host.log.2 via Windows-style displacement when both exist", async () => {
    await writeFile(BACKUP(), "gen one");
    await writeFile(OLDEST(), "gen two");
    await writeFile(LOG(), "m".repeat(MAX_HOST_LOG_BYTES + 1));

    // Rename call order derived from `rotate`:
    //   1. rename(host.log.1, host.log.2)  -> EPERM (host.log.2 exists)
    //   2. rename(host.log.2, <displaced>) -> ok    (displace it aside)
    //   3. rename(host.log.1, host.log.2)  -> ok    (promote; the displaced
    //      old host.log.2 is then removed and the shift is "rotated")
    //   4. rename(host.log, host.log.1)    -> ok    (host.log.1 no longer
    //      exists, it was just moved onto host.log.2, so no fault is needed;
    //      the queued `null` delegates to the real rename)
    renameFaults.codes.push("EPERM", null, null, null);

    expect(await rotateHostLogIfOversized("dev")).toBe("rotated");

    expect((await readFile(BACKUP(), "utf8")).startsWith("m")).toBe(true);
    expect(await readFile(OLDEST(), "utf8")).toBe("gen one");
    expect((await readdir(logDir)).sort()).toEqual([
      "host.log.1",
      "host.log.2",
    ]);
  });
});

describe("rotateHostLogForPurge (host uninstall --all / dev teardown)", () => {
  it("propagates capability loss before the first rename and preserves the live log", async () => {
    await writeFile(LOG(), "authority-sensitive session\n");
    const verify = async (): Promise<void> => {
      throw new Error("mutation authority lost");
    };

    await expect(
      rotateHostLogForPurgeWithVerifier("dev", verify),
    ).rejects.toThrow("mutation authority lost");
    expect(await readFile(LOG(), "utf8")).toBe("authority-sensitive session\n");
    expect(await exists(BACKUP())).toBe(false);
  });

  it("propagates capability loss between replacement rename edges without rollback or deletion", async () => {
    await writeFile(LOG(), "current session\n");
    await writeFile(BACKUP(), "prior session\n");
    // host.log.2 must pre-exist too: the injected EPERM on the first rename
    // is the host.log.1 -> host.log.2 shift's own replace attempt, and that
    // fault path only continues into displacement when the destination
    // (host.log.2) is found to already be a regular file.
    await writeFile(OLDEST(), "older session\n");
    // Only two rename calls happen before the verifier throws (see the count
    // below), so only two fault codes are ever consumed.
    renameFaults.codes.push("EPERM", null);
    let verifyCalls = 0;
    const verify = async (): Promise<void> => {
      verifyCalls += 1;
      if (verifyCalls === 3) throw new Error("mutation authority lost");
    };

    await expect(
      rotateHostLogForPurgeWithVerifier("dev", verify),
    ).rejects.toThrow("mutation authority lost");
    // The purge path runs the host.log.1 -> host.log.2 shift's `rotate()`
    // call first, and `rotate` calls the verifier before every rename
    // attempt:
    //   verify #1 -> rename(host.log.1, host.log.2)  -> EPERM (host.log.2
    //                exists as a regular file, so displacement is attempted)
    //   verify #2 -> rename(host.log.2, <displaced>) -> ok
    //   verify #3 -> throws, before the promote rename ever runs
    // The exception propagates straight out of the shift's own `rotate()`
    // call, so the second `rotate()` call (host.log -> host.log.1) never
    // starts - exactly as before, this is capability loss between the
    // replacement rename edges, just now inside the first of the two shifted
    // moves.
    expect(verifyCalls).toBe(3);
    expect(await readFile(LOG(), "utf8")).toBe("current session\n");
    expect(
      (await readdir(logDir)).some((name) => name.includes("replace-")),
    ).toBe(true);
  });

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
    // Nothing existed at host.log.1 to shift, so host.log.2 must not appear
    // either.
    expect(await exists(OLDEST())).toBe(false);
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
    await writeFile(LOG(), "run three\n");
    await rotateHostLogForPurge("dev");

    // Still exactly two backups - the two-generation trail the host's own
    // rotator keeps - holding the two most recent runs.
    expect(await readFile(BACKUP(), "utf8")).toBe("run three\n");
    expect(await readFile(OLDEST(), "utf8")).toBe("run two\n");
    expect(await exists(join(logDir, "host.log.3"))).toBe(false);
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
