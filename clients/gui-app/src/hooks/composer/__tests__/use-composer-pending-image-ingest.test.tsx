/**
 * T4's shared in-place b64 -> hash rewrite (`useComposerPendingImageIngest`),
 * extracted from `landing-composer.tsx`'s own copy for the three chat
 * surfaces. Two entry points, one background job: `ingestPastedComposerImages`
 * (a rich-clipboard paste, node arrives already carrying bytes) and
 * `reingestPendingImages` (mount-time restart for any surviving `b64content`
 * node - the upgrade path for every large draft already out there).
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  useComposerPendingImageIngest,
  type PendingImageIngestEditorHandle,
} from "@/hooks/composer/use-composer-pending-image-ingest";
import { IMAGE_READ_TIMEOUT_MS } from "@/hooks/composer/use-composer-paste";
import { PREPARED_IMAGE_MAX_BYTES } from "@/lib/composer/prompt-stash-image-preparation";
import type { ImageAttachmentRewrite } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import { getImageBytes } from "@/lib/composer/landing-image-store";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  encodedWebpBytesOfSize,
  pngBytesWithHeader,
} from "@/lib/composer/__tests__/prompt-stash-image-fixtures";
import {
  resetLandingImageBudgetReservationsForTesting,
  type LandingImageBudgetReservation,
} from "@/lib/composer/landing-image-budget";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";

// F3 needs to see whether `reserveLandingImageBudget` was called at all (the
// non-storable path must take no reservation) and, for the mixed-batch case,
// needs a per-call handle on the reservation it returns so a job's release
// can be attributed to the right image rather than merely "some release
// happened". Every other test in this file relies on the real admission math
// (the mock's default implementation calls straight through to it).
const landingImageBudgetMocks = vi.hoisted(() => ({
  reserveLandingImageBudget: vi.fn<
    (
      draftId: string | null,
      candidates: ReadonlyArray<{
        readonly hash: string | null;
        readonly bytes: number;
      }>,
    ) => LandingImageBudgetReservation | null
  >(),
  actualReserve: null as
    | ((
        draftId: string | null,
        candidates: ReadonlyArray<{
          readonly hash: string | null;
          readonly bytes: number;
        }>,
      ) => LandingImageBudgetReservation | null)
    | null,
}));

vi.mock("@/lib/composer/landing-image-budget", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/composer/landing-image-budget")
    >();
  landingImageBudgetMocks.actualReserve = actual.reserveLandingImageBudget;
  landingImageBudgetMocks.reserveLandingImageBudget.mockImplementation(
    actual.reserveLandingImageBudget,
  );
  return {
    ...actual,
    reserveLandingImageBudget:
      landingImageBudgetMocks.reserveLandingImageBudget,
  };
});

const toastMocks = vi.hoisted(() => ({
  reportableErrorToast: vi.fn(),
}));

vi.mock("@/lib/reportable-error-toast", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/reportable-error-toast")>();
  return { ...actual, reportableErrorToast: toastMocks.reportableErrorToast };
});

const landingImageStoreMocks = vi.hoisted(() => ({
  putImage: vi.fn<(bytes: ImageBytes) => Promise<string>>(),
  actualPutImage: null as ((bytes: ImageBytes) => Promise<string>) | null,
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  landingImageStoreMocks.actualPutImage = actual.putImage;
  // Calls through to the real, content-addressed store by default; only the
  // "failed ingest" test below (and the F3 mixed-batch test) override this.
  landingImageStoreMocks.putImage.mockImplementation(actual.putImage);
  return { ...actual, putImage: landingImageStoreMocks.putImage };
});

function fakeEditor(initial: JsonContent): {
  readonly handle: PendingImageIngestEditorHandle;
  readonly removeImageAttachmentById: Mock<(id: string) => undefined>;
  readonly rewriteImageAttachmentHashById: Mock<
    (id: string, rewrite: ImageAttachmentRewrite) => boolean
  >;
  setJSON: (next: JsonContent) => void;
} {
  let content = initial;
  const removeImageAttachmentById: Mock<(id: string) => undefined> = vi.fn(
    (_id: string) => undefined,
  );
  const rewriteImageAttachmentHashById: Mock<
    (id: string, rewrite: ImageAttachmentRewrite) => boolean
  > = vi.fn((_id: string, _rewrite: ImageAttachmentRewrite) => true);
  return {
    handle: {
      isReady: () => true,
      getJSON: () => content,
      removeImageAttachmentById,
      rewriteImageAttachmentHashById,
    },
    removeImageAttachmentById,
    rewriteImageAttachmentHashById,
    setJSON: (next) => {
      content = next;
    },
  };
}

/** Runs the job immediately, with a signal that never aborts. */
function immediateRunPendingImageJob(
  job: (signal: AbortSignal) => Promise<void>,
): void {
  void job(new AbortController().signal);
}

function b64Of(text: string): string {
  return btoa(text);
}

function pendingImageNode(
  id: string,
  b64content: string,
  mimeType: string,
): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id,
      fileName: `${id}.png`,
      b64content,
      mimeType,
      size: b64content.length,
    },
  };
}

beforeEach(() => {
  installFreshIndexedDb();
  resetLandingImageBudgetReservationsForTesting();
  toastMocks.reportableErrorToast.mockReset();
});

afterEach(() => {
  // `mockClear()` only, never `mockReset()`: reset would also wipe the
  // call-through implementation the `vi.mock` factory installed at module
  // load (it runs once), leaving every later test's `putImage` a bare stub
  // that resolves `undefined` - which is exactly indistinguishable from a
  // real hash until it hits `IDBObjectStore.get` as an invalid key.
  landingImageStoreMocks.putImage.mockClear();
  // Same reasoning as above: clear calls, keep the passthrough implementation
  // the `vi.mock` factory installed once at module load. Any test that
  // installs its own wrapping implementation restores the passthrough itself
  // before this runs (see the F3 describe block).
  landingImageBudgetMocks.reserveLandingImageBudget.mockClear();
});

describe("ingestPastedComposerImages (rich-clipboard channel)", () => {
  it("accepts a validated image, stores its bytes, and rewrites the node to hash-only", async () => {
    const editor = fakeEditor({ type: "doc", content: [] });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: immediateRunPendingImageJob,
        draftId: null,
      }),
    );

    const outcomes = result.current.ingestPastedComposerImages([
      {
        fileName: "rich.png",
        mimeType: "image/png",
        b64content: b64Of("rich-bytes"),
      },
    ]);

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes.at(0);
    expect(outcome?.kind).toBe("accepted");
    const id = outcome?.kind === "accepted" ? outcome.id : null;
    expect(id).not.toBeNull();

    await waitFor(() => {
      expect(editor.rewriteImageAttachmentHashById).toHaveBeenCalledTimes(1);
    });
    const [rewrittenId, rewrite] =
      editor.rewriteImageAttachmentHashById.mock.calls[0];
    expect(rewrittenId).toBe(id);
    const stored = await getImageBytes(rewrite.hash);
    expect(stored).toBeDefined();
    expect(Array.from(stored ?? [])).toEqual(
      Array.from(new TextEncoder().encode("rich-bytes")),
    );
    // These bytes are not an image preparation can model, so it falls back to
    // the SOURCE bytes - and says so. The metadata must describe those source
    // bytes, and `byHashEligible` must be false: the host's writer would
    // refuse them, and claiming otherwise is what writes a reference the host
    // cannot resolve. (The re-encoding path is pinned separately below.)
    expect(rewrite.mimeType).toBe("image/png");
    expect(rewrite.size).toBe("rich-bytes".length);
    expect(rewrite.byHashEligible).toBe(false);
    expect(editor.removeImageAttachmentById).not.toHaveBeenCalled();
  });

  it("rejects an undecodable image and reports it as corrupted, with no background job", () => {
    const editor = fakeEditor({ type: "doc", content: [] });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: immediateRunPendingImageJob,
        draftId: null,
      }),
    );

    const outcomes = result.current.ingestPastedComposerImages([
      {
        fileName: "bad.png",
        mimeType: "image/png",
        b64content: "not-base64!!",
      },
    ]);

    expect(outcomes).toEqual([{ kind: "rejected" }]);
    expect(toastMocks.reportableErrorToast).toHaveBeenCalledWith(
      "Couldn't attach a pasted image.",
      expect.objectContaining({
        description: "The image was corrupted or too large.",
      }),
      expect.anything(),
    );
  });
});

describe("ingestPastedComposerImages - F3: format verdict runs before budget admission", () => {
  it("charges the budget for a storable sibling but NOT for a non-storable one in the same batch", async () => {
    // Pre-fix (e1bdceff5): reservation was taken for every DECODED image
    // before the format was consulted, so a non-storable image - which starts
    // no job and therefore releases nothing - still charged capacity it would
    // hold forever. Repeated BMP pastes drained the 64 MiB ledger with no
    // bytes ever stored, and near the cap a fallback node could consume the
    // very reservation its storable sibling needed.
    //
    // Both halves live in ONE batch on purpose. "The BMP took no reservation"
    // asserted alone is satisfied by a broken mock, a removed call site, or an
    // ingest that did nothing at all; the PNG beside it is the positive
    // control that says the ledger WAS exercised in this very run. The
    // pre-fix code scores 2 calls here, not 0 - so the count, not the
    // absence, is what carries the test.
    const editor = fakeEditor({ type: "doc", content: [] });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: immediateRunPendingImageJob,
        draftId: null,
      }),
    );

    const outcomes = result.current.ingestPastedComposerImages([
      {
        fileName: "legacy.bmp",
        mimeType: "image/bmp",
        b64content: b64Of("bmp-bytes"),
      },
      {
        fileName: "rich.png",
        mimeType: "image/png",
        b64content: b64Of("png-bytes"),
      },
    ]);

    expect(outcomes).toHaveLength(2);
    const bmpOutcome = outcomes.at(0);
    const pngOutcome = outcomes.at(1);
    expect(bmpOutcome?.kind).toBe("accepted");
    expect(pngOutcome?.kind).toBe("accepted");
    const bmpId = bmpOutcome?.kind === "accepted" ? bmpOutcome.id : null;
    const pngId = pngOutcome?.kind === "accepted" ? pngOutcome.id : null;
    expect(typeof bmpId).toBe("string");
    expect(typeof pngId).toBe("string");
    expect(bmpId).not.toBe(pngId);

    // POSITIVE CONTROL: the ledger was exercised - exactly once, for the PNG,
    // charged for the PNG's decoded byte length and nothing else.
    expect(
      landingImageBudgetMocks.reserveLandingImageBudget,
    ).toHaveBeenCalledTimes(1);
    const pngByteLength = new TextEncoder().encode("png-bytes").byteLength;
    expect(
      landingImageBudgetMocks.reserveLandingImageBudget,
    ).toHaveBeenCalledWith(null, [{ hash: null, bytes: pngByteLength }]);

    // And the BMP started no background job at all: only the PNG's bytes ever
    // reach the store, and only the PNG's node is rewritten.
    await waitFor(() => {
      expect(editor.rewriteImageAttachmentHashById).toHaveBeenCalledTimes(1);
    });
    expect(editor.rewriteImageAttachmentHashById.mock.calls[0][0]).toBe(pngId);
    expect(landingImageStoreMocks.putImage).toHaveBeenCalledTimes(1);
    expect(editor.removeImageAttachmentById).not.toHaveBeenCalled();
  });

  it("in a mixed [PNG, BMP, PNG] batch, each storable image's job releases exactly ITS OWN reservation - never a sibling's", async () => {
    // Pre-fix (e1bdceff5): reservations were tracked by a running counter that
    // advanced only for storable images, so in a mixed batch the counter's
    // value at completion time did not match the image's position in the
    // batch - one image's job released another image's handle. Keying by the
    // image's own INDEX (as the fix does) is what this test proves: gating the
    // first PNG's store call lets the second PNG's job settle first, and its
    // release must land on the SECOND reservation only.
    const releaseSpies: Array<Mock<() => void>> = [];
    landingImageBudgetMocks.reserveLandingImageBudget.mockImplementation(
      (draftId, candidates) => {
        const actual = landingImageBudgetMocks.actualReserve;
        if (actual === null) throw new Error("actual reserve not captured");
        const real = actual(draftId, candidates);
        if (real === null) return null;
        const releaseSpy: Mock<() => void> = vi.fn(() => {
          real.release();
        });
        releaseSpies.push(releaseSpy);
        return { release: releaseSpy, settleStored: () => undefined };
      },
    );

    let releaseFirstPng: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirstPng = resolve;
    });
    let putImageCallCount = 0;
    landingImageStoreMocks.putImage.mockImplementation(async (bytes) => {
      putImageCallCount += 1;
      // The FIRST storable image's store call is the one we gate - it is
      // index 0's PNG, invoked before the BMP (which never calls `putImage`
      // at all) and before the second PNG.
      const isFirstCall = putImageCallCount === 1;
      if (isFirstCall) await gate;
      const actual = landingImageStoreMocks.actualPutImage;
      if (actual === null) throw new Error("actual putImage not captured");
      return actual(bytes);
    });

    const editor = fakeEditor({ type: "doc", content: [] });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: immediateRunPendingImageJob,
        draftId: null,
      }),
    );

    const outcomes = result.current.ingestPastedComposerImages([
      {
        fileName: "first.png",
        mimeType: "image/png",
        b64content: b64Of("first-bytes"),
      },
      {
        fileName: "legacy.bmp",
        mimeType: "image/bmp",
        b64content: b64Of("bmp-bytes"),
      },
      {
        fileName: "second.png",
        mimeType: "image/png",
        b64content: b64Of("second-bytes"),
      },
    ]);

    expect(outcomes).toHaveLength(3);
    const firstId = outcomes[0].kind === "accepted" ? outcomes[0].id : null;
    const bmpId = outcomes[1].kind === "accepted" ? outcomes[1].id : null;
    const secondId = outcomes[2].kind === "accepted" ? outcomes[2].id : null;
    expect(firstId).not.toBeNull();
    expect(bmpId).not.toBeNull();
    expect(secondId).not.toBeNull();

    // Exactly two reservations exist: one for index 0 (first.png), one for
    // index 2 (second.png). The BMP at index 1 took none.
    expect(releaseSpies).toHaveLength(2);
    const [firstReservationRelease, secondReservationRelease] = releaseSpies;

    // second.png's store call is NOT gated, so its job settles first.
    await waitFor(() => {
      const rewrittenIds = editor.rewriteImageAttachmentHashById.mock.calls.map(
        (call) => call[0],
      );
      expect(rewrittenIds).toContain(secondId);
    });

    // Only the SECOND reservation is released so far - the first.png job is
    // still parked on the gate. This is exactly what a running-counter bug
    // would get wrong: it has nothing but call order to go on, and here the
    // job that finishes first is NOT the job that reserved first.
    expect(secondReservationRelease).toHaveBeenCalledTimes(1);
    expect(firstReservationRelease).not.toHaveBeenCalled();

    releaseFirstPng();
    await waitFor(() => {
      const rewrittenIds = editor.rewriteImageAttachmentHashById.mock.calls.map(
        (call) => call[0],
      );
      expect(rewrittenIds).toContain(firstId);
    });

    // Now both are released, exactly once each - never the other's.
    expect(firstReservationRelease).toHaveBeenCalledTimes(1);
    expect(secondReservationRelease).toHaveBeenCalledTimes(1);

    // Restore the passthrough for every later test in this file.
    landingImageBudgetMocks.reserveLandingImageBudget.mockImplementation(
      (draftId, candidates) => {
        const actual = landingImageBudgetMocks.actualReserve;
        if (actual === null) throw new Error("actual reserve not captured");
        return actual(draftId, candidates);
      },
    );
    landingImageStoreMocks.putImage.mockImplementation((bytes) => {
      const actual = landingImageStoreMocks.actualPutImage;
      if (actual === null) throw new Error("actual putImage not captured");
      return actual(bytes);
    });
  });
});

describe("reingestPendingImages (mount-time restart)", () => {
  it("rewrites a surviving b64content node to a hash-only one - the upgrade path for an existing large draft", async () => {
    const editor = fakeEditor({
      type: "doc",
      content: [
        pendingImageNode("legacy-1", b64Of("legacy-bytes"), "image/png"),
      ],
    });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: immediateRunPendingImageJob,
        draftId: null,
      }),
    );

    result.current.reingestPendingImages();

    await waitFor(() => {
      expect(editor.rewriteImageAttachmentHashById).toHaveBeenCalledTimes(1);
    });
    const [id, rewrite] = editor.rewriteImageAttachmentHashById.mock.calls[0];
    expect(id).toBe("legacy-1");
    const stored = await getImageBytes(rewrite.hash);
    expect(stored).toBeDefined();
    expect(Array.from(stored ?? [])).toEqual(
      Array.from(new TextEncoder().encode("legacy-bytes")),
    );
    // A migration of bytes preparation cannot model keeps its source metadata
    // and stays ineligible - the same verdict a fresh paste of them gets, so
    // the channel a node may use does not depend on which mount hashed it.
    expect(rewrite.mimeType).toBe("image/png");
    expect(rewrite.size).toBe("legacy-bytes".length);
    expect(rewrite.byHashEligible).toBe(false);
  });

  it("leaves a NON-STORABLE format inline instead of hashing it, on every mount", async () => {
    // The format decision says a declared BMP stays inline: the host's disk
    // writer refuses it, so a hash would be a hash the host cannot resolve.
    // `decodeValidatedPastedImage` has no format allowlist - it only asks
    // whether the bytes decode - so without an explicit guard this mount-time
    // restart would hash the very node the file ingest deliberately left
    // inline, and would do it again on every single editor mount.
    // A STORABLE sibling rides along as the positive control. Waiting for its
    // rewrite is what proves enough time passed for the BMP's to have happened
    // too - without it, asserting "not called" after a single microtask passes
    // whether the guard is there or not, because no rewrite has landed yet.
    const editor = fakeEditor({
      type: "doc",
      content: [
        pendingImageNode("bmp-1", b64Of("bmp-bytes"), "image/bmp"),
        pendingImageNode("png-1", b64Of("png-bytes"), "image/png"),
      ],
    });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: immediateRunPendingImageJob,
        draftId: null,
      }),
    );

    result.current.reingestPendingImages();

    await waitFor(() => {
      const idsSoFar = editor.rewriteImageAttachmentHashById.mock.calls.map(
        (call) => call[0],
      );
      expect(idsSoFar).toContain("png-1");
    });
    const rewrittenIds = editor.rewriteImageAttachmentHashById.mock.calls.map(
      (call) => call[0],
    );
    expect(rewrittenIds).toEqual(["png-1"]);
    // And that one rewrite carried a real hash - "hashed" is the whole claim.
    const [, pngRewrite] = editor.rewriteImageAttachmentHashById.mock.calls[0];
    expect(pngRewrite.hash.length).toBeGreaterThan(0);
    // And the BMP is LEFT there, not dropped - "stays inline" is the point.
    expect(editor.removeImageAttachmentById).not.toHaveBeenCalled();
  });

  it("does nothing when no node in the document still carries b64content", () => {
    const editor = fakeEditor({
      type: "doc",
      content: [
        {
          type: "imageAttachment",
          attrs: {
            id: "already-hash",
            fileName: "x.png",
            hash: "a".repeat(64),
            mimeType: "image/png",
            size: 1,
          },
        },
      ],
    });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: immediateRunPendingImageJob,
        draftId: null,
      }),
    );

    result.current.reingestPendingImages();

    expect(editor.rewriteImageAttachmentHashById).not.toHaveBeenCalled();
  });
});

describe("a failed ingest removes the node and toasts, keeping no inline bytes", () => {
  it("putImage rejecting removes the node instead of leaving it stuck or re-inlined", async () => {
    landingImageStoreMocks.putImage.mockImplementationOnce(() =>
      Promise.reject(new Error("store unavailable")),
    );
    const editor = fakeEditor({
      type: "doc",
      content: [
        pendingImageNode("will-fail", b64Of("doomed-bytes"), "image/png"),
      ],
    });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: immediateRunPendingImageJob,
        draftId: null,
      }),
    );

    result.current.reingestPendingImages();

    await waitFor(() => {
      expect(editor.removeImageAttachmentById).toHaveBeenCalledWith(
        "will-fail",
      );
    });
    expect(editor.rewriteImageAttachmentHashById).not.toHaveBeenCalled();
    expect(toastMocks.reportableErrorToast).toHaveBeenCalledWith(
      "Couldn't attach the image.",
      expect.objectContaining({ description: "Please try adding it again." }),
      expect.anything(),
    );
  });
});

/**
 * Bare `runPendingImageJob` fake that hands the job a REAL AbortController's
 * signal the test can abort on demand - unlike `immediateRunPendingImageJob`,
 * whose controller never aborts.
 */
function controllableRunPendingImageJob(): {
  readonly run: (job: (signal: AbortSignal) => Promise<void>) => void;
  readonly abort: () => void;
} {
  const controller = new AbortController();
  return {
    run: (job: (signal: AbortSignal) => Promise<void>) => {
      void job(controller.signal);
    },
    abort: () => {
      controller.abort();
    },
  };
}

// With fake timers active, `waitFor`'s own polling `setTimeout` is faked too
// and never fires on its own - so this block flushes microtasks directly
// instead of polling, mirroring landing-image-gc.test.ts's `flush()`.
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe("F5: the 15s deadline and abort responsiveness (use-composer-pending-image-ingest)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("a putImage that never resolves fails at the 15s deadline: the node is removed, a toast fires, and the reservation is released", async () => {
    // Pre-fix (e1bdceff5): `putImage(bytes)` was awaited directly, with no
    // deadline wrapper. A stalled store left `pendingImageCount` positive
    // forever - Send disabled, the reservation charged, with no way to settle
    // it. There is also nothing here BEFORE the deadline that this test could
    // pass on trivially: `putImage` never settles on its own, so only the
    // 15s timeout can end this job.
    let putImageEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      putImageEntered = resolve;
    });
    landingImageStoreMocks.putImage.mockImplementation(() => {
      putImageEntered();
      // Never resolves and never rejects.
      return new Promise<string>(() => undefined);
    });

    const editor = fakeEditor({
      type: "doc",
      content: [pendingImageNode("stuck-1", b64Of("stuck-bytes"), "image/png")],
    });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: immediateRunPendingImageJob,
        draftId: null,
      }),
    );

    result.current.reingestPendingImages();

    // Arrival signal FIRST: advancing the fake clock before the mock has
    // actually been entered would never fire the deadline it is racing
    // against - the timer that matters is the one `withAbortableDeadline`
    // sets up when it is called.
    await entered;
    await vi.advanceTimersByTimeAsync(IMAGE_READ_TIMEOUT_MS);
    await flushMicrotasks();

    expect(editor.removeImageAttachmentById).toHaveBeenCalledWith("stuck-1");
    expect(editor.rewriteImageAttachmentHashById).not.toHaveBeenCalled();
    expect(toastMocks.reportableErrorToast).toHaveBeenCalledWith(
      "Couldn't attach the image.",
      expect.objectContaining({ description: "Please try adding it again." }),
      expect.anything(),
    );
  });

  it("aborting mid-flight releases the reservation immediately, without waiting for the stalled write to ever settle", async () => {
    // Pre-fix, the only abort check was `signal.throwIfAborted()` - which the
    // module doc calls out as NOT a substitute, because it only runs once the
    // wrapped promise settles. A stalled `putImage` meant the abort could
    // never be observed at all, so this reservation would sit held for the
    // life of the renderer. This test never advances the 15s deadline timer -
    // it proves the SEPARATE, faster abort path settles the job on its own.
    let putImageEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      putImageEntered = resolve;
    });
    landingImageStoreMocks.putImage.mockImplementation(() => {
      putImageEntered();
      return new Promise<string>(() => undefined);
    });

    const releaseSpy: Mock<() => void> = vi.fn();
    landingImageBudgetMocks.reserveLandingImageBudget.mockImplementation(
      (draftId, candidates) => {
        const actual = landingImageBudgetMocks.actualReserve;
        if (actual === null) throw new Error("actual reserve not captured");
        const real = actual(draftId, candidates);
        if (real === null) return null;
        return {
          release: () => {
            releaseSpy();
            real.release();
          },
          settleStored: (candidateIndex: number, hash: string) => {
            real.settleStored(candidateIndex, hash);
          },
        };
      },
    );

    const editor = fakeEditor({ type: "doc", content: [] });
    const controllable = controllableRunPendingImageJob();
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: controllable.run,
        draftId: null,
      }),
    );

    result.current.ingestPastedComposerImages([
      {
        fileName: "abort.png",
        mimeType: "image/png",
        b64content: b64Of("abort-bytes"),
      },
    ]);

    await entered;
    controllable.abort();
    await flushMicrotasks();

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    // Discarded, not inserted: the abort ended the job before the (still
    // hanging) store write could ever be used.
    expect(editor.rewriteImageAttachmentHashById).not.toHaveBeenCalled();
    // No toast for a job the surface itself walked away from.
    expect(toastMocks.reportableErrorToast).not.toHaveBeenCalled();

    // Restore the passthrough for every later test in this file.
    landingImageBudgetMocks.reserveLandingImageBudget.mockImplementation(
      (draftId, candidates) => {
        const actual = landingImageBudgetMocks.actualReserve;
        if (actual === null) throw new Error("actual reserve not captured");
        return actual(draftId, candidates);
      },
    );
  });
});
describe("noteContentImages: edge-triggered, safe to call on every change", () => {
  // The gap this closes: a browser-preview screenshot node is appended by the
  // mention extension long AFTER mount (`commitBrowserTabPreviewInsertion`),
  // so mount-time re-entry cannot see it - it does not exist yet. Without an
  // on-change caller the node travels inline until the next mount.
  //
  // The witness is `runPendingImageJob`, counted: it is the one place a job
  // can start, so "exactly once across N changes" is a statement about work
  // actually done, not about an outcome that could be reached another way.
  interface JobCounter {
    count: number;
    readonly settled: Array<Promise<void>>;
  }

  function newJobCounter(): JobCounter {
    return { count: 0, settled: [] };
  }

  /**
   * Counts jobs AND keeps their promises, so a test can settle them and then
   * count. Asserting "no job ran" by polling a counter that starts at zero
   * passes before the first job would have started either way.
   */
  function countingRunPendingImageJob(counter: JobCounter) {
    return (job: (signal: AbortSignal) => Promise<void>): void => {
      counter.count += 1;
      counter.settled.push(job(new AbortController().signal));
    };
  }

  it("ingests a node appended after mount exactly once across many content changes", async () => {
    const counter = newJobCounter();
    const editor = fakeEditor({ type: "doc", content: [] });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: countingRunPendingImageJob(counter),
        draftId: null,
      }),
    );

    // Mount-time re-entry sees an empty document: nothing to do, and nothing
    // recorded. This is the state the screenshot arrives into.
    result.current.reingestPendingImages();
    expect(counter.count).toBe(0);

    const withScreenshot: JsonContent = {
      type: "doc",
      content: [
        pendingImageNode("shot-1", b64Of("screenshot-bytes"), "image/png"),
      ],
    };
    editor.setJSON(withScreenshot);

    // Ten content changes, as ten keystrokes would deliver them.
    for (let i = 0; i < 10; i += 1) {
      result.current.noteContentImages(withScreenshot);
    }

    await waitFor(() => {
      expect(editor.rewriteImageAttachmentHashById).toHaveBeenCalledTimes(1);
    });
    expect(counter.count).toBe(1);
    expect(landingImageStoreMocks.putImage).toHaveBeenCalledTimes(1);
    const [rewrittenId] = editor.rewriteImageAttachmentHashById.mock.calls[0];
    expect(rewrittenId).toBe("shot-1");

    // And changes arriving after the job settled do not restart it either -
    // by then the node is hash-only, so the scan skips it for a second reason.
    result.current.noteContentImages(withScreenshot);
    expect(counter.count).toBe(1);
  });

  it("never re-prepares a node preparation REFUSED, however many changes follow", async () => {
    // Bytes preparation cannot model AND cannot fall back on: over the output
    // ceiling, so `prepareComposerImageBytesOrRefuse` refuses outright. By the
    // migration invariant the node stays inline - which is exactly the node a
    // per-keystroke caller would otherwise re-prepare on every character.
    const oversized = "x".repeat(PREPARED_IMAGE_MAX_BYTES + 1);
    const content: JsonContent = {
      type: "doc",
      content: [pendingImageNode("huge-1", b64Of(oversized), "image/png")],
    };
    const counter = newJobCounter();
    const editor = fakeEditor(content);
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: countingRunPendingImageJob(counter),
        draftId: null,
      }),
    );

    result.current.reingestPendingImages();
    expect(counter.count).toBe(1);
    // SETTLE the job, then assert - a poll on a counter that starts at zero
    // would pass before the refusal was ever reached.
    await Promise.all(counter.settled);
    expect(landingImageStoreMocks.putImage).not.toHaveBeenCalled();

    for (let i = 0; i < 10; i += 1) {
      result.current.noteContentImages(content);
    }

    // Still one job, and the node is still there: a refusal on the migration
    // path leaves the inline bytes alone, and the guard is what stops the
    // refusal being re-derived ten more times.
    expect(counter.count).toBe(1);
    expect(editor.removeImageAttachmentById).not.toHaveBeenCalled();
    expect(editor.rewriteImageAttachmentHashById).not.toHaveBeenCalled();
  });

  it("does not start a second job for an image the paste path just minted", async () => {
    // A paste and an on-change scan can land in the same tick, and the node is
    // inline b64 from insertion until its rewrite settles. The paste path
    // records its minted id for exactly this reason.
    const counter = newJobCounter();
    const editor = fakeEditor({ type: "doc", content: [] });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: countingRunPendingImageJob(counter),
        draftId: null,
      }),
    );

    const outcomes = result.current.ingestPastedComposerImages([
      {
        fileName: "pasted.png",
        mimeType: "image/png",
        b64content: b64Of("pasted-bytes"),
      },
    ]);
    const outcome = outcomes.at(0);
    const pastedId = outcome?.kind === "accepted" ? outcome.id : null;
    expect(pastedId).not.toBeNull();
    expect(counter.count).toBe(1);

    // The node as the paste handler inserts it: still carrying its bytes.
    result.current.noteContentImages({
      type: "doc",
      content: [
        pendingImageNode(pastedId ?? "", b64Of("pasted-bytes"), "image/png"),
      ],
    });

    expect(counter.count).toBe(1);
    await waitFor(() => {
      expect(editor.rewriteImageAttachmentHashById).toHaveBeenCalledTimes(1);
    });
  });
});

describe("preparation runs INSIDE the job, and its output is what lands", () => {
  // Every other case in this file feeds bytes preparation cannot model, so it
  // falls back to the source and nothing distinguishes "prepared" from "passed
  // through". This one installs the codec doubles so preparation really runs
  // and really re-encodes - which is the only way to pin that the bytes the
  // store receives, and the metadata the node ends up with, are the PREPARED
  // ones rather than the pasted ones.
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  // Restored INDIVIDUALLY, never with `vi.restoreAllMocks()`: this file's
  // module-level `putImage` and `reserveLandingImageBudget` mocks carry
  // call-through implementations installed once at module load (see the
  // top-level `afterEach`), and a blanket restore here would strip them for
  // every describe that runs after this one.
  const installedSpies: Array<{ readonly mockRestore: () => void }> = [];

  afterEach(() => {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: originalCreateImageBitmap,
    });
    for (const spy of installedSpies) spy.mockRestore();
    installedSpies.length = 0;
  });

  function installCodecDoubles(): void {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: vi.fn(() =>
        Promise.resolve({
          width: 3000,
          height: 1000,
          close: () => undefined,
        }),
      ),
    });
    installedSpies.push(
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
        contextId: string,
      ) => {
        if (contextId !== "2d") return null;
        return {
          fillStyle: "",
          fillRect: () => undefined,
          drawImage: () => undefined,
        };
      }) as HTMLCanvasElement["getContext"]),
    );
    installedSpies.push(
      vi
        .spyOn(HTMLCanvasElement.prototype, "toBlob")
        .mockImplementation(function mockedToBlob(
          this: HTMLCanvasElement,
          callback: BlobCallback,
          type: string | undefined,
        ): void {
          if (this.width === 1 && this.height === 1) {
            callback(new Blob([new Uint8Array([1])], { type: "image/webp" }));
            return;
          }
          // Magic-byte sniffed against the requested type, so the payload has
          // to be a real WebP or every encode attempt is discarded.
          callback(
            new Blob([encodedWebpBytesOfSize(64)], {
              type: type ?? "image/webp",
            }),
          );
        }),
    );
  }

  it("stores the PREPARED bytes and rewrites the node with the prepared metadata, not the pasted ones", async () => {
    installCodecDoubles();
    // 3000px on the long edge, so the 2000px bound forces a real re-encode
    // rather than a verbatim pass-through.
    const sourceBytes = pngBytesWithHeader(3000, 1000, 8192);
    const editor = fakeEditor({ type: "doc", content: [] });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: immediateRunPendingImageJob,
        draftId: null,
      }),
    );

    const outcomes = result.current.ingestPastedComposerImages([
      {
        fileName: "wide.png",
        mimeType: "image/png",
        b64content: bytesToBase64(sourceBytes),
      },
    ]);
    expect(outcomes.at(0)?.kind).toBe("accepted");

    await waitFor(() => {
      expect(editor.rewriteImageAttachmentHashById).toHaveBeenCalledTimes(1);
    });
    const [, rewrite] = editor.rewriteImageAttachmentHashById.mock.calls[0];

    // The bytes that reached the store are the encoder's output, NOT the 8192
    // source bytes - preparation ran between the paste and `putImage`.
    // `.at(0)`, not `calls[0]`: without `noUncheckedIndexedAccess` an index
    // read is typed as present, so the chains below would be guarding a state
    // the type has ruled out. `.at()` types the miss, which keeps them real -
    // if `putImage` never ran this fails as "expected undefined to be 64",
    // naming the absent call rather than throwing on a property of nothing.
    const storedBytes = landingImageStoreMocks.putImage.mock.calls.at(0)?.[0];
    expect(storedBytes?.byteLength).toBe(64);
    expect(storedBytes?.byteLength).not.toBe(sourceBytes.byteLength);
    const stored = await getImageBytes(rewrite.hash);
    expect(Array.from(stored ?? [])).toEqual(
      Array.from(encodedWebpBytesOfSize(64)),
    );

    // And the node describes THOSE bytes. A node still saying `image/png` at
    // 8192 bytes would be describing bytes nobody holds: the budget reads
    // `size` back, and `mimeType` is what the send carries.
    expect(rewrite.mimeType).toBe("image/webp");
    expect(rewrite.size).toBe(64);
    expect(rewrite.fileName).toBe("wide.webp");
    // Produced by the preparer, so the host can take it by hash - the
    // complement of the fallback cases above.
    expect(rewrite.byHashEligible).toBe(true);
  });
});

describe("a full budget does not delete an image the draft already holds", () => {
  // The F5 block installs a never-resolving `putImage` with
  // `mockImplementation` and the shared `afterEach` only `mockClear()`s, so a
  // test running after it inherits that stall. Restoring the passthrough is the
  // convention this file's afterEach comment names; without it this test times
  // out inside `putImage` and never reaches the branch it is about.
  beforeEach(() => {
    const passthrough = landingImageStoreMocks.actualPutImage;
    if (passthrough !== null) {
      landingImageStoreMocks.putImage.mockImplementation(passthrough);
    }
  });

  afterEach(() => {
    const passthrough = landingImageBudgetMocks.actualReserve;
    if (passthrough !== null) {
      landingImageBudgetMocks.reserveLandingImageBudget.mockImplementation(
        passthrough,
      );
    }
  });

  it("keeps the inline node when a MIGRATION cannot reserve capacity (DRIVE RED)", async () => {
    // `reingestPendingImages` is the migration path: the node is already in the
    // document carrying its own `b64content`, which is the draft's durable copy
    // and is sendable exactly as it is. Removing it on a capacity refusal
    // discarded the user's attachment for no reason but opening the draft while
    // the budget was full - and unlike a rejected PASTE, there is nothing for
    // them to re-add.
    // `reingestPendingImages` takes NO pre-store reservation - it goes
    // straight to the job with `reserveAfterStore: true` - so every call here
    // is the post-store one, and refusing them all is exactly "the budget is
    // full when the draft is opened".
    let reservationAsked: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      reservationAsked = resolve;
    });
    landingImageBudgetMocks.reserveLandingImageBudget.mockImplementation(() => {
      reservationAsked();
      return null;
    });
    const editor = fakeEditor({
      type: "doc",
      content: [
        pendingImageNode("legacy-1", b64Of("legacy-bytes"), "image/png"),
      ],
    });
    const { result } = renderHook(() =>
      useComposerPendingImageIngest({
        editorRef: { current: editor.handle },
        runPendingImageJob: immediateRunPendingImageJob,
        draftId: null,
      }),
    );

    result.current.reingestPendingImages();

    // The job ends with NEITHER editor call - that is the whole assertion - so
    // there is no editor mock to poll on. `settled` resolves from the job's own
    // reservation call, which is the last thing it does before returning.
    await settled;
    await flushMicrotasks();

    expect(landingImageStoreMocks.putImage).toHaveBeenCalled();
    // The node is untouched: not deleted, and not rewritten to a hash whose
    // bytes were never charged to the budget.
    expect(editor.removeImageAttachmentById).not.toHaveBeenCalled();
    expect(editor.rewriteImageAttachmentHashById).not.toHaveBeenCalled();
  });
});
