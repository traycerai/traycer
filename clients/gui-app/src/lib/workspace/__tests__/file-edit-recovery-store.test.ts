import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, get as idbGet, set as idbSet } from "idb-keyval";

const idbData = vi.hoisted(() => new Map<string, unknown>());

vi.mock("idb-keyval", () => {
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(idbData.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      idbData.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string) => {
      idbData.delete(key);
      return Promise.resolve();
    }),
  };
});

import {
  fileEditRecoveryPartition,
  indexedDbFileEditRecoveryJournal,
  resetFileEditRecoveryStoreForTesting,
} from "@/lib/workspace/file-edit-recovery-store";
import type { FileEditRecoveryEntry } from "@/lib/workspace/file-edit-runtime";

/**
 * Minimal BroadcastChannel stand-in (mirrors the one in
 * prompt-stash-store.test.ts). Same-name channels share a peer set; the
 * sender does not receive its own postMessage, matching real browsers.
 */
class FakeBroadcastChannel {
  static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();

  readonly name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  constructor(name: string) {
    this.name = name;
    const set = FakeBroadcastChannel.channels.get(name) ?? new Set();
    set.add(this);
    FakeBroadcastChannel.channels.set(name, set);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    const peers = FakeBroadcastChannel.channels.get(this.name);
    if (peers === undefined) return;
    const event = { data } as MessageEvent;
    for (const peer of peers) {
      if (peer === this) continue;
      peer.onmessage?.(event);
      for (const listener of peer.listeners) listener(event);
    }
  }

  close(): void {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  static reset(): void {
    FakeBroadcastChannel.channels.clear();
  }
}

const ENTRY: FileEditRecoveryEntry = {
  version: 2,
  identity: {
    userId: "user-1",
    hostId: "host-1",
    workspacePath: "/repo",
    filePath: "src/file.ts",
  },
  baselineRevision: "a".repeat(64),
  draftContent: "draft",
  contentRevision: 2,
};

describe("file-edit-recovery-store", () => {
  beforeEach(() => {
    idbData.clear();
    vi.clearAllMocks();
    resetFileEditRecoveryStoreForTesting();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "runnerHost");
    vi.unstubAllGlobals();
    FakeBroadcastChannel.reset();
    window.sessionStorage.clear();
  });

  it("uses a distinct IndexedDB database for each desktop window", async () => {
    Reflect.set(globalThis, "runnerHost", {
      windows: { windowId: "window-7" },
    });
    await indexedDbFileEditRecoveryJournal.save("desktop-file", ENTRY);
    expect(createStore).toHaveBeenLastCalledWith(
      "traycer-gui-app:window-7:file-edit-recovery",
      "drafts",
    );
    expect(idbSet).toHaveBeenCalledTimes(1);
  });

  it("gives each browser tab its own stable, distinct partition", async () => {
    const partition = fileEditRecoveryPartition();
    expect(partition).not.toBe("default");
    expect(fileEditRecoveryPartition()).toBe(partition);

    await indexedDbFileEditRecoveryJournal.save("browser-file", ENTRY);
    expect(createStore).toHaveBeenLastCalledWith(
      `traycer-gui-app:${partition}:file-edit-recovery`,
      "drafts",
    );

    window.sessionStorage.clear();
    resetFileEditRecoveryStoreForTesting();
    expect(fileEditRecoveryPartition()).not.toBe(partition);
  });

  it("falls back to a non-crypto id when crypto.randomUUID is unavailable or throws", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new Error("randomUUID requires a secure context");
      },
    });

    const partition = fileEditRecoveryPartition();
    expect(partition).not.toBe("default");
    expect(fileEditRecoveryPartition()).toBe(partition);
  });

  it("falls back to the shared 'default' partition when sessionStorage itself is unavailable", () => {
    vi.stubGlobal("window", {
      ...window,
      sessionStorage: {
        getItem: () => {
          throw new Error("sessionStorage is disabled");
        },
        setItem: () => {
          throw new Error("sessionStorage is disabled");
        },
      },
    });

    expect(fileEditRecoveryPartition()).toBe("default");
  });

  it("disambiguates a duplicated tab that inherited the same sessionStorage id", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);

    const original = fileEditRecoveryPartition();
    expect(original).not.toBe("default");

    // A duplicated tab (Cmd+T "duplicate tab", or a browser restoring a
    // closed one) inherits the exact same sessionStorage entry, then
    // independently claims it over the shared channel - simulated here by a
    // peer broadcasting the id this "original" tab is already using,
    // without touching this tab's own sessionStorage/module state at all.
    const duplicatePeer = new FakeBroadcastChannel(
      "traycer-gui-app:file-edit-recovery-tab-claim:v1",
    );
    duplicatePeer.postMessage({ id: original });

    // The collision listener regenerates and re-claims a fresh id so the
    // two tabs stop sharing one recovery partition.
    expect(fileEditRecoveryPartition()).not.toBe(original);
  });

  it("round-trips valid entries and ignores malformed stored values", async () => {
    await indexedDbFileEditRecoveryJournal.save("valid", ENTRY);
    expect(await indexedDbFileEditRecoveryJournal.load("valid")).toEqual(ENTRY);

    idbData.set("invalid", { ...ENTRY, contentRevision: -1 });
    expect(await indexedDbFileEditRecoveryJournal.load("invalid")).toBeNull();
    idbData.set("legacy", { ...ENTRY, version: 1 });
    expect(await indexedDbFileEditRecoveryJournal.load("legacy")).toBeNull();
    expect(idbGet).toHaveBeenCalledWith("invalid", expect.any(Function));
  });
});
