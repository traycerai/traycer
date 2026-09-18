/**
 * The shared paste core's PREPARATION behaviour against the REAL
 * universal-policy preparer — not a mocked codec. The production session
 * (`createComposerImagePreparationSession`) always uses the real browser codec
 * with no injection seam, so these tests drive it the same way
 * `prompt-stash-image-preparation-browser-fallback.test.ts` does: a
 * `createImageBitmap` double plus canvas `getContext`/`toBlob` doubles.
 *
 * Driven through `useComposerHashFirstPaste`, the hook the chat composer, the
 * edit composer and the new-conversation modal actually run. These pins used to
 * go through `useComposerPasteAdapter`, whose base64 ingest lost its last
 * caller
 * when those surfaces went hash-first and was deleted with it; the preparation
 * path underneath — `collectImages`, the per-mount session, the serial `for`
 * loop that keeps one bitmap alive at a time, and the prepared size/type/name
 * the node ends up carrying — is the same code under either ingest, which is why
 * every assertion below is unchanged.
 *
 * `putImage` is doubled rather than driven against IndexedDB: these are
 * preparation pins, and the store has its own suite.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { toast } from "sonner";

import {
  MAX_IMAGE_SOURCE_BYTES,
  type ComposerFilePathIngestArgs,
} from "@/hooks/composer/use-composer-paste";
import {
  useComposerHashFirstPaste,
  type ComposerHashFirstEditorHandle,
} from "@/hooks/composer/use-composer-hash-first-paste";
import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import {
  encodedWebpBytesOfSize,
  pngBytesOfSize,
} from "@/lib/composer/__tests__/prompt-stash-image-fixtures";

vi.mock("@/lib/composer/composer-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/composer/composer-image-store")
    >();
  return {
    ...actual,
    putImage: vi.fn(() => Promise.resolve("prepared-image-hash")),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

const NOOP_FILE_PATHS: ComposerFilePathIngestArgs = {
  fileDrops: {
    resolveDroppedFilePaths: () => Promise.resolve([]),
    copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
    readNativeClipboardFilePaths: () => Promise.resolve([]),
  },
  mentionRoots: [],
  beginPathInsertion: () => null,
};

/**
 * Mounts the real hook against a stub editor handle that records each batch of
 * inserted attrs — the same collector shape these pins used when they drove
 * the deleted adapter's `insertAttrs` callback directly. `budgetOwnerId`
 * is `null` because the byte budget is per-window and the owner id only picks
 * refusal copy, which no pin here asserts.
 */
function renderPasteHook(inserted: ImageAttachmentAttrs[][]) {
  const handle: ComposerHashFirstEditorHandle = {
    isReady: () => true,
    insertImageAttachments: (attrs) => {
      inserted.push([...attrs]);
    },
    beginPathInsertion: () => null,
    focus: () => undefined,
    getJSON: () => ({ type: "doc", content: [] }),
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => true,
  };
  const editorRef = { current: handle };
  return renderHook(() =>
    useComposerHashFirstPaste({
      editorRef,
      budgetOwnerId: null,
      disabled: false,
      fileDrops: NOOP_FILE_PATHS.fileDrops,
      mentionRoots: NOOP_FILE_PATHS.mentionRoots,
    }),
  );
}

const originalCreateImageBitmap = globalThis.createImageBitmap;

afterEach(() => {
  cleanup();
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: originalCreateImageBitmap,
  });
  vi.mocked(toast.error).mockClear();
  vi.restoreAllMocks();
});

function pngFileWithBytes(bytes: Uint8Array<ArrayBuffer>, name: string): File {
  const file = new File([bytes], name, { type: "image/png" });
  Object.defineProperty(file, "size", { value: bytes.byteLength });
  return file;
}

interface TestBitmap {
  readonly width: number;
  readonly height: number;
  readonly close: () => void;
}

/**
 * Installs a `createImageBitmap` double plus canvas doubles that always
 * encode successfully as WebP, at a fixed small (< 2000px edge) size, so no
 * scaling or source-family attempt is needed and the ladder's first WebP
 * attempt always fits. `onDecodeCall` fires synchronously at call time
 * (before the returned promise resolves) so a test can observe call ORDER,
 * not just eventual completion.
 */
function installRealCodecDoubles(args: {
  readonly onDecodeCall:
    | ((callIndex: number) => Promise<TestBitmap>)
    | undefined;
}): {
  readonly close: Mock<() => void>;
} {
  const close: Mock<() => void> = vi.fn<() => void>(() => undefined);
  let callIndex = 0;
  const createImageBitmap = vi.fn(
    (
      _source: ImageBitmapSource,
      _opts: ImageBitmapOptions | undefined,
    ): Promise<TestBitmap> => {
      const index = callIndex;
      callIndex += 1;
      if (args.onDecodeCall !== undefined) return args.onDecodeCall(index);
      return Promise.resolve({ width: 800, height: 600, close });
    },
  );
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: createImageBitmap,
  });

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
    contextId: string,
  ) => {
    if (contextId !== "2d") return null;
    return {
      fillStyle: "",
      fillRect: () => undefined,
      drawImage: () => undefined,
    };
  }) as HTMLCanvasElement["getContext"]);

  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    function mockedToBlob(
      this: HTMLCanvasElement,
      callback: BlobCallback,
      type: string | undefined,
    ): void {
      // The 1×1 supportsWebP probe canvas: only `blob.type` is consulted,
      // never sniffed, so an arbitrary payload is fine here.
      if (this.width === 1 && this.height === 1) {
        callback(new Blob([new Uint8Array([1])], { type: "image/webp" }));
        return;
      }
      // A real encode candidate is magic-byte SNIFFED against its requested
      // MIME type (`sniffImageMimeType`), so the payload must actually be a
      // valid WebP - arbitrary bytes would silently fail every attempt.
      callback(
        new Blob([encodedWebpBytesOfSize(64)], { type: type ?? "image/webp" }),
      );
    },
  );

  return { close };
}

describe("shared paste core: preparation against the real codec", () => {
  it("refuses a file over the 50 MiB source ceiling with the standard toast, and never reads it", async () => {
    const bytes = new Uint8Array(1);
    const oversized = new File([bytes], "huge.png", { type: "image/png" });
    Object.defineProperty(oversized, "size", {
      value: MAX_IMAGE_SOURCE_BYTES + 1,
    });
    const readSpy = vi.spyOn(oversized, "arrayBuffer");

    const inserted: ImageAttachmentAttrs[][] = [];
    const { result } = renderPasteHook(inserted);

    act(() => {
      result.current.attachImageFiles([oversized]);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
    expect(toast.error).toHaveBeenCalledWith(
      "Image too large even after resizing.",
      expect.objectContaining({ description: "huge.png" }),
    );
    expect(inserted).toHaveLength(0);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("prepares and attaches a file under 50 MiB but over the 3.75 MiB output ceiling, carrying the PREPARED size and MIME type, not the File's", async () => {
    installRealCodecDoubles({ onDecodeCall: undefined });
    const sourceBytes = pngBytesOfSize(4 * 1024 * 1024); // header-less: forces decode
    const file = pngFileWithBytes(sourceBytes, "big.png");
    expect(file.size).toBe(4 * 1024 * 1024);

    const inserted: ImageAttachmentAttrs[][] = [];
    const { result } = renderPasteHook(inserted);

    act(() => {
      result.current.attachImageFiles([file]);
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    const attrs = inserted[0];
    const image = attrs?.[0];
    expect(image).toBeDefined();
    if (image === undefined) throw new Error("expected an inserted image");
    // The mocked encode always answers a 64-byte WebP blob - far from the
    // source file's 4 MiB, which is the point: the node must carry what
    // preparation produced, never the original File's numbers.
    expect(image.size).toBe(64);
    expect(image.size).not.toBe(file.size);
    expect(image.mimeType).toBe("image/webp");
    expect(image.mimeType).not.toBe(file.type);
  });

  it("re-extends the file name when preparation changes the encoded format", async () => {
    installRealCodecDoubles({ onDecodeCall: undefined });
    const sourceBytes = pngBytesOfSize(4 * 1024 * 1024);
    const file = pngFileWithBytes(sourceBytes, "shot.png");

    const inserted: ImageAttachmentAttrs[][] = [];
    const { result } = renderPasteHook(inserted);

    act(() => {
      result.current.attachImageFiles([file]);
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    const image = inserted[0]?.[0];
    expect(image).toBeDefined();
    expect(image?.fileName).toBe("shot.webp");
  });

  it("prepares a multi-image paste SERIALLY: the second decode is not invoked until the first bitmap's close has run", async () => {
    const events: string[] = [];
    const gates: Array<() => void> = [];

    const bitmapFor = (index: number): TestBitmap => ({
      width: 800,
      height: 600,
      close: () => events.push(`close:${index}`),
    });

    installRealCodecDoubles({
      onDecodeCall: (index) => {
        events.push(`decode-call:${index}`);
        return new Promise<TestBitmap>((resolve) => {
          gates.push(() => resolve(bitmapFor(index)));
        });
      },
    });

    const fileA = pngFileWithBytes(pngBytesOfSize(4 * 1024 * 1024), "a.png");
    const fileB = pngFileWithBytes(pngBytesOfSize(4 * 1024 * 1024), "b.png");

    const inserted: ImageAttachmentAttrs[][] = [];
    const { result } = renderPasteHook(inserted);

    act(() => {
      result.current.attachImageFiles([fileA, fileB]);
    });

    // Both files were accepted for ingest, but only the first decode has
    // been reached - the `for` loop's `await` blocks the second file's read
    // and decode until the first `prepare()` call has fully settled.
    await waitFor(() => expect(gates).toHaveLength(1));
    expect(events).toEqual(["decode-call:0"]);

    await act(async () => {
      gates[0]?.();
      // Let the first image's encode/close and the second image's read+decode
      // start settle through the microtask queue.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(gates).toHaveLength(2));
    expect(events).toEqual(["decode-call:0", "close:0", "decode-call:1"]);

    await act(async () => {
      gates[1]?.();
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(events).toEqual([
      "decode-call:0",
      "close:0",
      "decode-call:1",
      "close:1",
    ]);
    expect(inserted[0]).toHaveLength(2);
  });

  // Concurrency fix: `attachImageFiles` launches ONE independent background
  // job per call (`trackPendingImageJob` fires a `void job(...)` and does
  // not await it), so two rapid pastes on the SAME mount do not await one
  // another the way the single-paste, two-file test above does (that one's
  // seriality comes from `hashFirstImageAttrsFromFiles`'s own `for` loop,
  // which would hold even without the mount-shared session). This pins the
  // session-level queue: `useComposerHashFirstPaste` memoizes ONE session per
  // mount, so a second paste issued in the same tick still queues behind the
  // first.
  it("serializes TWO separate attachImageFiles calls issued in the same tick: the second paste's decode waits for the first paste's conversion to settle", async () => {
    const events: string[] = [];
    const gates: Array<() => void> = [];

    const bitmapFor = (index: number): TestBitmap => ({
      width: 800,
      height: 600,
      close: () => events.push(`close:${index}`),
    });

    installRealCodecDoubles({
      onDecodeCall: (index) => {
        events.push(`decode-call:${index}`);
        return new Promise<TestBitmap>((resolve) => {
          gates.push(() => resolve(bitmapFor(index)));
        });
      },
    });

    const fileA = pngFileWithBytes(pngBytesOfSize(4 * 1024 * 1024), "a.png");
    const fileB = pngFileWithBytes(pngBytesOfSize(4 * 1024 * 1024), "b.png");

    const inserted: ImageAttachmentAttrs[][] = [];
    const { result } = renderPasteHook(inserted);

    // Two SEPARATE calls, same tick, no await between them - exactly what a
    // second paste landing while the first is still converting looks like.
    act(() => {
      result.current.attachImageFiles([fileA]);
      result.current.attachImageFiles([fileB]);
    });

    // Without the mount-shared session, both pastes' conversions would reach
    // `createImageBitmap` in this same tick.
    await waitFor(() => expect(gates).toHaveLength(1));
    expect(events).toEqual(["decode-call:0"]);

    await act(async () => {
      gates[0]?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(gates).toHaveLength(2));
    // The second paste's decode starts only after the first's bitmap closed.
    expect(events).toEqual(["decode-call:0", "close:0", "decode-call:1"]);

    await act(async () => {
      gates[1]?.();
    });

    await waitFor(() => expect(inserted).toHaveLength(2));
    expect(events).toEqual([
      "decode-call:0",
      "close:0",
      "decode-call:1",
      "close:1",
    ]);
  });
});
