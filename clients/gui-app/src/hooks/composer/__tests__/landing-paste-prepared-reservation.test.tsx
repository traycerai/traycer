/**
 * Extends the reservation-handoff coverage
 * (`use-landing-composer-paste-reservation-handoff.test.tsx`) with the
 * PREPARED-vs-source byte accounting: `landingImageAttrsFromFiles` reserves
 * against `image.byteLength` (what preparation produced and `putImage` is
 * about to store), never `File.size`. Setup mirrors that suite (idb-keyval
 * double, `reserveLandingImageBudget` spy) — read it first.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { ComposerPasteEditorHandle } from "@/hooks/composer/use-composer-paste";
import { useLandingComposerPaste } from "@/hooks/composer/use-landing-composer-paste";
import {
  resetLandingImageBudgetReservationsForTesting,
  type LandingImageBudgetReservation,
} from "@/lib/composer/landing-image-budget";
import * as landingImageBudget from "@/lib/composer/landing-image-budget";
import {
  deleteImageBytesUnchecked,
  imageHashKeys,
  releaseSession,
} from "@/lib/composer/landing-image-store";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import * as idb from "idb-keyval";
import {
  encodedWebpBytesOfSize,
  pngBytesOfSize,
} from "@/lib/composer/__tests__/prompt-stash-image-fixtures";

import {
  makeHandle,
  NO_MENTION_ROOTS,
  NOOP_FILE_DROPS,
} from "./use-landing-composer-paste-test-helpers";

const gcMocks = vi.hoisted(() => ({
  scheduleLandingImageReconcile: vi.fn(() => undefined),
}));

vi.mock("@/lib/composer/landing-image-gc", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/composer/landing-image-gc")>();
  gcMocks.scheduleLandingImageReconcile.mockImplementation(() => undefined);
  return {
    ...actual,
    scheduleLandingImageReconcile: gcMocks.scheduleLandingImageReconcile,
  };
});

const idbData = vi.hoisted(() => new Map<string, unknown>());

function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("landing image store keys are string hashes");
  }
  return key;
}

vi.mock("idb-keyval", () => {
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(idbData.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      idbData.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string) => {
      idbData.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

const originalCreateImageBitmap = globalThis.createImageBitmap;

let urlCounter = 0;
// One preparation session per test (queue-serialization fix), created fresh
// in `beforeEach` and shared across every `useLandingComposerPaste` call in
// a given test - never a fresh one inside a `renderHook` callback.

beforeEach(async () => {
  URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
  URL.revokeObjectURL = vi.fn();
  vi.mocked(idb.set).mockImplementation((key, value) => {
    idbData.set(idbStringKey(key), value);
    return Promise.resolve();
  });
  const hashes = await imageHashKeys();
  await Promise.all(
    hashes.map(async (hash) => {
      await deleteImageBytesUnchecked(hash);
      releaseSession(hash);
    }),
  );
  resetLandingImageBudgetReservationsForTesting();
  vi.mocked(toast.error).mockClear();
  vi.mocked(scheduleLandingImageReconcile).mockClear();
  gcMocks.scheduleLandingImageReconcile.mockImplementation(() => undefined);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

afterEach(() => {
  cleanup();
  resetLandingImageBudgetReservationsForTesting();
  gcMocks.scheduleLandingImageReconcile.mockImplementation(() => undefined);
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: originalCreateImageBitmap,
  });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Installs a real-codec double that always downscale-encodes to WebP. */
function installRealCodecDoubles(): void {
  const createImageBitmap = vi.fn(
    (
      _source: ImageBitmapSource,
      _opts: ImageBitmapOptions | undefined,
    ): Promise<{ width: number; height: number; close: () => void }> =>
      Promise.resolve({ width: 800, height: 600, close: () => undefined }),
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
      if (this.width === 1 && this.height === 1) {
        callback(new Blob([new Uint8Array([1])], { type: "image/webp" }));
        return;
      }
      callback(
        new Blob([encodedWebpBytesOfSize(96)], { type: type ?? "image/webp" }),
      );
    },
  );
}

function pngFileWithBytes(bytes: Uint8Array<ArrayBuffer>, name: string): File {
  const file = new File([bytes], name, { type: "image/png" });
  Object.defineProperty(file, "size", { value: bytes.byteLength });
  return file;
}

describe("useLandingComposerPaste - reservation charges the PREPARED byte length", () => {
  const originalReserveLandingImageBudget =
    landingImageBudget.reserveLandingImageBudget;

  afterEach(() => {
    const current = landingImageBudget.reserveLandingImageBudget;
    if (vi.isMockFunction(current)) {
      current.mockRestore();
    }
    vi.mocked(idb.set).mockImplementation((key, value) => {
      idbData.set(idbStringKey(key), value);
      return Promise.resolve();
    });
  });

  function spyReservations(): {
    readonly calls: Array<
      ReadonlyArray<{ readonly hash: string | null; readonly bytes: number }>
    >;
    readonly releaseSpies: Array<() => void>;
  } {
    const calls: Array<
      ReadonlyArray<{ readonly hash: string | null; readonly bytes: number }>
    > = [];
    const releaseSpies: Array<() => void> = [];
    vi.spyOn(
      landingImageBudget,
      "reserveLandingImageBudget",
    ).mockImplementation((draftId, candidates) => {
      calls.push(candidates.map((c) => ({ hash: c.hash, bytes: c.bytes })));
      const reservation: LandingImageBudgetReservation | null =
        originalReserveLandingImageBudget(draftId, candidates);
      if (reservation === null) return null;
      const release = vi.fn(() => reservation.release());
      releaseSpies.push(release);
      // `settleStored` is delegated, not stubbed away: the paste path calls it
      // per candidate to hand that slot's charge to the hash it turned out to
      // be, and a spy that answered only `release` would silently leave every
      // landed image double-charged for the rest of the batch - which is the
      // very accounting these cases measure.
      return {
        release,
        settleStored: (candidateIndex: number, hash: string) => {
          reservation.settleStored(candidateIndex, hash);
        },
      };
    });
    return { calls, releaseSpies };
  }

  it("reserves the PREPARED byte length, not the source File's, when preparation compresses the image", async () => {
    installRealCodecDoubles();
    const { calls, releaseSpies } = spyReservations();

    // Header-less: forces the decode/encode path rather than the sniff
    // verbatim path, so the reserved length genuinely differs from the
    // source file's.
    const sourceBytes = pngBytesOfSize(4 * 1024 * 1024);
    const file = pngFileWithBytes(sourceBytes, "big.png");
    expect(file.size).toBe(4 * 1024 * 1024);

    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted, []);
    const editorRef = { current: handle };
    const { result } = renderHook(() =>
      useLandingComposerPaste({
        editorRef,
        draftId: "draft-prepared-size",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: NO_MENTION_ROOTS,
      }),
    );

    act(() => {
      result.current.attachImageFiles([file]);
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    await waitFor(() => expect(calls).toHaveLength(1));

    // The mocked encode always answers a 96-byte WebP blob.
    expect(calls[0]).toEqual([{ hash: null, bytes: 96 }]);
    expect(calls[0]?.[0]?.bytes).not.toBe(file.size);

    // Indexed directly, and the `expect(image).toBeDefined()` that used to sit
    // here is gone with the optional chains: `inserted` is
    // `ImageAttachmentAttrs[][]`, so the element type is non-nullable and that
    // assertion could never fail. The `waitFor` above is what establishes the
    // insertion actually happened; if it somehow had not, reading `.size` off
    // nothing fails this line by name, which is the clearer failure anyway.
    const image = inserted[0][0];
    expect(image.size).toBe(96);
    expect(image.mimeType).toBe("image/webp");

    await waitFor(() => expect(releaseSpies).toHaveLength(1));
    await waitFor(() => expect(releaseSpies[0]).toHaveBeenCalledTimes(1));
  });

  it("keeps release-after-insert ordering when the reservation is keyed on the prepared size", async () => {
    installRealCodecDoubles();
    const { releaseSpies } = spyReservations();

    const sourceBytes = pngBytesOfSize(4 * 1024 * 1024);
    const file = pngFileWithBytes(sourceBytes, "ordered.png");

    const order: string[] = [];
    const editorRef = {
      current: {
        isReady: () => true,
        insertImageAttachments: (
          _attrs: ReadonlyArray<ImageAttachmentAttrs>,
        ) => {
          order.push("insert");
          // The handoff must still hold the reservation here - release only
          // fires in `runImageIngest`'s finally, after this returns.
          expect(releaseSpies[0]).toBeDefined();
          expect(releaseSpies[0]).not.toHaveBeenCalled();
        },
        beginPathInsertion: () => null,
        focus: () => {
          order.push("focus");
        },
      } satisfies ComposerPasteEditorHandle,
    };

    const { result } = renderHook(() =>
      useLandingComposerPaste({
        editorRef,
        draftId: "draft-prepared-order",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: NO_MENTION_ROOTS,
      }),
    );

    act(() => {
      result.current.attachImageFiles([file]);
    });

    await waitFor(() => expect(releaseSpies).toHaveLength(1));
    await waitFor(() => expect(releaseSpies[0]).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["insert", "focus"]);
  });

  it("releases the reservation exactly once when insertAttrs throws, even though the charge came from the prepared size", async () => {
    installRealCodecDoubles();
    const { releaseSpies } = spyReservations();

    const sourceBytes = pngBytesOfSize(4 * 1024 * 1024);
    const file = pngFileWithBytes(sourceBytes, "throws.png");

    const editorRef = {
      current: {
        isReady: () => true,
        insertImageAttachments: (
          _attrs: ReadonlyArray<ImageAttachmentAttrs>,
        ) => {
          throw new Error("insert boom");
        },
        beginPathInsertion: () => null,
        focus: () => undefined,
      } satisfies ComposerPasteEditorHandle,
    };

    const { result } = renderHook(() =>
      useLandingComposerPaste({
        editorRef,
        draftId: "draft-prepared-throw",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: NO_MENTION_ROOTS,
      }),
    );

    act(() => {
      result.current.attachImageFiles([file]);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't attach the image.", {
        description: "Please try adding it again.",
      });
    });
    await waitFor(() => expect(releaseSpies).toHaveLength(1));
    await waitFor(() => expect(releaseSpies[0]).toHaveBeenCalledTimes(1));
  });
});
