import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sandboxRoot = "";

vi.mock("../../logger", () => ({
  createCliLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  type Environment = "dev" | "production";
  const cacheDirFor = (environment: Environment): string =>
    join(sandboxRoot, "host", environment, "download-cache");
  return {
    ...actual,
    hostDownloadCacheDir: (environment: Environment) =>
      cacheDirFor(environment),
    ensureHostDownloadCacheDir: async (environment: Environment) => {
      mkdirSync(cacheDirFor(environment), { recursive: true });
    },
  };
});

import {
  acquireDownloadSlot,
  refreshDownloadSlotClaim,
  releaseDownloadSlot,
  releaseDownloadSlotOwnership,
} from "../download-cache";

// Comfortably past `UNIDENTIFIED_OWNER_IDLE_TAKEOVER_MS` (15 minutes).
const IDLE_PAST_TAKEOVER_MS = 20 * 60 * 1000;
// Short enough that an entry touched this recently is still "being worked
// on" under the same rule.
const IDLE_WITHIN_TAKEOVER_MS = 60 * 1000;
// Past `BREAK_MARKER_GRACE_MS` (30s), so the sub-lock looks abandoned on age
// alone - which must not be enough to take it.
const BREAK_MARKER_AGED_MS = 60 * 1000;

const SLOT = {
  environment: "production" as const,
  version: "1.5.0",
  sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  urlBasename: "traycer-host-windows-x64.zip",
};

function cacheDir(): string {
  return join(sandboxRoot, "host", "production", "download-cache");
}

function ageFile(path: string, ms: number): void {
  const old = new Date(Date.now() - ms);
  utimesSync(path, old, old);
}

// A pid that is provably not running, so `verifyProcessIdentity` returns
// "dead" rather than "indeterminate" - the SIGKILLed-previous-invocation
// case. `startedAtMs: null` would only ever be "indeterminate".
function writeDeadOwner(ownerPath: string): void {
  writeFileSync(
    ownerPath,
    JSON.stringify({ pid: 0x7fffffff, startedAtMs: Date.now() }),
    "utf8",
  );
}

beforeEach(() => {
  sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-download-cache-test-"));
});

afterEach(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("acquireDownloadSlot", () => {
  it("resolves the same path for the same version+sha across invocations", async () => {
    const first = await acquireDownloadSlot(SLOT);
    await releaseDownloadSlotOwnership("production", first.archivePath);
    const second = await acquireDownloadSlot(SLOT);

    expect(second.archivePath).toBe(first.archivePath);
    expect(second.resumable).toBe(true);
    expect(dirname(first.archivePath)).toBe(cacheDir());
  });

  it("takes over a slot whose owner is gone, keeping the partial bytes", async () => {
    // The reported failure: Desktop SIGKILLs the CLI mid-download, so the
    // marker outlives its process. The next invocation must inherit the
    // partial, not delete it.
    const slot = await acquireDownloadSlot(SLOT);
    writeFileSync(slot.archivePath, "partial-bytes", "utf8");
    writeDeadOwner(`${slot.archivePath}.owner`);

    const reacquired = await acquireDownloadSlot(SLOT);

    expect(reacquired.archivePath).toBe(slot.archivePath);
    expect(reacquired.resumable).toBe(true);
    expect(readFileSync(slot.archivePath, "utf8")).toBe("partial-bytes");
    expect(JSON.parse(readFileSync(`${slot.archivePath}.owner`, "utf8")).pid) //
      .toBe(process.pid);
  });

  it("hands out a private path while a live process holds the slot", async () => {
    // Two writers appending to one file would corrupt both, so the second
    // caller trades cross-process resume for a path of its own.
    const held = await acquireDownloadSlot(SLOT);
    writeFileSync(held.archivePath, "held", "utf8");

    const other = await acquireDownloadSlot(SLOT);

    expect(other.resumable).toBe(false);
    expect(other.archivePath).not.toBe(held.archivePath);
    expect(dirname(other.archivePath)).toMatch(/private-/);
    expect(readFileSync(held.archivePath, "utf8")).toBe("held");
  });

  it("keeps a superseded version's partial only while its owner lives", async () => {
    const stale = await acquireDownloadSlot({ ...SLOT, version: "1.4.0" });
    writeFileSync(stale.archivePath, "old-partial", "utf8");
    const live = await acquireDownloadSlot({ ...SLOT, version: "1.4.1" });
    writeFileSync(live.archivePath, "live-partial", "utf8");
    writeDeadOwner(`${stale.archivePath}.owner`);

    const current = await acquireDownloadSlot(SLOT);

    expect(existsSync(stale.archivePath)).toBe(false);
    expect(existsSync(`${stale.archivePath}.owner`)).toBe(false);
    // Still owned by this (live) process - never swept out from under it.
    expect(existsSync(live.archivePath)).toBe(true);
    expect(existsSync(current.archivePath)).toBe(false);
  });

  it("sweeps an unowned leftover but spares an unidentifiable one until it goes idle", async () => {
    mkdirSync(cacheDir(), { recursive: true });
    const orphan = join(cacheDir(), "1.0.0-deadbeefdeadbeef-host.zip");
    writeFileSync(orphan, "orphan", "utf8");
    const unverifiable = join(cacheDir(), "1.0.1-deadbeefdeadbeef-host.zip");
    writeFileSync(unverifiable, "unverifiable", "utf8");
    // A marker that cannot be parsed is not positive evidence of anything,
    // so the idle rule - not the identity rule - decides.
    writeFileSync(`${unverifiable}.owner`, "{not json", "utf8");

    await acquireDownloadSlot(SLOT);

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(unverifiable)).toBe(true);

    // An old marker beside an archive that is still GROWING is a live
    // downloader mid-transfer, not litter: the newest mtime across the pair
    // is what decides, so this must still be spared.
    ageFile(`${unverifiable}.owner`, IDLE_PAST_TAKEOVER_MS);
    ageFile(unverifiable, IDLE_WITHIN_TAKEOVER_MS);
    await acquireDownloadSlot({ ...SLOT, version: "1.6.0" });

    expect(existsSync(unverifiable)).toBe(true);

    // Nothing has touched either one for longer than the takeover window.
    ageFile(unverifiable, IDLE_PAST_TAKEOVER_MS);
    await acquireDownloadSlot({ ...SLOT, version: "1.7.0" });

    expect(existsSync(unverifiable)).toBe(false);
    expect(existsSync(`${unverifiable}.owner`)).toBe(false);
  });

  it("hands the slot to exactly one of two processes racing the same stale marker", async () => {
    // Proving a marker stale is not the same as being allowed to replace it.
    // Two contenders reach the same conclusion about the same marker, and
    // the gap between deciding and acting spans a `ps`/`tasklist` probe - if
    // both then win, both append to one file and the partial stops being a
    // prefix of the archive.
    const slot = await acquireDownloadSlot(SLOT);
    writeFileSync(slot.archivePath, "partial-bytes", "utf8");
    writeDeadOwner(`${slot.archivePath}.owner`);

    const [first, second] = await Promise.all([
      acquireDownloadSlot(SLOT),
      acquireDownloadSlot(SLOT),
    ]);

    expect([first.resumable, second.resumable].filter(Boolean)).toHaveLength(1);
    const winner = first.resumable ? first : second;
    const loser = first.resumable ? second : first;
    expect(winner.archivePath).toBe(slot.archivePath);
    expect(readFileSync(slot.archivePath, "utf8")).toBe("partial-bytes");
    expect(dirname(loser.archivePath)).toMatch(/private-/);
    // The break sub-lock is transient - it must not be left behind to wedge
    // every future takeover of this slot.
    expect(existsSync(`${slot.archivePath}.owner.break`)).toBe(false);
  });

  it("declines to steal the break sub-lock from a breaker that is still alive", async () => {
    // Another process is mid-takeover of this slot. Its sub-lock is old
    // enough to look abandoned, but its recorded identity does not say it
    // crashed - and age alone is not evidence. Stealing it would put two
    // processes in the critical section at once, and the descheduled one's
    // unlink would then land on the marker the other just wrote for itself,
    // leaving both appending to one archive.
    const slot = await acquireDownloadSlot(SLOT);
    writeFileSync(slot.archivePath, "partial-bytes", "utf8");
    writeDeadOwner(`${slot.archivePath}.owner`);
    const breakPath = `${slot.archivePath}.owner.break`;
    writeFileSync(
      breakPath,
      JSON.stringify({
        pid: process.pid,
        startedAtMs: null,
        nonce: "held-by-someone-else",
      }),
      "utf8",
    );
    ageFile(breakPath, BREAK_MARKER_AGED_MS);

    const contender = await acquireDownloadSlot(SLOT);

    expect(contender.resumable).toBe(false);
    // The sub-lock and the partial both survive untouched.
    expect(readFileSync(breakPath, "utf8")).toContain("held-by-someone-else");
    expect(readFileSync(slot.archivePath, "utf8")).toBe("partial-bytes");
  });

  it("refreshing the claim keeps an unidentifiable owner's slot from being taken over", async () => {
    // Everything after the transfer - hashing, signature verification, and
    // above all the caller's extract - only READS the archive, so its mtime
    // stops advancing while the slot is still legitimately held. The refresh
    // is what keeps the idle rule from handing the slot away mid-extract.
    const slot = await acquireDownloadSlot(SLOT);
    writeFileSync(slot.archivePath, "partial-bytes", "utf8");
    writeFileSync(
      `${slot.archivePath}.owner`,
      JSON.stringify({ pid: process.pid, startedAtMs: null }),
      "utf8",
    );
    ageFile(`${slot.archivePath}.owner`, IDLE_PAST_TAKEOVER_MS);
    ageFile(slot.archivePath, IDLE_PAST_TAKEOVER_MS);

    await refreshDownloadSlotClaim("production", slot.archivePath);

    expect((await acquireDownloadSlot(SLOT)).resumable).toBe(false);
  });

  it("takes over a slot whose owner cannot be identified once it goes idle", async () => {
    // Where the liveness probe itself is unavailable - a locked-down Windows
    // with no usable `tasklist` - every verdict is "indeterminate". Identity
    // alone would then pin the slot indefinitely and silently turn
    // cross-process resume back off, which is the behaviour being fixed.
    const slot = await acquireDownloadSlot(SLOT);
    writeFileSync(slot.archivePath, "partial-bytes", "utf8");
    writeFileSync(
      `${slot.archivePath}.owner`,
      // Alive pid, unknowable start time -> "indeterminate".
      JSON.stringify({ pid: process.pid, startedAtMs: null }),
      "utf8",
    );

    // Still being written to, so it is not up for grabs yet.
    expect((await acquireDownloadSlot(SLOT)).resumable).toBe(false);

    ageFile(`${slot.archivePath}.owner`, IDLE_PAST_TAKEOVER_MS);
    ageFile(slot.archivePath, IDLE_PAST_TAKEOVER_MS);
    const takenOver = await acquireDownloadSlot(SLOT);

    expect(takenOver.resumable).toBe(true);
    expect(takenOver.archivePath).toBe(slot.archivePath);
    expect(readFileSync(slot.archivePath, "utf8")).toBe("partial-bytes");
  });

  it("spares a private slot whose claim exists before its directory", async () => {
    // The window `createPrivateSlot` closes by claiming first: mid-creation
    // the marker exists and the directory does not, and a concurrent sweep
    // must read that as a claim to respect rather than an unowned entry to
    // remove.
    const held = await acquireDownloadSlot(SLOT);
    writeFileSync(held.archivePath, "held", "utf8");
    const priv = await acquireDownloadSlot(SLOT);
    const privateDir = dirname(priv.archivePath);
    rmSync(privateDir, { recursive: true, force: true });

    await acquireDownloadSlot({ ...SLOT, version: "9.9.9" });

    expect(existsSync(`${privateDir}.owner`)).toBe(true);
  });

  it("folds a hostile publisher basename into one safe path segment", async () => {
    const slot = await acquireDownloadSlot({
      ...SLOT,
      urlBasename: "../../../etc/passwd",
    });

    // The publisher-controlled segment can never contribute a separator or
    // a parent-dir hop: whatever it contained, the archive resolves to one
    // plain entry directly inside the cache dir.
    expect(dirname(slot.archivePath)).toBe(cacheDir());
    expect(basename(slot.archivePath)).not.toMatch(/[/\\]/);
    expect(basename(slot.archivePath)).not.toContain("..");
  });

  it("keeps a publisher basename out of the reserved bookkeeping suffixes", async () => {
    // `sanitizeSegment` preserves `.` and `-`, so a published asset named
    // `…owner` / `…break` would otherwise produce a slot file the sweep
    // mistakes for its own bookkeeping: `readMarkerRaw` would read a
    // multi-hundred-MB partial into a string, a `.break` name would never be
    // reclaimed, and the marker for a neighbouring slot would resolve onto
    // the archive itself.
    for (const hostile of ["host.owner", "host.break"]) {
      const slot = await acquireDownloadSlot({
        ...SLOT,
        version: `1.0.0-${hostile}`,
        urlBasename: hostile,
      });
      const name = basename(slot.archivePath);
      expect(name.endsWith(".owner")).toBe(false);
      expect(name.endsWith(".break")).toBe(false);
      // Still recognizable - the fold swaps the separator, it does not
      // discard the publisher's name.
      expect(name).toContain(hostile.replace(".", "-"));
    }
  });
});

describe("releaseDownloadSlot", () => {
  it("drops the archive and the claim once the caller has consumed it", async () => {
    const slot = await acquireDownloadSlot(SLOT);
    writeFileSync(slot.archivePath, "verified", "utf8");

    await releaseDownloadSlot("production", slot.archivePath);

    expect(readdirSync(cacheDir())).toEqual([]);
  });

  it("leaves the slot alone when the claim has changed hands", async () => {
    // A slot legitimately changes owner while this process holds it - the
    // idle takeover fires during a long extract. After that the archive and
    // the marker belong to a fresh holder that is resuming them, so this
    // process's release must not delete either.
    const slot = await acquireDownloadSlot(SLOT);
    writeFileSync(slot.archivePath, "verified", "utf8");
    writeFileSync(
      `${slot.archivePath}.owner`,
      JSON.stringify({ pid: 0x7ffffffe, startedAtMs: Date.now() }),
      "utf8",
    );

    await releaseDownloadSlot("production", slot.archivePath);

    expect(existsSync(slot.archivePath)).toBe(true);
    expect(existsSync(`${slot.archivePath}.owner`)).toBe(true);
  });

  it("escalates to a recursive remove only for a private slot inside the cache", async () => {
    // Exported and called for any archive the installer considers temporary,
    // including archives this module never created. Deciding "this is a
    // private slot, remove its whole directory" from the parent's NAME alone
    // would let such an archive aim an `rm -rf` at its own parent.
    const outside = join(sandboxRoot, "elsewhere", "private-not-ours");
    mkdirSync(outside, { recursive: true });
    const archive = join(outside, "host.zip");
    writeFileSync(archive, "archive", "utf8");
    writeFileSync(
      `${archive}.owner`,
      JSON.stringify({ pid: process.pid, startedAtMs: null }),
      "utf8",
    );
    const sibling = join(outside, "keep-me.txt");
    writeFileSync(sibling, "keep", "utf8");

    await releaseDownloadSlot("production", archive);

    expect(existsSync(archive)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it("keeps the partial but drops the claim when only ownership is released", async () => {
    const slot = await acquireDownloadSlot(SLOT);
    writeFileSync(slot.archivePath, "partial", "utf8");

    await releaseDownloadSlotOwnership("production", slot.archivePath);

    expect(readFileSync(slot.archivePath, "utf8")).toBe("partial");
    expect(existsSync(`${slot.archivePath}.owner`)).toBe(false);
  });

  it("removes the whole private directory, never the shared cache dir", async () => {
    const held = await acquireDownloadSlot(SLOT);
    const priv = await acquireDownloadSlot(SLOT);
    writeFileSync(priv.archivePath, "private", "utf8");

    await releaseDownloadSlot("production", priv.archivePath);

    expect(existsSync(dirname(priv.archivePath))).toBe(false);
    expect(existsSync(cacheDir())).toBe(true);
    expect(existsSync(`${held.archivePath}.owner`)).toBe(true);
  });
});
