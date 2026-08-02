import { describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

// In-memory idb-keyval stub so importing the landing stores (which pull in
// landing-image-gc → landing-image-store) doesn't touch a real IndexedDB.
vi.mock("idb-keyval", () => {
  const data = new Map<string, unknown>();
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(data.get(key))),
    set: vi.fn(() => Promise.resolve()),
    del: vi.fn(() => Promise.resolve()),
    keys: vi.fn(() => Promise.resolve(Array.from(data.keys()))),
  };
});

function imageDoc(hash: string, size: number): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: `node-${hash.slice(0, 8)}`,
              fileName: "live.png",
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

// Regression: the runtime registry deliberately does not import the persisted
// source. The draft store configures it only after construction, avoiding the
// former composer-store cycle while still allowing GC to read live roots.
describe("landing draft runtime wiring", () => {
  it("evaluates the source and registry cleanly when the draft store is imported first", async () => {
    vi.resetModules();
    const draft = await import("@/stores/home/landing-draft-store");
    const runtime = await import("@/stores/home/draft-runtime-registry");
    const id = draft.useLandingDraftStore.getState().createDraft(null);
    expect(runtime.draftRuntimeRegistry.getOrHydrate(id)).not.toBeNull();
  });

  it("evaluates the registry before the draft store without a temporal dead zone", async () => {
    vi.resetModules();
    const runtime = await import("@/stores/home/draft-runtime-registry");
    const draft = await import("@/stores/home/landing-draft-store");
    const id = draft.useLandingDraftStore.getState().createDraft(null);
    expect(runtime.draftRuntimeRegistry.getOrHydrate(id)).not.toBeNull();
  });
});

/**
 * Regression for the fixed store → gc → budget → store cycle. Budget no longer
 * statically imports the draft store; the store registers a read-only root
 * source after construction. These cases exercise both realistic cold-start
 * order (store first) and reverse order (budget/gc first) and prove a
 * reconcile-shaped root read never throws a TDZ ReferenceError.
 */
describe("landing budget store import order", () => {
  it("store-first cold start: root read and reserve do not throw", async () => {
    vi.resetModules();
    // Realistic entry: something that pulls the draft store (and therefore
    // gc → budget) before anything else touches the budget module alone.
    const draft = await import("@/stores/home/landing-draft-store");
    const budget = await import("@/lib/composer/landing-image-budget");

    const liveHash = "a".repeat(64);
    draft.useLandingDraftStore.setState({
      drafts: [
        {
          id: "import-cycle-draft",
          content: imageDoc(liveHash, 1024),
          selection: null,
          lastTouchedAt: 1,
          settings: null,
          composerMode: "chat",
          workspace: draft.emptyLandingDraftWorkspaceSnapshot(),
        },
      ],
      activeDraftId: "import-cycle-draft",
    });

    expect(() => budget.landingLiveImageRootHashes()).not.toThrow();
    expect(budget.landingLiveImageRootHashes()).toEqual(new Set([liveHash]));

    const reservation = budget.reserveLandingImageBudget("import-cycle-draft", [
      { hash: liveHash, bytes: 1024 },
    ]);
    expect(reservation).not.toBeNull();
    reservation?.release();
  });

  it("budget-first then store: root read does not throw a TDZ ReferenceError", async () => {
    vi.resetModules();
    // Reverse of cold-start: budget (or a consumer that only needs admission
    // math) loads before the draft store ever registers the root source.
    const budget = await import("@/lib/composer/landing-image-budget");
    // Before registration: empty, never a crash against an unregistered source.
    expect(budget.landingLiveImageRootHashes()).toEqual(new Set());

    const draft = await import("@/stores/home/landing-draft-store");
    const liveHash = "b".repeat(64);
    draft.useLandingDraftStore.setState({
      drafts: [
        {
          id: "budget-first-draft",
          content: imageDoc(liveHash, 2048),
          selection: null,
          lastTouchedAt: 1,
          settings: null,
          composerMode: "chat",
          workspace: draft.emptyLandingDraftWorkspaceSnapshot(),
        },
      ],
      activeDraftId: "budget-first-draft",
    });

    expect(() => budget.landingLiveImageRootHashes()).not.toThrow();
    expect(budget.landingLiveImageRootHashes()).toEqual(new Set([liveHash]));
  });

  it("gc-first then store: reconcile-shaped live-root read stays safe", async () => {
    vi.resetModules();
    // GC is the other mid-cycle importer of budget; loading it first used to
    // be enough to hit a half-initialized store via the old static import.
    const gc = await import("@/lib/composer/landing-image-gc");
    const budget = await import("@/lib/composer/landing-image-budget");
    expect(budget.landingLiveImageRootHashes()).toEqual(new Set());

    const draft = await import("@/stores/home/landing-draft-store");
    const liveHash = "c".repeat(64);
    draft.useLandingDraftStore.setState({
      drafts: [
        {
          id: "gc-first-draft",
          content: imageDoc(liveHash, 512),
          selection: null,
          lastTouchedAt: 1,
          settings: null,
          composerMode: "chat",
          workspace: draft.emptyLandingDraftWorkspaceSnapshot(),
        },
      ],
      activeDraftId: "gc-first-draft",
    });

    // Same shape as reconcile(): read live roots after the store is up.
    expect(() => budget.landingLiveImageRootHashes()).not.toThrow();
    expect(budget.landingLiveImageRootHashes()).toEqual(new Set([liveHash]));
    // Touch a GC export so the import is not dead-code-eliminated and so a
    // future re-cycle that breaks GC load order fails this suite loudly.
    expect(typeof gc.scheduleLandingImageReconcile).toBe("function");
  });
});
