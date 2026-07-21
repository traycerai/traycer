import { describe, expect, it, vi } from "vitest";

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
