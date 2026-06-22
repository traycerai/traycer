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
export async function putImage(bytes: ImageBytes): Promise<string> {
  const hash = await sha256Hex(bytes);
  // Seed the session cache BEFORE the IndexedDB write so the invariant "bytes in
  // IndexedDB ⟹ hash present in the session cache" always holds. GC reconcile
  // treats the session set as a delete-root; if the write landed first, a
  // reconcile that observed the new IDB key without the matching session entry
  // could reap freshly pasted bytes.
  if (!session.has(hash)) {
    session.set(hash, {
      bytes,
      objectUrl: URL.createObjectURL(new Blob([bytes])),
    });
  }
  const store = imageStore();
  if ((await get(hash, store)) === undefined) {
    await set(hash, bytes, store);
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
  if (fromSession !== undefined) return fromSession.bytes;
  return get<ImageBytes>(hash, imageStore());
}

/** Delete the persisted bytes for `hash`. Does not touch the session cache. */
export async function deleteImage(hash: string): Promise<void> {
  await del(hash, imageStore());
}

/** Every hash with bytes persisted in this runtime's partition. */
export async function imageHashKeys(): Promise<string[]> {
  return keys<string>(imageStore());
}

/** The same-session object-URL for `hash`, or `null` if not seen this session. */
export function sessionObjectUrl(hash: string): string | null {
  return session.get(hash)?.objectUrl ?? null;
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
