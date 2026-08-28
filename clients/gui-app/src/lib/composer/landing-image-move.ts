/**
 * Cross-window image-byte handoff for a landing draft MOVE.
 *
 * A draft's persisted content is hash-only, and each window keeps its image
 * bytes in its OWN IndexedDB partition (`landing-image-store`). Moving a draft
 * to a new window therefore has to move bytes too, but the destination's
 * partition is keyed by a windowId that does not exist until the move IPC has
 * created the window - by which point its renderer is already loading. The
 * handoff closes that gap with a third, draftId-keyed database:
 *
 *   source:      stageDraftImageHandoff  - copy the draft's bytes into
 *                `…:draft-move:{draftId}:landing-images` BEFORE the move IPC.
 *   destination: adoptDraftImageHandoff  - on first projection, any referenced
 *                hash missing from the local partition is imported from the
 *                handoff DB (via `putImage`, which re-hashes and so verifies
 *                content addressing), then the handoff DB is deleted.
 *   source:      discardDraftImageHandoff - delete the handoff when the move
 *                is refused, so a cancelled move leaves nothing behind.
 *
 * Adoption is self-gating (it only opens the handoff DB when a hash is
 * actually missing locally), so ordinary restores never touch it, and a
 * destination that crashed before adopting simply retries on its next launch -
 * the handoff DB is deleted only after an adoption pass ran.
 *
 * The handoff DB is driven with RAW IndexedDB rather than `idb-keyval`
 * deliberately: `createStore` holds its connection open forever (no close is
 * exposed), and `indexedDB.deleteDatabase` BLOCKS until every connection to
 * that database closes - so a delete after an idb-keyval read/write in the
 * same window never resolves, silently stranding the handoff. Every open here
 * is paired with a `close()` before any delete can run. (The schema matches
 * what `createStore(name, "bytes")` would produce - version 1, one "bytes"
 * store - so tooling can still read a staged handoff either way.)
 */

import type { JsonContent } from "@traycer/protocol/common/registry";

import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { getImageBytes, putImage } from "@/lib/composer/landing-image-store";
import { PERSIST_PREFIX } from "@/lib/persist/keys";

const HANDOFF_OBJECT_STORE = "bytes";

function handoffDbName(draftId: string): string {
  return `${PERSIST_PREFIX}:draft-move:${draftId}:landing-images`;
}

function awaitRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed"));
    };
  });
}

function openHandoffDb(draftId: string): Promise<IDBDatabase> {
  const request = indexedDB.open(handoffDbName(draftId), 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(HANDOFF_OBJECT_STORE)) {
      request.result.createObjectStore(HANDOFF_OBJECT_STORE);
    }
  };
  return awaitRequest(request);
}

function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    };
  });
}

/**
 * Whether the draft's handoff DB exists, without creating it. A draft can
 * reference a hash that is missing locally AND was never staged (a manually
 * wiped restore); without this check every adoption probe for it would create
 * an empty handoff DB just to delete it again. `databases()` is feature-probed
 * because not every engine ships it; when absent the answer defaults to true
 * and the open-adopt-delete path handles the empty DB as before.
 */
async function handoffDbExists(draftId: string): Promise<boolean> {
  if (typeof indexedDB.databases !== "function") return true;
  const name = handoffDbName(draftId);
  const databases = await indexedDB.databases();
  return databases.some((info) => info.name === name);
}

function deleteHandoffDb(draftId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(handoffDbName(draftId));
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error("deleteDatabase failed"));
    };
    // Another WINDOW holding the DB open defers the delete; the request still
    // completes once it closes, so treat blocked as pending, not failed. This
    // window's own connections are all closed before a delete is issued - see
    // the module doc - so a block can only be cross-window.
    request.onblocked = () => undefined;
  });
}

/** Distinct image hashes referenced by a draft's content, in document order. */
export function draftImageHashes(content: JsonContent): ReadonlyArray<string> {
  const hashes = new Set<string>();
  for (const atom of collectImageAtoms(content)) {
    if (atom.hash !== null) hashes.add(atom.hash);
  }
  return [...hashes];
}

/**
 * Whether the draft still holds an attachment that has not finished ingesting.
 * An in-place structured paste leaves the image in the document as base64 with
 * NO hash until the background `putImage` rewrites that node
 * (`startPendingImageIngest`), and such an atom is invisible to every part of
 * the move: `draftImageHashes` has no hash to stage, and the desktop
 * projection strips base64 before the snapshot the destination is seeded from.
 * Moving in that gap would carry the draft over without the attachment and
 * then close the only copy that still had it - so the move waits it out.
 */
export function draftHasIngestingImages(content: JsonContent): boolean {
  return collectImageAtoms(content).some((atom) => atom.hash === null);
}

/**
 * Copy the draft's reachable bytes into its handoff DB. A hash with no local
 * bytes (a manually wiped restore) is skipped: the moved draft renders that
 * chip broken in the destination exactly as it would have here, and the move
 * itself must not be blocked on it. No handoff DB is created when nothing is
 * reachable.
 */
export async function stageDraftImageHandoff(
  draftId: string,
  hashes: ReadonlyArray<string>,
): Promise<void> {
  const entries: Array<readonly [string, Uint8Array<ArrayBuffer>]> = [];
  for (const hash of hashes) {
    const bytes = await getImageBytes(hash);
    if (bytes === undefined) continue;
    entries.push([hash, bytes]);
  }
  if (entries.length === 0) return;
  const db = await openHandoffDb(draftId);
  try {
    const tx = db.transaction(HANDOFF_OBJECT_STORE, "readwrite");
    const store = tx.objectStore(HANDOFF_OBJECT_STORE);
    for (const [hash, bytes] of entries) {
      store.put(bytes, hash);
    }
    await awaitTransaction(tx);
  } finally {
    db.close();
  }
}

/**
 * Import any of `hashes` missing from this window's partition from the
 * draft's handoff DB, then delete the handoff. No-op (and no handoff DB is
 * created) when every hash is already locally reachable, or when nothing was
 * ever staged for the draft.
 */
export async function adoptDraftImageHandoff(
  draftId: string,
  hashes: ReadonlyArray<string>,
): Promise<void> {
  const missing: string[] = [];
  for (const hash of hashes) {
    if ((await getImageBytes(hash)) === undefined) missing.push(hash);
  }
  if (missing.length === 0) return;
  if (!(await handoffDbExists(draftId))) return;
  const db = await openHandoffDb(draftId);
  const imported: Array<Uint8Array<ArrayBuffer>> = [];
  try {
    const tx = db.transaction(HANDOFF_OBJECT_STORE, "readonly");
    const store = tx.objectStore(HANDOFF_OBJECT_STORE);
    const values = await Promise.all(
      missing.map((hash) => awaitRequest<unknown>(store.get(hash))),
    );
    for (const value of values) {
      // Copy into a fresh plain-ArrayBuffer view: narrows the untyped IDB
      // read to exactly what `putImage` takes, whatever realm or buffer kind
      // the driver handed back.
      if (ArrayBuffer.isView(value)) {
        imported.push(
          new Uint8Array(
            new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
          ),
        );
      }
    }
  } finally {
    db.close();
  }
  // `putImage` re-hashes the bytes, so a corrupted or mismatched handoff entry
  // lands under its true hash and simply stays "missing" for the draft - it
  // can never impersonate the expected content.
  for (const bytes of imported) {
    await putImage(bytes);
  }
  await deleteHandoffDb(draftId);
}

/** Source-side cleanup for a refused or failed move. */
export function discardDraftImageHandoff(draftId: string): Promise<void> {
  return deleteHandoffDb(draftId);
}
