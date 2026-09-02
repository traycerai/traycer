/**
 * `loadPdfPreview()`'s own memoization contract (pdf-preview-loader.ts):
 * a successful chunk load is cached for the module's lifetime, but a
 * rejected attempt is forgotten so the next call retries. This drives the
 * mocked `../pdf-preview` factory to reject on its first evaluation and
 * resolve on its second, to prove the retry actually re-imports rather than
 * replaying the same rejected promise.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ attempt: 0 }));

vi.mock("../pdf-preview", () => {
  state.attempt += 1;
  if (state.attempt === 1) {
    throw new Error("chunk failed to load");
  }
  return { default: (): null => null };
});

describe("loadPdfPreview", () => {
  afterEach(() => {
    state.attempt = 0;
    vi.resetModules();
  });

  it("forgets a rejected attempt and memoizes the retry that follows", async () => {
    const { loadPdfPreview } = await import("../pdf-preview-loader");

    const first = loadPdfPreview();
    await expect(first).rejects.toBeInstanceOf(Error);

    const second = loadPdfPreview();
    await expect(second).resolves.toHaveProperty("default");

    const third = loadPdfPreview();
    expect(third).toBe(second);
  });
});
