import "../../../../__tests__/test-browser-apis";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  useComposerHashFirstPaste,
  type ComposerHashFirstEditorHandle,
} from "@/hooks/composer/use-composer-hash-first-paste";
import type { ImageAttachmentRewrite } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { jpegBytesOfSize } from "@/lib/composer/__tests__/prompt-stash-image-fixtures";

// In-memory stand-in for idb-keyval - the storage backend only, matching the
// established pattern in landing-image-gc.test.ts / composer-image-store.test.ts.
const idbData = vi.hoisted(() => new Map<string, unknown>());

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
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn() }),
}));

const NODE_ID = "browser-tab-preview-node-1";
const JPEG_BYTES = jpegBytesOfSize(64);

function browserTabPreviewDoc(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: NODE_ID,
              fileName: "host-a-tab.jpg",
              mimeType: "image/jpeg",
              size: null,
              // The cross-host browser-tab preview node stamps this false -
              // nothing has classified the bytes yet, per
              // fetchBrowserTabPreviewImage's doc comment.
              byHashEligible: false,
              b64content: bytesToBase64(JPEG_BYTES),
            },
          },
        ],
      },
    ],
  };
}

interface RecordingEditor {
  readonly handle: ComposerHashFirstEditorHandle;
  readonly rewrites: ImageAttachmentRewrite[];
  readonly removedIds: string[];
}

function recordingEditor(content: JsonContent): RecordingEditor {
  const rewrites: ImageAttachmentRewrite[] = [];
  const removedIds: string[] = [];
  const handle: ComposerHashFirstEditorHandle = {
    isReady: () => true,
    insertImageAttachments: () => undefined,
    beginPathInsertion: () => null,
    focus: () => undefined,
    getJSON: () => content,
    removeImageAttachmentById: (id) => {
      removedIds.push(id);
    },
    rewriteImageAttachmentHashById: (_id, rewrite) => {
      rewrites.push(rewrite);
      return true;
    },
  };
  return { handle, rewrites, removedIds };
}

const NOOP_FILE_DROPS: IFileDropHost = {
  resolveDroppedFilePaths: () => Promise.resolve([]),
  copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
  readNativeClipboardFilePaths: () => Promise.resolve([]),
};

beforeEach(() => {
  idbData.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useComposerHashFirstPaste: notePossiblePendingImages catch-all sweep", () => {
  it("hashes a pending b64 node inserted by a route the paste hook did not itself insert", async () => {
    const content = browserTabPreviewDoc();
    const editor = recordingEditor(content);
    const editorRef = { current: editor.handle };

    const { result } = renderHook(() =>
      useComposerHashFirstPaste({
        editorRef,
        budgetOwnerId: "chat-1",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: [],
      }),
    );

    act(() => {
      result.current.notePossiblePendingImages(content);
    });

    await waitFor(() => {
      expect(editor.rewrites).toHaveLength(1);
    });
    expect(editor.removedIds).toHaveLength(0);
    expect(typeof editor.rewrites[0]?.hash).toBe("string");
    expect(editor.rewrites[0]?.hash.length).toBeGreaterThan(0);
  });

  it("is idempotent: the same node id present again does not start a second ingest job", async () => {
    const content = browserTabPreviewDoc();
    const editor = recordingEditor(content);
    const editorRef = { current: editor.handle };

    const { result } = renderHook(() =>
      useComposerHashFirstPaste({
        editorRef,
        budgetOwnerId: "chat-1",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: [],
      }),
    );

    // Two calls back-to-back in the SAME tick, before the first job's async
    // preparation/hash/store settles: the first claims the node id in
    // `inFlightIds`, so the second must see it already owned and skip.
    act(() => {
      result.current.notePossiblePendingImages(content);
      result.current.notePossiblePendingImages(content);
    });

    await waitFor(() => {
      expect(editor.rewrites).toHaveLength(1);
    });
    // No duplicate rewrite / job ever landed for the same node.
    expect(editor.rewrites).toHaveLength(1);
  });
});
