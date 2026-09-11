import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonContent } from "@traycer/protocol/common/registry";
import type { LegacyRecoveryDraft } from "@/lib/tab-recovery/history";

// In-memory stand-in for idb-keyval, mirroring landing-image-store.test. Keyed by
// string hash; the store argument is ignored. The Map is hoisted so tests can
// reinstall a working `set` after a rejecting override without losing the body.
const idbData = vi.hoisted(() => new Map<string, unknown>());
const recoveryData = vi.hoisted(() => new Map<string, unknown>());
const imageStoreToken = vi.hoisted(() => ({}));
const recoveryStoreToken = vi.hoisted(() => ({}));

function dataForStore(store: unknown): Map<string, unknown> {
  return store === recoveryStoreToken ? recoveryData : idbData;
}

function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("landing image store keys are string hashes");
  }
  return key;
}

vi.mock("idb-keyval", () => {
  return {
    createStore: vi.fn((name: string) =>
      name.endsWith(":landing-images") ? imageStoreToken : recoveryStoreToken,
    ),
    get: vi.fn((key: string, store: unknown) =>
      Promise.resolve(dataForStore(store).get(key)),
    ),
    set: vi.fn((key: string, value: unknown, store: unknown) => {
      dataForStore(store).set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string, store: unknown) => {
      dataForStore(store).delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn((store: unknown) =>
      Promise.resolve(Array.from(dataForStore(store).keys())),
    ),
    entries: vi.fn((store: unknown) =>
      Promise.resolve(Array.from(dataForStore(store).entries())),
    ),
  };
});

const toastInfo = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { info: toastInfo, error: toastError }),
}));

let urlCounter = 0;

function bytesOf(values: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const EMPTY_DOC: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

function imageNode(hash: string, size: number | null): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id: `node-${hash}`,
      fileName: "image.png",
      hash,
      mimeType: "image/png",
      size,
    },
  };
}

function docWithImages(...nodes: ReadonlyArray<JsonContent>): JsonContent {
  return { type: "doc", content: [{ type: "paragraph", content: [...nodes] }] };
}

// Flush a handful of microtask turns so `void deleteImage(...)` chains settle.
// No real timers are involved in the delete path, so this is enough.
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

type Modules = {
  readonly gc: typeof import("@/lib/composer/landing-image-gc");
  readonly budget: typeof import("@/lib/composer/landing-image-budget");
  readonly store: typeof import("@/lib/composer/landing-image-store");
  readonly draft: typeof import("@/stores/home/landing-draft-store");
  readonly runtime: typeof import("@/stores/home/draft-runtime-registry");
  readonly recovery: typeof import("@/lib/tab-recovery/history");
  readonly idb: typeof import("idb-keyval");
};

async function loadModules(opts: {
  readonly desktop: boolean;
  readonly clearData?: boolean;
}): Promise<Modules> {
  vi.resetModules();
  if (opts.clearData !== false) {
    idbData.clear();
    recoveryData.clear();
  }
  if (opts.desktop) {
    Reflect.set(globalThis, "runnerHost", {
      windows: { windowId: "win-test" },
    });
  } else {
    Reflect.deleteProperty(globalThis, "runnerHost");
  }
  const idb = await import("idb-keyval");
  // Always reinstall a working set after reset - prior tests may have left a
  // rejecting mockImplementation on the shared idb-keyval mock module.
  vi.mocked(idb.set).mockImplementation((key, value, store) => {
    dataForStore(store).set(idbStringKey(key), value);
    return Promise.resolve();
  });
  vi.mocked(idb.get).mockImplementation((key, store) =>
    Promise.resolve(dataForStore(store).get(idbStringKey(key))),
  );
  vi.mocked(idb.del).mockImplementation((key, store) => {
    dataForStore(store).delete(idbStringKey(key));
    return Promise.resolve();
  });
  vi.mocked(idb.keys).mockImplementation((store) =>
    Promise.resolve(Array.from(dataForStore(store).keys())),
  );
  vi.mocked(idb.entries).mockImplementation((store) =>
    Promise.resolve(Array.from(dataForStore(store).entries())),
  );
  const store = await import("@/lib/composer/landing-image-store");
  const budget = await import("@/lib/composer/landing-image-budget");
  const gc = await import("@/lib/composer/landing-image-gc");
  const recovery = await import("@/lib/tab-recovery/history");
  const draft = await import("@/stores/home/landing-draft-store");
  const runtime = await import("@/stores/home/draft-runtime-registry");
  recovery.useTabRecoveryHistory.setState({ entries: [], ready: true });
  draft.useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  runtime.draftRuntimeRegistry.resetForTesting();
  return { gc, budget, store, draft, runtime, recovery, idb };
}

function makeDraft(
  m: Modules,
  input: {
    readonly id: string;
    readonly content: JsonContent;
    readonly lastTouchedAt: number;
  },
): import("@/stores/home/landing-draft-store").LandingDraftTab {
  return {
    id: input.id,
    content: input.content,
    selection: null,
    lastTouchedAt: input.lastTouchedAt,
    settings: null,
    composerMode: "chat",
    workspace: m.draft.emptyLandingDraftWorkspaceSnapshot(),
    ...m.draft.freshLandingMirrorState(),
  };
}

function makeLegacyDraft(
  m: Modules,
  input: {
    readonly id: string;
    readonly content: JsonContent;
    readonly lastTouchedAt: number;
  },
): LegacyRecoveryDraft {
  const draft = makeDraft(m, input);
  return {
    id: draft.id,
    content: draft.content,
    selection: draft.selection,
    lastTouchedAt: draft.lastTouchedAt,
    settings: draft.settings,
    composerMode: draft.composerMode,
    workspace: draft.workspace,
  };
}

describe("landing-image-gc", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
    URL.revokeObjectURL = vi.fn();
    toastInfo.mockClear();
    toastError.mockClear();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "runnerHost");
  });

  it("[C1] does not delete stored bytes before the desktop draft set is known", async () => {
    const m = await loadModules({ desktop: true });
    // Restored bytes (IDB-only, no session entry) — the desktop-restart shape.
    await m.idb.set("restored-1", bytesOf([1, 2, 3]), m.store.imageStore());

    // Drafts have NOT been projected yet (empty set). An UNGATED sweep would
    // compute orphans = [restored-1] and delete it — the C1 data-loss bug.
    expect(m.gc.landingDraftsReady()).toBe(false);
    await m.gc.reconcile();
    await flush();

    expect(await m.store.imageHashKeys()).toContain("restored-1");
  });

  it("[C1] the first desktop projection flips the ready gate and runs the sweep", async () => {
    const m = await loadModules({ desktop: true });
    // [B2] Open the deletion gate WITHOUT flipping readiness: a non-empty
    // authoritative snapshot marks the roots trustworthy but, unlike
    // `markLandingEditorMounted`, does not itself fire `markLandingDraftsReady`
    // (which mount now does). That keeps `landingDraftsReady()` false below so
    // this test still exercises the FIRST projection flipping the ready gate.
    m.gc.markLandingDraftsAuthoritativeNonEmpty();
    await m.idb.set(
      "restored-orphan",
      bytesOf([7, 8, 9]),
      m.store.imageStore(),
    );
    expect(m.gc.landingDraftsReady()).toBe(false);

    // The first inbound projection means the draft set is now known: ready flips
    // and the startup sweep collects the unreferenced restored bytes.
    m.draft.applyLandingDraftDesktopProjection({
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    await flush();

    expect(m.gc.landingDraftsReady()).toBe(true);
    expect(await m.store.imageHashKeys()).not.toContain("restored-orphan");
  });

  it("[B2] defers orphan deletion on desktop while the roots are untrustworthy", async () => {
    const m = await loadModules({ desktop: true });
    // Restored bytes, ready gate open (draft set known), but NO trustworthy
    // signal yet: neither markLandingDraftsAuthoritativeNonEmpty nor
    // markLandingEditorMounted. A cold-start empty projection would otherwise
    // reap every restored image as an "orphan".
    await m.idb.set("cold-orphan", bytesOf([1, 2, 3, 4]), m.store.imageStore());
    m.gc.markLandingDraftsReady();
    await flush();

    await m.gc.reconcile();
    await flush();

    // Gate closed → no delete.
    expect(await m.store.imageHashKeys()).toContain("cold-orphan");

    // Opening the gate (editor mounted) re-runs a scheduled reconcile so the
    // genuine orphan is reaped once roots are trustworthy.
    m.gc.markLandingEditorMounted();
    await vi.advanceTimersByTimeAsync(250);
    await flush();

    expect(await m.store.imageHashKeys()).not.toContain("cold-orphan");
  });

  it("once ready, a referenced restored image survives while an unreferenced one is collected", async () => {
    const m = await loadModules({ desktop: true });
    // [B2] Roots are trustworthy (landing editor mounted) so the sweep may delete.
    m.gc.markLandingEditorMounted();
    await m.idb.set("restored-keep", bytesOf([4, 5, 6]), m.store.imageStore());
    await m.idb.set(
      "restored-orphan",
      bytesOf([7, 8, 9]),
      m.store.imageStore(),
    );

    // A draft references `restored-keep`; `restored-orphan` is unreferenced.
    m.draft.useLandingDraftStore.setState({
      drafts: [
        makeDraft(m, {
          id: "d1",
          content: docWithImages(imageNode("restored-keep", 10)),
          lastTouchedAt: 1,
        }),
      ],
      activeDraftId: "d1",
    });
    m.gc.markLandingDraftsReady();
    await m.gc.reconcile();
    await flush();

    const keys = await m.store.imageHashKeys();
    expect(keys).toContain("restored-keep");
    expect(keys).not.toContain("restored-orphan");
  });

  it("keeps a recovered draft image until its recovery entry is removed", async () => {
    const m = await loadModules({ desktop: true });
    m.gc.markLandingEditorMounted();
    const hash = "recovered-draft-image";
    await m.idb.set(hash, bytesOf([13, 14, 15]), m.store.imageStore());

    m.recovery.useTabRecoveryHistory.setState({
      entries: [
        {
          id: "recovery-entry",
          kind: "header",
          bulk: false,
          items: [
            {
              kind: "draft",
              draftId: "recovered-draft",
              hostId: null,
              index: 0,
              legacyDraft: makeLegacyDraft(m, {
                id: "recovered-draft",
                content: docWithImages(imageNode(hash, 3)),
                lastTouchedAt: 1,
              }),
            },
          ],
        },
      ],
      ready: true,
    });

    await m.gc.reconcile();
    await flush();
    expect(await m.store.imageHashKeys()).toContain(hash);

    m.recovery.removeRecoveryEntry("recovery-entry");
    await m.gc.reconcile();
    await flush();
    expect(await m.store.imageHashKeys()).not.toContain(hash);
  });

  it("preserves recovery images for an inactive account after a switch and reload", async () => {
    const first = await loadModules({ desktop: true });
    const hash = "account-a-recovery-image";
    await first.idb.set(hash, bytesOf([16, 17, 18]), first.store.imageStore());
    await first.recovery.configureTabRecoveryHistory("account-a");
    first.recovery.recordClosedHeaderTab({
      kind: "draft",
      draftId: "account-a-draft",
      hostId: null,
      legacyDraft: makeLegacyDraft(first, {
        id: "account-a-draft",
        content: docWithImages(imageNode(hash, 3)),
        lastTouchedAt: 1,
      }),
      index: 0,
    });
    await first.recovery.flushTabRecoveryHistory();

    // The active account changes, so the in-memory recovery list no longer
    // includes A's draft. Its persisted bucket remains a root for this window.
    await first.recovery.configureTabRecoveryHistory("account-b");
    expect(first.recovery.useTabRecoveryHistory.getState().entries).toEqual([]);

    // A renderer reload drops the in-memory history and image session cache,
    // while the two IndexedDB stores survive.
    const reloaded = await loadModules({ desktop: true, clearData: false });
    await reloaded.recovery.configureTabRecoveryHistory("account-b");
    reloaded.gc.markLandingEditorMounted();
    reloaded.gc.markLandingDraftsReady();
    await reloaded.gc.reconcile();
    await flush();

    expect(await reloaded.store.imageHashKeys()).toContain(hash);
  });

  it("refuses admission while a persisted inactive legacy history fills the budget", async () => {
    const m = await loadModules({ desktop: true });
    const legacyHash = "account-a-budget-image";
    await m.recovery.configureTabRecoveryHistory("account-a");
    m.recovery.recordClosedHeaderTab({
      kind: "draft",
      draftId: "account-a-budget-draft",
      hostId: null,
      legacyDraft: makeLegacyDraft(m, {
        id: "account-a-budget-draft",
        content: docWithImages(
          imageNode(legacyHash, m.budget.LANDING_IMAGE_BUDGET_BYTES - 1),
        ),
        lastTouchedAt: 1,
      }),
      index: 0,
    });
    await m.recovery.flushTabRecoveryHistory();

    const canonicalDraft = makeDraft(m, {
      id: "canonical-saved-draft",
      content: docWithImages(imageNode("canonical-image", 3)),
      lastTouchedAt: 2,
    });
    m.draft.useLandingDraftStore.setState({
      drafts: [canonicalDraft],
      activeDraftId: null,
    });
    await m.recovery.configureTabRecoveryHistory("account-b");

    const reservation = m.budget.reserveLandingImageBudget("account-b-draft", [
      { hash: "new-image", bytes: 2 },
    ]);
    expect(reservation).toBeNull();
    await m.recovery.flushTabRecoveryHistory();

    await m.recovery.configureTabRecoveryHistory("account-a");
    const accountAEntries = m.recovery.useTabRecoveryHistory.getState().entries;
    expect(accountAEntries).toHaveLength(1);
    expect(accountAEntries[0]).toMatchObject({
      kind: "header",
      items: [{ kind: "draft", draftId: "account-a-budget-draft" }],
    });
    expect(m.draft.useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(m.draft.useLandingDraftStore.getState().drafts[0]?.id).toBe(
      "canonical-saved-draft",
    );
  });

  it("[C2] a just-pasted hash in the live editor survives a reconcile from an unrelated close", async () => {
    const m = await loadModules({ desktop: true });
    m.gc.markLandingDraftsReady();
    await flush();

    // Pasted image: bytes in IDB + session, node synchronously in this draft's
    // keyed live runtime.
    const pasted = await m.store.putImage(bytesOf([10, 11, 12]));
    m.draft.useLandingDraftStore.setState({
      drafts: [
        makeDraft(m, { id: "live", content: EMPTY_DOC, lastTouchedAt: 1 }),
      ],
      activeDraftId: "live",
    });
    const runtime = m.runtime.draftRuntimeRegistry.getOrHydrate("live");
    if (runtime === null) throw new Error("expected live draft runtime");
    runtime.setSnapshot(docWithImages(imageNode(pasted, 3)), null);

    // An unrelated, image-free draft is closed → triggers a reconcile.
    m.draft.useLandingDraftStore.setState({
      drafts: [
        makeDraft(m, { id: "live", content: EMPTY_DOC, lastTouchedAt: 1 }),
        makeDraft(m, { id: "other", content: EMPTY_DOC, lastTouchedAt: 2 }),
      ],
      activeDraftId: "other",
    });
    m.draft.useLandingDraftStore.getState().closeDraft("other");
    await m.gc.reconcile();
    await flush();

    // Live-editor membership keeps it a root: bytes AND session entry survive.
    expect(await m.store.imageHashKeys()).toContain(pasted);
    expect(m.store.sessionObjectUrl(pasted)).not.toBeNull();
  });

  it("[C2] the paste→insert window: a session-only hash keeps its IDB bytes through a reconcile", async () => {
    const m = await loadModules({ desktop: true });
    m.gc.markLandingDraftsReady();
    await flush();

    // Bytes pasted (IDB + session) but the node has NOT been inserted yet, so the
    // hash is in neither the persisted drafts nor the live editor.
    const pasted = await m.store.putImage(bytesOf([20, 21, 22]));

    await m.gc.reconcile();
    await flush();

    // The session is a delete-root: the bytes must NOT be collected (no data
    // loss). The session entry itself may be released, which is harmless.
    expect(await m.store.imageHashKeys()).toContain(pasted);
  });

  it("[C2] a paste landing DURING reconcile's IDB read is protected from deletion", async () => {
    const m = await loadModules({ desktop: true });
    m.gc.markLandingDraftsReady();
    await flush();

    // Gate the keys() read so it resolves only after we release it — modelling a
    // paste whose putImage lands DURING reconcile's `await imageHashKeys()`. The
    // one-shot override delegates back to the default mock impl (which reads the
    // current data) once released.
    let releaseKeys: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseKeys = resolve;
    });
    const realKeys = m.idb.keys;
    vi.mocked(m.idb.keys).mockImplementationOnce(() =>
      gate.then(() => realKeys(m.store.imageStore())),
    );

    const reconcilePromise = m.gc.reconcile();
    // Reconcile is now parked on the gated keys(). A paste completes: bytes land in
    // IDB + session, but the node is NOT inserted, so the hash is in neither the
    // persisted drafts nor the live editor.
    const pasted = await m.store.putImage(bytesOf([40, 41, 42]));
    releaseKeys();
    await reconcilePromise;
    await flush();

    // The fix snapshots the session/live roots AFTER the await, so the just-pasted
    // bytes are protected even though they were not referenced when reconcile
    // started. (Pre-fix, the pre-await snapshot missed them and they were reaped.)
    expect(await m.store.imageHashKeys()).toContain(pasted);
  });

  it("deletes orphan bytes once the sweep is unblocked (session empty)", async () => {
    const m = await loadModules({ desktop: true });
    // [B2] The deleting sweep only runs once the roots are trustworthy; mounting
    // the landing editor unblocks it. (The cold-start deferral itself — no delete
    // while untrustworthy — is covered separately.)
    m.gc.markLandingEditorMounted();
    await m.idb.set("orphan", bytesOf([1]), m.store.imageStore());
    m.gc.markLandingDraftsReady();
    await flush();
    await m.gc.reconcile();
    await flush();

    expect(await m.store.imageHashKeys()).not.toContain("orphan");
  });

  it("empty close deletes the draft and reclaims unreferenced session bytes", async () => {
    const m = await loadModules({ desktop: true });
    m.gc.markLandingEditorMounted();
    m.gc.markLandingDraftsReady();
    await flush();

    const hash = await m.store.putImage(bytesOf([30, 31, 32]));
    m.draft.useLandingDraftStore.setState({
      drafts: [
        makeDraft(m, {
          id: "d1",
          content: EMPTY_DOC,
          lastTouchedAt: 1,
        }),
      ],
      activeDraftId: "d1",
    });
    expect(m.store.sessionObjectUrl(hash)).not.toBeNull();

    m.draft.useLandingDraftStore.getState().closeDraft("d1");
    expect(m.draft.useLandingDraftStore.getState().drafts).toEqual([]);

    await m.gc.reconcile();
    await flush();
    expect(m.store.sessionObjectUrl(hash)).toBeNull();
    expect(await m.store.imageHashKeys()).toContain(hash);

    await m.gc.reconcile();
    await flush();
    expect(await m.store.imageHashKeys()).not.toContain(hash);
  });

  it("retained close keeps image bytes by hash through reconcile", async () => {
    const m = await loadModules({ desktop: true });
    m.gc.markLandingEditorMounted();
    m.gc.markLandingDraftsReady();
    await flush();

    const bytes = bytesOf([30, 31, 32]);
    const hash = await m.store.putImage(bytes);
    m.draft.useLandingDraftStore.setState({
      drafts: [
        makeDraft(m, {
          id: "d1",
          content: docWithImages(imageNode(hash, 5)),
          lastTouchedAt: 1,
        }),
      ],
      activeDraftId: "d1",
    });

    m.draft.useLandingDraftStore.getState().closeDraft("d1");
    expect(m.draft.useLandingDraftStore.getState().drafts[0]?.closed).toBe(
      true,
    );

    await m.gc.reconcile();
    await flush();
    await m.gc.reconcile();
    await flush();

    expect(await m.store.imageHashKeys()).toContain(hash);
    const stored = await m.store.getImageBytes(hash);
    expect(stored).toBeDefined();
    if (stored === undefined) return;
    expect(Array.from(stored)).toEqual(Array.from(bytes));
    const recomputed = await sha256Hex(stored);
    expect(recomputed).toBe(hash);
  });

  // Budget admission tests live in landing-image-budget.test.ts (canonical
  // service). GC no longer owns reserveLandingImageBudget.

  it("browser readies the sweep automatically after synchronous hydration", async () => {
    const m = await loadModules({ desktop: false });
    // The draft store's module-bottom hook queued the ready microtask on import.
    await flush();

    expect(m.gc.landingDraftsReady()).toBe(true);
  });

  it("partial putImage failure rolls back failed presence and reclaims the successful sibling orphan", async () => {
    // Real scheduleLandingImageReconcile + reconcile (not a no-op mock): after a
    // multi-image ingest where one putImage rejects, the failed hash must not
    // report present without durable bytes, and the successful sibling's now-
    // unreferenced IDB bytes must be reclaimed by the two-phase reconcile chain.
    const m = await loadModules({ desktop: false });
    await flush();
    expect(m.gc.landingDraftsReady()).toBe(true);

    // Empty live roots (no drafts, no live runtime mirror - loadModules already
    // reset draftRuntimeRegistry and this test never attaches one) so a
    // successful put with no editor node is unreferenced and eligible for
    // reclaim — the same shape as Promise.all multi-file attach after
    // onRejected (no nodes inserted).
    m.draft.useLandingDraftStore.setState({
      drafts: [],
      activeDraftId: null,
    });

    const successBytes = bytesOf([11, 11, 11]);
    const failBytes = bytesOf([22, 22, 22]);
    const successHashExpected = await sha256Hex(successBytes);
    const failedHash = await sha256Hex(failBytes);

    // Reject by content hash so the failure is deterministic even if callers
    // ever switch to concurrent putImage (call-count races which write fails).
    vi.mocked(m.idb.set).mockImplementation((key, value) => {
      const hash = idbStringKey(key);
      if (hash === failedHash) {
        return Promise.reject(new Error("idb write failed"));
      }
      idbData.set(hash, value);
      return Promise.resolve();
    });

    const successHash = await m.store.putImage(successBytes);
    expect(successHash).toBe(successHashExpected);
    await expect(m.store.putImage(failBytes)).rejects.toThrow(
      "idb write failed",
    );

    // (a) Failed hash is NOT left present with no durable bytes (putImage rollback).
    expect(m.store.hasLandingImageBytes(failedHash)).toBe(false);
    expect(await m.store.imageHashKeys()).not.toContain(failedHash);
    expect(m.store.sessionObjectUrl(failedHash)).toBeNull();
    // Successful sibling is still durable + session-cached (no node inserted).
    expect(m.store.hasLandingImageBytes(successHash)).toBe(true);
    expect(await m.store.imageHashKeys()).toContain(successHash);
    expect(m.store.sessionObjectUrl(successHash)).not.toBeNull();

    // (b) Real scheduler: onRejected would schedule reconcile. First sweep
    // releases the unreferenced session entry and schedules a follow-up; the
    // follow-up reclaims the now-unprotected IDB bytes.
    m.gc.scheduleLandingImageReconcile();
    await vi.advanceTimersByTimeAsync(250);
    await flush();
    expect(m.store.sessionObjectUrl(successHash)).toBeNull();
    expect(await m.store.imageHashKeys()).toContain(successHash);

    await vi.advanceTimersByTimeAsync(250);
    await flush();
    expect(await m.store.imageHashKeys()).not.toContain(successHash);
    expect(m.store.hasLandingImageBytes(successHash)).toBe(false);

    // Restore a working set so later cases (same idb mock module) are not poisoned.
    vi.mocked(m.idb.set).mockImplementation((key, value) => {
      idbData.set(idbStringKey(key), value);
      return Promise.resolve();
    });
  });

  it("[B1+B2] later empty-inbound guard preserves roots; mount then reaps unreferenced restored bytes", async () => {
    // Real projection → GC seam (no stubbed gates): the first empty desktop
    // hydrate is authoritative and opens readiness, but NOT the deletion gate.
    // After a live draft exists, a later spurious empty inbound preserves its
    // roots. markLandingEditorMounted then opens the deletion gate and reaps
    // genuine orphans while keeping the live draft's bytes.
    const m = await loadModules({ desktop: true });
    m.draft.applyLandingDraftDesktopProjection({
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    await flush();
    expect(m.gc.landingDraftsReady()).toBe(true);

    await m.idb.set("keep", bytesOf([1, 1, 1]), m.store.imageStore());
    await m.idb.set("orphan", bytesOf([2, 2, 2]), m.store.imageStore());

    m.draft.useLandingDraftStore.setState({
      drafts: [
        makeDraft(m, {
          id: "alive",
          content: docWithImages(imageNode("keep", 3)),
          lastTouchedAt: 1,
        }),
      ],
      activeDraftId: "alive",
    });

    // Later spurious empty inbound: B1 preserves the live draft.
    m.draft.applyLandingDraftDesktopProjection({
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    await flush();

    expect(m.gc.landingDraftsReady()).toBe(true);
    expect(m.draft.useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(await m.store.imageHashKeys()).toContain("keep");
    expect(await m.store.imageHashKeys()).toContain("orphan");

    // Mount: B2 deletion gate opens → orphan reaped, keep survives.
    m.gc.markLandingEditorMounted();
    await vi.advanceTimersByTimeAsync(250);
    await flush();

    expect(m.gc.landingDraftsReady()).toBe(true);
    const keys = await m.store.imageHashKeys();
    expect(keys).toContain("keep");
    expect(keys).not.toContain("orphan");
  });
});
