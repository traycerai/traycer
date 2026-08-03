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
  });

  it("uses a distinct IndexedDB database for each desktop window", async () => {
    expect(fileEditRecoveryPartition()).toBe("default");
    await indexedDbFileEditRecoveryJournal.save("browser-file", ENTRY);
    expect(createStore).toHaveBeenLastCalledWith(
      "traycer-gui-app:default:file-edit-recovery",
      "drafts",
    );

    Reflect.set(globalThis, "runnerHost", {
      windows: { windowId: "window-7" },
    });
    await indexedDbFileEditRecoveryJournal.save("desktop-file", ENTRY);
    expect(createStore).toHaveBeenLastCalledWith(
      "traycer-gui-app:window-7:file-edit-recovery",
      "drafts",
    );
    expect(idbSet).toHaveBeenCalledTimes(2);
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
