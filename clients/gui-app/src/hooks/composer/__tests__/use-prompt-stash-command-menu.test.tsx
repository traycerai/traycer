/** usePromptStash command/menu state */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { toast } from "sonner";

import { usePromptStash } from "@/hooks/composer/use-prompt-stash";
import type { PromptStashEntry } from "@/lib/composer/prompt-stash-codec";
import { resetActivePromptStashForTests } from "@/lib/commands/active-prompt-stash-registry";
import { dispatchAction } from "@/lib/keybindings/dispatch";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";
import {
  emptyDoc,
  hookArgs,
  makeDestination,
  makeEditor,
  makeSource,
  noopRouter,
  textDoc,
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

describe("usePromptStash command/menu state", () => {
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
  });

  it("registers on the active-prompt-stash stack while active and unregisters on unmount", async () => {
    usePromptStashStore.setState({
      rows: [
        {
          kind: "entry",
          entry: {
            id: "existing-entry",
            createdAt: 1,
            content: textDoc("already stashed"),
            blobHashes: [],
          },
        },
      ],
    });
    const editor = makeEditor({ content: textDoc("stash me") });
    const source = makeSource({ content: textDoc("stash me") });
    const { result, unmount } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source,
          destination: makeDestination(undefined),
        }),
      ),
    );

    act(() => result.current.setMenuOpen(true));
    expect(result.current.menuOpen).toBe(true);
    expect(dispatchAction("composer.stash", noopRouter())).toBe(true);
    await waitFor(() => {
      expect(storeMocks.save).toHaveBeenCalledTimes(1);
    });
    expect(source.clearIfUnchanged).toHaveBeenCalledTimes(1);
    expect(result.current.pulseEpoch).toBeGreaterThan(0);
    expect(result.current.menuOpen).toBe(false);

    unmount();
    storeMocks.save.mockClear();
    expect(dispatchAction("composer.stash", noopRouter())).toBe(false);
    expect(storeMocks.save).not.toHaveBeenCalled();
  });
  it("modal Cmd+S stays registered while disabled (terminal mode) and never falls through to the underlying composer", async () => {
    // Mirrors NewConversationModalBody over an open chat/landing composer:
    // modal stays `active: true` for its whole open lifetime (so it owns the
    // stack top), and folds terminal-mode into `disabled` so Cmd+S is a
    // genuine no-op rather than releasing the slot to the composer beneath.
    const underlyingEditor = makeEditor({
      content: textDoc("underlying draft"),
    });
    const underlyingSource = makeSource({
      content: textDoc("underlying draft"),
      identity: "underlying",
      surface: "chat",
    });
    renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: underlyingEditor.editorRef,
          source: underlyingSource,
          destination: makeDestination({
            identity: "underlying-dest",
            surface: "chat",
          }),
          active: true,
          disabled: false,
        }),
      ),
    );

    const modalEditor = makeEditor({ content: textDoc("modal draft") });
    const modalSource = makeSource({
      content: textDoc("modal draft"),
      identity: "modal",
      surface: "new-conversation",
    });
    const { rerender } = renderHook(
      ({ disabled }: { disabled: boolean }) =>
        usePromptStash(
          hookArgs({
            editorRef: modalEditor.editorRef,
            source: modalSource,
            destination: makeDestination({
              identity: "modal-dest",
              surface: "new-conversation",
            }),
            active: true,
            disabled,
          }),
        ),
      { initialProps: { disabled: false } },
    );

    // Chat mode: modal owns the stack top; stash hits the modal source only.
    storeMocks.save.mockClear();
    underlyingSource.capture.mockClear();
    underlyingSource.clearIfUnchanged.mockClear();
    modalSource.capture.mockClear();
    modalSource.clearIfUnchanged.mockClear();

    expect(dispatchAction("composer.stash", noopRouter())).toBe(true);
    await waitFor(() => {
      expect(storeMocks.save).toHaveBeenCalledTimes(1);
    });
    expect(modalSource.capture).toHaveBeenCalled();
    expect(modalSource.clearIfUnchanged).toHaveBeenCalledTimes(1);
    expect(underlyingSource.capture).not.toHaveBeenCalled();
    expect(underlyingSource.clearIfUnchanged).not.toHaveBeenCalled();

    // Switch to terminal mode WITHOUT unmounting: disabled flips true while
    // active stays true (the registration must survive the mode toggle).
    storeMocks.save.mockClear();
    underlyingSource.capture.mockClear();
    underlyingSource.clearIfUnchanged.mockClear();
    modalSource.capture.mockClear();
    modalSource.clearIfUnchanged.mockClear();

    rerender({ disabled: true });

    // Modal remains on the stack (dispatch still finds an action) but both
    // sources stay untouched - suppressed, not redirected.
    expect(dispatchAction("composer.stash", noopRouter())).toBe(true);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(storeMocks.save).not.toHaveBeenCalled();
    expect(underlyingSource.capture).not.toHaveBeenCalled();
    expect(underlyingSource.clearIfUnchanged).not.toHaveBeenCalled();
    expect(modalSource.capture).not.toHaveBeenCalled();
    expect(modalSource.clearIfUnchanged).not.toHaveBeenCalled();

    // Toggle back to chat: same registration still owns the stack and stashes
    // the modal draft again without needing to re-register.
    storeMocks.save.mockClear();
    underlyingSource.capture.mockClear();
    underlyingSource.clearIfUnchanged.mockClear();
    modalSource.capture.mockClear();
    modalSource.clearIfUnchanged.mockClear();
    // Mock source does not clear content on clearIfUnchanged; re-seed for a
    // clean second stash so submittable content is guaranteed.
    modalSource.setContent(textDoc("modal draft again"));

    rerender({ disabled: false });

    expect(dispatchAction("composer.stash", noopRouter())).toBe(true);
    await waitFor(() => {
      expect(storeMocks.save).toHaveBeenCalledTimes(1);
    });
    expect(modalSource.capture).toHaveBeenCalled();
    expect(modalSource.clearIfUnchanged).toHaveBeenCalledTimes(1);
    expect(underlyingSource.capture).not.toHaveBeenCalled();
    expect(underlyingSource.clearIfUnchanged).not.toHaveBeenCalled();
  });
  it("does not open or save when the composer and global stash are empty", () => {
    const editor = makeEditor({ content: emptyDoc() });
    const source = makeSource({ content: emptyDoc() });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source,
          destination: makeDestination(undefined),
        }),
      ),
    );

    expect(result.current.menuOpen).toBe(false);
    act(() => {
      result.current.stashCurrent();
    });
    expect(result.current.menuOpen).toBe(false);
    expect(storeMocks.save).not.toHaveBeenCalled();
  });
  it("toggles the existing stash menu when the composer is empty", () => {
    usePromptStashStore.setState({
      rows: [
        {
          kind: "entry",
          entry: {
            id: "existing-entry",
            createdAt: 1,
            content: textDoc("already stashed"),
            blobHashes: [],
          },
        },
      ],
    });
    const editor = makeEditor({ content: emptyDoc() });
    const source = makeSource({ content: emptyDoc() });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source,
          destination: makeDestination(undefined),
        }),
      ),
    );

    act(() => {
      result.current.stashCurrent();
    });
    expect(result.current.menuOpen).toBe(true);
    act(() => {
      result.current.stashCurrent();
    });
    expect(result.current.menuOpen).toBe(false);
    expect(storeMocks.save).not.toHaveBeenCalled();
  });
  it("supports explicit delete from the popover without restoring", async () => {
    const entry: PromptStashEntry = {
      id: "entry-delete",
      createdAt: 1,
      content: textDoc("bye"),
      blobHashes: [],
    };
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: makeEditor({ content: emptyDoc() }).editorRef,
          source: makeSource({ content: emptyDoc() }),
          destination: makeDestination(undefined),
        }),
      ),
    );

    await act(async () => {
      await result.current.remove(entry.id);
    });
    expect(storeMocks.remove).toHaveBeenCalledWith("entry-delete");
  });
  it("refuses stash and restore while disabled (attachment pending / submitting)", async () => {
    const editor = makeEditor({ content: textDoc("blocked") });
    const source = makeSource({ content: textDoc("blocked") });
    const destination = makeDestination(undefined);
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source,
          destination,
          disabled: true,
        }),
      ),
    );

    act(() => {
      result.current.stashCurrent();
    });
    expect(storeMocks.save).not.toHaveBeenCalled();

    let ok = true;
    await act(async () => {
      ok = await result.current.restore({
        id: "x",
        createdAt: 1,
        content: textDoc("nope"),
        blobHashes: [],
      });
    });
    expect(ok).toBe(false);
    expect(destination.importAndInsert).not.toHaveBeenCalled();
  });
  it("returns false without import when captureIdentity is null", async () => {
    const entry: PromptStashEntry = {
      id: "entry-no-dest",
      createdAt: 1,
      content: textDoc("nowhere"),
      blobHashes: [],
    };
    const destination = makeDestination({ identity: null });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: makeEditor({ content: emptyDoc() }).editorRef,
          destination,
        }),
      ),
    );

    let ok = true;
    await act(async () => {
      ok = await result.current.restore(entry);
    });
    expect(ok).toBe(false);
    expect(destination.importAndInsert).not.toHaveBeenCalled();
    expect(storeMocks.remove).not.toHaveBeenCalled();
  });
});
