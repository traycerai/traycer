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
const publishPromptStashReset = vi.fn<() => void>();
vi.mock("@/lib/windows/per-window-projection-debounce", () => ({
  flushActiveDesktopPerWindowProjection: () =>
    flushActiveDesktopPerWindowProjection(),
}));
vi.mock("@/stores/tabs/desktop-tabs-persistence", () => ({
  drainDesktopTabsPersistence: () => drainDesktopTabsPersistence(),
}));
vi.mock("@/lib/composer/prompt-stash-channel", () => ({
  publishPromptStashReset: () => publishPromptStashReset(),
}));

import { clearAllPersistedStores } from "@/lib/persist/wipe";

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
  publishPromptStashReset.mockClear();

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
    // 3 local + 2 session persisted keys are swept (the seeds above).
    expect(order.filter((e) => e.includes("removeItem")).length).toBe(5);
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
});

describe("clearAllPersistedStores — landing-image IndexedDB drop", () => {
  // A mix of: two real per-window landing-image partitions, a same-prefix db
  // that is NOT a landing-image db, and an unrelated db. Only the two
  // `traycer-gui-app:*:landing-images` entries must be deleted.
  const DB_NAMES = [
    "traycer-gui-app:default:landing-images",
    "traycer-gui-app:window-7:landing-images",
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

  it("deletes landing-image partitions plus the fixed prompt-stash db name; unrelated dbs survive", async () => {
    const { deleted } = installIndexedDB({
      databases: () => Promise.resolve(DB_NAMES.map((name) => ({ name }))),
    });

    await clearAllPersistedStores({ hostClear: null });

    // Landing partitions come from enumeration; prompt-stash is always deleted
    // by exact fixed name even when enumeration never lists it.
    expect(deleted.sort()).toEqual(
      [
        "traycer-gui-app:default:landing-images",
        "traycer-gui-app:prompt-stash",
        "traycer-gui-app:window-7:landing-images",
      ].sort(),
    );
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(publishPromptStashReset).toHaveBeenCalledTimes(1);
  });

  it("notifies peer windows only after the prompt-stash database is deleted", async () => {
    const order: string[] = [];
    const value = {
      databases: vi.fn(() => Promise.resolve([])),
      deleteDatabase: vi.fn((name: string) => {
        const { request, fire } = fakeDeleteRequest();
        queueMicrotask(() => {
          order.push(`deleted:${name}`);
          fire();
        });
        return request;
      }),
    };
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value,
    });
    publishPromptStashReset.mockImplementation(() => order.push("reset"));

    await clearAllPersistedStores({ hostClear: null });

    expect(order).toEqual(["deleted:traycer-gui-app:prompt-stash", "reset"]);
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

  it("still reloads when a landing-image db deletion errors (best-effort)", async () => {
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

  it("still deletes the fixed prompt-stash db when `indexedDB.databases` is absent", async () => {
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
    // but the single known prompt-stash name is always deleted.
    expect(deleteDatabase).toHaveBeenCalledWith("traycer-gui-app:prompt-stash");
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("still deletes prompt stash and reloads when database enumeration rejects", async () => {
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

    expect(deleteDatabase).toHaveBeenCalledWith("traycer-gui-app:prompt-stash");
    expect(publishPromptStashReset).toHaveBeenCalledTimes(1);
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

  it("deleteDatabase onblocked resolves so the wipe still reloads", async () => {
    const value = {
      databases: vi.fn(() =>
        Promise.resolve([{ name: "traycer-gui-app:default:landing-images" }]),
      ),
      deleteDatabase: vi.fn((_name: string) => {
        const request = {
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onblocked: null as (() => void) | null,
          error: null as DOMException | null,
        };
        // Blocked path: resolve (not reject) so a stuck connection can't abort
        // the rest of the wipe/reload sequence.
        queueMicrotask(() => request.onblocked?.());
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
});
