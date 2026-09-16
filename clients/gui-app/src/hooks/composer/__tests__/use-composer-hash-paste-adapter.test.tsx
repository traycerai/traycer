/**
 * T4's hash-only paste adapter (`useComposerHashPasteAdapter`/
 * `useComposerHashPaste`), the sibling of `useComposerPasteAdapter` that
 * stores a pasted/dropped/picked image content-addressed and inserts a
 * `{ hash }` node, instead of inline base64. `useComposerPasteAdapter` itself
 * is untouched and stays covered by `use-composer-paste.test.tsx`; this file
 * is its hash-only twin.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  useComposerHashPasteAdapter,
  type ComposerFilePathIngestArgs,
} from "@/hooks/composer/use-composer-paste";
import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import { getImageBytes, putImage } from "@/lib/composer/landing-image-store";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import { reconcile } from "@/lib/composer/landing-image-gc";
import { pendingIngestImageHashRoots } from "@/lib/composer/pending-ingest-image-roots";
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";

// F1 needs to gate ONE file's `putImage` mid-batch while its sibling's has
// already resolved, so the GC sweep can be driven while the batch is still
// waiting on the slow file. Every other test in this file calls through to
// the real, content-addressed store.
const landingImageStoreMocks = vi.hoisted(() => ({
  putImage: vi.fn<(bytes: ImageBytes) => Promise<string>>(),
  actualPutImage: null as ((bytes: ImageBytes) => Promise<string>) | null,
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  landingImageStoreMocks.actualPutImage = actual.putImage;
  landingImageStoreMocks.putImage.mockImplementation(actual.putImage);
  return { ...actual, putImage: landingImageStoreMocks.putImage };
});

async function sha256Hex(bytes: ImageBytes): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function bytesEqual(a: ImageBytes, b: ReadonlyArray<number>): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

const NOOP_FILE_PATHS: ComposerFilePathIngestArgs = {
  fileDrops: {
    resolveDroppedFilePaths: () => Promise.resolve([]),
    copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
    readNativeClipboardFilePaths: () => Promise.resolve([]),
  },
  mentionRoots: [],
  beginPathInsertion: () => null,
};

function pngFile(name: string, bytes: ReadonlyArray<number>): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

function bmpFile(name: string, bytes: ReadonlyArray<number>): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/bmp" });
}

function docWithImageAttrs(
  attrs: ReadonlyArray<ImageAttachmentAttrs>,
): JsonContent {
  return {
    type: "doc",
    content: attrs.map((attr): JsonContent => ({
      type: "imageAttachment",
      // A plain object literal, not the `attr` union value itself:
      // `ImageAttachmentAttrs`'s `hash?: never` / `b64content?: never`
      // discriminant fields are not assignable to `JsonContent.attrs`'s
      // `Record<string, unknown>`.
      attrs: {
        id: attr.id,
        fileName: attr.fileName,
        mimeType: attr.mimeType,
        size: attr.size,
        hash: attr.hash,
        b64content: attr.b64content,
      },
    })),
  };
}

interface FileTransferLike {
  readonly files: ReadonlyArray<File>;
  readonly types: ReadonlyArray<string>;
  readonly items: ReadonlyArray<{
    readonly kind: string;
    readonly type: string;
    getAsFile: () => File | null;
  }>;
  getData: (type: string) => string;
}

function makeFileTransfer(files: ReadonlyArray<File>): FileTransferLike {
  return {
    files,
    types: files.length > 0 ? ["Files"] : [],
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    })),
    getData: () => "",
  };
}

function PasteHarness(props: { readonly inserted: ImageAttachmentAttrs[][] }) {
  const handlers = useComposerHashPasteAdapter((attrs) => {
    props.inserted.push([...attrs]);
    return attrs.length;
  }, NOOP_FILE_PATHS);
  return (
    <div
      data-testid="paste-zone"
      onPaste={handlers.onPaste}
      onDrop={handlers.onDrop}
      onDragOver={handlers.onDragOver}
      onDragEnter={handlers.onDragEnter}
      onDragLeave={handlers.onDragLeave}
    />
  );
}

beforeEach(() => {
  installFreshIndexedDb();
  // The budget reservation ledger is a module-level singleton, not scoped to
  // this test file - a reservation left outstanding by another suite in the
  // same worker process can make a later test's `reserveLandingImageBudget`
  // refuse for no reason this test caused.
  resetLandingImageBudgetReservationsForTesting();
});

afterEach(() => {
  cleanup();
  // `mockClear()` only, never `mockReset()` - see
  // use-composer-pending-image-ingest.test.tsx for why: reset would wipe the
  // call-through implementation the `vi.mock` factory installed at module
  // load (it runs once).
  landingImageStoreMocks.putImage.mockClear();
});

describe("useComposerHashPasteAdapter - real file paste", () => {
  it("a pasted PNG becomes a hash-only node, with its bytes in the local store", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    render(<PasteHarness inserted={inserted} />);
    const png = pngFile("shot.png", [1, 2, 3]);

    fireEvent.paste(screen.getByTestId("paste-zone"), {
      clipboardData: makeFileTransfer([png]),
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    const attrs = inserted.at(0)?.at(0);
    expect(attrs).toBeDefined();
    if (attrs === undefined) return;
    expect(attrs.fileName).toBe("shot.png");
    // The union's absent field is `undefined` (`hash?: never` /
    // `b64content?: never`), never `null` - see `ImageAttachmentAttrs`.
    expect(attrs.hash).not.toBeUndefined();
    expect(attrs.b64content).toBeUndefined();
    const hash = attrs.hash;
    if (hash === undefined) return;
    expect(await getImageBytes(hash)).toEqual(new Uint8Array([1, 2, 3]));
    expect(blobHashesFromContent(docWithImageAttrs([attrs]))).toEqual([hash]);
  });

  it("a dropped PNG becomes a hash-only node at the same position as a paste", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    render(<PasteHarness inserted={inserted} />);
    const png = pngFile("dropped.png", [4, 5, 6]);

    fireEvent.drop(screen.getByTestId("paste-zone"), {
      dataTransfer: makeFileTransfer([png]),
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    const attrs = inserted.at(0)?.at(0);
    expect(attrs).toBeDefined();
    if (attrs === undefined) return;
    expect(attrs.hash).not.toBeUndefined();
    expect(attrs.b64content).toBeUndefined();
  });

  it("a picker-selected PNG (attachImageFiles) becomes a hash-only node", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { result } = renderHook(() =>
      useComposerHashPasteAdapter((attrs) => {
        inserted.push([...attrs]);
        return attrs.length;
      }, NOOP_FILE_PATHS),
    );

    act(() => {
      result.current.attachImageFiles([pngFile("picked.png", [7, 8, 9])]);
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    const attrs = inserted.at(0)?.at(0);
    expect(attrs).toBeDefined();
    if (attrs === undefined) return;
    expect(attrs.hash).not.toBeUndefined();
    expect(attrs.b64content).toBeUndefined();
  });
});

describe("useComposerHashPasteAdapter - format fallback", () => {
  it("a declared-BMP file stays inline (today's behaviour), not hash-only", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    render(<PasteHarness inserted={inserted} />);
    const bmp = bmpFile("legacy.bmp", [10, 11, 12]);

    fireEvent.paste(screen.getByTestId("paste-zone"), {
      clipboardData: makeFileTransfer([bmp]),
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    const attrs = inserted.at(0)?.at(0);
    expect(attrs).toBeDefined();
    if (attrs === undefined) return;
    expect(attrs.fileName).toBe("legacy.bmp");
    expect(attrs.hash).toBeUndefined();
    expect(attrs.b64content).not.toBeUndefined();
  });

  it("a mixed [PNG, BMP] paste keeps document order: one hash-only, one inline", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    render(<PasteHarness inserted={inserted} />);
    const png = pngFile("first.png", [1, 2, 3]);
    const bmp = bmpFile("second.bmp", [4, 5, 6]);

    fireEvent.paste(screen.getByTestId("paste-zone"), {
      clipboardData: makeFileTransfer([png, bmp]),
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    const attrs = inserted[0];
    expect(attrs).toHaveLength(2);
    const [first, second] = attrs;
    expect(first.fileName).toBe("first.png");
    expect(first.hash).not.toBeUndefined();
    expect(first.b64content).toBeUndefined();
    expect(second.fileName).toBe("second.bmp");
    expect(second.hash).toBeUndefined();
    expect(second.b64content).not.toBeUndefined();
  });
});

describe("useComposerHashPasteAdapter - F1: a completed hash survives while a batch sibling is still slow", () => {
  it("holds a fast file's stored bytes rooted through a real GC sweep while its slow sibling's putImage is still in flight", async () => {
    // Pre-fix (e1bdceff5): `holdPendingIngestImageHash` was not called, so
    // once the fast file's `putImage` resolved its hash sat referenced by
    // NOTHING - not the document (the batch waits for every sibling before
    // inserting any of them), not the budget ledger (accounting, not a root),
    // and the session cache is a root that THIS SWEEP releases the moment it
    // finds no live root, opening the door for the very next sweep to delete
    // the durable bytes. Two reconciles inside one slow batch is exactly what
    // the module doc describes, and is what this test drives.
    const inserted: ImageAttachmentAttrs[][] = [];
    render(<PasteHarness inserted={inserted} />);

    const FAST_BYTES = [1, 2, 3];
    const SLOW_BYTES = [4, 5, 6, 7, 8, 9];
    let releaseSlow: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    landingImageStoreMocks.putImage.mockImplementation(async (bytes) => {
      const isSlowFile = bytesEqual(bytes, SLOW_BYTES);
      if (isSlowFile) await gate;
      const actual = landingImageStoreMocks.actualPutImage;
      if (actual === null) {
        throw new Error("actual putImage was never captured");
      }
      return actual(bytes);
    });

    const fastHash = await sha256Hex(new Uint8Array(FAST_BYTES));
    // Positive control: unrelated bytes with NO root at all (not in this
    // batch, not in any draft/live editor). If a sweep runs and finds nothing
    // to delete, that proves nothing - this hash proves the sweep actually
    // executed its deleting branch during the window under test.
    const orphanHash = await putImage(new Uint8Array([99, 99, 99]));

    const fast = pngFile("fast.png", FAST_BYTES);
    const slow = pngFile("slow.png", SLOW_BYTES);
    fireEvent.paste(screen.getByTestId("paste-zone"), {
      clipboardData: makeFileTransfer([fast, slow]),
    });

    // Wait until the fast file's `putImage` has actually resolved (its bytes
    // are durably stored) while the slow sibling is still gated - the exact
    // window F1 exists to cover. The batch itself has NOT inserted anything
    // yet (it waits for both files), so nothing but the pending-ingest root
    // hold can be keeping the fast hash alive right now.
    await waitFor(async () => {
      expect(await getImageBytes(fastHash)).toBeDefined();
    });
    expect(inserted).toHaveLength(0);

    // "Two sweeps inside one slow read is all it takes" - drive both directly
    // rather than waiting on the debounce timer.
    await reconcile();
    await reconcile();

    // Positive control fired: the sweep actually deleted an unrooted hash.
    expect(await getImageBytes(orphanHash)).toBeUndefined();
    // The fix: the fast file's hash is still rooted (by the pending-ingest
    // hold), so it survived the same two sweeps that just reaped the orphan.
    expect(await getImageBytes(fastHash)).toBeDefined();

    releaseSlow();
    await waitFor(() => expect(inserted).toHaveLength(1));
  });
});

describe("useComposerHashPasteAdapter - F5(c): a late completion after abort must discard, never insert or root", () => {
  it("a slow file's real store write completing AFTER the surface aborted is discarded - not inserted, not rooted", async () => {
    // Pre-fix (e1bdceff5): the per-file conversion had no abort-responsive
    // wrapper around `putImage` - only a `signal.throwIfAborted()` that runs
    // once the promise settles. So a paste abandoned mid-flight (the surface
    // unmounted, or the user navigated away) would just keep waiting for the
    // real, uncancellable write; once it finally resolved - however late -
    // the old code would call `holdPendingIngestImageHash` and return the
    // attrs as if the abort had never happened. `withAbortableDeadline`
    // rejects the MOMENT the signal aborts, so the per-file job has already
    // thrown and released everything well before the real write catches up.
    const inserted: ImageAttachmentAttrs[][] = [];
    const { unmount } = render(<PasteHarness inserted={inserted} />);

    const FAST_BYTES = [1, 2, 3];
    const SLOW_BYTES = [4, 5, 6, 7, 8, 9];
    let releaseSlow: () => void = () => undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowEntered: () => void = () => undefined;
    const slowEnteredSignal = new Promise<void>((resolve) => {
      slowEntered = resolve;
    });
    // Captures the REAL (uncancellable) write's promise so the test can await
    // its completion deterministically, rather than guessing how many
    // microtask turns idb-keyval needs. Signalled via its own promise, not a
    // plain variable read right after `releaseSlow()` - the mock only reaches
    // this line on the NEXT microtask after the gate resolves, so a bare
    // synchronous read would race it.
    let resolveSlowRealWrite: (write: Promise<string>) => void = () =>
      undefined;
    const slowRealWriteCaptured = new Promise<Promise<string>>((resolve) => {
      resolveSlowRealWrite = resolve;
    });
    landingImageStoreMocks.putImage.mockImplementation(async (bytes) => {
      const isSlowFile = bytesEqual(bytes, SLOW_BYTES);
      if (isSlowFile) {
        slowEntered();
        await slowGate;
      }
      const actual = landingImageStoreMocks.actualPutImage;
      if (actual === null) {
        throw new Error("actual putImage was never captured");
      }
      const write = actual(bytes);
      if (isSlowFile) resolveSlowRealWrite(write);
      return write;
    });

    const slowHash = await sha256Hex(new Uint8Array(SLOW_BYTES));

    const fast = pngFile("fast.png", FAST_BYTES);
    const slow = pngFile("slow.png", SLOW_BYTES);
    fireEvent.paste(screen.getByTestId("paste-zone"), {
      clipboardData: makeFileTransfer([fast, slow]),
    });

    // Arrival signal: wait until the slow file's `putImage` has actually been
    // entered (and is now parked on `slowGate`) before abandoning the surface.
    await slowEnteredSignal;

    // Abandon the surface. `useComposerPasteEvents`'s unmount cleanup aborts
    // every outstanding controller - this is the SAME abort path a real
    // navigate-away or unmount takes, not a synthetic signal this test wires
    // up itself.
    unmount();

    // The abort rejects `withAbortableDeadline`'s wrapper the moment it
    // fires - no timer advance or extra wait needed. The batch fails as a
    // whole (one rejection sinks `Promise.allSettled`'s caller), so nothing
    // was inserted, including the fast sibling whose own bytes are real.
    await waitFor(() => {
      expect(inserted).toHaveLength(0);
    });

    // NOW let the real, uncancellable write actually finish - late, after the
    // abort already gave up on it. Await the captured promise directly so
    // this assertion is deterministic, not a guess about flush timing.
    releaseSlow();
    // `slowRealWriteCaptured` is a `Promise<Promise<string>>` - awaiting it
    // already flattens through to the real write's resolved hash.
    await slowRealWriteCaptured;

    // Positive control: the late completion genuinely executed (proves this
    // isn't a promise that silently never resolved) - its bytes are now
    // durably stored.
    expect(await getImageBytes(slowHash)).toBeDefined();

    // But nothing acted on that late completion: no node was inserted for it
    // (the surface is gone - there is nothing left to insert into), and its
    // hash was never rooted by the pending-ingest hold (the per-file job had
    // already thrown via the abort before reaching that line).
    expect(inserted).toHaveLength(0);
    expect(pendingIngestImageHashRoots()).not.toContain(slowHash);
  });
});

describe("useComposerHashPasteAdapter - T4: abort between the file read completing and the store starting", () => {
  it("aborting in that exact window calls putImage zero times and produces no unhandled rejection", async () => {
    // Pre-fix: `hashImageAttrsFromFiles` had no `signal.throwIfAborted()`
    // between the awaited `file.arrayBuffer()` and constructing the
    // `putImage(bytes)` call. There is no `await` between them, so the only
    // way to land an abort strictly AFTER the read settles but BEFORE
    // `putImage` is called is to abort from INSIDE the read's own
    // resolution - a plain `Promise` cannot do this (resolving it only
    // SCHEDULES its `.then` callback as a later microtask, well after
    // `withAbortableDeadline`'s wrapper has already resolved and its own
    // `await` continuation - the one that calls `putImage` - has already run,
    // as this test proved empirically before landing). A custom thenable
    // whose own `then()` calls back into the caller SYNCHRONOUSLY is the only
    // way to interpose exactly there: it runs the abort in the same
    // synchronous stretch that resolved `withAbortableDeadline`'s wrapper,
    // strictly before that wrapper's pending `await` continuation gets its
    // own turn on the microtask queue. Without the guard, this test's
    // `putImage` assertion fails (it is called once) - confirmed by
    // temporarily removing the guard and re-running this exact test.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const inserted: ImageAttachmentAttrs[][] = [];
      const { unmount } = render(<PasteHarness inserted={inserted} />);

      const file = pngFile("mid-abort.png", [1, 2, 3]);
      const readCompletesThenAborts = {
        then(onFulfilled: (buffer: ArrayBuffer) => void): void {
          onFulfilled(new Uint8Array([1, 2, 3]).buffer);
          // The read has now resolved `withAbortableDeadline`'s wrapper
          // (its `finish` already ran, synchronously, inside `onFulfilled`
          // above) - the ONE window this test exists to hit. Aborting here,
          // still synchronously, lands strictly before the outer `await`'s
          // continuation runs.
          unmount();
        },
      };
      Object.defineProperty(file, "arrayBuffer", {
        value: () => readCompletesThenAborts,
      });

      fireEvent.paste(screen.getByTestId("paste-zone"), {
        clipboardData: makeFileTransfer([file]),
      });

      // Let every already-queued microtask drain.
      await act(async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });

      expect(inserted).toHaveLength(0);
      expect(landingImageStoreMocks.putImage).not.toHaveBeenCalled();
      expect(rejections).toHaveLength(0);

      // Positive control: prove this listener actually observes an unhandled
      // rejection, so the zero-length assertion above is not vacuous.
      void Promise.reject(new Error("control: unhandled rejection listener"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
