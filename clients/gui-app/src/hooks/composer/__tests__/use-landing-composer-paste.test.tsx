import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { ComposerPasteEditorHandle } from "@/hooks/composer/use-composer-paste";
import { useLandingComposerPaste } from "@/hooks/composer/use-landing-composer-paste";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  deleteImage,
  getImageBytes,
  imageHashKeys,
  releaseSession,
  sessionObjectUrl,
} from "@/lib/composer/landing-image-store";

// In-memory stand-in for idb-keyval so `putImage` can persist + read back bytes
// without a real IndexedDB. Mirrors the landing-image-store unit test.
vi.mock("idb-keyval", () => {
  const data = new Map<string, unknown>();
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(data.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string) => {
      data.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(data.keys()))),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

let urlCounter = 0;

beforeEach(async () => {
  URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
  URL.revokeObjectURL = vi.fn();
  for (const hash of await imageHashKeys()) {
    await deleteImage(hash);
    releaseSession(hash);
  }
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
});

function makeHandle(inserted: ImageAttachmentAttrs[][]): {
  readonly handle: ComposerPasteEditorHandle;
  readonly focusCalls: { count: number };
} {
  const focusCalls = { count: 0 };
  const handle: ComposerPasteEditorHandle = {
    isReady: () => true,
    insertImageAttachments: (attrs) => inserted.push([...attrs]),
    focus: () => {
      focusCalls.count += 1;
    },
  };
  return { handle, focusCalls };
}

describe("useLandingComposerPaste", () => {
  it("does not report an attachment when a non-null editor is not ready", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const editorRef = {
      current: {
        isReady: () => false,
        insertImageAttachments: (attrs: ReadonlyArray<ImageAttachmentAttrs>) =>
          inserted.push([...attrs]),
        focus: () => undefined,
      },
    };
    const { result } = renderHook(() => useLandingComposerPaste(editorRef));

    act(() => {
      result.current.attachImageFiles([
        new File(["hello"], "not-ready.png", { type: "image/png" }),
      ]);
    });
    await waitFor(async () => {
      expect(await imageHashKeys()).toHaveLength(1);
    });

    expect(inserted).toEqual([]);
    expect(track).not.toHaveBeenCalledWith(
      AnalyticsEvent.AttachmentAdded,
      expect.anything(),
    );
  });

  it("ingests an image as a hash-only node with bytes + a session object-URL", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle, focusCalls } = makeHandle(inserted);
    const editorRef = { current: handle };
    const { result } = renderHook(() => useLandingComposerPaste(editorRef));

    const file = new File(["hello"], "shot.png", { type: "image/png" });
    act(() => {
      result.current.attachImageFiles([file]);
    });

    await waitFor(() => {
      expect(inserted).toHaveLength(1);
    });

    const attrs = inserted[0][0];
    expect(attrs.fileName).toBe("shot.png");
    expect(attrs.mimeType).toBe("image/png");
    expect(attrs.size).toBe(5);
    // Hash-only: a content hash, never inline base64.
    expect(attrs.b64content).toBeUndefined();
    const hash = attrs.hash;
    if (hash === undefined) throw new Error("expected a hash-only node");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Bytes are persisted + reachable, and a synchronous object-URL exists so the
    // chip renders instantly (no placeholder frame).
    expect(await getImageBytes(hash)).toEqual(
      new Uint8Array([104, 101, 108, 108, 111]),
    );
    expect(sessionObjectUrl(hash)).not.toBeNull();
    expect(focusCalls.count).toBe(1);
  });

  it("dedupes identical bytes to a single hash across two pastes", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted);
    const editorRef = { current: handle };
    const { result } = renderHook(() => useLandingComposerPaste(editorRef));

    const first = new File(["same"], "a.png", { type: "image/png" });
    const second = new File(["same"], "b.png", { type: "image/png" });

    act(() => {
      result.current.attachImageFiles([first]);
    });
    await waitFor(() => expect(inserted).toHaveLength(1));
    act(() => {
      result.current.attachImageFiles([second]);
    });
    await waitFor(() => expect(inserted).toHaveLength(2));

    // Same content → same hash; distinct node ids and file names.
    expect(inserted[0][0].hash).toBe(inserted[1][0].hash);
    expect(inserted[0][0].id).not.toBe(inserted[1][0].id);
    expect(await imageHashKeys()).toHaveLength(1);
  });

  it("drops non-image files and keeps only images", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted);
    const editorRef = { current: handle };
    const { result } = renderHook(() => useLandingComposerPaste(editorRef));

    const png = new File(["img"], "shot.png", { type: "image/png" });
    const pdf = new File(["doc"], "doc.pdf", { type: "application/pdf" });

    act(() => {
      result.current.attachImageFiles([png, pdf]);
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0]).toHaveLength(1);
    expect(inserted[0][0].fileName).toBe("shot.png");
  });

  it("surfaces a toast and inserts nothing when ingest fails", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted);
    const editorRef = { current: handle };
    const { result } = renderHook(() => useLandingComposerPaste(editorRef));

    // Force `putImage` (its `sha256Hex`) to reject so the whole ingest rejects —
    // the partial-paste failure path. The `.catch` must surface a toast (and
    // schedule a reclaim) instead of an unhandled rejection.
    const digestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValue(new Error("hash failed"));

    const file = new File(["hello"], "shot.png", { type: "image/png" });
    act(() => {
      result.current.attachImageFiles([file]);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't attach the image.", {
        description: "Please try adding it again.",
      });
    });
    expect(inserted).toHaveLength(0);

    digestSpy.mockRestore();
  });

  it("rejects oversized images via a toast and inserts nothing", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted);
    const editorRef = { current: handle };
    const { result } = renderHook(() => useLandingComposerPaste(editorRef));

    const oversized = new File(["x"], "big.png", { type: "image/png" });
    Object.defineProperty(oversized, "size", { value: 10 * 1024 * 1024 });

    act(() => {
      result.current.attachImageFiles([oversized]);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inserted).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(await imageHashKeys()).toHaveLength(0);
  });
});
