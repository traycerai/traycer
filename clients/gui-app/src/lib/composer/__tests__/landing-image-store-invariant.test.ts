/**
 * The landing image store's one invariant, walked: it claims a hash (presence,
 * or a measured size) only while the bytes are in memory (the session, or a
 * reclaim's custody) or in the database as it is now, whatever order the
 * operations of a window and the deletions of its database overtake each other
 * in. Replayable: every walk is `SEEDS` x `STEPS` steps of a seeded generator
 * over a real IndexedDB (fake-indexeddb), and a failure names its seed, its
 * step and the steps taken, so `SEEDS` narrowed to that seed reruns it.
 *
 * Each step is started and not awaited, and 0 to 3 turns of the event loop pass
 * before the next, so operations overlap; a held transaction keeps one
 * operation of the store queued behind it while a deletion goes by. `settle`
 * lets every holder go and every operation end, and the invariants are read
 * then, against the database through a connection of its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteDatabaseWhenClosed,
  installFreshIndexedDb,
  openHoldingConnection,
  rawGet,
  stubDigestsOf,
  type HeldTransaction,
} from "@/lib/composer/__tests__/fake-idb";
import type { ImageBytes } from "@/lib/attachments/image-bytes";

/** The seeds walked: 1 to 24. A failure reports its seed; narrow this to rerun it. */
const SEEDS: ReadonlyArray<number> = Array.from(
  { length: 24 },
  (_, i) => i + 1,
);
/** The steps of each walk. */
const STEPS = 40;
/**
 * The weight of each step among the others. Fixed: they were chosen so that,
 * on the store as it was before the invariant held, the walks reach both a
 * claim kept for bytes that were released after a deletion and a put that
 * resolved with nothing stored.
 */
const WEIGHTS: ReadonlyArray<readonly [StepKind, number]> = [
  ["put", 6],
  ["get", 2],
  ["keys", 2],
  ["release", 3],
  ["sweep", 2],
  ["hold", 3],
  ["unhold", 2],
  ["delete", 3],
  ["settle", 2],
];

type StepKind =
  | "put"
  | "get"
  | "keys"
  | "release"
  | "sweep"
  | "hold"
  | "unhold"
  | "delete"
  | "settle";

const IMAGES_DB = "traycer-gui-app:default:landing-images";

/** Three images with distinct bytes. 0 and 1 are rooted, as a draft names them; 2 never is. */
const IMAGES: ReadonlyArray<ImageBytes> = [
  new Uint8Array([1, 1]),
  new Uint8Array([2, 2, 2]),
  new Uint8Array([3, 3, 3, 3]),
];
const ROOTED: ReadonlyArray<boolean> = [true, true, false];

type Window = typeof import("@/lib/composer/landing-image-store");

/** mulberry32: a small seeded generator, the same numbers on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function turns(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await turn();
}

async function loadWindow(): Promise<Window> {
  vi.resetModules();
  return import("@/lib/composer/landing-image-store");
}

/** The length of the bytes the database holds under `hash`; `null` when it holds none. */
async function lengthInDatabase(hash: string): Promise<number | null> {
  const value = await rawGet(IMAGES_DB, "bytes", hash);
  return ArrayBuffer.isView(value) ? value.byteLength : null;
}

interface Walk {
  readonly seed: number;
  readonly window: Window;
  readonly hashes: ReadonlyArray<string>;
  readonly random: () => number;
  readonly trace: string[];
  readonly violations: string[];
  /** Everything started and not yet ended, whatever its outcome. */
  pending: Promise<unknown>[];
  /** The latest resolution of a put of each image, with the deletion count it ended at. */
  readonly resolvedPut: Array<{ readonly deletions: number } | null>;
  held: HeldTransaction[];
  /** While set, a holder that opens is let go at once: nothing may wait on one while the walk waits on everything. */
  settling: boolean;
}

function violate(
  walk: Walk,
  step: number,
  invariant: string,
  what: string,
): void {
  walk.violations.push(
    `seed ${walk.seed}, step ${step}, invariant ${invariant}: ${what}; steps: ${walk.trace.join(" ")}`,
  );
}

function rootedHash(walk: Walk, hash: string): boolean {
  return walk.hashes.some((own, i) => own === hash && ROOTED[i]);
}

/** The operations of one step. Each starts what it does and returns; none is awaited by the walk. */
function startStep(walk: Walk, kind: StepKind, image: number): void {
  const { window, hashes } = walk;
  const hash = hashes[image];
  switch (kind) {
    case "put":
      walk.pending.push(
        window.putImage(IMAGES[image]).then(
          () => {
            walk.resolvedPut[image] = {
              deletions: window.landingImageDeletions(),
            };
          },
          (error: unknown) => {
            walk.violations.push(
              `seed ${walk.seed}: put of image ${image} rejected (e): ${String(error)}; steps: ${walk.trace.join(" ")}`,
            );
          },
        ),
      );
      return;
    case "get":
      walk.pending.push(window.getImageBytes(hash).catch(() => undefined));
      return;
    case "keys":
      walk.pending.push(window.imageHashKeys().catch(() => undefined));
      return;
    case "release":
      window.releaseSession(hash);
      return;
    case "sweep":
      walk.pending.push(sweep(walk).catch(() => undefined));
      return;
    case "hold": {
      if (walk.held.length > 0) return;
      walk.pending.push(
        openHoldingConnection(IMAGES_DB, "bytes").then(
          (connection) => {
            const held = connection.hold(hash);
            if (walk.settling) held.release();
            else walk.held.push(held);
          },
          () => undefined,
        ),
      );
      return;
    }
    case "unhold":
      for (const held of walk.held) held.release();
      walk.held = [];
      return;
    case "delete":
      walk.pending.push(
        deleteDatabaseWhenClosed(IMAGES_DB).catch(() => undefined),
      );
      return;
    case "settle":
      return;
  }
}

/** One sweep of the landing image reconcile, in its order (`landing-image-gc.ts`). */
async function sweep(walk: Walk): Promise<void> {
  const { window } = walk;
  await window.ensureMeasuredImageSizes();
  await window.flushReclaimCustody();
  const stored = await window.imageHashKeys();
  const sessionKeys = window.sessionHashKeys();
  const orphans = stored.filter(
    (hash) => !rootedHash(walk, hash) && !sessionKeys.includes(hash),
  );
  for (const hash of orphans) {
    await window.reclaimImageBytes(hash, () => rootedHash(walk, hash));
  }
  for (const hash of sessionKeys) {
    if (!rootedHash(walk, hash)) window.releaseSession(hash);
  }
}

/** Lets every holder go and every operation and deletion end, then reads the invariants. */
async function settle(walk: Walk, step: number): Promise<void> {
  walk.settling = true;
  for (const held of walk.held) held.release();
  walk.held = [];
  while (walk.pending.length > 0) {
    const ending = walk.pending;
    walk.pending = [];
    await Promise.allSettled(ending);
  }
  walk.settling = false;
  // The size writes nobody awaits.
  await turns(5);
  await check(walk, step);
}

/** Whether image `i` has its bytes anywhere the window could still read them from. */
function residentIn(
  walk: Walk,
  i: number,
  lengths: ReadonlyArray<number | null>,
): boolean {
  const hash = walk.hashes[i];
  return (
    walk.window.sessionImageBytes(hash) !== null ||
    walk.window.reclaimCustodyHashesForTests().includes(hash) ||
    lengths[i] !== null
  );
}

/** (a) and (b): what the window claims for image `i` is true of bytes it has. */
function checkClaims(
  walk: Walk,
  step: number,
  i: number,
  resident: boolean,
): void {
  const hash = walk.hashes[i];
  if (walk.window.hasLandingImageBytes(hash) && !resident) {
    violate(walk, step, "a", `image ${i} is present with no bytes anywhere`);
  }
  const size = walk.window.measuredLandingImageSize(hash);
  if (size === null) return;
  if (!resident) {
    violate(
      walk,
      step,
      "b",
      `image ${i} has size ${size} with no bytes anywhere`,
    );
  }
  if (size !== IMAGES[i].byteLength) {
    violate(
      walk,
      step,
      "b",
      `image ${i} has size ${size}, not ${IMAGES[i].byteLength}`,
    );
  }
}

/** (c): a put of a rooted image that resolved with no deletion since left its bytes in the database. */
function checkPut(
  walk: Walk,
  step: number,
  i: number,
  inDatabase: boolean,
): void {
  const resolved = walk.resolvedPut[i];
  if (!ROOTED[i] || resolved === null || inDatabase) return;
  if (resolved.deletions !== walk.window.landingImageDeletions()) return;
  violate(
    walk,
    step,
    "c",
    `the put of rooted image ${i} resolved after the last deletion and the database has no bytes for it`,
  );
}

async function check(walk: Walk, step: number): Promise<void> {
  const lengths = await Promise.all(walk.hashes.map(lengthInDatabase));
  for (let i = 0; i < IMAGES.length; i += 1) {
    checkClaims(walk, step, i, residentIn(walk, i, lengths));
    checkPut(walk, step, i, lengths[i] !== null);
  }
  // (d) After an enumeration, whatever is resident is claimed.
  await walk.window.imageHashKeys();
  for (let i = 0; i < IMAGES.length; i += 1) {
    if (
      residentIn(walk, i, lengths) &&
      !walk.window.hasLandingImageBytes(walk.hashes[i])
    ) {
      violate(
        walk,
        step,
        "d",
        `image ${i} has bytes but is not claimed after an enumeration`,
      );
    }
  }
}

function pick(random: () => number): StepKind {
  const total = WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  let left = random() * total;
  for (const [kind, weight] of WEIGHTS) {
    left -= weight;
    if (left < 0) return kind;
  }
  return "settle";
}

async function walkSeed(seed: number): Promise<string[]> {
  installFreshIndexedDb();
  const window = await loadWindow();
  await window.awaitLandingImageSizes();
  const hashes = await Promise.all(
    IMAGES.map((bytes) => window.sha256Hex(bytes)),
  );
  const walk: Walk = {
    seed,
    window,
    hashes,
    random: mulberry32(seed),
    trace: [],
    violations: [],
    pending: [],
    resolvedPut: IMAGES.map(() => null),
    held: [],
    settling: false,
  };
  for (let step = 0; step < STEPS; step += 1) {
    const kind = pick(walk.random);
    const image = Math.floor(walk.random() * IMAGES.length);
    walk.trace.push(`${step}:${kind}(${image})`);
    startStep(walk, kind, image);
    if (kind === "settle") await settle(walk, step);
    await turns(Math.floor(walk.random() * 4));
  }
  await settle(walk, STEPS);
  return walk.violations;
}

beforeEach(async () => {
  installFreshIndexedDb();
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => undefined;
  await stubDigestsOf(IMAGES);
});

describe("the landing image store's claims against its bytes, over seeded walks of overlapping operations and deletions", () => {
  it.each(SEEDS)(
    "seed %i holds the invariant at every settle",
    async (seed) => {
      expect(await walkSeed(seed)).toEqual([]);
    },
  );
});
