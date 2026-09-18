/**
 * Local IndexedDB stash -> closed start-page drafts (D19). The stash schema
 * is driven through a real `fake-indexeddb` database, so the reader's
 * version pin and its refusal to CREATE the database are exercised for real;
 * the landing image partition is the usual `idb-keyval` fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ImageBlob } from "@/lib/attachments/image-bytes";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import { getImageBytes } from "@/lib/composer/landing-image-store";
import {
  STASH_DB_NAME,
  convertStashEntry,
  migrateLocalStash,
  resetStashMigrationForTests,
} from "@/lib/drafts/stash-migration";
import { setActiveDesktopPerWindowProjectionBridge } from "@/lib/windows/per-window-projection-debounce";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

const idbData = vi.hoisted(() => new Map<string, unknown>());

function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("idb keys in these tests are strings");
  }
  return key;
}

vi.mock("idb-keyval", () => {
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: IDBValidKey) =>
      Promise.resolve(idbData.get(idbStringKey(key))),
    ),
    set: vi.fn((key: IDBValidKey, value: unknown) => {
      idbData.set(idbStringKey(key), value);
      return Promise.resolve();
    }),
    setMany: vi.fn((entries: ReadonlyArray<[IDBValidKey, unknown]>) => {
      for (const [key, value] of entries) {
        idbData.set(idbStringKey(key), value);
      }
      return Promise.resolve();
    }),
    del: vi.fn((key: IDBValidKey) => {
      idbData.delete(idbStringKey(key));
      return Promise.resolve();
    }),
    delMany: vi.fn((keys: ReadonlyArray<IDBValidKey>) => {
      for (const key of keys) idbData.delete(idbStringKey(key));
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
  };
});

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  }),
}));

interface SeedEntry {
  readonly id: string;
  readonly createdAt: number;
  readonly content: JsonContent;
  readonly blobHashes: readonly string[];
}

interface SeedBlob {
  readonly hash: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly byteLength: number;
  readonly mimeType: string;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function imageDoc(text: string, hash: string, size: number): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text },
          {
            type: "imageAttachment",
            attrs: {
              id: `node-${hash.slice(0, 6)}`,
              fileName: "shot.png",
              hash,
              b64content: null,
              mimeType: "image/png",
              size,
            },
          },
        ],
      },
    ],
  };
}

/** Writes the v2 schema `prompt-stash-repository.ts` owns, then closes. */
function seedStashDb(
  entries: readonly SeedEntry[],
  blobs: readonly SeedBlob[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STASH_DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("entries", { keyPath: "id" });
      db.createObjectStore("blobs", { keyPath: "hash" });
      db.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(["entries", "blobs"], "readwrite");
      for (const entry of entries) tx.objectStore("entries").put(entry);
      for (const blob of blobs) tx.objectStore("blobs").put(blob);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error ?? new Error("seed failed"));
    };
    request.onerror = () => reject(request.error ?? new Error("open failed"));
  });
}

async function databaseNames(): Promise<string[]> {
  const databases = await indexedDB.databases();
  return databases
    .map((database) => database.name)
    .filter((name): name is string => name !== undefined);
}

async function seedTwoEntries(): Promise<{
  readonly newerHash: string;
  readonly olderHash: string;
}> {
  const newerBytes = new Uint8Array([1, 2, 3, 4]);
  const olderBytes = new Uint8Array([9, 9, 9]);
  const newerHash = await sha256Hex(newerBytes);
  const olderHash = await sha256Hex(olderBytes);
  await seedStashDb(
    [
      {
        id: "stash-older",
        createdAt: 100,
        content: imageDoc("older", olderHash, olderBytes.byteLength),
        blobHashes: [olderHash],
      },
      {
        id: "stash-newer",
        createdAt: 200,
        content: imageDoc("newer", newerHash, newerBytes.byteLength),
        blobHashes: [newerHash],
      },
    ],
    [
      {
        hash: newerHash,
        bytes: newerBytes,
        byteLength: newerBytes.byteLength,
        mimeType: "image/png",
      },
      {
        hash: olderHash,
        bytes: olderBytes,
        byteLength: olderBytes.byteLength,
        mimeType: "image/png",
      },
    ],
  );
  return { newerHash, olderHash };
}

function draftTexts(): string[] {
  return useLandingDraftStore.getState().drafts.map((draft) => {
    const paragraph = draft.content.content?.[0];
    const text = paragraph?.content?.[0]?.text;
    return text ?? "";
  });
}

function signedInAs(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

beforeEach(() => {
  installFreshIndexedDb();
  idbData.clear();
  window.localStorage.clear();
  resetStashMigrationForTests();
  resetLandingImageBudgetReservationsForTesting();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

afterEach(() => {
  setActiveDesktopPerWindowProjectionBridge(null);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  vi.restoreAllMocks();
});

describe("local stash migration", () => {
  it("converts every entry into a closed landing draft, newest first, without touching the active draft", async () => {
    const { newerHash, olderHash } = await seedTwoEntries();
    useLandingDraftStore.setState({ activeDraftId: "live-draft" });

    await migrateLocalStash();

    const drafts = useLandingDraftStore.getState().drafts;
    expect(drafts).toHaveLength(2);
    expect(drafts.every((draft) => draft.closed)).toBe(true);
    expect(drafts.every((draft) => draft.adoption.state === "unadopted")).toBe(
      true,
    );
    // Newest stash entry keeps the highest `lastTouchedAt`, so the list orders
    // migrated rows the way the stash did.
    const byTime = [...drafts].toSorted(
      (left, right) => right.lastTouchedAt - left.lastTouchedAt,
    );
    expect(byTime[0]?.content.content?.[0]?.content?.[0]?.text).toBe("newer");
    expect(byTime[1]?.content.content?.[0]?.content?.[0]?.text).toBe("older");
    expect(byTime[0]?.lastTouchedAt).toBeGreaterThan(
      byTime[1]?.lastTouchedAt ?? 0,
    );
    // The active draft is the user's, never the migration's (C4).
    expect(useLandingDraftStore.getState().activeDraftId).toBe("live-draft");
    // Bytes moved into this window's landing partition under the same
    // content hash, so the rewritten nodes resolve.
    expect(await getImageBytes(newerHash)).toBeDefined();
    expect(await getImageBytes(olderHash)).toBeDefined();
    // Every id is converted, so the database is gone.
    expect(await databaseNames()).not.toContain(STASH_DB_NAME);
  });

  it("converts nothing on a second run over the same entries", async () => {
    await seedTwoEntries();
    await migrateLocalStash();
    expect(useLandingDraftStore.getState().drafts).toHaveLength(2);

    // A peer window (or a host that re-listed them) leaves the same entries
    // behind: the app-global converted map is what makes this a no-op.
    await seedTwoEntries();
    await migrateLocalStash();

    expect(useLandingDraftStore.getState().drafts).toHaveLength(2);
    expect(draftTexts().toSorted()).toEqual(["newer", "older"]);
  });

  it("leaves the database in place when an entry could not be converted", async () => {
    await seedTwoEntries();
    vi.spyOn(
      useLandingDraftStore.getState(),
      "installLandingDraft",
    ).mockImplementationOnce(() => {
      throw new Error("install refused");
    });

    await migrateLocalStash();

    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
    expect(await databaseNames()).toContain(STASH_DB_NAME);
  });

  it("stops the pass and keeps the database when the account changes mid-run (DRIVE RED)", async () => {
    // The migration runs once per launch across every entry, and each install
    // lands in a per-WINDOW store with no account of its own. A switch partway
    // through would file the rest of the outgoing account's prompts in the
    // incoming account's Drafts list - so the fence is captured once, at the
    // start, and a refusal ends the pass rather than skipping one entry.
    await seedTwoEntries();
    signedInAs("user-migration");
    const installed: string[] = [];
    const realInstall = useLandingDraftStore.getState().installLandingDraft;
    vi.spyOn(
      useLandingDraftStore.getState(),
      "installLandingDraft",
    ).mockImplementation((input) => {
      installed.push(input.id);
      // The switch lands after the FIRST row is in, so the second entry meets
      // a moved account.
      signedInAs("somebody-else");
      return realInstall(input);
    });

    await migrateLocalStash();

    expect(installed).toHaveLength(1);
    expect(draftTexts()).toEqual(["newer"]);
    // The abandoned entry wrote no receipt, so the `remaining` gate keeps the
    // database for the next launch to convert it under the right account.
    expect(await databaseNames()).toContain(STASH_DB_NAME);
    const converted: unknown = JSON.parse(
      window.localStorage.getItem("traycer-gui-app:stash-migration") ?? "{}",
    );
    expect(Object.keys(converted as Record<string, string>)).toEqual([
      "stash-newer",
    ]);
  });

  it("does not create the stash database when there is none", async () => {
    await migrateLocalStash();

    expect(await databaseNames()).toEqual([]);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
  });

  it("records nothing and keeps the source when the desktop projection flush fails", async () => {
    await seedTwoEntries();
    // The desktop writer for landing drafts. A rejected flush means the row
    // reached the store and not the disk, so the receipt must not be written.
    setActiveDesktopPerWindowProjectionBridge({
      update: () => Promise.resolve(),
      flush: () => Promise.reject(new Error("no ipc")),
      dispose: () => undefined,
    });

    await migrateLocalStash();

    expect(window.localStorage.getItem("traycer-gui-app:stash-migration")).toBe(
      null,
    );
    expect(await databaseNames()).toContain(STASH_DB_NAME);
  });

  it("converts a stash id once when two callers race on it", async () => {
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const hash = await sha256Hex(bytes);
    let resolveBlob: (blob: ImageBlob | null) => void = () => undefined;
    const deferred = new Promise<ImageBlob | null>((resolve) => {
      resolveBlob = resolve;
    });
    const args = {
      stashId: "stash-raced",
      content: imageDoc("raced", hash, bytes.byteLength),
      blobHashes: [hash],
      lastTouchedAt: 500,
      readBlob: () => deferred,
      stillCurrent: () => true,
    };

    // The local IndexedDB pass and a host apply of the same id, overlapping:
    // the map is only written at the end, so the second caller has to join
    // the first rather than pass the same check.
    const first = convertStashEntry(args);
    const second = convertStashEntry(args);
    resolveBlob({ bytes, mimeType: "image/png" });
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(firstOutcome.status).toBe("converted");
    // The JOINER, not a second conversion: both calls share one promise, so
    // the loser sees the winner's own outcome rather than `already-converted`.
    expect(secondOutcome).toEqual(firstOutcome);
  });
});
