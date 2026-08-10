import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type {
  PromptStashEntry,
  PromptStashManifest,
  PromptStashRow,
  PromptStashSnapshot,
} from "@/lib/composer/prompt-stash-codec";

const repoMocks = vi.hoisted(() => ({
  loadPromptStashSnapshot: vi.fn(),
  savePromptStashSnapshot: vi.fn(),
  deletePromptStashEntry: vi.fn(),
}));

vi.mock("@/lib/composer/prompt-stash-repository", () => ({
  loadPromptStashSnapshot: repoMocks.loadPromptStashSnapshot,
  savePromptStashSnapshot: repoMocks.savePromptStashSnapshot,
  deletePromptStashEntry: repoMocks.deletePromptStashEntry,
}));

const PROMPT_STASH_CHANNEL = "traycer-gui-app:prompt-stash:v1";

/**
 * Minimal BroadcastChannel stand-in. Same-origin windows share a channel by
 * name; the sender does not receive its own postMessage (matches browsers).
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

function textDoc(text: string): JsonContent {
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

function entry(id: string, createdAt: number, text: string): PromptStashEntry {
  return {
    id,
    createdAt,
    content: textDoc(text),
    blobHashes: [],
  };
}

function asRows(
  entries: ReadonlyArray<PromptStashEntry>,
): ReadonlyArray<PromptStashRow> {
  return entries.map((entry) => ({ kind: "entry" as const, entry }));
}

function manifest(
  entries: ReadonlyArray<PromptStashEntry>,
  revision: number,
): PromptStashManifest {
  return { rows: asRows(entries), revision };
}

type StoreModule = typeof import("@/stores/composer/prompt-stash-store");

/**
 * Configure repository mocks first, then import the store module. The store
 * auto-hydrates on import, so seed values must already be on the mocks.
 */
async function loadStore(opts: {
  readonly load: PromptStashManifest | (() => Promise<PromptStashManifest>);
}): Promise<StoreModule> {
  vi.resetModules();
  FakeBroadcastChannel.reset();
  repoMocks.loadPromptStashSnapshot.mockReset();
  repoMocks.savePromptStashSnapshot.mockReset();
  repoMocks.deletePromptStashEntry.mockReset();
  if (typeof opts.load === "function") {
    repoMocks.loadPromptStashSnapshot.mockImplementation(opts.load);
  } else {
    repoMocks.loadPromptStashSnapshot.mockResolvedValue(opts.load);
  }
  repoMocks.savePromptStashSnapshot.mockResolvedValue(manifest([], 0));
  repoMocks.deletePromptStashEntry.mockResolvedValue(manifest([], 0));

  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);

  return import("@/stores/composer/prompt-stash-store");
}

describe("usePromptStashStore", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeBroadcastChannel.reset();
    vi.restoreAllMocks();
  });

  it("hydrates once and exposes entries from the repository", async () => {
    const seeded = [entry("a", 2, "a"), entry("b", 1, "b")];
    const { usePromptStashStore } = await loadStore({
      load: manifest(seeded, 1),
    });
    // Module import kicks off auto-hydrate; await it explicitly.
    await usePromptStashStore.getState().hydrate();

    expect(usePromptStashStore.getState().rows).toEqual(asRows(seeded));
    expect(repoMocks.loadPromptStashSnapshot).toHaveBeenCalledTimes(1);

    // Second hydrate reuses the in-flight/completed promise.
    await usePromptStashStore.getState().hydrate();
    expect(repoMocks.loadPromptStashSnapshot).toHaveBeenCalledTimes(1);
  });

  it("re-arms hydration after a failed load so a later retry can succeed", async () => {
    const { usePromptStashStore } = await loadStore({
      load: () => Promise.reject(new Error("idb offline")),
    });

    // Auto-hydrate on import is swallowed (.catch(() => undefined)). An
    // explicit hydrate still rejects until the repository recovers, then a
    // later hydrate re-arms and succeeds.
    await expect(usePromptStashStore.getState().hydrate()).rejects.toThrow(
      /idb offline/,
    );
    repoMocks.loadPromptStashSnapshot.mockResolvedValue(
      manifest([entry("recovered", 1, "ok")], 1),
    );
    await usePromptStashStore.getState().hydrate();
    expect(usePromptStashStore.getState().rows).toEqual(
      asRows([entry("recovered", 1, "ok")]),
    );
  });

  it("save hydrates first, updates entries, and does not leave partial local state on failure", async () => {
    const existing = [entry("kept", 1, "kept")];
    const { usePromptStashStore } = await loadStore({
      load: manifest(existing, 1),
    });
    await usePromptStashStore.getState().hydrate();

    const nextEntries = [entry("new", 2, "new"), ...existing];
    const snapshot: PromptStashSnapshot = {
      entry: entry("new", 2, "new"),
      imagesByHash: new Map(),
    };
    repoMocks.savePromptStashSnapshot.mockResolvedValueOnce(
      manifest(nextEntries, 2),
    );

    await usePromptStashStore.getState().save(snapshot);
    expect(repoMocks.savePromptStashSnapshot).toHaveBeenCalledWith(snapshot);
    expect(usePromptStashStore.getState().rows).toEqual(asRows(nextEntries));

    repoMocks.savePromptStashSnapshot.mockRejectedValueOnce(new Error("quota"));
    await expect(
      usePromptStashStore.getState().save({
        entry: entry("fail", 3, "fail"),
        imagesByHash: new Map(),
      }),
    ).rejects.toThrow(/quota/);
    // Local store keeps the last durable entries; failed save must not invent state.
    expect(usePromptStashStore.getState().rows).toEqual(asRows(nextEntries));
  });

  it("remove hydrates first and replaces entries with the repository result", async () => {
    const existing = [entry("a", 2, "a"), entry("b", 1, "b")];
    const { usePromptStashStore } = await loadStore({
      load: manifest(existing, 1),
    });
    await usePromptStashStore.getState().hydrate();
    repoMocks.deletePromptStashEntry.mockResolvedValueOnce(
      manifest([entry("b", 1, "b")], 2),
    );

    await usePromptStashStore.getState().remove("a");

    expect(repoMocks.deletePromptStashEntry).toHaveBeenCalledWith("a");
    expect(usePromptStashStore.getState().rows).toEqual(
      asRows([entry("b", 1, "b")]),
    );
  });

  it("publishes a BroadcastChannel change with revision on local save and remove", async () => {
    const existing = [entry("a", 1, "a")];
    const { usePromptStashStore } = await loadStore({
      load: manifest(existing, 1),
    });
    await usePromptStashStore.getState().hydrate();

    const peer = new FakeBroadcastChannel(PROMPT_STASH_CHANNEL);
    const received: unknown[] = [];
    peer.addEventListener("message", (event) => {
      received.push(event.data);
    });

    repoMocks.savePromptStashSnapshot.mockResolvedValueOnce(
      manifest([entry("b", 2, "b"), ...existing], 2),
    );
    await usePromptStashStore.getState().save({
      entry: entry("b", 2, "b"),
      imagesByHash: new Map(),
    });
    expect(received).toEqual([{ type: "changed", revision: 2 }]);

    received.length = 0;
    repoMocks.deletePromptStashEntry.mockResolvedValueOnce(
      manifest(existing, 3),
    );
    await usePromptStashStore.getState().remove("b");
    expect(received).toEqual([{ type: "changed", revision: 3 }]);

    peer.close();
  });

  it("reloads the manifest when another window publishes a newer revision", async () => {
    const initial = [entry("local", 1, "local")];
    const remote = [entry("remote", 2, "remote"), entry("local", 1, "local")];
    const { usePromptStashStore } = await loadStore({
      load: manifest(initial, 1),
    });
    await usePromptStashStore.getState().hydrate();
    expect(usePromptStashStore.getState().rows).toEqual(asRows(initial));

    // Next load (driven by the channel listener) returns the remote snapshot.
    repoMocks.loadPromptStashSnapshot.mockResolvedValueOnce(
      manifest(remote, 2),
    );
    const peer = new FakeBroadcastChannel(PROMPT_STASH_CHANNEL);
    peer.postMessage({ type: "changed", revision: 2 });

    await vi.waitFor(() => {
      expect(usePromptStashStore.getState().rows).toEqual(asRows(remote));
    });
    // Initial hydrate + the channel-driven reload.
    expect(
      repoMocks.loadPromptStashSnapshot.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);

    peer.close();
  });

  it("skips reload when the broadcast revision is already applied", async () => {
    const initial = [entry("local", 1, "local")];
    const { usePromptStashStore } = await loadStore({
      load: manifest(initial, 5),
    });
    await usePromptStashStore.getState().hydrate();
    const loadCallsAfterHydrate =
      repoMocks.loadPromptStashSnapshot.mock.calls.length;

    const peer = new FakeBroadcastChannel(PROMPT_STASH_CHANNEL);
    peer.postMessage({ type: "changed", revision: 5 });
    peer.postMessage({ type: "changed", revision: 3 });
    // Give the listener a turn; it must not issue another load.
    await Promise.resolve();
    await Promise.resolve();
    expect(repoMocks.loadPromptStashSnapshot.mock.calls.length).toBe(
      loadCallsAfterHydrate,
    );
    peer.close();
  });

  it("reloads post-reset rows even when the reset arrives after their change", async () => {
    const initial = [entry("old", 1, "old")];
    const replacement = [entry("new", 2, "new")];
    const { usePromptStashStore } = await loadStore({
      load: manifest(initial, 9),
    });
    await usePromptStashStore.getState().hydrate();
    const loadCallsBeforeReset =
      repoMocks.loadPromptStashSnapshot.mock.calls.length;
    repoMocks.loadPromptStashSnapshot.mockResolvedValueOnce(
      manifest(replacement, 1),
    );

    const peer = new FakeBroadcastChannel(PROMPT_STASH_CHANNEL);
    // A save into the recreated database can broadcast its low revision before
    // the delayed reset. The old generation suppresses that change, so reset
    // must reload rather than only clearing memory.
    peer.postMessage({ type: "changed", revision: 1 });
    peer.postMessage({ type: "reset" });

    expect(usePromptStashStore.getState().rows).toEqual([]);
    await vi.waitFor(() => {
      expect(repoMocks.loadPromptStashSnapshot).toHaveBeenCalledTimes(
        loadCallsBeforeReset + 1,
      );
      expect(usePromptStashStore.getState().rows).toEqual(asRows(replacement));
    });
    peer.close();
  });

  it("does not regress when a stale broadcast-triggered load resolves after a local save", async () => {
    const initial = [entry("a", 1, "a")];
    let resolveStaleLoad: ((value: PromptStashManifest) => void) | undefined;
    const staleLoad = new Promise<PromptStashManifest>((resolve) => {
      resolveStaleLoad = resolve;
    });

    // First load (hydrate) resolves immediately; subsequent loads hang until
    // we resolve the deferred promise (simulating a slow cross-window reload).
    let loadCount = 0;
    const { usePromptStashStore } = await loadStore({
      load: async () => {
        loadCount += 1;
        if (loadCount === 1) return manifest(initial, 1);
        return staleLoad;
      },
    });
    await usePromptStashStore.getState().hydrate();
    expect(usePromptStashStore.getState().rows).toEqual(asRows(initial));

    // Trigger a broadcast reload (issues load #2, still pending).
    const peer = new FakeBroadcastChannel(PROMPT_STASH_CHANNEL);
    peer.postMessage({ type: "changed", revision: 2 });
    await vi.waitFor(() => {
      expect(loadCount).toBeGreaterThanOrEqual(2);
    });

    // Local save lands at revision 3 while the broadcast reload is in flight.
    const afterSave = [entry("b", 2, "b"), ...initial];
    repoMocks.savePromptStashSnapshot.mockResolvedValueOnce(
      manifest(afterSave, 3),
    );
    await usePromptStashStore.getState().save({
      entry: entry("b", 2, "b"),
      imagesByHash: new Map(),
    });
    expect(usePromptStashStore.getState().rows).toEqual(asRows(afterSave));

    // Stale reload finally resolves with the older revision-2 snapshot.
    resolveStaleLoad?.(
      manifest([entry("stale-remote", 9, "stale"), ...initial], 2),
    );
    await Promise.resolve();
    await Promise.resolve();

    // Store keeps the fresher local save; stale reload must not regress.
    expect(usePromptStashStore.getState().rows).toEqual(asRows(afterSave));
    peer.close();
  });

  it("applies a local save that resolves after a broadcast reload raced ahead with a newer load token", async () => {
    // Inverse of the stale-load-after-save case: save starts first (deferred),
    // a broadcast reload is issued afterward (newer load token) and resolves
    // first with an intermediate revision, then the save lands with a higher
    // revision. Mutation results must apply by revision alone — not be
    // discarded on token mismatch.
    const initial = [entry("a", 1, "a")];
    let resolveSave: ((value: PromptStashManifest) => void) | undefined;
    const pendingSave = new Promise<PromptStashManifest>((resolve) => {
      resolveSave = resolve;
    });

    const { usePromptStashStore } = await loadStore({
      load: manifest(initial, 1),
    });
    await usePromptStashStore.getState().hydrate();
    expect(usePromptStashStore.getState().rows).toEqual(asRows(initial));

    repoMocks.savePromptStashSnapshot.mockReturnValueOnce(pendingSave);
    const savePromise = usePromptStashStore.getState().save({
      entry: entry("b", 2, "b"),
      imagesByHash: new Map(),
    });

    // While save is in flight, another window's broadcast issues a reload
    // under a newer load token and resolves immediately.
    const peer = new FakeBroadcastChannel(PROMPT_STASH_CHANNEL);
    const broadcastEntries = [entry("from-broadcast", 9, "bc")];
    repoMocks.loadPromptStashSnapshot.mockResolvedValueOnce(
      manifest(broadcastEntries, 2),
    );
    peer.postMessage({ type: "changed", revision: 2 });
    await vi.waitFor(() => {
      expect(usePromptStashStore.getState().rows).toEqual(
        asRows(broadcastEntries),
      );
    });

    // Save finally resolves at revision 3 — authoritative, must win.
    const afterSave = [entry("b", 2, "b"), ...initial];
    resolveSave?.(manifest(afterSave, 3));
    await savePromise;

    expect(usePromptStashStore.getState().rows).toEqual(asRows(afterSave));
    peer.close();
  });

  it("preserves a newer peer reload that starts before an older local save completes", async () => {
    const initial = [entry("a", 1, "a")];
    let resolveSave: ((value: PromptStashManifest) => void) | undefined;
    let resolvePeerLoad: ((value: PromptStashManifest) => void) | undefined;
    const pendingSave = new Promise<PromptStashManifest>((resolve) => {
      resolveSave = resolve;
    });
    const pendingPeerLoad = new Promise<PromptStashManifest>((resolve) => {
      resolvePeerLoad = resolve;
    });

    let loadCount = 0;
    const { usePromptStashStore } = await loadStore({
      load: async () => {
        loadCount += 1;
        return loadCount === 1 ? manifest(initial, 1) : pendingPeerLoad;
      },
    });
    await usePromptStashStore.getState().hydrate();

    repoMocks.savePromptStashSnapshot.mockReturnValueOnce(pendingSave);
    const savePromise = usePromptStashStore.getState().save({
      entry: entry("local", 2, "local"),
      imagesByHash: new Map(),
    });

    const peer = new FakeBroadcastChannel(PROMPT_STASH_CHANNEL);
    peer.postMessage({ type: "changed", revision: 3 });
    await vi.waitFor(() => expect(loadCount).toBe(2));

    const localRows = [entry("local", 2, "local"), ...initial];
    resolveSave?.(manifest(localRows, 2));
    await savePromise;
    expect(usePromptStashStore.getState().rows).toEqual(asRows(localRows));

    const peerRows = [entry("peer", 3, "peer"), ...localRows];
    resolvePeerLoad?.(manifest(peerRows, 3));
    await vi.waitFor(() => {
      expect(usePromptStashStore.getState().rows).toEqual(asRows(peerRows));
    });
    peer.close();
  });

  it("does not regress when an earlier-issued hydrate/reload resolves after a later one", async () => {
    let resolveFirst: ((value: PromptStashManifest) => void) | undefined;
    let resolveSecond: ((value: PromptStashManifest) => void) | undefined;
    const firstLoad = new Promise<PromptStashManifest>((resolve) => {
      resolveFirst = resolve;
    });
    const secondLoad = new Promise<PromptStashManifest>((resolve) => {
      resolveSecond = resolve;
    });

    let loadCount = 0;
    const { usePromptStashStore } = await loadStore({
      load: async () => {
        loadCount += 1;
        if (loadCount === 1) return firstLoad;
        if (loadCount === 2) return secondLoad;
        return manifest([], 99);
      },
    });

    // Auto-hydrate is load #1 (pending). Force a second load via broadcast
    // before the first resolves (channel message with unknown/higher revision).
    const peer = new FakeBroadcastChannel(PROMPT_STASH_CHANNEL);
    // Wait a tick so the store's channel listener is registered.
    await Promise.resolve();
    peer.postMessage({ type: "changed", revision: 10 });
    await vi.waitFor(() => {
      expect(loadCount).toBeGreaterThanOrEqual(2);
    });

    // Later-issued load (#2) resolves first with revision 5.
    const laterEntries = [entry("later", 2, "later")];
    resolveSecond?.(manifest(laterEntries, 5));
    await vi.waitFor(() => {
      expect(usePromptStashStore.getState().rows).toEqual(asRows(laterEntries));
    });

    // Earlier-issued load (#1) resolves after with a lower revision — ignored
    // because its load token is no longer current.
    resolveFirst?.(manifest([entry("earlier", 1, "earlier")], 1));
    await Promise.resolve();
    await Promise.resolve();
    expect(usePromptStashStore.getState().rows).toEqual(asRows(laterEntries));

    peer.close();
  });

  it("markUnavailable replaces the row until a fresher manifest arrives", async () => {
    const seeded = [entry("a", 2, "a"), entry("b", 1, "b")];
    const { usePromptStashStore } = await loadStore({
      load: manifest(seeded, 1),
    });
    await usePromptStashStore.getState().hydrate();

    usePromptStashStore.getState().markUnavailable("a");
    expect(usePromptStashStore.getState().rows.at(0)).toEqual({
      kind: "unavailable",
      id: "a",
      createdAt: 2,
      content: textDoc("a"),
    });

    const afterUnrelatedSave = [...seeded, entry("c", 3, "c")];
    const snapshot: PromptStashSnapshot = {
      entry: entry("c", 3, "c"),
      imagesByHash: new Map(),
    };
    repoMocks.savePromptStashSnapshot.mockResolvedValueOnce(
      manifest(afterUnrelatedSave, 2),
    );
    await usePromptStashStore.getState().save(snapshot);

    expect(usePromptStashStore.getState().rows).toEqual(
      asRows(afterUnrelatedSave),
    );
  });
});
