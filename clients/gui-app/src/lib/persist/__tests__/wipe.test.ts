import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

// Mock the projection-debounce module so `flushActiveDesktopPerWindowProjection`
// is observable; the real implementation would no-op without an active bridge,
// but the spy lets us assert the `hostClear === null` fallback path.
const flushActiveDesktopPerWindowProjection = vi.fn<() => Promise<void>>(() =>
  Promise.resolve(),
);
const drainDesktopTabsPersistence = vi.fn<() => Promise<void>>(() =>
  Promise.resolve(),
);
const resetTabRecoveryHistory = vi.fn<() => Promise<void>>(() =>
  Promise.resolve(),
);
vi.mock("@/lib/windows/per-window-projection-debounce", () => ({
  flushActiveDesktopPerWindowProjection: () =>
    flushActiveDesktopPerWindowProjection(),
}));
vi.mock("@/stores/tabs/desktop-tabs-persistence", () => ({
  drainDesktopTabsPersistence: () => drainDesktopTabsPersistence(),
}));
vi.mock("@/lib/tab-recovery/history", () => ({
  resetTabRecoveryHistory: () => resetTabRecoveryHistory(),
}));

// The real module reaches `idb-keyval` on first use, which jsdom has no
// native support for. Mocked wholesale; the wipe's OWN handling of it
// (calling it, tolerating its rejection, and deleting its fixed db name
// unconditionally) is what this file tests.
// `vi.mock` factories run during import resolution - which, for ES modules,
// happens BEFORE any of this file's own top-level `const`s execute (imports
// hoist above regular statements). A factory that closes over a later
// `const` in this same file hits its temporal dead zone; `vi.hoisted` runs
// before the mock factory needs it instead.
const { clearAppearanceCache, APPEARANCE_DB_NAME } = vi.hoisted(() => ({
  clearAppearanceCache: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  APPEARANCE_DB_NAME: "traycer-gui-app:appearance",
}));
vi.mock("@/lib/appearance/appearance-cache", () => ({
  APPEARANCE_DB_NAME,
  clearAppearanceCache: () => clearAppearanceCache(),
}));

import { clearAllPersistedStores } from "@/lib/persist/wipe";
import { STASH_DB_NAME } from "@/lib/drafts/stash-migration";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";
import {
  deferJsonWrite,
  cancelDeferredJsonWrites,
  flushDeferredJsonWrite,
} from "@/lib/persist/deferred-json-storage";
import { composerDraftRowPrefix, persistKey } from "@/lib/persist/keys";
import {
  EMPTY_COMPOSER_DRAFT,
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import {
  ANON_NAME,
  textDoc,
} from "@/stores/composer/__tests__/composer-draft-rows";
import { SKELETON_RESUME_DB_NAME } from "@/stores/chats/skeleton-resume-durable-cache";

const SKELETON_RESUME_PRESENT_KEY = persistKey(
  "chat-skeleton-resume-present-v1",
);

function createMockStorage(seed: Record<string, string>): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function snapshotKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys.sort();
}

// Seed both storages with: real persisted keys (on the `:` boundary), an auth
// key (`traycer.` prefix), an unrelated key, and the tricky `traycer-gui-appX:`
// key that must survive because it is NOT on the `traycer-gui-app:` boundary.
const LOCAL_SEED: Record<string, string> = {
  "traycer-gui-app:settings": "{}",
  "traycer-gui-app:composer-run-settings:anon": "{}",
  "traycer-gui-app:open-epic:u1:e1": "{}",
  "traycer-gui-app:reading-position:u1:epic-1:view:native:tile-1": "{}",
  [SKELETON_RESUME_PRESENT_KEY]: '["account-scoped-chat-key"]',
  "traycer.token": "secret-auth-token",
  "some-unrelated-key": "keep-me",
  "traycer-gui-appX:foo": "must-not-be-swept",
};

const SESSION_SEED: Record<string, string> = {
  "traycer-gui-app:consumed-initial-route:w1:/home": "1",
  "traycer-gui-app:tabs": "{}",
  "traycer.session": "secret-session",
  "unrelated-session-key": "keep-me-too",
  "traycer-gui-appX:bar": "must-not-be-swept",
};

// A minimal `IDBOpenDBRequest` stand-in: `deleteDatabase` returns it and we
// fire `onsuccess` on the next microtask so the awaited deletion resolves.
function fakeDeleteRequest(): {
  request: {
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    onblocked: (() => void) | null;
    error: DOMException | null;
  };
  fire: () => void;
} {
  const request = {
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onblocked: null as (() => void) | null,
    error: null as DOMException | null,
  };
  return { request, fire: () => request.onsuccess?.() };
}

let localStorageMock: Storage;
let sessionStorageMock: Storage;
let reloadSpy: Mock<() => void>;

beforeEach(() => {
  flushActiveDesktopPerWindowProjection.mockClear();
  drainDesktopTabsPersistence.mockClear();
  resetTabRecoveryHistory.mockReset();
  resetTabRecoveryHistory.mockResolvedValue(undefined);
  clearAppearanceCache.mockClear();
  clearAppearanceCache.mockResolvedValue(undefined);

  localStorageMock = createMockStorage(LOCAL_SEED);
  sessionStorageMock = createMockStorage(SESSION_SEED);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: localStorageMock,
  });
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    writable: true,
    value: sessionStorageMock,
  });

  // jsdom's `window.location.reload` is "Not implemented" and throws; replace
  // the whole `location` object with a spy-backed clone so the reload call is
  // observable and lint-clean (no `as any` cast of the native method).
  reloadSpy = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...window.location, reload: reloadSpy },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clearAllPersistedStores — blanket-prefix sweep", () => {
  it("removes only `traycer-gui-app:`-boundary keys from BOTH storages; auth + unrelated + `traycer-gui-appX` survive", async () => {
    await clearAllPersistedStores({ hostClear: null });

    expect(snapshotKeys(localStorageMock)).toEqual(
      ["traycer.token", "some-unrelated-key", "traycer-gui-appX:foo"].sort(),
    );
    expect(localStorageMock.getItem(SKELETON_RESUME_PRESENT_KEY)).toBeNull();
    expect(snapshotKeys(sessionStorageMock)).toEqual(
      [
        "traycer.session",
        "unrelated-session-key",
        "traycer-gui-appX:bar",
      ].sort(),
    );
  });

  it("drains source and tabs projections BEFORE the provided `hostClear`", async () => {
    const order: string[] = [];
    flushActiveDesktopPerWindowProjection.mockImplementation(() => {
      order.push("source-drain");
      return Promise.resolve();
    });
    drainDesktopTabsPersistence.mockImplementation(() => {
      order.push("tabs-drain");
      return Promise.resolve();
    });
    const hostClear = vi.fn(() => {
      order.push("hostClear");
      return Promise.resolve();
    });

    await clearAllPersistedStores({ hostClear });

    expect(flushActiveDesktopPerWindowProjection).toHaveBeenCalledTimes(1);
    expect(drainDesktopTabsPersistence).toHaveBeenCalledTimes(1);
    expect(hostClear).toHaveBeenCalledTimes(1);
    // Drain MUST precede the clear so the unload-time flush can't re-push
    // pre-wipe state and resurrect the snapshot we just cleared.
    expect(order).toEqual(["source-drain", "tabs-drain", "hostClear"]);
  });

  it("falls back to `flushActiveDesktopPerWindowProjection` when `hostClear` is null", async () => {
    await clearAllPersistedStores({ hostClear: null });

    expect(flushActiveDesktopPerWindowProjection).toHaveBeenCalledTimes(1);
  });

  it("reloads the window LAST — after the awaited clear and the sweep", async () => {
    const order: string[] = [];

    const hostClear = vi.fn(() => {
      order.push("hostClear");
      return Promise.resolve();
    });
    vi.spyOn(localStorageMock, "removeItem").mockImplementation((key) => {
      order.push(`local:removeItem:${key}`);
    });
    vi.spyOn(sessionStorageMock, "removeItem").mockImplementation((key) => {
      order.push(`session:removeItem:${key}`);
    });
    reloadSpy.mockImplementation(() => {
      order.push("reload");
    });

    await clearAllPersistedStores({ hostClear });

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    // reload is the final action.
    expect(order[order.length - 1]).toBe("reload");
    // hostClear precedes every sweep removal.
    expect(order[0]).toBe("hostClear");
    // Seven seeded prefix keys are swept (5 local incl. the resume presence
    // hint + 2 session); the resume clear removes its presence hint again
    // after the sweep, and the composer draft clear issues its own (no-op)
    // `removeItem` of its legacy blob key.
    expect(order.filter((e) => e.includes("removeItem")).length).toBe(9);
  });

  it("awaits `hostClear` BEFORE sweeping (a rejecting clear aborts the sweep + reload)", async () => {
    const order: string[] = [];
    const hostClear = vi.fn(() => {
      order.push("hostClear");
      return Promise.reject(new Error("clear failed"));
    });
    vi.spyOn(localStorageMock, "removeItem").mockImplementation(() => {
      order.push("local:removeItem");
    });

    await expect(clearAllPersistedStores({ hostClear })).rejects.toThrow(
      "clear failed",
    );

    expect(order).toEqual(["hostClear"]);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("does not tear down file-edit runtimes when `hostClear` rejects (mounted editors keep working)", async () => {
    const teardownSpy = vi
      .spyOn(fileEditRuntimeRegistry, "teardown")
      .mockResolvedValue(undefined);
    const hostClear = vi.fn(() => Promise.reject(new Error("clear failed")));

    await expect(clearAllPersistedStores({ hostClear })).rejects.toThrow(
      "clear failed",
    );

    expect(teardownSpy).not.toHaveBeenCalled();
  });

  it("tears down file-edit runtimes AFTER `hostClear` succeeds, before the storage sweep", async () => {
    const order: string[] = [];
    const teardownSpy = vi
      .spyOn(fileEditRuntimeRegistry, "teardown")
      .mockImplementation(() => {
        order.push("teardown");
        return Promise.resolve();
      });
    const hostClear = vi.fn(() => {
      order.push("hostClear");
      return Promise.resolve();
    });
    vi.spyOn(localStorageMock, "removeItem").mockImplementation(() => {
      order.push("local:removeItem");
    });

    await clearAllPersistedStores({ hostClear });

    expect(teardownSpy).toHaveBeenCalledTimes(1);
    const hostClearIndex = order.indexOf("hostClear");
    const teardownIndex = order.indexOf("teardown");
    const sweepIndex = order.indexOf("local:removeItem");
    expect(hostClearIndex).toBeLessThan(teardownIndex);
    expect(teardownIndex).toBeLessThan(sweepIndex);
  });

  it("stops before the sweep and reload when tab-recovery reset fails", async () => {
    resetTabRecoveryHistory.mockRejectedValueOnce(
      new Error("tab recovery reset failed"),
    );

    await expect(clearAllPersistedStores({ hostClear: null })).rejects.toThrow(
      "tab recovery reset failed",
    );

    expect(resetTabRecoveryHistory).toHaveBeenCalledTimes(1);
    expect(localStorageMock.getItem("traycer-gui-app:settings")).toBe("{}");
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe("clearAllPersistedStores — renderer IndexedDB drop", () => {
  // A mix of app-owned per-window partitions, a same-prefix db that is not one
  // of ours, and an unrelated db. Only the known renderer stores are deleted.
  const DB_NAMES = [
    "traycer-gui-app:default:landing-images",
    "traycer-gui-app:window-7:landing-images",
    "traycer-gui-app:default:file-edit-recovery",
    "traycer-gui-app:window-7:file-edit-recovery",
    "traycer-gui-app:anon:transcript-images",
    "traycer-gui-app:user-1:transcript-images",
    "traycer-gui-app:anon:transcript-image-meta",
    "traycer-gui-app:user-1:transcript-image-meta",
    "traycer-gui-app:some-other-store",
    "unrelated-app-db",
  ];

  // Install an `indexedDB` whose `deleteDatabase` records the name and returns a
  // request that auto-fires `onsuccess` on the next microtask (after the caller
  // has assigned its handlers), so the awaited deletion resolves.
  function installIndexedDB(args: {
    databases: () => Promise<{ name: string | undefined }[]>;
  }): { deleted: string[] } {
    const deleted: string[] = [];
    const value = {
      databases: vi.fn(args.databases),
      deleteDatabase: vi.fn((name: string) => {
        deleted.push(name);
        const { request, fire } = fakeDeleteRequest();
        queueMicrotask(fire);
        return request;
      }),
    };
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value,
    });
    return { deleted };
  }

  it("deletes known renderer dbs (including skeleton resume); same-prefix + unrelated dbs survive", async () => {
    const { deleted } = installIndexedDB({
      databases: () => Promise.resolve(DB_NAMES.map((name) => ({ name }))),
    });

    await clearAllPersistedStores({ hostClear: null });

    // Renderer partitions come from enumeration; the legacy stash, fixed
    // appearance, and skeleton resume db are deleted by exact name even when
    // enumeration never lists them.
    expect(deleted.sort()).toEqual(
      [
        "traycer-gui-app:default:landing-images",
        STASH_DB_NAME,
        "traycer-gui-app:appearance",
        "traycer-gui-app:window-7:landing-images",
        "traycer-gui-app:default:file-edit-recovery",
        "traycer-gui-app:window-7:file-edit-recovery",
        "traycer-gui-app:anon:transcript-images",
        "traycer-gui-app:user-1:transcript-images",
        "traycer-gui-app:anon:transcript-image-meta",
        "traycer-gui-app:user-1:transcript-image-meta",
        SKELETON_RESUME_DB_NAME,
        "traycer-gui-app:tab-recovery",
      ].sort(),
    );
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the appearance cache during the wipe", async () => {
    installIndexedDB({ databases: () => Promise.resolve([]) });

    await clearAllPersistedStores({ hostClear: null });

    expect(clearAppearanceCache).toHaveBeenCalledTimes(1);
  });

  it("deletes the fixed appearance database by name even when nothing enumerates it", async () => {
    const { deleted } = installIndexedDB({
      databases: () => Promise.resolve([]),
    });

    await clearAllPersistedStores({ hostClear: null });

    expect(deleted).toContain(APPEARANCE_DB_NAME);
  });

  it("deletes the skeleton resume presence hint and fixed database", async () => {
    const { deleted } = installIndexedDB({
      databases: () => Promise.resolve([]),
    });

    await clearAllPersistedStores({ hostClear: null });

    expect(localStorageMock.getItem(SKELETON_RESUME_PRESENT_KEY)).toBeNull();
    expect(deleted).toContain(SKELETON_RESUME_DB_NAME);
  });

  it("still reloads when clearAppearanceCache rejects (best-effort, does not abort the wipe)", async () => {
    installIndexedDB({ databases: () => Promise.resolve([]) });
    clearAppearanceCache.mockRejectedValueOnce(
      new Error("appearance clear failed"),
    );

    await clearAllPersistedStores({ hostClear: null });

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the appearance cache BEFORE dropping renderer databases and reloading", async () => {
    const order: string[] = [];
    clearAppearanceCache.mockImplementation(() => {
      order.push("appearance-clear");
      return Promise.resolve();
    });
    const value = {
      databases: vi.fn(() => Promise.resolve([])),
      deleteDatabase: vi.fn((name: string) => {
        order.push(`deleteDatabase:${name}`);
        const { request, fire } = fakeDeleteRequest();
        queueMicrotask(fire);
        return request;
      }),
    };
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value,
    });
    reloadSpy.mockImplementation(() => order.push("reload"));

    await clearAllPersistedStores({ hostClear: null });

    expect(order[0]).toBe("appearance-clear");
    expect(order[order.length - 1]).toBe("reload");
  });

  it("drops the dbs AFTER the storage sweep and BEFORE the reload", async () => {
    const order: string[] = [];
    const value = {
      databases: vi.fn(() =>
        Promise.resolve([{ name: "traycer-gui-app:default:landing-images" }]),
      ),
      deleteDatabase: vi.fn((name: string) => {
        order.push(`deleteDatabase:${name}`);
        const { request, fire } = fakeDeleteRequest();
        queueMicrotask(fire);
        return request;
      }),
    };
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value,
    });
    vi.spyOn(localStorageMock, "removeItem").mockImplementation(() => {
      order.push("local:removeItem");
    });
    reloadSpy.mockImplementation(() => order.push("reload"));

    await clearAllPersistedStores({ hostClear: null });

    const sweepIndex = order.indexOf("local:removeItem");
    const deleteIndex = order.indexOf(
      "deleteDatabase:traycer-gui-app:default:landing-images",
    );
    const reloadIndex = order.indexOf("reload");
    expect(sweepIndex).toBeLessThan(deleteIndex);
    expect(deleteIndex).toBeLessThan(reloadIndex);
  });

  it("still reloads when a renderer db deletion errors (best-effort)", async () => {
    // The first partition's delete fires `onerror`; the second succeeds. A single
    // erroring delete must NOT abort the wipe or the reload.
    const value = {
      databases: vi.fn(() =>
        Promise.resolve([
          { name: "traycer-gui-app:default:landing-images" },
          { name: "traycer-gui-app:window-7:landing-images" },
        ]),
      ),
      deleteDatabase: vi.fn((name: string) => {
        const request = {
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onblocked: null as (() => void) | null,
          error: new DOMException("delete failed"),
        };
        queueMicrotask(() =>
          name.includes("default")
            ? request.onerror?.()
            : request.onsuccess?.(),
        );
        return request;
      }),
    };
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value,
    });

    await expect(
      clearAllPersistedStores({ hostClear: null }),
    ).resolves.toBeUndefined();

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("still deletes the fixed legacy stash db when `indexedDB.databases` is absent", async () => {
    const deleteDatabase = vi.fn((_name: string) => {
      const { request, fire } = fakeDeleteRequest();
      queueMicrotask(fire);
      return request;
    });
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      // A shell IndexedDB with no `databases()` (non-Chromium engine).
      value: { deleteDatabase },
    });

    await expect(
      clearAllPersistedStores({ hostClear: null }),
    ).resolves.toBeUndefined();

    // Without enumeration, landing partitions cannot be found - accepted gap -
    // but the single known legacy stash name is always deleted.
    //
    // Deliberately the LITERAL historical name, not `STASH_DB_NAME`: this is
    // the one assertion that pins what the retired prompt-stash repository
    // actually wrote. Production, the migration reader and every other
    // assertion here share that constant, so a typo in it would leave the real
    // db on disk untouched while all of them still agreed with each other.
    expect(deleteDatabase).toHaveBeenCalledWith("traycer-gui-app:prompt-stash");
    expect(STASH_DB_NAME).toBe("traycer-gui-app:prompt-stash");
    expect(deleteDatabase).toHaveBeenCalledWith(
      "traycer-gui-app:anon:transcript-images",
    );
    expect(deleteDatabase).toHaveBeenCalledWith(
      "traycer-gui-app:anon:transcript-image-meta",
    );
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("still deletes the legacy stash db and reloads when database enumeration rejects", async () => {
    const deleteDatabase = vi.fn((_name: string) => {
      const { request, fire } = fakeDeleteRequest();
      queueMicrotask(fire);
      return request;
    });
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value: {
        databases: vi.fn(() => Promise.reject(new Error("enumeration failed"))),
        deleteDatabase,
      },
    });

    await expect(
      clearAllPersistedStores({ hostClear: null }),
    ).resolves.toBeUndefined();

    expect(deleteDatabase).toHaveBeenCalledWith(STASH_DB_NAME);
    expect(deleteDatabase).toHaveBeenCalledWith(
      "traycer-gui-app:anon:transcript-images",
    );
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("no-ops gracefully and still reloads when `indexedDB` itself is absent", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    await expect(
      clearAllPersistedStores({ hostClear: null }),
    ).resolves.toBeUndefined();

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects and does not reload when tab-recovery deletion is blocked", async () => {
    const value = {
      databases: vi.fn(() =>
        Promise.resolve([{ name: "traycer-gui-app:default:landing-images" }]),
      ),
      deleteDatabase: vi.fn((name: string) => {
        const request = {
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onblocked: null as (() => void) | null,
          error: null as DOMException | null,
        };
        // Other renderer stores remain best effort, while recovery deletion is
        // authoritative: a stuck recovery connection must stop before reload.
        queueMicrotask(() =>
          name === "traycer-gui-app:tab-recovery"
            ? request.onblocked?.()
            : request.onsuccess?.(),
        );
        return request;
      }),
    };
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value,
    });

    await expect(clearAllPersistedStores({ hostClear: null })).rejects.toThrow(
      "blocked",
    );
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe("clearAllPersistedStores - queued debounced writes", () => {
  it("cancels a queued history/canvas write before the sweep, so a later pagehide cannot resurrect it", async () => {
    // Reset to jsdom's real default (no IndexedDB) - a prior "renderer
    // IndexedDB drop" test may have left a blocked-deletion factory installed,
    // which is irrelevant to this test's own concern.
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const key = "traycer-gui-app:last-route:window-a";
    expect(localStorageMock.getItem(key)).toBeNull();

    // A history navigation (or a canvas local-persist write) queued its disk
    // write but the 100ms debounce hasn't fired yet.
    deferJsonWrite(key, () => {
      window.localStorage.setItem(
        key,
        JSON.stringify({ entries: ["/epics/e1/t1"], index: 0 }),
      );
    });

    await clearAllPersistedStores({ hostClear: null });

    expect(localStorageMock.getItem(key)).toBeNull();

    // The unload-time flush must not be able to resurrect a key the wipe
    // just cleared.
    window.dispatchEvent(new Event("pagehide"));

    expect(localStorageMock.getItem(key)).toBeNull();
  });
});

describe("clearAllPersistedStores - composer drafts", () => {
  it("empties the live drafts and the storage baseline at the sweep, so old text is gone while the reload is pending and the next custody write lands", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const composerRows = (): string[] =>
      snapshotKeys(localStorageMock).filter((key) =>
        key.startsWith(composerDraftRowPrefix(ANON_NAME)),
      );
    const allStoredText = (): string =>
      snapshotKeys(localStorageMock)
        .map((key) => localStorageMock.getItem(key) ?? "")
        .join("\n");

    // A persisted row (the adapter has now seen its revision), unsaved text on
    // top of it, and a pending submitted-draft receipt.
    const store = useComposerDraftStore.getState();
    store.setSnapshot("chat-wipe", textDoc("OLD persisted"), null);
    flushDeferredJsonWrite(ANON_NAME);
    expect(composerRows()).toHaveLength(1);
    store.setSnapshot("chat-wipe", textDoc("OLD unsaved"), null);
    store.recordPendingSubmittedDraftRetract("draft-old", "host-a");
    const epochBefore = readComposerDraftSnapshot("chat-wipe").resetEpoch;

    // Hold the wipe after the storage sweep, before the reload: the renderer
    // stays live in that window.
    let releaseCleanup: () => void = () => undefined;
    clearAppearanceCache.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      }),
    );
    const wiping = clearAllPersistedStores({ hostClear: null });
    await vi.waitFor(() => {
      expect(clearAppearanceCache).toHaveBeenCalled();
    });
    expect(reloadSpy).not.toHaveBeenCalled();

    // Nothing of the old drafts is left on disk or in the editor's source.
    expect(composerRows()).toEqual([]);
    const afterWipe = readComposerDraftSnapshot("chat-wipe");
    expect(afterWipe.content).toEqual(EMPTY_COMPOSER_DRAFT.content);
    expect(afterWipe.resetEpoch).toBeGreaterThan(epochBefore);
    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes,
    ).toEqual({});
    window.dispatchEvent(new Event("pagehide"));
    expect(allStoredText()).not.toContain("OLD");

    // A custody write in that window is not blocked by the wiped row's old
    // revision, and it is durable.
    expect(() =>
      useComposerDraftStore
        .getState()
        .replaceDraft("chat-wipe", textDoc("NEW restored"), null),
    ).not.toThrow();
    expect(composerRows()).toHaveLength(1);
    expect(allStoredText()).toContain("NEW restored");
    expect(allStoredText()).not.toContain("OLD");

    releaseCleanup();
    await wiping;
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    cancelDeferredJsonWrites();
  });
});
