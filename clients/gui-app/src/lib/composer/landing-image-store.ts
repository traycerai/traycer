/**
 * Per-runtime, content-addressed image store for the landing / new-epic
 * composer.
 *
 * The landing draft's persisted `content` never carries image base64 — only a
 * content `hash` per image. The bytes for each hash live here, in an
 * IndexedDB store keyed by that hash, plus an in-memory session cache that
 * also powers flash-free same-session render.
 *
 * Browser-safe: in a browser / non-desktop runtime the partition collapses to
 * `"default"`; on desktop each window gets its own partition so per-window
 * enumeration and wipe match by DB-name prefix.
 *
 * This module is intentionally consumer-free (no React, no paste/render/submit
 * wiring) — store ops, GC, and submit all run OUTSIDE React render, so the
 * partition resolver is imperative, NOT a hook.
 */

import {
  createStore,
  del,
  entries,
  get,
  keys,
  set,
  type UseStore,
} from "idb-keyval";

import type { ImageBytes } from "@/lib/attachments/image-bytes";
import { PERSIST_PREFIX } from "@/lib/persist/keys";

/**
 * Session entry for a hash seen this session. Holds the bytes (so submit can
 * re-inline base64 synchronously) AND a pre-created object-URL (so a just
 * pasted image paints with no placeholder frame). The session cache is a GC
 * root, never a GC victim.
 */
interface SessionEntry {
  readonly bytes: ImageBytes;
  readonly objectUrl: string;
}

const session = new Map<string, SessionEntry>();

/**
 * Every hash whose bytes are reachable in THIS window's partition (session cache
 * or IndexedDB) as far as we have observed this session. Seeded on write
 * (`putImage`) and on any successful read (`getImageBytes`, which the
 * restored-draft fetcher drives when an image renders), and pruned on
 * `reclaimImageBytes`. Backs the synchronous landing paste presence predicate
 * (`hasLandingImageBytes`): unlike the session map alone, it also reports a
 * restored draft's IndexedDB-backed hash as present once its image has rendered,
 * so a same-window copy→paste of that image is not falsely stripped.
 */
const knownHashes = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The IndexedDB partition for this runtime.
 *
 * IMPERATIVE — must NOT be a React hook; callers (GC, submit, store ops) run
 * outside render. Reads the desktop `windowId` imperatively off the global
 * runner-host bridge (`runnerHost.windows.windowId`, the same value
 * electron-main keys `desktop-windows.json` by — see `readDesktopWindowId` in
 * `traycer-app.tsx`). A browser / no-desktop runtime has no such global and
 * collapses to `"default"`.
 */
export function landingImagePartition(): string {
  const runnerHost: unknown = Reflect.get(globalThis, "runnerHost");
  if (!isRecord(runnerHost)) return "default";
  const windows = runnerHost.windows;
  if (!isRecord(windows)) return "default";
  const windowId = windows.windowId;
  return typeof windowId === "string" && windowId.length > 0
    ? windowId
    : "default";
}

function imageDbName(partition: string): string {
  return `${PERSIST_PREFIX}:${partition}:landing-images`;
}

/**
 * Sizes live in their own database rather than beside the bytes.
 *
 * Reading a size must not mean deserializing the image: idb-keyval hands back
 * the whole `Uint8Array`, so measuring a cold partition through the byte store
 * would pull every image into memory at startup - the exact cost the budget
 * exists to bound. A separate key-to-number database is enumerable in one cheap
 * read. It keeps the partition prefix, so the desktop per-window wipe (which
 * matches by DB-name prefix) still takes it.
 */
function imageSizeDbName(partition: string): string {
  return `${PERSIST_PREFIX}:${partition}:landing-image-sizes`;
}

// Memoize the open store per partition so repeated ops reuse a single DB
// connection instead of opening one per call. The partition is stable within a
// runtime; a change (only possible across desktop windows in tests) re-opens.
let cachedStore: {
  readonly partition: string;
  readonly store: UseStore;
} | null = null;

let cachedSizeStore: {
  readonly partition: string;
  readonly store: UseStore;
} | null = null;

/** The idb-keyval store for this runtime's partition (`hash` → bytes). */
export function imageStore(): UseStore {
  const partition = landingImagePartition();
  if (cachedStore === null || cachedStore.partition !== partition) {
    cachedStore = {
      partition,
      store: createStore(imageDbName(partition), "bytes"),
    };
  }
  return cachedStore.store;
}

/** The idb-keyval store for this partition's `hash` -> byte-length side table. */
function imageSizeStore(): UseStore {
  const partition = landingImagePartition();
  if (cachedSizeStore === null || cachedSizeStore.partition !== partition) {
    cachedSizeStore = {
      partition,
      store: createStore(imageSizeDbName(partition), "sizes"),
    };
  }
  return cachedSizeStore.store;
}

/**
 * Measured byte length per resident hash - the capacity authority's input.
 *
 * The landing byte budget has to charge for every hash its GC roots PROTECT,
 * and most of those roots are hash-only: an annotation crop, a composer or
 * new-chat row, a stash entry. Nothing in that shape declares a size, so the
 * budget used to count them as zero while the GC kept their bytes alive - 60 MiB
 * of protected bytes plus a 10 MiB paste passed a 64 MiB cap. What the roots
 * cannot say, the store can: it has the bytes in its hands on every write.
 */
const measuredSizes = new Map<string, number>();

function rememberMeasuredSize(hash: string, byteLength: number): void {
  if (measuredSizes.get(hash) === byteLength) return;
  measuredSizes.set(hash, byteLength);
  void set(hash, byteLength, imageSizeStore()).catch(() => undefined);
}

/**
 * The measured length of `hash`'s bytes, or `null` when this partition has
 * never measured them. `null` is NOT zero - see `landing-image-budget.ts`, which
 * charges an unmeasured root conservatively rather than free.
 */
export function measuredLandingImageSize(hash: string): number | null {
  return measuredSizes.get(hash) ?? null;
}

async function sha256Hex(bytes: ImageBytes): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Store `bytes` under their SHA-256 hash and seed the session cache. Dedupes:
 * the IndexedDB write is skipped when the hash is already persisted, and the
 * session entry (bytes + a synchronously created object-URL) is created once.
 * Returns the content hash to embed in the image node.
 */
// Single-flight writes per content hash. Concurrent callers with byte-identical
// images (which hash equal) JOIN one in-flight write instead of each running
// their own optimistic seed + rollback. That makes the rollback ownership
// unambiguous: exactly one flight owns the seeding it added, so a failed durable
// write can't revoke session/known entries a concurrent sibling is relying on.
const inFlightPuts = new Map<string, Promise<string>>();

/**
 * Store already-hashed bytes under `hash`. Refuses a digest mismatch
 * (never writes). Used by `drafts.readBlob` so the local partition
 * remains the render/GC tier after a host fetch.
 */
export async function putImageBytesAtHash(
  hash: string,
  bytes: ImageBytes,
): Promise<boolean> {
  const actual = await sha256Hex(bytes);
  if (actual !== hash) return false;
  await writeImageUnderHash(hash, bytes);
  return true;
}

export async function putImage(bytes: ImageBytes): Promise<string> {
  const hash = await sha256Hex(bytes);
  const existing = inFlightPuts.get(hash);
  if (existing !== undefined) return existing;
  const flight = writeImageUnderHash(hash, bytes);
  inFlightPuts.set(hash, flight);
  try {
    return await flight;
  } finally {
    inFlightPuts.delete(hash);
  }
}

async function writeImageUnderHash(
  hash: string,
  bytes: ImageBytes,
): Promise<string> {
  // Seed the session cache BEFORE the IndexedDB write so the invariant "bytes in
  // IndexedDB ⟹ hash present in the session cache" always holds. GC reconcile
  // treats the session set as a delete-root; if the write landed first, a
  // reconcile that observed the new IDB key without the matching session entry
  // could reap freshly pasted bytes.
  const seededSession = !session.has(hash);
  if (seededSession) {
    session.set(hash, {
      bytes,
      objectUrl: URL.createObjectURL(new Blob([bytes])),
    });
  }
  const seededKnown = !knownHashes.has(hash);
  knownHashes.add(hash);
  const store = imageStore();
  try {
    if ((await get(hash, store)) === undefined) {
      await set(hash, bytes, store);
    }
    // After the write, and on the dedupe path too: a hash whose bytes were
    // already there may still be unmeasured (an older build wrote them).
    rememberMeasuredSize(hash, bytes.byteLength);
  } catch (error) {
    // The durable write failed: roll back the optimistic seeding THIS call added
    // (a dedupe hit that found the hash already cached is left intact). Without
    // this, `hasLandingImageBytes` would report present with no durable bytes, so
    // a later paste of that hash would pass validation into a blank preview.
    if (seededSession) releaseSession(hash);
    if (seededKnown) knownHashes.delete(hash);
    throw error;
  }
  return hash;
}

/**
 * Bytes for `hash`: the session cache first (covers bytes not yet flushed and
 * avoids an IndexedDB round-trip), then the partition's IndexedDB store.
 * `undefined` when neither holds them.
 */
export async function getImageBytes(
  hash: string,
): Promise<ImageBytes | undefined> {
  const fromSession = session.get(hash);
  if (fromSession !== undefined) {
    knownHashes.add(hash);
    return fromSession.bytes;
  }
  const stored = await get<ImageBytes>(hash, imageStore());
  if (stored !== undefined) {
    knownHashes.add(hash);
    rememberMeasuredSize(hash, stored.byteLength);
  }
  return stored;
}

/**
 * Answers "is `hash` referenced by anything you know about, right now?" - live
 * for the whole reclaim, not a snapshot. `reclaimImageBytes` calls it several
 * times and the LAST call is the one that decides.
 */
export type ImageRootProbe = () => boolean;

export type ImageReclaimOutcome =
  /** The bytes were deleted and stayed deleted. */
  | "reclaimed"
  /** A root appeared; the bytes are still readable (restored if need be). */
  | "kept"
  /** There were no persisted bytes to reclaim. */
  | "absent";

/**
 * Reclaim `hash`'s persisted bytes - and put them back if the hash gained a root
 * while the delete was in flight.
 *
 * ## Why the caller cannot do this itself
 *
 * A sweep reads the live roots, then calls in here, and `del` hops inside
 * idb-keyval before its transaction runs. A root acquired in that hop is
 * invisible to the caller's snapshot, so the bytes are deleted out from under a
 * live reference - and for a local paste that has never been uploaded or
 * published, deleted is GONE: there is no host mirror or cloud blob to re-fetch
 * from. No extra read on the CALLER's side can fix that, because every one of
 * them runs before the hop.
 *
 * So the protocol is here, at the storage boundary, and it is retain-and-restore
 * rather than validate-and-hope:
 *
 *  1. retain the bytes in memory before deleting, because after `del` commits
 *     they cannot be read back;
 *  2. probe once more immediately before the delete, so an already-visible root
 *     costs nothing;
 *  3. probe AFTER the delete has committed - the decisive one. A root acquired
 *     at any point up to that line is visible to it, and the delete is undone by
 *     writing the retained bytes back.
 *
 * What is left is the acquisition that lands after step 3: a reference to a hash
 * that was unrooted at the instant it was deleted, being brought back to life
 * afterwards. That is a resurrected dead reference, not a lost live one, and it
 * is not reachable from the paths that acquire roots here - each of them holds
 * the content it is rooting from the moment it captures it.
 */
export async function reclaimImageBytes(
  hash: string,
  isRooted: ImageRootProbe,
): Promise<ImageReclaimOutcome> {
  const store = imageStore();
  if (stillRooted(hash, isRooted)) return "kept";
  const retained = await get<ImageBytes>(hash, store);
  if (retained === undefined) {
    knownHashes.delete(hash);
    return "absent";
  }
  if (stillRooted(hash, isRooted)) return "kept";
  await deleteImageBytesUnchecked(hash);
  if (!stillRooted(hash, isRooted)) return "reclaimed";
  await set(hash, retained, store);
  knownHashes.add(hash);
  rememberMeasuredSize(hash, retained.byteLength);
  return "kept";
}

/**
 * Delete `hash`'s persisted bytes with NO root check of any kind. Does not touch
 * the session cache.
 *
 * Reclaiming unreferenced bytes goes through `reclaimImageBytes`, which is this
 * plus the retain-and-restore protocol above; reach for this one only where the
 * bytes are known to be unwanted regardless of what references them - which in
 * practice means test fixtures clearing a partition.
 */
export async function deleteImageBytesUnchecked(hash: string): Promise<void> {
  // Prune presence only AFTER the durable delete succeeds. Pruning first would,
  // on a rejected `del`, report the still-present bytes as absent until a later
  // enumeration healed the set.
  await del(hash, imageStore());
  knownHashes.delete(hash);
  measuredSizes.delete(hash);
  void del(hash, imageSizeStore()).catch(() => undefined);
}

/**
 * The session cache is this module's OWN root, and the earliest signal there is:
 * `writeImageUnderHash` seeds it before the durable write, so a paste that began
 * during a sweep is visible here before its bytes are.
 */
function stillRooted(hash: string, isRooted: ImageRootProbe): boolean {
  return session.has(hash) || isRooted();
}

/** Every hash with bytes persisted in this runtime's partition. */
export async function imageHashKeys(): Promise<string[]> {
  const keysList = await keys<string>(imageStore());
  // Enumerating durable keys is the source of truth for presence, so fold them
  // into `knownHashes`. This keeps `hasLandingImageBytes` honest even when a
  // restored image rendered from the app-wide blob cache (a cache hit never
  // calls the per-surface fetcher / `getImageBytes`, so that path wouldn't seed
  // it). Cheap and idempotent; the module also runs this once at init below.
  for (const hash of keysList) knownHashes.add(hash);
  return keysList;
}

/** The same-session object-URL for `hash`, or `null` if not seen this session. */
export function sessionObjectUrl(hash: string): string | null {
  return session.get(hash)?.objectUrl ?? null;
}

/**
 * Whether `hash` has bytes reachable in this window's landing partition (session
 * cache or IndexedDB), as observed this session. Backs the landing paste presence
 * predicate (`hasPastedImageBytes` on the landing composer): a pasted hash-only
 * node whose bytes are not landing-reachable is stripped, closing the
 * phantom-preview fail-open. Synchronous, mirroring the chat composer's predicate.
 *
 * Reflects durable IndexedDB bytes regardless of how the image was rendered:
 * `knownHashes` is seeded from the partition's stored keys at init (and on every
 * `imageHashKeys` enumeration), plus by `putImage`/`getImageBytes`. So a restored
 * image whose chip reused an app-wide blob-cache URL (never calling the
 * per-surface fetcher) still reports present, and a same-window copy→paste of it
 * is not a false negative.
 */
export function hasLandingImageBytes(hash: string): boolean {
  return knownHashes.has(hash);
}

/**
 * Synchronously read this session's bytes for `hash`, or `null` if the hash was
 * not seen this session. Lets submit re-inline base64 without an `await` (and so
 * keep the optimistic local-state + navigation block synchronous) whenever every
 * image was pasted in the current session.
 */
export function sessionImageBytes(hash: string): ImageBytes | null {
  return session.get(hash)?.bytes ?? null;
}

/**
 * Hashes seen this session (present in the in-memory cache). GC treats these as
 * roots: a just-pasted hash that isn't yet committed to a persisted draft must
 * survive a reconcile, so it has to be enumerable from this module.
 */
export function sessionHashKeys(): string[] {
  return Array.from(session.keys());
}

/** Revoke `hash`'s session object-URL and drop its session entry. */
export function releaseSession(hash: string): void {
  const entry = session.get(hash);
  if (entry === undefined) return;
  URL.revokeObjectURL(entry.objectUrl);
  session.delete(hash);
}

/**
 * Hydrate the measured sizes for a partition restored from disk, and measure
 * anything the side table does not know about.
 *
 * Both halves matter. The side table answers the normal case in one cheap read.
 * The second pass exists because an unmeasured resident hash must not be free to
 * the budget, and the only honest way out of "unknown" is to go and look: those
 * are hashes written before this table existed, so the pass is bounded by what a
 * pre-existing partition holds and converges to nothing on every later start.
 * `getImageBytes` records the size it reads, so the measurement is the read.
 */
async function hydrateMeasuredImageSizes(): Promise<void> {
  const rows = await entries<string, number>(imageSizeStore());
  for (const [hash, byteLength] of rows) {
    if (typeof byteLength === "number") measuredSizes.set(hash, byteLength);
  }
  const resident = await imageHashKeys();
  for (const hash of resident) {
    if (measuredSizes.has(hash)) continue;
    await getImageBytes(hash);
  }
}

/**
 * Resolves once this partition's sizes are as known as they are going to get.
 * Admission consults it rather than blocking: see `landing-image-budget.ts`.
 */
const measuredSizesHydration: Promise<void> = hydrateMeasuredImageSizes().catch(
  () => undefined,
);

/**
 * Resolves when the cold-start measurement above has finished. Admission does
 * not wait on it: an unmeasured root is charged conservatively rather than
 * free, so the direction of error while this is still running is a refusal, not
 * an overrun. Tests await it to make the measured numbers deterministic.
 */
export function awaitLandingImageSizes(): Promise<void> {
  return measuredSizesHydration;
}

export function __resetMeasuredLandingImageSizesForTests(): void {
  measuredSizes.clear();
}
