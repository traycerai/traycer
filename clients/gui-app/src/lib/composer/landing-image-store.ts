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

import { createStore, del, get, keys, set, type UseStore } from "idb-keyval";

import { PERSIST_PREFIX } from "@/lib/persist/keys";

/** A view guaranteed to be backed by a plain `ArrayBuffer` (not shared). */
type ImageBytes = Uint8Array<ArrayBuffer>;

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
 * `deleteImage`. Backs the synchronous landing paste presence predicate
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

// Memoize the open store per partition so repeated ops reuse a single DB
// connection instead of opening one per call. The partition is stable within a
// runtime; a change (only possible across desktop windows in tests) re-opens.
let cachedStore: {
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
  if (stored !== undefined) knownHashes.add(hash);
  return stored;
}

/** Delete the persisted bytes for `hash`. Does not touch the session cache. */
export async function deleteImage(hash: string): Promise<void> {
  // Prune presence only AFTER the durable delete succeeds. Pruning first would,
  // on a rejected `del`, report the still-present bytes as absent until a later
  // enumeration healed the set.
  await del(hash, imageStore());
  knownHashes.delete(hash);
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

// Seed the presence set from durable IndexedDB keys at module init (best-effort),
// so a restored draft's hash reports present before any GC reconcile has run and
// regardless of whether its render went through the fetcher. `imageHashKeys`
// folds the keys into `knownHashes`; a failure (no IndexedDB) just leaves the set
// to be populated lazily by put/get/subsequent enumerations.
void imageHashKeys().catch(() => undefined);
