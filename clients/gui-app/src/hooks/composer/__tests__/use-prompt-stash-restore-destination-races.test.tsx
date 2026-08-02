/** usePromptStash restore destination races */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { toast } from "sonner";

import { usePromptStash } from "@/hooks/composer/use-prompt-stash";
import type { PromptStashEntry } from "@/lib/composer/prompt-stash-codec";
import { resetActivePromptStashForTests } from "@/lib/commands/active-prompt-stash-registry";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";
import {
  emptyDoc,
  hookArgs,
  makeDestination,
  makeEditor,
  textDoc,
  type MutableDestination,
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

describe("usePromptStash restore destination races", () => {
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

  describe("delayed-materialize destination acknowledgement", () => {
    it("does not insert or consume when destination becomes stale mid-materialize", async () => {
      const entry: PromptStashEntry = {
        id: "entry-stale-mid",
        createdAt: 1,
        content: textDoc("stashed while switching"),
        blobHashes: [],
      };
      let resolveMaterialize: ((content: JsonContent) => void) | undefined;
      materializeMocks.impl = () =>
        new Promise((resolve) => {
          resolveMaterialize = resolve;
        });

      const editor = makeEditor({ content: emptyDoc() });
      const destination = makeDestination({
        identity: "task-a",
        surface: "chat",
        latestContent: emptyDoc(),
      });
      const { result } = renderHook(() =>
        usePromptStash(
          hookArgs({
            editorRef: editor.editorRef,
            destination,
          }),
        ),
      );

      let restorePromise: Promise<boolean> | undefined;
      await act(async () => {
        restorePromise = result.current.restore(entry);
        await Promise.resolve();
      });
      expect(destination.captureIdentity).toHaveBeenCalled();
      expect(destination.importAndInsert).not.toHaveBeenCalled();

      destination.setIdentity("task-b");

      await act(async () => {
        resolveMaterialize?.(textDoc("stashed while switching"));
        await restorePromise;
      });

      expect(destination.importAndInsert).toHaveBeenCalledTimes(1);
      expect(destination.getInserts()).toHaveLength(0);
      expect(destination.getLatestContent()).toEqual(emptyDoc());
      expect(storeMocks.remove).not.toHaveBeenCalled();
      expect(editor.focuses).toHaveLength(0);
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("does not insert or consume when ready editor generation remounts under same owner id", async () => {
      const entry: PromptStashEntry = {
        id: "entry-remount-gen",
        createdAt: 1,
        content: textDoc("stashed while remounting"),
        blobHashes: [],
      };
      let resolveMaterialize: ((content: JsonContent) => void) | undefined;
      materializeMocks.impl = () =>
        new Promise((resolve) => {
          resolveMaterialize = resolve;
        });

      const editor = makeEditor({ content: emptyDoc() });
      const destination = makeDestination({
        identity: "task-same",
        surface: "chat",
        latestContent: emptyDoc(),
        editorGeneration: Object.freeze({ generation: "handle-v1" }),
      });
      const { result } = renderHook(() =>
        usePromptStash(
          hookArgs({
            editorRef: editor.editorRef,
            destination,
          }),
        ),
      );

      let restorePromise: Promise<boolean> | undefined;
      await act(async () => {
        restorePromise = result.current.restore(entry);
        await Promise.resolve();
      });
      destination.setEditorGeneration(
        Object.freeze({ generation: "handle-v2" }),
      );

      let ok = true;
      await act(async () => {
        resolveMaterialize?.(textDoc("stashed while remounting"));
        if (restorePromise === undefined) throw new Error("expected restore");
        ok = await restorePromise;
      });

      expect(ok).toBe(false);
      expect(destination.importAndInsert).toHaveBeenCalledTimes(1);
      expect(destination.getInserts()).toHaveLength(0);
      expect(destination.getLatestContent()).toEqual(emptyDoc());
      expect(storeMocks.remove).not.toHaveBeenCalled();
      expect(editor.focuses).toHaveLength(0);
    });

    it("does not insert or consume when destination adapter returns stale", async () => {
      const entry: PromptStashEntry = {
        id: "entry-stale-result",
        createdAt: 1,
        content: textDoc("gone"),
        blobHashes: [],
      };
      const destination = makeDestination({
        importResult: { status: "stale" },
      });
      const editor = makeEditor({ content: emptyDoc() });
      const { result } = renderHook(() =>
        usePromptStash(
          hookArgs({
            editorRef: editor.editorRef,
            destination,
          }),
        ),
      );

      let ok = true;
      await act(async () => {
        ok = await result.current.restore(entry);
      });

      expect(ok).toBe(false);
      expect(storeMocks.remove).not.toHaveBeenCalled();
      expect(editor.focuses).toHaveLength(0);
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.warning).not.toHaveBeenCalled();
    });

    it("appends against latest destination content mutated during blob reads", async () => {
      const entry: PromptStashEntry = {
        id: "entry-mutate-during",
        createdAt: 1,
        content: textDoc("restored chunk"),
        blobHashes: [],
      };
      let resolveMaterialize: ((content: JsonContent) => void) | undefined;
      materializeMocks.impl = () =>
        new Promise((resolve) => {
          resolveMaterialize = resolve;
        });

      const destination = makeDestination({
        latestContent: textDoc("typed before restore"),
      });
      const editor = makeEditor({ content: textDoc("typed before restore") });
      const { result } = renderHook(() =>
        usePromptStash(
          hookArgs({
            editorRef: editor.editorRef,
            destination,
          }),
        ),
      );

      await act(async () => {
        const pending = result.current.restore(entry);
        await Promise.resolve();
        destination.setLatestContent(textDoc("typed during blob reads"));
        resolveMaterialize?.(textDoc("restored chunk"));
        await pending;
      });

      expect(destination.getLatestContent()).toEqual({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "typed during blob reads" }],
          },
          { type: "paragraph" },
          {
            type: "paragraph",
            content: [{ type: "text", text: "restored chunk" }],
          },
        ],
      });
      expect(storeMocks.remove).toHaveBeenCalledWith("entry-mutate-during");
      expect(editor.focuses).toHaveLength(1);
    });

    it("uses the latest render's destination for post-materialize import (sync destinationRef)", async () => {
      // After materialize, importAndInsert is invoked through
      // destinationRef.current (freshest adapter), not the generation that
      // started materialize. Owner-2 receives the originally captured identity
      // and must refuse it.
      const entry: PromptStashEntry = {
        id: "entry-dest-swap",
        createdAt: 1,
        content: textDoc("for owner-1 only"),
        blobHashes: [],
      };
      let resolveMaterialize: ((content: JsonContent) => void) | undefined;
      materializeMocks.impl = () =>
        new Promise((resolve) => {
          resolveMaterialize = resolve;
        });

      const owner1 = makeDestination({
        identity: "owner-1",
        latestContent: emptyDoc(),
      });
      const owner2 = makeDestination({
        identity: "owner-2",
        latestContent: textDoc("owner-2 draft"),
      });
      const editor = makeEditor({ content: emptyDoc() });

      const { result, rerender } = renderHook(
        ({ destination }: { destination: MutableDestination }) =>
          usePromptStash(
            hookArgs({
              editorRef: editor.editorRef,
              destination,
            }),
          ),
        { initialProps: { destination: owner1 } },
      );

      let restorePromise: Promise<boolean> | undefined;
      await act(async () => {
        restorePromise = result.current.restore(entry);
        await Promise.resolve();
      });
      expect(owner1.captureIdentity).toHaveBeenCalled();
      expect(owner1.importAndInsert).not.toHaveBeenCalled();

      rerender({ destination: owner2 });

      let ok = true;
      await act(async () => {
        resolveMaterialize?.(textDoc("for owner-1 only"));
        if (restorePromise === undefined) throw new Error("expected restore");
        ok = await restorePromise;
      });

      expect(owner2.importAndInsert).toHaveBeenCalledTimes(1);
      expect(owner2.importAndInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          identity: {
            surface: "test",
            identity: "owner-1",
            editorGeneration: owner1.getEditorGeneration(),
          },
        }),
      );
      expect(owner1.importAndInsert).not.toHaveBeenCalled();
      expect(owner2.getLatestContent()).toEqual(textDoc("owner-2 draft"));
      expect(ok).toBe(false);
      expect(storeMocks.remove).not.toHaveBeenCalled();
    });

    it("importAndInsert sees live identity mutated during destination materialize", async () => {
      // Regression: importAndInsert must re-check against live adapter state
      // after materialize, not a value closed over when restore started.
      // Drive this with a custom destination.materialize that delays, and an
      // importAndInsert that reads `let currentKey` from test scope.
      const entry: PromptStashEntry = {
        id: "entry-live-key",
        createdAt: 1,
        content: textDoc("race me"),
        blobHashes: [],
      };
      let currentKey = "key-a";
      let resolveMaterialize: (() => void) | undefined;
      const editorGeneration = Object.freeze({ generation: "g1" });

      const destination: MutableDestination = makeDestination({
        identity: "key-a",
        editorGeneration,
        latestContent: emptyDoc(),
        materialize: () =>
          new Promise((resolve) => {
            resolveMaterialize = () => {
              resolve({ content: textDoc("race me") });
            };
          }),
        importAndInsert: (args) => {
          // Live read of currentKey (not closed-over at materialize start).
          if (
            args.identity.identity !== currentKey ||
            args.identity.editorGeneration !== editorGeneration
          ) {
            return Promise.resolve({ status: "stale" });
          }
          return Promise.resolve({ status: "accepted" });
        },
      });

      const editor = makeEditor({ content: emptyDoc() });
      const { result } = renderHook(() =>
        usePromptStash(
          hookArgs({
            editorRef: editor.editorRef,
            destination,
          }),
        ),
      );

      let restorePromise: Promise<boolean> | undefined;
      await act(async () => {
        restorePromise = result.current.restore(entry);
        await Promise.resolve();
      });
      expect(resolveMaterialize).toBeTypeOf("function");
      expect(destination.importAndInsert).not.toHaveBeenCalled();

      // Mutate the live key while materialize is in flight.
      currentKey = "key-b";
      destination.setIdentity("key-b");

      let ok = true;
      await act(async () => {
        resolveMaterialize?.();
        if (restorePromise === undefined) throw new Error("expected restore");
        ok = await restorePromise;
      });

      expect(ok).toBe(false);
      expect(destination.importAndInsert).toHaveBeenCalledTimes(1);
      const call = destination.importAndInsert.mock.calls.at(0)?.[0];
      if (call === undefined) {
        throw new Error("expected importAndInsert call");
      }
      expect(call.identity.identity).toBe("key-a");
      expect(call.content).toEqual(textDoc("race me"));
      expect(storeMocks.remove).not.toHaveBeenCalled();
      expect(editor.focuses).toHaveLength(0);
    });

    it("allows two destinations to both insert the same snapshot without corrupting either", async () => {
      const entry: PromptStashEntry = {
        id: "entry-dup-windows",
        createdAt: 1,
        content: textDoc("shared snapshot"),
        blobHashes: [],
      };
      const windowA = makeDestination({
        identity: "window-a",
        latestContent: textDoc("A before"),
      });
      const windowB = makeDestination({
        identity: "window-b",
        latestContent: textDoc("B before"),
      });
      const editorA = makeEditor({ content: textDoc("A before") });
      const editorB = makeEditor({ content: textDoc("B before") });

      const hookA = renderHook(() =>
        usePromptStash(
          hookArgs({
            editorRef: editorA.editorRef,
            destination: windowA,
          }),
        ),
      );
      const hookB = renderHook(() =>
        usePromptStash(
          hookArgs({
            editorRef: editorB.editorRef,
            destination: windowB,
          }),
        ),
      );

      let okA = false;
      let okB = false;
      await act(async () => {
        const [a, b] = await Promise.all([
          hookA.result.current.restore(entry),
          hookB.result.current.restore(entry),
        ]);
        okA = a;
        okB = b;
      });

      // No claims/leases: both may accept and insert independently.
      expect(okA).toBe(true);
      expect(okB).toBe(true);
      expect(windowA.getLatestContent()).toEqual({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "A before" }],
          },
          { type: "paragraph" },
          {
            type: "paragraph",
            content: [{ type: "text", text: "shared snapshot" }],
          },
        ],
      });
      expect(windowB.getLatestContent()).toEqual({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "B before" }],
          },
          { type: "paragraph" },
          {
            type: "paragraph",
            content: [{ type: "text", text: "shared snapshot" }],
          },
        ],
      });
      // Neither destination was overwritten with the other window's content.
      expect(windowA.getLatestContent()).not.toEqual(
        windowB.getLatestContent(),
      );
      expect(storeMocks.remove).toHaveBeenCalled();
    });
  });
});
