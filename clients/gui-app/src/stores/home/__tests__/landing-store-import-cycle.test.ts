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

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

// Regression: the landing stores form an import cycle
//   landing-draft-store → landing-image-gc → landing-composer-store → landing-draft-store
// `EMPTY_LANDING_DRAFT_CONTENT` must resolve from a dependency-free leaf module so
// landing-composer-store's module-eval read of it can't hit a temporal-dead-zone
// error — regardless of which module the app imports first. Pre-fix this crashed
// at startup ("Cannot access 'EMPTY_LANDING_DRAFT_CONTENT' before initialization")
// in an order the other unit tests happened not to exercise.
describe("landing store import cycle", () => {
  it("evaluates the cycle cleanly when landing-draft-store is imported first", async () => {
    vi.resetModules();
    // The app's failing order: importing the draft store evaluates the whole
    // cycle (→ gc → composer-store) before the draft store's own body finishes.
    await import("@/stores/home/landing-draft-store");
    const composer = await import("@/stores/composer/landing-composer-store");
    expect(composer.useLandingComposerStore.getState().currentContent).toEqual(
      EMPTY_DOC,
    );
  });

  it("evaluates the cycle cleanly when landing-composer-store is imported first", async () => {
    vi.resetModules();
    const composer = await import("@/stores/composer/landing-composer-store");
    expect(composer.useLandingComposerStore.getState().currentContent).toEqual(
      EMPTY_DOC,
    );
  });
});
