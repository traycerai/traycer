/** usePromptStash capture/source CAS */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { StrictMode, type ReactNode } from "react";
import { toast } from "sonner";

import { usePromptStash } from "@/hooks/composer/use-prompt-stash";
import { PromptStashCapacityExceededError } from "@/lib/composer/prompt-stash-repository";
import type { PromptStashEntry } from "@/lib/composer/prompt-stash-codec";
import { PromptStashImagePreparationError } from "@/lib/composer/prompt-stash-content";
import { resetActivePromptStashForTests } from "@/lib/commands/active-prompt-stash-registry";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";
import {
  hookArgs,
  imageDoc,
  makeDestination,
  makeEditor,
  makeSource,
  sha256Hex,
  textDoc,
  type MutableSource,
} from "./use-prompt-stash-test-helpers";

const storeMocks = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  hydrate: vi.fn(() => Promise.resolve(undefined)),
  markUnavailable: vi.fn(),
}));

const idbData = vi.hoisted(() => new Map<string, unknown>());

/**
 * Optional delayed materialize for destination-race tests. When `impl` is set,
 * restore uses it instead of the real blob-read path.
 */
const materializeMocks = vi.hoisted(() => ({
  impl: null as null | ((entry: PromptStashEntry) => Promise<JsonContent>),
}));

// These tests only ever pass string keys through the idb-keyval mock.
vi.mock("idb-keyval", () => {
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(idbData.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      idbData.set(key, value);
      return Promise.resolve();
    }),
    setMany: vi.fn((entries: ReadonlyArray<[string, unknown]>) => {
      for (const [key, value] of entries) {
        idbData.set(key, value);
      }
      return Promise.resolve();
    }),
    del: vi.fn((key: string) => {
      idbData.delete(key);
      return Promise.resolve();
    }),
    delMany: vi.fn((keys: ReadonlyArray<string>) => {
      for (const key of keys) {
        idbData.delete(key);
      }
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
  };
});

vi.mock("@/lib/composer/prompt-stash-content", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/composer/prompt-stash-content")
    >();
  return {
    ...actual,
    materializePromptStashEntry: (entry: PromptStashEntry) => {
      if (materializeMocks.impl !== null) {
        return materializeMocks.impl(entry);
      }
      return actual.materializePromptStashEntry(entry);
    },
  };
});

vi.mock("@/stores/composer/prompt-stash-store", () => {
  const state = {
    rows: [] as Array<
      | { kind: "entry"; entry: PromptStashEntry }
      | {
          kind: "unavailable";
          id: string;
          createdAt: number;
          content: PromptStashEntry["content"] | null;
        }
    >,
    hydrate: storeMocks.hydrate,
    save: storeMocks.save,
    remove: storeMocks.remove,
    markUnavailable: (id: string) => {
      storeMocks.markUnavailable(id);
      state.rows = state.rows.map((row) =>
        row.kind === "entry" && row.entry.id === id
          ? {
              kind: "unavailable",
              id,
              createdAt: row.entry.createdAt,
              content: row.entry.content,
            }
          : row,
      );
    },
  };
  const usePromptStashStoreMock = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    {
      getState: () => state,
      setState: (partial: Partial<typeof state>) => {
        Object.assign(state, partial);
      },
    },
  );
  return { usePromptStashStore: usePromptStashStoreMock };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "fixed-entry-id"),
}));

describe("usePromptStash capture/source CAS", () => {
  beforeEach(() => {
    resetActivePromptStashForTests();
    idbData.clear();
    materializeMocks.impl = null;
    storeMocks.save.mockReset();
    storeMocks.remove.mockReset();
    storeMocks.hydrate.mockReset();
    storeMocks.markUnavailable.mockReset();
    storeMocks.hydrate.mockResolvedValue(undefined);
    storeMocks.save.mockResolvedValue(undefined);
    storeMocks.remove.mockResolvedValue(undefined);
    usePromptStashStore.setState({
      rows: [],
    });
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.success).mockClear();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_123);
  });

  afterEach(() => {
    cleanup();
    resetActivePromptStashForTests();
    materializeMocks.impl = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not clear the source when durable save fails", async () => {
    storeMocks.save.mockRejectedValueOnce(new Error("quota"));
    const editor = makeEditor({ content: textDoc("keep me") });
    const source = makeSource({ content: textDoc("keep me") });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source,
          destination: makeDestination(undefined),
        }),
      ),
    );

    await act(async () => {
      result.current.stashCurrent();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(source.clearIfUnchanged).not.toHaveBeenCalled();
    expect(editor.handle.getJSON()).toEqual(textDoc("keep me"));
    expect(result.current.pulseEpoch).toBe(0);
  });
  it("surfaces capacity and image-preparation failures with composer-preserved copy", async () => {
    const editor = makeEditor({ content: textDoc("keep me") });
    const source = makeSource({ content: textDoc("keep me") });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source,
          destination: makeDestination(undefined),
        }),
      ),
    );

    storeMocks.save.mockRejectedValueOnce(
      new PromptStashCapacityExceededError(),
    );
    await act(async () => {
      result.current.stashCurrent();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Could not stash this prompt", {
        description:
          "The prompt stash is full. Delete an older stashed prompt to free space; this prompt was left in the composer.",
      });
    });
    expect(source.clearIfUnchanged).not.toHaveBeenCalled();

    vi.mocked(toast.error).mockClear();
    storeMocks.save.mockRejectedValueOnce(
      new PromptStashImagePreparationError(
        "Image shot.png could not be prepared for stash.",
      ),
    );
    // Re-trigger stash; source still has content.
    await act(async () => {
      result.current.stashCurrent();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Could not stash this prompt", {
        description:
          "Image shot.png could not be prepared for stash. The composer was left unchanged.",
      });
    });
  });
  it("uses the adapter image resolver for hash-only landing / chat stashes", async () => {
    // Ticket 4 capture path decode-validates animation, then keeps bytes
    // verbatim. Stub the browser codec so jsdom can complete readability.
    const { twoFrameGifBytesOfSize } =
      await import("@/lib/composer/__tests__/prompt-stash-image-fixtures");
    const imageBytes = twoFrameGifBytesOfSize(64);
    const bitmapClose = vi.fn(() => undefined);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() =>
        Promise.resolve({
          width: 16,
          height: 16,
          close: bitmapClose,
        }),
      ),
    );
    const hash = await sha256Hex(imageBytes);
    const stashContent = imageDoc({
      id: "img-hash",
      fileName: "from-adapter.gif",
      hash,
      b64content: null,
      mimeType: "image/gif",
      size: imageBytes.byteLength,
    });
    const editor = makeEditor({ content: stashContent });
    const readHashImage = vi.fn((requested: string) => {
      expect(requested).toBe(hash);
      return Promise.resolve(imageBytes);
    });
    const source = makeSource({ content: stashContent });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          readHashImage,
          source,
          destination: makeDestination(undefined),
        }),
      ),
    );

    await act(async () => {
      result.current.stashCurrent();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(storeMocks.save).toHaveBeenCalledTimes(1);
    });
    expect(readHashImage).toHaveBeenCalledWith(hash);
    expect(source.clearIfUnchanged).toHaveBeenCalledTimes(1);
    expect(bitmapClose).toHaveBeenCalledTimes(1);
    const snapshot = storeMocks.save.mock.calls[0]?.[0] as {
      entry: PromptStashEntry;
      imagesByHash: Map<string, { bytes: Uint8Array; mimeType: string }>;
    };
    expect(snapshot.entry.id).toBe("fixed-entry-id");
    // Ticket 5 snapshot shape: blob is bytes + canonical mimeType.
    expect(snapshot.imagesByHash.get(hash)).toEqual({
      bytes: imageBytes,
      mimeType: "image/gif",
    });
  });
  it("rejects codec-unreadable animated GIF before any save or source clear", async () => {
    const { structurallyAnimatedGifWithCorruptLzw } =
      await import("@/lib/composer/__tests__/prompt-stash-image-fixtures");
    const imageBytes = structurallyAnimatedGifWithCorruptLzw(128);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.reject(new Error("codec unreadable animated GIF"))),
    );
    const hash = await sha256Hex(imageBytes);
    const stashContent = imageDoc({
      id: "img-corrupt-anim",
      fileName: "broken-anim.gif",
      hash,
      b64content: null,
      mimeType: "image/gif",
      size: imageBytes.byteLength,
    });
    const editor = makeEditor({ content: stashContent });
    const readHashImage = vi.fn((requested: string) => {
      expect(requested).toBe(hash);
      return Promise.resolve(imageBytes);
    });
    const source = makeSource({ content: stashContent });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          readHashImage,
          source,
          destination: makeDestination(undefined),
        }),
      ),
    );

    await act(async () => {
      result.current.stashCurrent();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Could not stash this prompt", {
        description:
          "A prompt image could not be decoded. The composer was left unchanged.",
      });
    });
    expect(readHashImage).toHaveBeenCalledWith(hash);
    expect(storeMocks.save).not.toHaveBeenCalled();
    expect(source.clearIfUnchanged).not.toHaveBeenCalled();
    expect(usePromptStashStore.getState().rows).toEqual([]);
  });
  describe("delayed-save source CAS races", () => {
    it("keeps newer edits, toasts, and still advances pulse when revision moves during save", async () => {
      let resolveSave: (() => void) | undefined;
      storeMocks.save.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve;
          }),
      );

      const editor = makeEditor({ content: textDoc("original stash") });
      const source = makeSource({
        content: textDoc("original stash"),
        revision: 3,
      });
      const { result } = renderHook(() =>
        usePromptStash(
          hookArgs({
            editorRef: editor.editorRef,
            source,
            destination: makeDestination(undefined),
          }),
        ),
      );

      await act(async () => {
        result.current.stashCurrent();
        await Promise.resolve();
      });
      // Capture happened; save is still pending.
      expect(source.capture).toHaveBeenCalled();
      expect(storeMocks.save).toHaveBeenCalledTimes(1);
      expect(source.clearIfUnchanged).not.toHaveBeenCalled();

      // Simulate a keystroke / paste / queue-edit while durable save is in flight.
      source.setContent(textDoc("typed during save"));
      source.setRevision(4);

      await act(async () => {
        resolveSave?.();
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(source.clearIfUnchanged).toHaveBeenCalledTimes(1);
      });
      // clearIfUnchanged must receive the ORIGINALLY captured token, not a re-read.
      expect(source.clearIfUnchanged).toHaveBeenCalledWith({
        surface: "test",
        identity: "test",
        revision: 3,
      });
      expect(source.clearIfUnchanged.mock.results[0]?.value).toBe(false);
      expect(toast.success).toHaveBeenCalledWith("Prompt stashed", {
        description: "Newer edits in the composer were kept.",
      });
      // A durable stash still happened - UI count must flash even though nothing cleared.
      expect(result.current.pulseEpoch).toBe(1);
    });

    it("clears when revision is unchanged and does not toast about kept edits", async () => {
      let resolveSave: (() => void) | undefined;
      storeMocks.save.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve;
          }),
      );

      const editor = makeEditor({ content: textDoc("stable prompt") });
      const source = makeSource({
        content: textDoc("stable prompt"),
        revision: 2,
      });
      const { result } = renderHook(() =>
        usePromptStash(
          hookArgs({
            editorRef: editor.editorRef,
            source,
            destination: makeDestination(undefined),
          }),
        ),
      );

      await act(async () => {
        result.current.stashCurrent();
        await Promise.resolve();
      });
      expect(source.clearIfUnchanged).not.toHaveBeenCalled();

      await act(async () => {
        resolveSave?.();
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(source.clearIfUnchanged).toHaveBeenCalledTimes(1);
      });
      expect(source.clearIfUnchanged).toHaveBeenCalledWith({
        surface: "test",
        identity: "test",
        revision: 2,
      });
      expect(source.clearIfUnchanged.mock.results[0]?.value).toBe(true);
      expect(toast.success).not.toHaveBeenCalled();
      expect(result.current.pulseEpoch).toBe(1);
    });

    it("does not clear or advance pulse when save rejects", async () => {
      let rejectSave: ((error: Error) => void) | undefined;
      storeMocks.save.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectSave = reject;
          }),
      );

      const editor = makeEditor({ content: textDoc("keep on failure") });
      const source = makeSource({
        content: textDoc("keep on failure"),
        revision: 5,
      });
      const { result } = renderHook(() =>
        usePromptStash(
          hookArgs({
            editorRef: editor.editorRef,
            source,
            destination: makeDestination(undefined),
          }),
        ),
      );

      await act(async () => {
        result.current.stashCurrent();
        await Promise.resolve();
      });
      expect(source.capture).toHaveBeenCalledTimes(1);
      expect(source.clearIfUnchanged).not.toHaveBeenCalled();

      await act(async () => {
        rejectSave?.(new Error("quota exceeded"));
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });
      expect(source.clearIfUnchanged).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(result.current.pulseEpoch).toBe(0);
    });

    it("uses the latest render's source for post-save clearIfUnchanged (sync sourceRef)", async () => {
      // sourceRef is assigned during layout (not a passive effect), so a
      // mid-flight source swap must resolve clearIfUnchanged on the NEW
      // adapter. Capture still used owner-1; the token is owner-1's, so the
      // owner-2 adapter correctly refuses to clear (identity mismatch) -
      // proving a stash for owner-1 never erases owner-2.
      let resolveSave: (() => void) | undefined;
      storeMocks.save.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve;
          }),
      );

      const editor = makeEditor({ content: textDoc("owner-1 prompt") });
      const owner1 = makeSource({
        content: textDoc("owner-1 prompt"),
        identity: "owner-1",
        revision: 1,
      });
      const owner2 = makeSource({
        content: textDoc("owner-2 different draft"),
        identity: "owner-2",
        revision: 1,
      });

      const { result, rerender } = renderHook(
        ({ source }: { source: MutableSource }) =>
          usePromptStash(
            hookArgs({
              editorRef: editor.editorRef,
              source,
              destination: makeDestination(undefined),
            }),
          ),
        { initialProps: { source: owner1 } },
      );

      await act(async () => {
        result.current.stashCurrent();
        await Promise.resolve();
      });
      expect(storeMocks.save).toHaveBeenCalledTimes(1);
      expect(owner1.capture).toHaveBeenCalled();
      expect(owner1.clearIfUnchanged).not.toHaveBeenCalled();
      expect(owner2.clearIfUnchanged).not.toHaveBeenCalled();

      // Mid-flight: surface rebinds to a different source owner.
      rerender({ source: owner2 });

      await act(async () => {
        resolveSave?.();
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(owner2.clearIfUnchanged).toHaveBeenCalledTimes(1);
      });
      // Latest source receives the ORIGINALLY captured token (owner-1).
      expect(owner2.clearIfUnchanged).toHaveBeenCalledWith({
        surface: "test",
        identity: "owner-1",
        revision: 1,
      });
      // Identity mismatch → owner-2 refuses to clear itself.
      expect(owner2.clearIfUnchanged.mock.results[0]?.value).toBe(false);
      // Stale owner-1 adapter is not used for the post-save clear.
      expect(owner1.clearIfUnchanged).not.toHaveBeenCalled();
      // Durable save still succeeded; kept-edits toast because clear returned false.
      expect(result.current.pulseEpoch).toBe(1);
      expect(toast.success).toHaveBeenCalledWith("Prompt stashed", {
        description: "Newer edits in the composer were kept.",
      });
    });

    it("skips source clear, pulse, toast, and setSaving after unmount while save is in flight (retiredRef)", async () => {
      // A fire-and-forget stash can still be awaiting IndexedDB when the
      // composer unmounts. Without retiredRef, post-save clearIfUnchanged
      // would run against a retired adapter and could ABA-clear a reopened
      // occupant of the same identity+revision; setSaving(false) would also
      // warn about a state update on an unmounted component.
      let resolveSave: (() => void) | undefined;
      storeMocks.save.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve;
          }),
      );

      const editor = makeEditor({ content: textDoc("unmount mid-save") });
      const source = makeSource({
        content: textDoc("unmount mid-save"),
        revision: 7,
        identity: "lifetime-1",
      });
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const { result, unmount } = renderHook(() =>
        usePromptStash(
          hookArgs({
            editorRef: editor.editorRef,
            source,
            destination: makeDestination(undefined),
          }),
        ),
      );

      await act(async () => {
        result.current.stashCurrent();
        await Promise.resolve();
      });
      expect(storeMocks.save).toHaveBeenCalledTimes(1);
      expect(source.clearIfUnchanged).not.toHaveBeenCalled();

      unmount();

      await act(async () => {
        resolveSave?.();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Durable save completed; retired instance never touches the source or
      // surfaces success feedback for a composer that is gone.
      expect(source.clearIfUnchanged).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      // No React "state update on unmounted component" from setSaving(false).
      const unmountedStateUpdates = consoleError.mock.calls.filter((call) =>
        call.some(
          (arg) =>
            typeof arg === "string" &&
            (arg.includes("unmounted") ||
              arg.includes("not mounted") ||
              arg.includes("Can't perform a React state update")),
        ),
      );
      expect(unmountedStateUpdates).toHaveLength(0);
      consoleError.mockRestore();
    });

    it("suppresses toast.error after unmount when save rejects (retiredRef catch)", async () => {
      // Sibling of the resolve-path retiredRef test above: a retired instance
      // must also suppress failure feedback. "Could not stash this prompt" is
      // meaningless once the composer is gone; the durable save already
      // settled independently (here: rejected).
      let rejectSave: ((error: Error) => void) | undefined;
      storeMocks.save.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectSave = reject;
          }),
      );

      const editor = makeEditor({ content: textDoc("unmount mid-reject") });
      const source = makeSource({
        content: textDoc("unmount mid-reject"),
        revision: 8,
        identity: "lifetime-reject-1",
      });
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const { result, unmount } = renderHook(() =>
        usePromptStash(
          hookArgs({
            editorRef: editor.editorRef,
            source,
            destination: makeDestination(undefined),
          }),
        ),
      );

      await act(async () => {
        result.current.stashCurrent();
        await Promise.resolve();
      });
      expect(storeMocks.save).toHaveBeenCalledTimes(1);
      expect(source.clearIfUnchanged).not.toHaveBeenCalled();

      unmount();

      await act(async () => {
        rejectSave?.(new Error("quota after unmount"));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Catch-block retiredRef gate: no error toast for a gone composer.
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(source.clearIfUnchanged).not.toHaveBeenCalled();
      const unmountedStateUpdates = consoleError.mock.calls.filter((call) =>
        call.some(
          (arg) =>
            typeof arg === "string" &&
            (arg.includes("unmounted") ||
              arg.includes("not mounted") ||
              arg.includes("Can't perform a React state update")),
        ),
      );
      expect(unmountedStateUpdates).toHaveLength(0);
      consoleError.mockRestore();
    });

    it("still runs a live stash under StrictMode double-invoke of the retiredRef layout effect", async () => {
      // React 18 Strict Mode double-invokes mount effects (setup → cleanup →
      // setup) for a still-mounted instance. The retiredRef layout effect
      // must reset to false in setup; without that, the simulated cleanup
      // would leave every live instance permanently retired and turn every
      // post-save clear/pulse/toast into a silent no-op.
      //
      // Convention: same StrictMode wrapper pattern as
      // stream-runtime.test.tsx / route-error-component.test.tsx.
      //
      // HARNESS LIMITATION: this vitest/jsdom setup does not double-invoke
      // mount layout effects under <StrictMode> (verified with a probe:
      // setup fires once even with NODE_ENV=development; same observation
      // as worktrees-enrichment.test.tsx). Mutation-removing
      // `retiredRef.current = false` therefore still leaves this test green
      // here. It remains a canary for the production shape and becomes a
      // real regression net if the harness gains dev-mode double-invocation.
      const strictWrapper = (props: {
        readonly children: ReactNode;
      }): ReactNode => <StrictMode>{props.children}</StrictMode>;

      const editor = makeEditor({ content: textDoc("strict mode stash") });
      const source = makeSource({
        content: textDoc("strict mode stash"),
        revision: 2,
        identity: "strict-mode-live",
      });
      const { result } = renderHook(
        () =>
          usePromptStash(
            hookArgs({
              editorRef: editor.editorRef,
              source,
              destination: makeDestination(undefined),
            }),
          ),
        { wrapper: strictWrapper },
      );

      // No unmount - a normal live stash after Strict Mode's mount cycle.
      await act(async () => {
        result.current.stashCurrent();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(storeMocks.save).toHaveBeenCalledTimes(1);
      });
      // Live instance is not stuck retired: clear, pulse, and setSaving run.
      expect(source.clearIfUnchanged).toHaveBeenCalledTimes(1);
      expect(source.clearIfUnchanged).toHaveBeenCalledWith({
        surface: "test",
        identity: "strict-mode-live",
        revision: 2,
      });
      expect(source.clearIfUnchanged.mock.results[0]?.value).toBe(true);
      expect(result.current.pulseEpoch).toBe(1);
      expect(result.current.saving).toBe(false);
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });
  });
});
