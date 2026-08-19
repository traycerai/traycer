import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopPreferredHostStore } from "../preferred-host-store";

/**
 * `DesktopPreferredHostStore` tests (F3 persistence). Style follows
 * `desktop-selection-ports.test.ts`: real temp directories, real `fs`,
 * no mocking of the `node:fs` module.
 *
 * Write-failure injection seam: the store's `write()` does
 * `mkdirSync(dirname(filePath), { recursive: true })` on every call. Node's
 * `mkdirSync(..., { recursive: true })` throws `ENOTDIR` when a path
 * component that should be a directory already exists as a plain FILE - a
 * structural error, not a permission check, so it fails identically whether
 * the test runs as root or not (unlike a `chmod`-based seam).
 */

const silentLog = { warn: (): void => undefined };

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "preferred-host-store-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Replaces the store's target directory with a plain file, so every future
 * `mkdirSync(dirname(filePath), { recursive: true })` inside `write()`
 * throws `ENOTDIR` - the store's write path becomes unconditionally broken
 * from this point on, regardless of process privileges.
 */
function sabotageWriteDirectory(filePath: string): void {
  const storeDir = dirname(filePath);
  rmSync(storeDir, { recursive: true, force: true });
  writeFileSync(storeDir, "blocker", "utf8");
}

describe("DesktopPreferredHostStore", () => {
  describe("E3: a failed sign-out wipe", () => {
    it("never reports clean, and load() keeps refusing the identity afterward", () => {
      const dir = makeTempDir();
      const filePath = join(dir, "prefs", "desktop-preferred-host.json");
      const store = new DesktopPreferredHostStore(filePath, silentLog);

      // Seed a real, durably-persisted preference first.
      expect(store.save("user-a", "host-1")).toEqual({ ok: true });
      expect(store.load("user-a")).toBe("host-1");
      expect(existsSync(filePath)).toBe(true);

      // Break every future write.
      sabotageWriteDirectory(filePath);

      // Sanity: the sabotage actually blocks a real write attempt (guards
      // against this test passing for the wrong reason).
      const unrelatedWrite = store.save("user-b", "host-2");
      expect(unrelatedWrite.ok).toBe(false);

      // The wipe itself: save(identityKey, null) for an identity with an
      // existing durable value, while the write path is broken.
      const wipeResult = store.save("user-a", null);
      // Never reports clean: the wipe's own result must reflect the write
      // failure, not silently claim success.
      expect(wipeResult).toEqual({
        ok: false,
        reason: expect.any(String),
      });

      // `load()` still refuses to serve the identity: a promised-wiped
      // bucket is never handed back even while the disk write lags/fails,
      // which is the store's actual guarantee (comment on `load()`) - this
      // is NOT because the wipe reached disk (it did not; the write failed),
      // but because `pendingWipes` forces the answer to `null` in memory
      // regardless of disk state, so the next identity can never inherit a
      // previous identity's choice through a stuck wipe.
      expect(store.load("user-a")).toBeNull();
    });

    it("keeps re-attempting the wipe on later calls (best-effort drain), and clears the pending state once the write path is restored", () => {
      const dir = makeTempDir();
      const filePath = join(dir, "prefs", "desktop-preferred-host.json");
      const store = new DesktopPreferredHostStore(filePath, silentLog);

      expect(store.save("user-a", "host-1")).toEqual({ ok: true });
      sabotageWriteDirectory(filePath);
      expect(store.save("user-a", null)).toEqual({
        ok: false,
        reason: expect.any(String),
      });
      expect(store.load("user-a")).toBeNull();

      // Restore the write path: remove the blocking file so `mkdirSync`
      // can succeed again.
      rmSync(dirname(filePath), { force: true });

      // The next call to the store (here, `load`) drains the pending wipe
      // as a side effect and the identity stays wiped.
      expect(store.load("user-a")).toBeNull();

      // A fresh save for that identity now succeeds normally again, proving
      // the store was not left permanently wedged by the earlier failure.
      expect(store.save("user-a", "host-3")).toEqual({ ok: true });
      expect(store.load("user-a")).toBe("host-3");
    });
  });

  describe("E2 (store level): the copy-vs-mutate latch", () => {
    it("a failed SET does not absorb into the cache, so an identical retry after the write path is restored actually writes and lands durable", () => {
      // Pins `save()`'s COPY-PERSIST-SWAP order. If `read()`'s live cache were
      // mutated before the write, a failed write would still leave the new
      // value sitting in memory - and the identical retry below would then
      // hit the `next.get(identityKey) === hostId` no-op short-circuit and
      // report {ok:true} having written nothing, silently latching the
      // failure until restart.
      const dir = makeTempDir();
      const filePath = join(dir, "prefs", "desktop-preferred-host.json");
      const store = new DesktopPreferredHostStore(filePath, silentLog);

      sabotageWriteDirectory(filePath);
      expect(store.save("user-a", "host-a")).toEqual({
        ok: false,
        reason: expect.any(String),
      });

      // THE load-bearing assertion: the cache must still be at the
      // last-durable state (nothing, in this case), never the failed value -
      // this is the assertion the copy-vs-mutate bug defeats. Without it,
      // this test would still pass under the bug, because the retry below
      // would ALSO return {ok:true} (from the short-circuit, not a real
      // write) and look indistinguishable from success.
      expect(store.load("user-a")).toBeNull();

      // Restore the write path, then retry the IDENTICAL save.
      rmSync(dirname(filePath), { force: true });
      expect(store.save("user-a", "host-a")).toEqual({ ok: true });

      // Durable on a FRESH store instance (its own cache, forced to read
      // disk), not just the same in-memory object.
      const reopened = new DesktopPreferredHostStore(filePath, silentLog);
      expect(reopened.load("user-a")).toBe("host-a");
    });
  });

  describe("E4: a no-op save writes nothing (retry-storm guard)", () => {
    it("re-saving the value already persisted for an identity short-circuits before write()", () => {
      const dir = makeTempDir();
      const filePath = join(dir, "prefs", "desktop-preferred-host.json");
      const store = new DesktopPreferredHostStore(filePath, silentLog);

      expect(store.save("user-a", "host-1")).toEqual({ ok: true });

      // Break every future write, then prove the sabotage is real.
      sabotageWriteDirectory(filePath);
      expect(store.save("user-b", "host-2").ok).toBe(false);

      // Saving the SAME value already on record for "user-a" must never
      // reach `write()` - if it did, it would fail exactly like the
      // "user-b" call above did. An `ok: true` here is only possible
      // because the equality check short-circuited before any I/O.
      expect(store.save("user-a", "host-1")).toEqual({ ok: true });
    });

    it("clearing a preference that was never set for an identity short-circuits before write()", () => {
      const dir = makeTempDir();
      const filePath = join(dir, "prefs", "desktop-preferred-host.json");
      const store = new DesktopPreferredHostStore(filePath, silentLog);

      // Establish the store (and its on-disk directory) with an unrelated
      // identity, so the sabotage below is meaningful.
      expect(store.save("user-b", "host-2")).toEqual({ ok: true });
      sabotageWriteDirectory(filePath);
      expect(store.save("user-c", "host-3").ok).toBe(false);

      // "user-a" has no persisted preference at all; wiping it is a no-op
      // that must not attempt a write either.
      expect(store.save("user-a", null)).toEqual({ ok: true });
      expect(store.load("user-a")).toBeNull();
    });
  });

  describe("an EXISTING but UNREADABLE state file", () => {
    // Read-failure injection seam, distinct from the write-failure seam above:
    // making `filePath` itself a DIRECTORY makes `readFileSync(filePath, ...)`
    // throw `EISDIR`, which is NOT `ENOENT` - a structural error, so it fails
    // identically whether the test runs as root or not (no chmod, no fs
    // mocking). The store's `read()` used to cache an unreadable file as an
    // authoritative EMPTY map, indistinguishable from a genuinely absent file -
    // so a later sign-out wipe found the identity "already absent" and
    // reported success without writing, and a later Activate would have
    // written that false-empty set over every other identity's preference.
    it("a sign-out wipe is held pending, not reported done, and lands once the file is readable again", () => {
      const dir = makeTempDir();
      const filePath = join(dir, "prefs", "desktop-preferred-host.json");
      const seeded = new DesktopPreferredHostStore(filePath, silentLog);
      expect(seeded.save("user-a", "host-1")).toEqual({ ok: true });

      // Sabotage the READ only: park the real file aside and put a directory
      // at its path.
      const parked = `${filePath}.parked`;
      renameSync(filePath, parked);
      mkdirSync(filePath);

      const store = new DesktopPreferredHostStore(filePath, silentLog);

      // Positive control that the seam actually bites (guards against this
      // test passing for the wrong reason).
      expect(() => readFileSync(filePath, "utf8")).toThrow();

      const wipe = store.save("user-a", null);
      // Never reports clean: the OLD code cached the unreadable file as an
      // empty map, so the identity looked "already absent" and this returned
      // {ok:true} having written nothing.
      expect(wipe).toEqual({ ok: false, reason: expect.any(String) });
      expect(store.load("user-a")).toBeNull();

      // Restore readability.
      rmSync(filePath, { recursive: true, force: true });
      renameSync(parked, filePath);

      // The next call re-attempts the wipe against a REAL read.
      expect(store.load("user-a")).toBeNull();

      // Relaunch: a fresh store reads the durable file - the preference must
      // be GONE. OLD code: "host-1" comes back, because the wipe never
      // actually reached disk while the false-empty cache was live.
      const relaunched = new DesktopPreferredHostStore(filePath, silentLog);
      expect(relaunched.load("user-a")).toBeNull();
    });

    it("an Activate refuses because the READ can't be trusted (not because the write also fails), and the unreadable read is not cached", () => {
      const dir = makeTempDir();
      const filePath = join(dir, "prefs", "desktop-preferred-host.json");
      const seeded = new DesktopPreferredHostStore(filePath, silentLog);
      expect(seeded.save("user-a", "host-1")).toEqual({ ok: true });

      const parked = `${filePath}.parked`;
      renameSync(filePath, parked);
      mkdirSync(filePath);

      // A directory at `filePath` breaks BOTH `readFileSync(filePath, ...)`
      // (EISDIR) and `renameSync(tmpPath, filePath)` inside `write()` (the
      // rename target is a non-empty directory) - so under the OLD code,
      // where `save()` did not refuse until it actually tried to write,
      // `activate.ok === false` would pass for the wrong reason: the write
      // failing, not the read being untrustworthy. A capturing logger (not
      // `silentLog`) makes that distinction checkable by which message
      // actually fired.
      const calls: string[] = [];
      const capturingLog = {
        warn: (message: string): void => {
          calls.push(message);
        },
      };
      const store = new DesktopPreferredHostStore(filePath, capturingLog);
      expect(() => readFileSync(filePath, "utf8")).toThrow();

      const activate = store.save("user-b", "host-2");
      expect(activate.ok).toBe(false);
      expect(calls).toContain("[selection-preferred] state file unreadable");
      expect(calls).not.toContain("[selection-preferred] state write failed");

      rmSync(filePath, { recursive: true, force: true });
      renameSync(parked, filePath);

      // NOT cached as empty: the same store instance now sees the real
      // durable set. OLD code cached {} at the first (failed) read, so
      // "user-a" would come back null here and a pending Activate would go on
      // to write "user-b" alone over every other identity's preference.
      expect(store.load("user-a")).toBe("host-1");
      expect(store.load("user-b")).toBeNull();
    });
  });

  describe("a state file written by a NEWER Traycer (rollback)", () => {
    // Not a read-failure seam: the file is perfectly readable and perfectly
    // valid - it is just in a format version this build does not know. That
    // used to fall through `version !== PREFERRED_HOST_STATE_VERSION` into an
    // authoritative, CACHED empty map, so after a rollback a sign-out found
    // the identity "already absent" and reported the wipe honoured without
    // touching the file, and an Activate wrote a v1 file holding ONE identity
    // over the newer build's file - deleting every other identity's
    // preference the user would get back on the next upgrade.
    const newerFile = JSON.stringify({
      version: 2,
      byIdentity: { "user-a": "host-1", "user-b": "host-2" },
      // Something a v2 writer might carry that v1 has no idea about.
      lastActivatedAt: { "user-a": 1 },
    });

    it("an Activate refuses - naming the newer format - and the newer file survives byte-for-byte", () => {
      const dir = makeTempDir();
      const filePath = join(dir, "prefs", "desktop-preferred-host.json");
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, newerFile, "utf8");
      const calls: string[] = [];
      const store = new DesktopPreferredHostStore(filePath, {
        warn: (message: string): void => {
          calls.push(message);
        },
      });

      // Reads as "no preference" - derivation's local default is the safe
      // answer for a shape this build cannot interpret.
      expect(store.load("user-a")).toBeNull();

      const activate = store.save("user-c", "host-3");
      expect(activate.ok).toBe(false);
      if (activate.ok) throw new Error("unreachable");
      expect(activate.reason).toContain("newer Traycer");
      expect(activate.reason).toContain("v2");
      expect(activate.reason).toContain(filePath);
      expect(calls).toContain(
        "[selection-preferred] state file written by a newer version",
      );
      // The refusal is the READ's, not a write's: nothing was attempted.
      expect(calls).not.toContain("[selection-preferred] state write failed");
      // The one assertion that matters: the newer build's file is untouched.
      expect(readFileSync(filePath, "utf8")).toBe(newerFile);
    });

    it("a sign-out wipe is held pending rather than reported done, and the identity is refused meanwhile", () => {
      const dir = makeTempDir();
      const filePath = join(dir, "prefs", "desktop-preferred-host.json");
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, newerFile, "utf8");
      const store = new DesktopPreferredHostStore(filePath, silentLog);

      const wipe = store.save("user-a", null);
      // OLD code: {ok:true} off the cached false-empty map, file untouched,
      // "host-1" back on the next upgrade as if the sign-out never happened.
      expect(wipe).toEqual({ ok: false, reason: expect.any(String) });
      expect(store.load("user-a")).toBeNull();
      expect(readFileSync(filePath, "utf8")).toBe(newerFile);
    });

    it("the newer-version read is NOT cached: once the file is back in this build's format, the same instance reads it", () => {
      const dir = makeTempDir();
      const filePath = join(dir, "prefs", "desktop-preferred-host.json");
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, newerFile, "utf8");
      const store = new DesktopPreferredHostStore(filePath, silentLog);
      expect(store.save("user-c", "host-3").ok).toBe(false);

      // The user upgrades-and-migrates (or hand-fixes) the file back to v1.
      writeFileSync(
        filePath,
        JSON.stringify({ version: 1, byIdentity: { "user-a": "host-1" } }),
        "utf8",
      );
      // OLD code cached {} at the first read, so this stayed null and the
      // pending Activate went on to write "user-c" alone.
      expect(store.load("user-a")).toBe("host-1");
      expect(store.save("user-c", "host-3")).toEqual({ ok: true });
      expect(store.load("user-a")).toBe("host-1");
      expect(store.load("user-c")).toBe("host-3");
    });

    it("an OLDER or missing version is malformed, not a format to preserve: it degrades to empty and IS overwritable", () => {
      // Only this build has ever written the file, so nothing below v1 can be
      // a real writer's format - refusing it would strand the user with no
      // way to ever set a preference again.
      const dir = makeTempDir();
      const filePath = join(dir, "prefs", "desktop-preferred-host.json");
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        JSON.stringify({ version: 0, byIdentity: { "user-a": "host-1" } }),
        "utf8",
      );
      const store = new DesktopPreferredHostStore(filePath, silentLog);
      expect(store.load("user-a")).toBeNull();
      expect(store.save("user-c", "host-3")).toEqual({ ok: true });
      const written: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      expect(written).toEqual({
        version: 1,
        byIdentity: { "user-c": "host-3" },
      });

      // And with no `version` key at all - the same verdict.
      writeFileSync(
        filePath,
        JSON.stringify({ byIdentity: { "user-a": "host-1" } }),
        "utf8",
      );
      const unversioned = new DesktopPreferredHostStore(filePath, silentLog);
      expect(unversioned.load("user-a")).toBeNull();
      expect(unversioned.save("user-d", "host-4")).toEqual({ ok: true });
      expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
        version: 1,
        byIdentity: { "user-d": "host-4" },
      });
    });
  });
});
