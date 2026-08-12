import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { File } from "@pierre/diffs";

/**
 * Real, unmocked `@pierre/diffs@1.3.1` proof for RESUME12's root cause: the
 * RESUME9 fix bumped `file.cacheKey`'s generation only on an `editing`
 * transition, so a purely read-only tile - `editing` never true, content
 * changing only via a reactivation refetch (`workspace-file-tile.tsx`'s
 * inactive->active `query.refetch()`) - kept the SAME cacheKey across a
 * content shrink and hit the exact same `FileRenderer.processFileResult`
 * ("Line doesnt exist") throw that RESUME9 fixed for the editing case.
 *
 * This proves the general library contract from
 * `workspace-empty-file-cachekey-console-regression.test.ts` also applies
 * with no `Editor` ever attached: a stable explicit `cacheKey` makes
 * `FileRenderer.isLineCacheForFile` skip comparing `contents` altogether, so
 * a later render under the same key with fewer lines reuses the stale
 * line-split. `WorkspaceFileRenderer`'s fix is to omit `cacheKey` entirely
 * while `editing` is false, letting the library fall back to its own
 * `lineCache.file === file && lineCache.sourceContents === file.contents`
 * comparison, which correctly rebuilds on every real content change.
 */
const originalGetContextDescriptor = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);
let originalPostMessage: typeof window.postMessage;
beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: text.length * 8 }),
    }),
  });
  originalPostMessage = window.postMessage.bind(window);
  const realPostMessage = originalPostMessage;
  window.postMessage = ((message: unknown) =>
    realPostMessage(message, "*")) as typeof window.postMessage;
});

afterAll(() => {
  if (originalGetContextDescriptor !== undefined) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "getContext",
      originalGetContextDescriptor,
    );
  }
  window.postMessage = originalPostMessage;
});

function makeContainer(): HTMLDivElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("@pierre/diffs cacheKey contract: a read-only content shrink under a SAME cacheKey throws (RESUME12 root cause)", () => {
  it("throws FileRenderer.processFileResult's 'Line doesnt exist' when read-only content shrinks under a stable cacheKey, no editor ever attached", async () => {
    const consoleErrors: unknown[][] = [];
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        consoleErrors.push(args);
      });

    try {
      // Mirrors the pre-RESUME12 `WorkspaceFileRenderer`: a stable cacheKey
      // even though `editing` is (and stays) false the entire time.
      const CACHE_KEY = "workspace-file-identity-key";
      const instance = new File({}, undefined, true);
      instance.hydrate({
        file: {
          name: "src/index.ts",
          contents: "line one\nline two\nline three\nline four\nline five",
          cacheKey: CACHE_KEY,
        },
        fileContainer: makeContainer(),
      });
      await settle(50);

      // A reactivation refetch resolves with far fewer lines than the
      // cached split (an external truncation, or the file simply being
      // shorter than what this tab last saw before it went inactive).
      instance.render({
        file: {
          name: "src/index.ts",
          contents: "line one",
          cacheKey: CACHE_KEY,
        },
      });
      await settle(100);
    } finally {
      consoleErrorSpy.mockRestore();
    }

    expect(consoleErrors.length).toBeGreaterThan(0);
    expect(consoleErrors[0]?.[0]).toBe(
      "FileRenderer.processFileResult: Line doesnt exist",
    );
  });

  it("does not throw for the same shrink when the file is unkeyed (the fix)", async () => {
    const consoleErrors: unknown[][] = [];
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        consoleErrors.push(args);
      });

    try {
      const instance = new File({}, undefined, true);
      instance.hydrate({
        file: {
          name: "src/index.ts",
          contents: "line one\nline two\nline three\nline four\nline five",
        },
        fileContainer: makeContainer(),
      });
      await settle(50);

      instance.render({
        file: { name: "src/index.ts", contents: "line one" },
      });
      await settle(100);

      // Grow back too - proves the unkeyed identity/content comparison
      // rebuilds correctly in both directions, not just shrink.
      instance.render({
        file: {
          name: "src/index.ts",
          contents: "a\nb\nc\nd\ne\nf\ng",
        },
      });
      await settle(100);
    } finally {
      consoleErrorSpy.mockRestore();
    }

    expect(consoleErrors).toEqual([]);
  });
});
