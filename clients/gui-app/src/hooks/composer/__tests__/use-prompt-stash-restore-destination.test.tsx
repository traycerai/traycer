/** usePromptStash restore/destination lifecycle */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { toast } from "sonner";

import { usePromptStash } from "@/hooks/composer/use-prompt-stash";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  PromptStashCorruptBlobError,
  PromptStashMissingBlobError,
} from "@/lib/composer/prompt-stash-repository";
import type { PromptStashEntry } from "@/lib/composer/prompt-stash-codec";
import { resetActivePromptStashForTests } from "@/lib/commands/active-prompt-stash-registry";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";
import {
  bytesOf,
  emptyDoc,
  hookArgs,
  imageDoc,
  makeDestination,
  makeEditor,
  makeSource,
  sha256Hex,
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

describe("usePromptStash restore/destination lifecycle", () => {
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

  it("restores only after materialize succeeds, then deletes the stash copy", async () => {
    // Default path: hook materializes (via mocked materializePromptStashEntry
    // so this suite stays free of Ticket 5's real IndexedDB), then passes
    // content/selection to importAndInsert.
    const imageBytes = bytesOf([4, 5, 6]);
    const hash = await sha256Hex(imageBytes);
    const materializedContent = imageDoc({
      id: "fresh-restored-id",
      fileName: "shot.png",
      hash: null,
      b64content: bytesToBase64(imageBytes),
      mimeType: "image/png",
      size: 3,
    });
    materializeMocks.impl = () => Promise.resolve(materializedContent);

    const entry: PromptStashEntry = {
      id: "entry-restore",
      createdAt: 9,
      content: imageDoc({
        id: "stashed-id",
        fileName: "shot.png",
        hash,
        b64content: null,
        mimeType: "image/png",
        size: 3,
      }),
      blobHashes: [hash],
    };

    const editor = makeEditor({ content: emptyDoc() });
    const destination = makeDestination({
      latestContent: emptyDoc(),
      identity: "dest-restore",
    });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source: makeSource({ content: emptyDoc() }),
          destination,
        }),
      ),
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.restore(entry);
    });
    expect(ok).toBe(true);
    expect(destination.importAndInsert).toHaveBeenCalledTimes(1);
    const call = destination.importAndInsert.mock.calls.at(0)?.[0];
    if (call === undefined) {
      throw new Error("expected an importAndInsert call");
    }
    expect(call.identity).toEqual({
      surface: "test",
      identity: "dest-restore",
      editorIncarnation: destination.getEditorIncarnation(),
    });
    expect(call.content).toEqual(materializedContent);
    expect(storeMocks.remove).toHaveBeenCalledWith("entry-restore");
    expect(editor.focuses).toHaveLength(1);
  });
  it("does not mutate the destination or delete the entry when materialize fails", async () => {
    materializeMocks.impl = () =>
      Promise.reject(new PromptStashMissingBlobError());
    const entry: PromptStashEntry = {
      id: "entry-missing-bytes",
      createdAt: 1,
      content: imageDoc({
        id: "img",
        fileName: "x.png",
        hash: "missing",
        b64content: null,
        mimeType: "image/png",
        size: 1,
      }),
      blobHashes: ["missing"],
    };

    const editor = makeEditor({ content: textDoc("destination draft") });
    const destination = makeDestination({
      latestContent: textDoc("destination draft"),
    });
    usePromptStashStore.setState({
      rows: [{ kind: "entry", entry }],
    });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source: makeSource({ content: textDoc("destination draft") }),
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
    expect(storeMocks.markUnavailable).toHaveBeenCalledWith(
      "entry-missing-bytes",
    );
    // The mock store's setState is not a reactive zustand store; assert the
    // client-only flag side effect via the action spy (and the store field it
    // mutates) rather than a re-render of result.current.rows.
    expect(usePromptStashStore.getState().rows.at(0)?.kind).toBe("unavailable");
    expect(toast.error).toHaveBeenCalledWith("Could not restore this prompt", {
      description:
        "An attached image could not be read. The stash was kept intact.",
    });
    expect(destination.getLatestContent()).toEqual(
      textDoc("destination draft"),
    );
  });
  it("marks corrupt blob restore failures unavailable with distinct copy", async () => {
    materializeMocks.impl = () =>
      Promise.reject(new PromptStashCorruptBlobError());
    const entry: PromptStashEntry = {
      id: "entry-corrupt",
      createdAt: 2,
      content: textDoc("damaged image entry"),
      blobHashes: ["bad"],
    };
    usePromptStashStore.setState({
      rows: [{ kind: "entry", entry }],
    });
    const editor = makeEditor({ content: emptyDoc() });
    const destination = makeDestination({ latestContent: emptyDoc() });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source: makeSource({ content: emptyDoc() }),
          destination,
        }),
      ),
    );

    await act(async () => {
      await result.current.restore(entry);
    });
    expect(storeMocks.markUnavailable).toHaveBeenCalledWith("entry-corrupt");
    expect(toast.error).toHaveBeenCalledWith("Could not restore this prompt", {
      description: "An attached image is damaged. The stash was kept intact.",
    });
  });
  it("keeps the stash when destination materialization fails", async () => {
    const entry: PromptStashEntry = {
      id: "entry-dest-failed",
      createdAt: 1,
      content: textDoc("ok bytes"),
      blobHashes: [],
    };
    usePromptStashStore.setState({
      rows: [{ kind: "entry", entry }],
    });
    const editor = makeEditor({ content: emptyDoc() });
    const destination = makeDestination({
      latestContent: emptyDoc(),
      materialize: () => Promise.resolve(null),
    });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source: makeSource({ content: emptyDoc() }),
          destination,
        }),
      ),
    );

    await act(async () => {
      await result.current.restore(entry);
    });
    expect(storeMocks.markUnavailable).not.toHaveBeenCalled();
    expect(storeMocks.remove).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Could not restore this prompt", {
      description:
        "The destination could not accept the prompt. The stash was kept intact.",
    });
  });
  it("releases materialize reservation when importAndInsert throws", async () => {
    // Regression: release must run in finally even if importAndInsert rejects,
    // otherwise landing's measured-budget reservation leaks for the session.
    const release = vi.fn();
    const entry: PromptStashEntry = {
      id: "entry-release-on-throw",
      createdAt: 1,
      content: textDoc("will throw on insert"),
      blobHashes: [],
    };
    const editor = makeEditor({ content: emptyDoc() });
    const destination = makeDestination({
      latestContent: emptyDoc(),
      materialize: () =>
        Promise.resolve({
          content: textDoc("will throw on insert"),
          release,
        }),
      importAndInsert: () =>
        Promise.reject(new Error("destination insert crashed")),
    });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source: makeSource({ content: emptyDoc() }),
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
    expect(toast.error).toHaveBeenCalledWith("Could not restore this prompt", {
      description:
        "The stash was kept intact. Try again after storage recovers.",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("releases materialize reservation exactly once on accepted import", async () => {
    const release = vi.fn();
    const entry: PromptStashEntry = {
      id: "entry-release-on-accept",
      createdAt: 1,
      content: textDoc("accepted"),
      blobHashes: [],
    };
    const editor = makeEditor({ content: emptyDoc() });
    const destination = makeDestination({
      latestContent: emptyDoc(),
      materialize: () =>
        Promise.resolve({
          content: textDoc("accepted"),
          release,
        }),
    });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source: makeSource({ content: emptyDoc() }),
          destination,
        }),
      ),
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.restore(entry);
    });

    expect(ok).toBe(true);
    expect(storeMocks.remove).toHaveBeenCalledWith("entry-release-on-accept");
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("warns but still reports success when consume fails after accepted insert", async () => {
    const entry: PromptStashEntry = {
      id: "entry-delete-fail",
      createdAt: 1,
      content: textDoc("restored text"),
      blobHashes: [],
    };
    storeMocks.remove.mockRejectedValueOnce(new Error("delete failed"));
    const editor = makeEditor({ content: emptyDoc() });
    const destination = makeDestination({ latestContent: emptyDoc() });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source: makeSource({ content: emptyDoc() }),
          destination,
        }),
      ),
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.restore(entry);
    });
    expect(ok).toBe(true);
    expect(destination.importAndInsert).toHaveBeenCalled();
    // Inserted content remains; stash row is still visible (consume failed).
    expect(destination.getLatestContent()).toEqual(textDoc("restored text"));
    expect(toast.warning).toHaveBeenCalledWith(
      "Prompt restored, but the stash copy remains",
      {
        description: "You can delete the duplicate after storage recovers.",
      },
    );
    expect(storeMocks.remove).toHaveBeenCalledWith("entry-delete-fail");
  });

  it("appends into a non-empty destination and places the caret at the end", async () => {
    const entry: PromptStashEntry = {
      id: "entry-append",
      createdAt: 1,
      content: textDoc("stashed"),
      blobHashes: [],
    };
    const editor = makeEditor({ content: textDoc("already here") });
    const destination = makeDestination({
      latestContent: textDoc("already here"),
    });
    const { result } = renderHook(() =>
      usePromptStash(
        hookArgs({
          editorRef: editor.editorRef,
          source: makeSource({ content: textDoc("already here") }),
          destination,
        }),
      ),
    );

    await act(async () => {
      await result.current.restore(entry);
    });
    // Destination appends against its latest content and never restores the
    // transient selection captured with the stash.
    expect(destination.getLatestContent()).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "already here" }],
        },
        { type: "paragraph" },
        {
          type: "paragraph",
          content: [{ type: "text", text: "stashed" }],
        },
      ],
    });
  });
});
