/**
 * Shared fixtures and IDB helpers for prompt-stash repository split suites.
 */
import { expect } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type {
  PromptStashEntry,
  PromptStashImageBlob,
  PromptStashManifest,
  PromptStashRestoreBlob,
  PromptStashRestoreRead,
  PromptStashSnapshot,
} from "@/lib/composer/prompt-stash-codec";
import { installFreshIndexedDb } from "./prompt-stash-fake-idb";

export { installFreshIndexedDb };
export type { PromptStashEntry, PromptStashManifest, PromptStashSnapshot };

export const DB_NAME = "traycer-gui-app:prompt-stash";

export type RepoModule =
  typeof import("@/lib/composer/prompt-stash-repository");

export async function loadRepo(): Promise<RepoModule> {
  return import("@/lib/composer/prompt-stash-repository");
}

export function bytesOf(values: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

/** Real PNG signature so restore-side MIME/signature validation accepts fixtures. */
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngBytesOf(extra: readonly number[]): Uint8Array<ArrayBuffer> {
  return bytesOf([...PNG_SIGNATURE, ...extra]);
}

/** Minimal JPEG SOI marker used for signature-vs-MIME mismatch regressions. */
export const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

export function jpegBytesOf(extra: readonly number[]): Uint8Array<ArrayBuffer> {
  return bytesOf([...JPEG_SIGNATURE, ...extra]);
}

export function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

export function imageDoc(hash: string, nodeId: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: nodeId,
              fileName: "shot.png",
              hash,
              b64content: null,
              mimeType: "image/png",
              size: 3,
            },
          },
        ],
      },
    ],
  };
}

export function textEntry(
  id: string,
  createdAt: number,
  text: string,
): PromptStashEntry {
  return {
    id,
    createdAt,
    content: textDoc(text),
    blobHashes: [],
  };
}

export function imageEntry(
  id: string,
  createdAt: number,
  hash: string,
): PromptStashEntry {
  return {
    id,
    createdAt,
    content: imageDoc(hash, `img-${id}`),
    blobHashes: [hash],
  };
}

export function snapshotFor(
  stashEntry: PromptStashEntry,
  images: ReadonlyArray<readonly [string, Uint8Array<ArrayBuffer>]>,
): PromptStashSnapshot {
  const imagesByHash = new Map<string, PromptStashImageBlob>();
  for (const [hash, bytes] of images) {
    imagesByHash.set(hash, { bytes, mimeType: "image/png" });
  }
  return { entry: stashEntry, imagesByHash };
}

export function textSnapshot(
  stashEntry: PromptStashEntry,
): PromptStashSnapshot {
  return snapshotFor(stashEntry, []);
}

export function openDb(
  name: string,
  version: number | undefined,
  onUpgrade: ((db: IDBDatabase) => void) | undefined,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? indexedDB.open(name)
        : indexedDB.open(name, version);
    if (onUpgrade !== undefined) {
      request.onupgradeneeded = () => {
        onUpgrade(request.result);
      };
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("openDb failed"));
  });
}

export function requestToPromise<T>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () =>
      reject(request.error ?? new Error("IDB request failed"));
  });
}

export function transactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function listStoreKeys(
  storeName: string,
): Promise<ReadonlyArray<IDBValidKey>> {
  const db = await openDb(DB_NAME, undefined, undefined);
  try {
    const tx = db.transaction(storeName, "readonly");
    const keys = await requestToPromise<IDBValidKey[]>(
      tx.objectStore(storeName).getAllKeys(),
    );
    await transactionComplete(tx);
    return keys;
  } finally {
    db.close();
  }
}

export async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  const db = await openDb(DB_NAME, undefined, undefined);
  try {
    const tx = db.transaction(storeName, "readonly");
    const values = await requestToPromise<T[]>(
      tx.objectStore(storeName).getAll(),
    );
    await transactionComplete(tx);
    return values;
  } finally {
    db.close();
  }
}

export async function putBlobRecord(record: {
  readonly hash: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly byteLength: number;
  readonly mimeType: string;
}): Promise<void> {
  const db = await openDb(DB_NAME, undefined, undefined);
  try {
    const tx = db.transaction("blobs", "readwrite");
    await requestToPromise(tx.objectStore("blobs").put(record));
    await transactionComplete(tx);
  } finally {
    db.close();
  }
}

export async function seedDevOnlyStashStore(): Promise<void> {
  const db = await openDb(DB_NAME, 1, (opened) => {
    if (!opened.objectStoreNames.contains("stash")) {
      opened.createObjectStore("stash");
    }
  });
  const tx = db.transaction("stash", "readwrite");
  await requestToPromise(tx.objectStore("stash").put("legacy", "entries:v1"));
  await transactionComplete(tx);
  db.close();
}

export function objectStoreNamesOf(db: IDBDatabase): string[] {
  return Array.from(db.objectStoreNames).toSorted();
}

/**
 * fake-indexeddb structured-clones TypedArrays across its own realm, so
 * `instanceof Uint8Array` and vitest's deep-equal can fail even when the value
 * is a genuine Uint8Array view with the right bytes. Assert by shape + content.
 */
export function expectUint8ArrayBytes(
  value: unknown,
  expected: readonly number[],
): asserts value is Uint8Array {
  expect(ArrayBuffer.isView(value)).toBe(true);
  expect(Object.prototype.toString.call(value)).toBe("[object Uint8Array]");
  const view = value as ArrayBufferView;
  expect(view.byteLength).toBe(expected.length);
  expect(
    Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
  ).toEqual([...expected]);
}

export async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function entryRow(entry: PromptStashEntry) {
  return { kind: "entry" as const, entry };
}

export function restoreBlobsOk(
  result: PromptStashRestoreRead,
): ReadonlyMap<string, PromptStashRestoreBlob> {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") {
    throw new Error("expected restore blobs status ok");
  }
  return result.blobs;
}
