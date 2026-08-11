import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDiskChatPartCache,
  createDiskChatPartCache,
} from "../chat-part-cache";

/**
 * Driven against a REAL directory, not a memfs.
 *
 * Everything interesting about this adapter is filesystem behaviour - the
 * rename, the fan-out, what a half-written file reads back as, what happens
 * when a path is not writable - and a stub filesystem is exactly the thing that
 * would make all four pass while none of them worked.
 */

const DIGEST_A =
  "0000000000000000000000000000000000000000000000000000000000000001";
const DIGEST_B =
  "ff00000000000000000000000000000000000000000000000000000000000002";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "traycer-chat-parts-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("round trip", () => {
  it("returns exactly the bytes it was given", async () => {
    const cache = createDiskChatPartCache(root);
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);

    await cache.put(DIGEST_A, bytes);

    expect(await cache.get(DIGEST_A)).toEqual(bytes);
  });

  it("survives a fresh cache over the same directory", async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    await createDiskChatPartCache(root).put(DIGEST_A, bytes);

    // The property the in-memory fallback cannot buy: a new process reading a
    // chat it read yesterday asks the cloud for nothing.
    expect(await createDiskChatPartCache(root).get(DIGEST_A)).toEqual(bytes);
  });

  it("answers null for a digest it does not hold", async () => {
    expect(await createDiskChatPartCache(root).get(DIGEST_B)).toBeNull();
  });

  it("stores a part under a one-byte fan-out of its own digest", async () => {
    await createDiskChatPartCache(root).put(DIGEST_B, new Uint8Array([1]));

    expect(await readdir(root)).toEqual(["ff"]);
    expect(await readdir(join(root, "ff"))).toEqual([DIGEST_B]);
  });

  it("writes a part with no temp file left behind", async () => {
    await createDiskChatPartCache(root).put(DIGEST_A, new Uint8Array([1, 2]));

    const entries = await readdir(join(root, "00"));
    expect(entries).toEqual([DIGEST_A]);
  });
});

describe("failing softly", () => {
  it("treats an unreadable entry as absent rather than throwing", async () => {
    const cache = createDiskChatPartCache(root);
    await cache.put(DIGEST_A, new Uint8Array([1]));
    // A directory where the file should be: the shape an interrupted or
    // externally mangled cache takes, and `readFile` throws EISDIR on it.
    await rm(join(root, "00", DIGEST_A));
    await createDiskChatPartCache(join(root, "00", DIGEST_A)).put(
      DIGEST_B,
      new Uint8Array([1]),
    );

    expect(await cache.get(DIGEST_A)).toBeNull();
  });

  it("swallows a failed put - a read must not fail because a store did", async () => {
    // A file where the root directory should be, so every `mkdir` under it
    // fails with ENOTDIR.
    const blocked = join(root, "blocked");
    await writeFile(blocked, "not a directory");
    const cache = createDiskChatPartCache(blocked);

    await expect(
      cache.put(DIGEST_A, new Uint8Array([1])),
    ).resolves.toBeUndefined();
    expect(await cache.get(DIGEST_A)).toBeNull();
  });
});

describe("the digest is a key, never a path", () => {
  it.each([
    ["a traversal", "../../../../etc/passwd"],
    [
      "a separator",
      "00/000000000000000000000000000000000000000000000000000000000001",
    ],
    // DIGEST_B, not DIGEST_A: the latter is all digits, so upper-casing it is
    // the identity and the case would silently test nothing.
    ["upper case", DIGEST_B.toUpperCase()],
    ["too short", "abc"],
    ["not hex", `${"z".repeat(64)}`],
  ])("refuses %s without touching the disk", async (_label, key) => {
    const cache = createDiskChatPartCache(root);

    await cache.put(key, new Uint8Array([1, 2, 3]));

    expect(await cache.get(key)).toBeNull();
    // The guard is a path-traversal guard, not validation theatre: a `sha256`
    // read off a wire document must not become a write target.
    expect(await readdir(root)).toEqual([]);
  });
});

describe("clearing", () => {
  it("drops every entry, and is safe on a directory that never existed", async () => {
    const cache = createDiskChatPartCache(root);
    await cache.put(DIGEST_A, new Uint8Array([1]));
    await cache.put(DIGEST_B, new Uint8Array([2]));

    // `null` is the success verdict - the clear RETURNS its failure instead
    // of throwing or swallowing, so logout can report what remains on disk.
    expect(await clearDiskChatPartCache(root)).toBeNull();

    expect(await cache.get(DIGEST_A)).toBeNull();
    await expect(
      clearDiskChatPartCache(join(root, "never-existed")),
    ).resolves.toBeNull();
  });
});

describe("concurrency", () => {
  it("converges when two writers store the same part at once", async () => {
    const bytes = new Uint8Array([9, 9, 9, 9]);
    const first = createDiskChatPartCache(root);
    const second = createDiskChatPartCache(root);

    await Promise.all([
      first.put(DIGEST_A, bytes),
      second.put(DIGEST_A, bytes),
      first.put(DIGEST_A, bytes),
    ]);

    // Identical bytes by construction - a race between writers of the same
    // content address is not a race - and no temp file survives either write.
    expect(await readFile(join(root, "00", DIGEST_A))).toEqual(
      Buffer.from(bytes),
    );
    expect(await readdir(join(root, "00"))).toEqual([DIGEST_A]);
  });
});
