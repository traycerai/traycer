/**
 * `loadDocxPreview()`'s memoization contract (docx-preview-loader.ts): ONE
 * import per module lifetime, whether it resolved or rejected. A rejection
 * is deliberately not retried - the browser's module map would reject the
 * same URL again without refetching - so a second call must hand back the
 * same promise rather than evaluate the chunk a second time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ attempts: 0, failFirst: false }));

vi.mock("../docx-preview", () => {
  state.attempts += 1;
  if (state.failFirst && state.attempts === 1) {
    throw new Error("chunk failed to load");
  }
  return { default: (): null => null };
});

// Rejection first: Vitest keeps a SUCCESSFULLY evaluated mock module cached
// across `vi.resetModules()`, while a factory that threw is re-run on the
// next import - so the order below is what lets both cases observe a fresh
// factory evaluation.
describe("loadDocxPreview", () => {
  afterEach(() => {
    state.attempts = 0;
    state.failFirst = false;
    vi.resetModules();
  });

  it("memoizes a rejected load instead of importing the chunk again", async () => {
    state.failFirst = true;
    const { loadDocxPreview } = await import("../docx-preview-loader");

    const first = loadDocxPreview();
    await expect(first).rejects.toBeInstanceOf(Error);
    expect(loadDocxPreview()).toBe(first);
    expect(state.attempts).toBe(1);
  });

  it("memoizes a successful load across callers", async () => {
    const { loadDocxPreview } = await import("../docx-preview-loader");

    const first = loadDocxPreview();
    await expect(first).resolves.toHaveProperty("default");
    expect(loadDocxPreview()).toBe(first);
    expect(state.attempts).toBe(1);
  });
});
