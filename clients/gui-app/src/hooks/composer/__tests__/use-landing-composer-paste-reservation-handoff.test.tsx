import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from "vitest";
import { toast } from "sonner";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { ComposerPasteEditorHandle } from "@/hooks/composer/use-composer-paste";
import { useLandingComposerPaste } from "@/hooks/composer/use-landing-composer-paste";
import {
  LANDING_IMAGE_BUDGET_BYTES,
  resetLandingImageBudgetReservationsForTesting,
  type LandingImageBudgetReservation,
} from "@/lib/composer/landing-image-budget";
import * as landingImageBudget from "@/lib/composer/landing-image-budget";
import {
  deleteImage,
  imageHashKeys,
  releaseSession,
} from "@/lib/composer/landing-image-store";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import * as idb from "idb-keyval";

import {
  makeHandle,
  NO_MENTION_ROOTS,
  NOOP_FILE_DROPS,
} from "./use-landing-composer-paste-test-helpers";

const gcMocks = vi.hoisted(() => ({
  scheduleLandingImageReconcile: vi.fn(() => undefined),
  actualScheduleLandingImageReconcile: null as null | (() => void),
}));

vi.mock("@/lib/composer/landing-image-gc", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/composer/landing-image-gc")>();
  gcMocks.actualScheduleLandingImageReconcile =
    actual.scheduleLandingImageReconcile;
  // Default: a no-op stub, not a call-through. The real scheduler starts a
  // 250ms timer that later calls the real `reconcile()`, which would otherwise
  // escape most tests' boundaries. Tests that need the real reclaim chain
  // opt in via mockImplementation → actualScheduleLandingImageReconcile.
  gcMocks.scheduleLandingImageReconcile.mockImplementation(() => undefined);
  return {
    ...actual,
    // Export the vi.fn itself so beforeEach can mockClear it.
    scheduleLandingImageReconcile: gcMocks.scheduleLandingImageReconcile,
  };
});

// In-memory stand-in for idb-keyval so `putImage` can persist + read back bytes
// without a real IndexedDB. Mirrors the landing-image-store unit test.
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

let urlCounter = 0;

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
      await deleteImage(hash);
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
  vi.useRealTimers();
});

/**
 * Fixup 02 / B2: reservation must stay charged through the conversion-to-
 * insertion handoff and through every started sibling write on batch failure.
 * Release fires exactly once on every terminal path.
 */
describe("useLandingComposerPaste - reservation handoff (B2)", () => {
  // Capture the real export once at suite load, before any spy replaces the
  // namespace property. Re-wrapping the live property across tests would nest
  // mocks and recurse into itself.
  const originalReserveLandingImageBudget =
    landingImageBudget.reserveLandingImageBudget;

  afterEach(() => {
    const current = landingImageBudget.reserveLandingImageBudget;
    if (vi.isMockFunction(current)) {
      current.mockRestore();
    }
    // Reinstall the default idb.set from the outer beforeEach in case a test
    // overrode it for write gating.
    vi.mocked(idb.set).mockImplementation((key, value) => {
      idbData.set(idbStringKey(key), value);
      return Promise.resolve();
    });
  });

  function deferred(): {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
  } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /**
   * Wrap every real reservation so we can count `release` without replacing
   * the ledger math. `releaseSpies` holds the wrappers in call order.
   */
  function spyReservationReleases(): {
    readonly releaseSpies: Array<Mock<() => void>>;
  } {
    const releaseSpies: Array<Mock<() => void>> = [];
    vi.spyOn(
      landingImageBudget,
      "reserveLandingImageBudget",
    ).mockImplementation((draftId, candidates) => {
      const reservation = originalReserveLandingImageBudget(
        draftId,
        candidates,
      );
      if (reservation === null) return null;
      const release: Mock<() => void> = vi.fn(() => {
        reservation.release();
      });
      releaseSpies.push(release);
      return { release };
    });
    return { releaseSpies };
  }

  function pngFile(bytes: number, name: string, fill: number): File {
    const body = new Uint8Array(bytes);
    body.fill(fill);
    const file = new File([body], name, { type: "image/png" });
    Object.defineProperty(file, "size", { value: bytes });
    return file;
  }

  it("rejects concurrent admission during the pre-insert handoff while the reservation is still held", async () => {
    const FILE_BYTES = 1024;
    const pre = originalReserveLandingImageBudget("pre-fill", [
      { hash: null, bytes: LANDING_IMAGE_BUDGET_BYTES - FILE_BYTES },
    ]);
    expect(pre).not.toBeNull();

    const { releaseSpies } = spyReservationReleases();
    const concurrentDuringInsert: Array<LandingImageBudgetReservation | null> =
      [];
    const inserted: ImageAttachmentAttrs[][] = [];
    const focusCalls = { count: 0 };
    const editorRef = {
      current: {
        isReady: () => true,
        insertImageAttachments: (
          attrs: ReadonlyArray<ImageAttachmentAttrs>,
        ) => {
          // convert() has returned {attrs, release} but runImageIngest has not
          // yet hit its finally - the paste reservation must still be charged.
          concurrentDuringInsert.push(
            originalReserveLandingImageBudget("concurrent", [
              { hash: null, bytes: 1 },
            ]),
          );
          inserted.push([...attrs]);
        },
        beginPathInsertion: () => null,
        focus: () => {
          focusCalls.count += 1;
        },
      } satisfies ComposerPasteEditorHandle,
    };

    const { result } = renderHook(() =>
      useLandingComposerPaste({
        editorRef,
        draftId: "draft-handoff",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: NO_MENTION_ROOTS,
      }),
    );

    act(() => {
      result.current.attachImageFiles([pngFile(FILE_BYTES, "held.png", 7)]);
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    await waitFor(() => expect(releaseSpies).toHaveLength(1));
    await waitFor(() => expect(releaseSpies[0]).toHaveBeenCalledTimes(1));

    expect(concurrentDuringInsert).toHaveLength(1);
    expect(concurrentDuringInsert[0]).toBeNull();

    // Paste released FILE_BYTES; pre still holds the rest, so 1 byte now fits.
    const afterPasteRelease = originalReserveLandingImageBudget("after-paste", [
      { hash: null, bytes: 1 },
    ]);
    expect(afterPasteRelease).not.toBeNull();
    afterPasteRelease?.release();
    pre?.release();
  });

  it("retains the reservation until a delayed sibling write settles after a fast sibling failure", async () => {
    const EACH = 2048;
    const pre = originalReserveLandingImageBudget("pre-batch", [
      { hash: null, bytes: LANDING_IMAGE_BUDGET_BYTES - EACH * 2 },
    ]);
    expect(pre).not.toBeNull();

    const { releaseSpies } = spyReservationReleases();
    const slowGate = deferred();
    let slowWriteEntered = false;
    // Gate at idb.set (putImage always reaches this for new hashes) so we do
    // not depend on a putImage spy reaching the named binding in the hook.
    vi.mocked(idb.set).mockImplementation((key, value) => {
      const hash = idbStringKey(key);
      const bytes = value as Uint8Array;
      if (bytes.byteLength === EACH && bytes[0] === 1) {
        return Promise.reject(new Error("fast sibling write failed"));
      }
      if (bytes.byteLength === EACH && bytes[0] === 2) {
        slowWriteEntered = true;
        return slowGate.promise.then(() => {
          idbData.set(hash, value);
        });
      }
      idbData.set(hash, value);
      return Promise.resolve();
    });

    const failFile = pngFile(EACH, "fail.png", 1);
    const slowFile = pngFile(EACH, "slow.png", 2);

    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted, []);
    const editorRef = { current: handle };
    const { result } = renderHook(() =>
      useLandingComposerPaste({
        editorRef,
        draftId: "draft-batch",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: NO_MENTION_ROOTS,
      }),
    );

    act(() => {
      result.current.attachImageFiles([failFile, slowFile]);
    });

    // Wait until the slow sibling's durable write is parked on slowGate
    // (proves the fast rejection did not short-circuit before allSettled).
    await waitFor(() => {
      expect(slowWriteEntered).toBe(true);
    });

    // First failure would have released under Promise.all; with allSettled the
    // batch reservation must still charge BOTH files until slow settles.
    expect(releaseSpies).toHaveLength(1);
    expect(releaseSpies[0]).not.toHaveBeenCalled();
    const midBatch = originalReserveLandingImageBudget("mid-batch", [
      { hash: null, bytes: 1 },
    ]);
    expect(midBatch).toBeNull();

    slowGate.resolve();

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't attach the image.", {
        description: "Please try adding it again.",
      });
    });
    expect(inserted).toHaveLength(0);
    expect(releaseSpies[0]).toHaveBeenCalledTimes(1);

    // Batch released; pre still holds BUDGET - 2*EACH, so 1 byte fits.
    const afterBatch = originalReserveLandingImageBudget("after-batch", [
      { hash: null, bytes: 1 },
    ]);
    expect(afterBatch).not.toBeNull();
    afterBatch?.release();
    pre?.release();
  });

  it("releases the reservation exactly once when insertAttrs throws", async () => {
    const { releaseSpies } = spyReservationReleases();
    const inserted: ImageAttachmentAttrs[][] = [];
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
        draftId: "draft-insert-throw",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: NO_MENTION_ROOTS,
      }),
    );

    act(() => {
      result.current.attachImageFiles([pngFile(64, "throw.png", 7)]);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't attach the image.", {
        description: "Please try adding it again.",
      });
    });
    expect(inserted).toHaveLength(0);
    expect(releaseSpies).toHaveLength(1);
    expect(releaseSpies[0]).toHaveBeenCalledTimes(1);

    // Idempotent: a second call must not double-free the ledger.
    releaseSpies[0]?.();
    expect(releaseSpies[0]).toHaveBeenCalledTimes(2);
    const again = originalReserveLandingImageBudget("post-throw", [
      { hash: null, bytes: LANDING_IMAGE_BUDGET_BYTES },
    ]);
    expect(again).not.toBeNull();
    again?.release();
  });

  it("releases the reservation exactly once when the composer unmounts mid-ingest", async () => {
    const { releaseSpies } = spyReservationReleases();
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted, []);
    const editorRef = { current: handle };

    let resolveDigest: (() => void) | null = null;
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDigest = () => resolve(new ArrayBuffer(32));
        }),
    );
    onTestFinished(() => digestSpy.mockRestore());

    const { result, unmount } = renderHook(() =>
      useLandingComposerPaste({
        editorRef,
        draftId: "draft-unmount",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: NO_MENTION_ROOTS,
      }),
    );

    act(() => {
      result.current.attachImageFiles([pngFile(128, "mid.png", 7)]);
    });

    await waitFor(() => expect(resolveDigest).not.toBeNull());
    // Reservation must exist before unmount aborts the in-flight write.
    expect(releaseSpies).toHaveLength(1);
    expect(releaseSpies[0]).not.toHaveBeenCalled();

    unmount();

    await act(async () => {
      resolveDigest?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(releaseSpies[0]).toHaveBeenCalledTimes(1));
    expect(inserted).toHaveLength(0);
    expect(toast.error).not.toHaveBeenCalled();

    // Idempotent second call does not corrupt the ledger.
    releaseSpies[0]?.();
    const again = originalReserveLandingImageBudget("post-unmount", [
      { hash: null, bytes: LANDING_IMAGE_BUDGET_BYTES },
    ]);
    expect(again).not.toBeNull();
    again?.release();
  });

  it("creates no reservation for an empty accepted batch or a full-budget rejection", async () => {
    const { releaseSpies } = spyReservationReleases();
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted, []);
    const editorRef = { current: handle };
    const { result } = renderHook(() =>
      useLandingComposerPaste({
        editorRef,
        draftId: "draft-empty",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: NO_MENTION_ROOTS,
      }),
    );

    // Empty accepted: oversized only - collectImages drops it before reserve.
    const oversized = new File(["x"], "big.png", { type: "image/png" });
    Object.defineProperty(oversized, "size", { value: 10 * 1024 * 1024 });
    act(() => {
      result.current.attachImageFiles([oversized]);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(inserted).toHaveLength(0);
    expect(releaseSpies).toHaveLength(0);

    // Full-budget rejection: reserve returns null; no release handle exists.
    // Use the real function so we do not count this hold as a paste release.
    const hold = originalReserveLandingImageBudget("fill", [
      { hash: null, bytes: LANDING_IMAGE_BUDGET_BYTES },
    ]);
    expect(hold).not.toBeNull();

    act(() => {
      result.current.attachImageFiles([pngFile(32, "no-room.png", 7)]);
    });
    await waitFor(() => {
      expect(scheduleLandingImageReconcile).toHaveBeenCalled();
    });
    expect(inserted).toHaveLength(0);
    // Production called reserve (null) - no release wrapper was created.
    expect(releaseSpies).toHaveLength(0);

    hold?.release();
  });

  it("releases the reservation exactly once after insertion on the happy path", async () => {
    const { releaseSpies } = spyReservationReleases();
    const order: string[] = [];
    const inserted: ImageAttachmentAttrs[][] = [];
    const editorRef = {
      current: {
        isReady: () => true,
        insertImageAttachments: (
          attrs: ReadonlyArray<ImageAttachmentAttrs>,
        ) => {
          order.push("insert");
          // Release must not have fired yet - handoff still owns the charge.
          expect(releaseSpies[0]).toBeDefined();
          expect(releaseSpies[0]).not.toHaveBeenCalled();
          inserted.push([...attrs]);
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
        draftId: "draft-success",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: NO_MENTION_ROOTS,
      }),
    );

    act(() => {
      result.current.attachImageFiles([pngFile(48, "ok.png", 7)]);
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    await waitFor(() => expect(releaseSpies).toHaveLength(1));
    await waitFor(() => expect(releaseSpies[0]).toHaveBeenCalledTimes(1));

    // insertAttrs runs insert then focus synchronously; release is only in
    // runImageIngest's finally after insertAttrs returns.
    expect(order).toEqual(["insert", "focus"]);
    expect(releaseSpies[0]).toHaveBeenCalledTimes(1);

    // Order proof: release was not yet called when insert ran (asserted above
    // inside insertImageAttachments), and is called exactly once after.
    releaseSpies[0]?.();
    expect(releaseSpies[0]).toHaveBeenCalledTimes(2);
    const again = originalReserveLandingImageBudget("post-success", [
      { hash: null, bytes: LANDING_IMAGE_BUDGET_BYTES },
    ]);
    expect(again).not.toBeNull();
    again?.release();
  });
});
