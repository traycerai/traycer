/**
 * Client-side conversion of the retired prompt stash into closed start-page
 * drafts (D19). Two entry points share one converted map and one install
 * sequence:
 *
 * - `migrateLocalStash()` reads the app-global IndexedDB stash once per
 *   launch and converts every entry it has not converted before;
 * - `convertStashEntry()` converts a `stash-entry` document a host or the
 *   cloud directory still lists (the coordinator retires the source row).
 *
 * The converted map (`stashId -> draftId`) lives in localStorage, which is
 * shared by every desktop window - unlike the landing draft store, which is
 * per window. That is what makes the database delete below safe: window A
 * only drops the database once the SHARED map accounts for every entry,
 * including the ones window B converted (G4).
 */
// The specific `keys` submodule, not the `@/lib/persist` barrel: the barrel
// re-exports `lib/persist/wipe.ts`, which imports `STASH_DB_NAME` from this
// module to delete the stash database by exact name - importing the barrel
// here would close that cycle.
import { PERSIST_PREFIX, persistKey } from "@/lib/persist/keys";

import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  ImageBlobCorruptError,
  ImageBlobMissingError,
  type ImageBlob,
  type ImageBytes,
} from "@/lib/attachments/image-bytes";
import { readComposerHostIdSnapshot } from "@/lib/composer/composer-host-snapshot";
import type { LandingImageBudgetReservation } from "@/lib/composer/landing-image-budget";
import { landingDraftsReady } from "@/lib/composer/landing-image-gc";
import { importImagesIntoLanding } from "@/lib/composer/landing-image-import";
import { currentDraftBlobOwnerId } from "@/lib/drafts/draft-blob-transport";
import { mintDraftId } from "@/lib/drafts/draft-ids";
import { flushActiveDesktopPerWindowProjection } from "@/lib/windows/per-window-projection-debounce";
import { isJsonContent, isRecord } from "@/lib/editor/prosemirror-json";
import { appLogger, describeLogError } from "@/lib/logger";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";

// Schema copied from `lib/composer/prompt-stash-repository.ts`, the writer
// this reader outlives: db `traycer-gui-app:prompt-stash` at version 2, with
// `entries` keyed by `id` and `blobs` keyed by `hash` (`meta` is ignored -
// nothing here reads a revision). The constants are duplicated rather than
// imported because T07 deletes that module.
export const STASH_DB_NAME = `${PERSIST_PREFIX}:prompt-stash`;
const STASH_DB_VERSION = 2;
const ENTRIES_STORE = "entries";
const BLOBS_STORE = "blobs";

const CONVERTED_MAP_KEY = persistKey("stash-migration");

/** One `entries` record: `{ id, createdAt, content, blobHashes }`. */
interface StashEntryRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly content: JsonContent;
  readonly blobHashes: readonly string[];
}

/**
 * Realm-safe `Uint8Array` check, from `prompt-stash-codec.ts` (deleted in
 * T07): IndexedDB's structured clone - and fake-indexeddb under jsdom - can
 * hand back a byte view whose prototype is not this realm's `Uint8Array`, so
 * a plain `instanceof` would false-negative every stored blob.
 */
function isImageBytes(value: unknown): value is ImageBytes {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

function rawIndexedDBFactory(): IDBFactory | undefined {
  // Through a call boundary so the wider return type - not the DOM lib's
  // non-nullable declaration - is what the caller's `undefined` check sees
  // (the same shape `prompt-stash-repository.ts` and `lib/persist/wipe.ts`
  // use for a runtime that really can lack IndexedDB).
  return globalThis.indexedDB;
}

function requestToPromise<T>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () =>
      reject(request.error ?? new Error("An IndexedDB request failed."));
  });
}

/**
 * Opens the stash database at its exact version, WITHOUT creating it. A
 * database that is not there (or predates the v2 schema) reaches
 * `upgradeneeded` with no `entries` store: the upgrade transaction is
 * aborted and the empty shell deleted, so a fresh install never grows a
 * stash database just by looking for one. `null` means "nothing to migrate".
 */
function openStashDb(): Promise<IDBDatabase | null> {
  const factory = rawIndexedDBFactory();
  if (factory === undefined) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = factory.open(STASH_DB_NAME, STASH_DB_VERSION);
    let absent = false;
    request.onupgradeneeded = () => {
      if (request.result.objectStoreNames.contains(ENTRIES_STORE)) return;
      absent = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      if (absent) {
        // The abort above reverts the version, but a zero-version shell can
        // still linger; delete it outright so the enumeration a wipe or a
        // later launch runs sees nothing.
        factory.deleteDatabase(STASH_DB_NAME);
        resolve(null);
        return;
      }
      reject(request.error ?? new Error("Could not open the stash database."));
    };
    request.onblocked = () => {
      // Another window holds an older version open; leave the database for
      // the next launch rather than hanging this one.
      resolve(null);
    };
  });
}

function deleteStashDb(): Promise<void> {
  const factory = rawIndexedDBFactory();
  if (factory === undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(STASH_DB_NAME);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Could not delete the stash db."));
  });
}

function parseStashEntry(value: unknown): StashEntryRecord | null {
  if (!isRecord(value)) return null;
  const { id, createdAt, content, blobHashes } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof createdAt !== "number") return null;
  if (!isJsonContent(content, 0)) return null;
  const hashes =
    Array.isArray(blobHashes) &&
    blobHashes.every((hash): hash is string => typeof hash === "string")
      ? blobHashes
      : [];
  return { id, createdAt, content, blobHashes: hashes };
}

function readStashEntries(db: IDBDatabase): Promise<unknown[]> {
  return requestToPromise<unknown[]>(
    db
      .transaction([ENTRIES_STORE], "readonly")
      .objectStore(ENTRIES_STORE)
      .getAll(),
  );
}

async function readStashBlob(
  db: IDBDatabase,
  hash: string,
): Promise<ImageBlob | null> {
  const record = await requestToPromise<unknown>(
    db
      .transaction([BLOBS_STORE], "readonly")
      .objectStore(BLOBS_STORE)
      .get(hash),
  );
  if (!isRecord(record)) return null;
  if (!isImageBytes(record.bytes)) return null;
  if (typeof record.mimeType !== "string") return null;
  return { bytes: record.bytes, mimeType: record.mimeType };
}

function readConvertedMap(): Record<string, string> {
  const converted: Record<string, string> = {};
  try {
    const raw = window.localStorage.getItem(CONVERTED_MAP_KEY);
    if (raw === null) return converted;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return converted;
    for (const [stashId, draftId] of Object.entries(parsed)) {
      if (typeof draftId === "string") converted[stashId] = draftId;
    }
  } catch (error: unknown) {
    appLogger.warn("[stash-migration] converted map unreadable", {
      error: describeLogError(error),
    });
  }
  return converted;
}

/**
 * Read-modify-write per entry rather than one write at the end: the map is
 * app-global and a peer window may have recorded its own conversions since
 * this one read it. Worst case a stash entry converts twice (two drafts,
 * nothing lost); the database delete stays gated on the merged map.
 */
function rememberConverted(stashId: string, draftId: string): void {
  const converted = readConvertedMap();
  converted[stashId] = draftId;
  try {
    window.localStorage.setItem(CONVERTED_MAP_KEY, JSON.stringify(converted));
  } catch (error: unknown) {
    appLogger.warn("[stash-migration] converted map not written", {
      error: describeLogError(error),
    });
  }
}

export function stashEntryIsConverted(stashId: string): boolean {
  return Object.hasOwn(readConvertedMap(), stashId);
}

/** The draft a previous conversion of `stashId` installed, or `null`. */
function convertedDraftIdFor(stashId: string): string | null {
  return readConvertedMap()[stashId] ?? null;
}

export interface StashConversionInput {
  readonly stashId: string;
  readonly content: JsonContent;
  readonly blobHashes: readonly string[];
  /** `createdAt` for a local entry, the document's `lastTouchedAt` otherwise. */
  readonly lastTouchedAt: number;
  readonly readBlob: (hash: string) => Promise<ImageBlob | null>;
  /**
   * The caller's account fence, re-asked SYNCHRONOUSLY immediately before the
   * install.
   *
   * A check the caller makes before calling this proves nothing: the image
   * import below awaits blob reads and IndexedDB writes, and an entry with no
   * images still yields through this async function. The landing draft store
   * is keyed per WINDOW, not per account, and `installLandingDraft` takes no
   * owner - so an install that lands after a sign-out files the outgoing
   * account's private text in the incoming account's drafts list, and roots
   * its images in that account's partition.
   */
  readonly stillCurrent: () => boolean;
}

/**
 * What one conversion did.
 *
 * `abandoned` is deliberately distinct from `already-converted`: both install
 * nothing, and the caller's response to them is opposite. An
 * already-converted entry is DONE - its source can be retired and the database
 * eventually dropped. An abandoned one was refused by the account fence, so
 * its source must stay exactly where it is for a later session to convert
 * under the right account, and no receipt may be written for it.
 */
export type StashConversionOutcome =
  | { readonly status: "converted"; readonly draftId: string }
  | { readonly status: "already-converted"; readonly draftId: string }
  | { readonly status: "abandoned" };

/**
 * Conversions running right now, keyed by stash id. The local IndexedDB pass
 * and a host/cloud apply of the SAME id can overlap - the converted map is
 * only written at the end, so both would pass the check at the top and
 * install their own draft. The second caller joins the first instead.
 */
const conversionsInFlight = new Map<string, Promise<StashConversionOutcome>>();

/**
 * Convert one stash entry into a closed, unadopted start-page draft and
 * record it in the converted map. Two concurrent calls for one id share a
 * single conversion; see {@link StashConversionOutcome} for what the answer
 * means.
 *
 * Images route through `importImagesIntoLanding`, which holds its budget
 * reservation across the writes AND this install, so the bytes are never
 * unreferenced roots while an image reconcile runs (C5). A budget refusal or
 * an unreadable/mismatched blob installs the ORIGINAL content instead: the
 * row is worth more than its images, and a hash whose bytes never landed
 * renders as unavailable.
 *
 * **Throws when the draft could not be made durable.** The converted map is
 * a receipt: written only after the row is on disk, so a caller that sees a
 * throw must leave the source (the IndexedDB entry, or the host row) exactly
 * where it is.
 */
export function convertStashEntry(
  input: StashConversionInput,
): Promise<StashConversionOutcome> {
  const joined = conversionsInFlight.get(input.stashId);
  if (joined !== undefined) return joined;
  const running = runStashConversion(input);
  conversionsInFlight.set(input.stashId, running);
  return running.finally(() => {
    conversionsInFlight.delete(input.stashId);
  });
}

async function runStashConversion(
  input: StashConversionInput,
): Promise<StashConversionOutcome> {
  const alreadyConverted = convertedDraftIdFor(input.stashId);
  if (alreadyConverted !== null) {
    return { status: "already-converted", draftId: alreadyConverted };
  }
  let content = input.content;
  let reservation: LandingImageBudgetReservation | null = null;
  try {
    const imported = await importImagesIntoLanding({
      content: input.content,
      blobHashes: input.blobHashes,
      readBlob: input.readBlob,
      draftId: null,
    });
    if (imported !== null) {
      content = imported.content;
      reservation = imported.reservation;
    }
  } catch (error: unknown) {
    if (
      !(error instanceof ImageBlobMissingError) &&
      !(error instanceof ImageBlobCorruptError)
    ) {
      throw error;
    }
  }
  try {
    // Re-checked after the image reads: a peer window may have converted this
    // same id into the shared map while they were in flight.
    const raced = convertedDraftIdFor(input.stashId);
    if (raced !== null) return { status: "already-converted", draftId: raced };
    // SYNCHRONOUS with the install below, with no await between them. Every
    // await above this line - the blob reads, the `putImage` writes, and this
    // function's own suspension for an entry with no images at all - is a
    // window in which the account could have changed.
    if (!input.stillCurrent()) return { status: "abandoned" };
    const draftId = mintDraftId();
    useLandingDraftStore.getState().installLandingDraft({
      id: draftId,
      content,
      selection: null,
      lastTouchedAt: input.lastTouchedAt,
      settings: useComposerRunSettingsStore
        .getState()
        .getGlobalRunSettings(readComposerHostIdSnapshot()),
      composerMode: "chat",
      workspace: emptyLandingDraftWorkspaceSnapshot(),
      closed: true,
    });
    // `installLandingDraft` only reaches the store. On desktop the row is
    // persisted by the per-window projection, which debounces 100ms and is
    // the ONLY writer there (localStorage persistence is off while the
    // bridge is installed), so recording the receipt before that write lands
    // would let a renderer exit leave the map saying "done" with nothing on
    // disk. Browser mode has no bridge and resolves immediately.
    //
    // A rejected flush throws out of here with the map unwritten and the
    // source untouched: the in-memory row still rides the next projection,
    // and the worst case is one duplicate on the next launch, never a loss.
    await flushActiveDesktopPerWindowProjection();
    rememberConverted(input.stashId, draftId);
    return { status: "converted", draftId };
  } finally {
    // Always: an install or flush that threw must not pin the reservation
    // for the rest of the session.
    reservation?.release();
  }
}

/**
 * The landing store must hold its real drafts before the first row is
 * installed: on desktop the per-window projection arrives over IPC and is
 * authoritative when it does, replacing whatever is in the store. Polls the
 * one-shot gate `landing-image-gc` already keeps for the same question (it
 * has no subscription seam), and gives up after ~10s - the database is left
 * for the next launch.
 */
async function landingDraftsAreReady(): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (landingDraftsReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Convert every local stash entry that has not been converted yet, newest
 * first, then drop the database once the shared map accounts for all of
 * them. Never rejects: a failure logs at `warn` and leaves the database for
 * the next launch.
 */
export async function migrateLocalStash(): Promise<void> {
  try {
    if (!(await landingDraftsAreReady())) return;
    const db = await openStashDb();
    if (db === null) return;
    try {
      const entries = (await readStashEntries(db))
        .map(parseStashEntry)
        .filter((entry): entry is StashEntryRecord => entry !== null)
        .toSorted((left, right) => right.createdAt - left.createdAt);
      // `now - rank` keeps the stash's own order while putting every migrated
      // row at the top of the list on this first launch - and out of the
      // front of the adopted-mirror LRU, which evicts oldest first (C4).
      const migrationStart = Date.now();
      // Captured ONCE, before the first conversion. The pass can run for
      // seconds across many entries, and every one of them installs into a
      // per-window store with no account of its own - so the fence has to name
      // the account this migration BELONGS to, not whichever one happens to be
      // current when a given entry finishes.
      const migrationOwner = currentDraftBlobOwnerId();
      const stillCurrent = (): boolean =>
        currentDraftBlobOwnerId() === migrationOwner;
      for (const [rank, entry] of entries.entries()) {
        const outcome = await convertStashEntry({
          stashId: entry.id,
          content: entry.content,
          blobHashes: entry.blobHashes,
          lastTouchedAt: migrationStart - rank,
          readBlob: (hash) => readStashBlob(db, hash),
          stillCurrent,
        });
        // Stop the whole pass, not just this entry. The account moved, so
        // every remaining entry would be refused for the same reason - and
        // the database has to survive for the next launch to convert them
        // under the right account, which the `remaining` gate below ensures
        // because no receipt was written for any of them.
        if (outcome.status === "abandoned") return;
      }
      // Re-read rather than trust the loop: a peer window may have written
      // entries while this one ran, and its conversions may not be in the
      // map yet either.
      const remaining = (await readStashEntries(db))
        .map(parseStashEntry)
        .filter((entry): entry is StashEntryRecord => entry !== null);
      const converted = readConvertedMap();
      if (remaining.some((entry) => !Object.hasOwn(converted, entry.id)))
        return;
      db.close();
      await deleteStashDb();
    } finally {
      db.close();
    }
  } catch (error: unknown) {
    appLogger.warn("[stash-migration] local stash migration failed", {
      error: describeLogError(error),
    });
  }
}

let started = false;

/** Runs the local migration once per renderer. */
export function startLocalStashMigration(): void {
  if (started) return;
  started = true;
  void migrateLocalStash();
}

export function resetStashMigrationForTests(): void {
  started = false;
  conversionsInFlight.clear();
  window.localStorage.removeItem(CONVERTED_MAP_KEY);
}
