import "../../../../__tests__/test-browser-apis";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerHashFirstPaste } from "@/hooks/composer/use-composer-hash-first-paste";
import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type {
  PastedComposerImage,
  PastedComposerImageOutcome,
} from "@/components/chat/composer/editor/extensions/chat-paste-handler";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { jpegBytesOfSize } from "@/lib/composer/__tests__/prompt-stash-image-fixtures";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { documentAwareEditor } from "@/hooks/composer/__tests__/hash-first-paste-test-editor";

const putImageMocks = vi.hoisted(() => ({
  callCount: 0,
  gate: null as Promise<void> | null,
  release: null as (() => void) | null,
}));

vi.mock("@/lib/composer/composer-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/composer/composer-image-store")
    >();
  return {
    ...actual,
    putImage: vi.fn(async (_bytes: Uint8Array) => {
      putImageMocks.callCount += 1;
      if (putImageMocks.callCount === 1 && putImageMocks.gate !== null) {
        await putImageMocks.gate;
      }
      return "fake-hash-remount-1";
    }),
  };
});

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn() }),
}));

const NODE_ID = "pending-node-remount-1";
const JPEG_BYTES = jpegBytesOfSize(64);

const PENDING_IMAGE: ImageAttachmentAttrs = {
  id: NODE_ID,
  fileName: "shot.jpg",
  mimeType: "image/jpeg",
  size: null,
  byHashEligible: false,
  b64content: bytesToBase64(JPEG_BYTES),
};

const NOOP_FILE_DROPS: IFileDropHost = {
  resolveDroppedFilePaths: () => Promise.resolve([]),
  copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
  readNativeClipboardFilePaths: () => Promise.resolve([]),
};

beforeEach(() => {
  putImageMocks.callCount = 0;
  putImageMocks.gate = null;
  putImageMocks.release = null;
});

function gatePutImage(): void {
  let release: (() => void) | null = null;
  putImageMocks.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  putImageMocks.release = release;
}

afterEach(() => {
  vi.restoreAllMocks();
  useComposerDraftStore.setState({ drafts: {} });
});

describe("useComposerHashFirstPaste: remount mid-ingest", () => {
  it("re-runs a background job still in flight at unmount, on the remounted composer's re-entry sweep", async () => {
    const firstEditor = documentAwareEditor([PENDING_IMAGE]);
    const firstEditorRef = { current: firstEditor.handle };

    gatePutImage();
    const first = renderHook(() =>
      useComposerHashFirstPaste({
        editorRef: firstEditorRef,
        budgetOwnerId: "chat-1",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: [],
      }),
    );

    act(() => {
      first.result.current.notePossiblePendingImages(firstEditor.getJSON());
    });
    await waitFor(() => {
      expect(putImageMocks.callCount).toBe(1);
    });

    // The job is parked inside the gated putImage - it has not rewritten
    // the node yet.
    expect(firstEditor.rewrites).toHaveLength(0);
    expect(firstEditor.imageNode(NODE_ID)?.b64content).not.toBeNull();

    // The composer/hook unmounts (navigate away, tab closed) WHILE the job
    // is still in flight. `useComposerPasteEvents`'s cleanup effect aborts
    // every tracked job's controller.
    first.unmount();

    // Release the gate: the aborted job's `putImage` resolves, bytes land
    // in the store, but the abort check short-circuits before any rewrite -
    // exactly the "editor unmounted mid-ingest" branch documented in
    // `runPendingImageIngest`. The pending b64 node in `firstEditor` is
    // therefore untouched.
    putImageMocks.release?.();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(firstEditor.rewrites).toHaveLength(0);

    // Remount: a fresh hook instance (its own empty `inFlightIds`) over a
    // SECOND editor seeded with the same still-pending node (mirroring the
    // first editor's untouched document, since `firstEditor.rewrites` is
    // still empty). The re-entry sweep must pick the node back up rather
    // than leaving it stripped from every persist forever.
    const secondEditor = documentAwareEditor([PENDING_IMAGE]);
    const secondEditorRef = { current: secondEditor.handle };
    const second = renderHook(() =>
      useComposerHashFirstPaste({
        editorRef: secondEditorRef,
        budgetOwnerId: "chat-1",
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: [],
      }),
    );

    act(() => {
      second.result.current.reingestPendingImages();
    });

    await waitFor(() => {
      expect(secondEditor.rewrites).toHaveLength(1);
    });
    expect(secondEditor.rewrites[0]?.hash).toBe("fake-hash-remount-1");
    expect(secondEditor.removedIds).toHaveLength(0);
    // Two distinct putImage calls total: the aborted first attempt and the
    // remount's re-entry - `putImage`'s own content-addressed dedupe (not
    // under test here, since it is mocked) is what makes a real second call
    // a no-op write in production.
    expect(putImageMocks.callCount).toBe(2);

    // The document-aware editor's own `rewriteImageAttachmentHashById`
    // returns `false` for an id it has no node for, so this passing means
    // the rewrite actually landed on the SAME node, not merely that some
    // rewrite happened.
    const rewrittenNode = secondEditor.imageNode(NODE_ID);
    expect(rewrittenNode?.hash).toBe("fake-hash-remount-1");
    expect(rewrittenNode?.b64content).toBeNull();
  });
});

describe("useComposerHashFirstPaste: first paste into a previously null/empty draft", () => {
  it("ingests a pasted image with no crash, and the document ends up hash-only, when the composer draft store has no entry yet", async () => {
    const chatId = "chat-never-typed-into";
    // Model "the draft was previously null": no entry in the store at all
    // (readComposerDraftSnapshot falls back to EMPTY_COMPOSER_DRAFT for this
    // id), not merely an empty document.
    expect(useComposerDraftStore.getState().drafts[chatId]).toBeUndefined();

    const editor = documentAwareEditor([]);
    const editorRef = { current: editor.handle };

    const { result } = renderHook(() =>
      useComposerHashFirstPaste({
        editorRef,
        budgetOwnerId: chatId,
        disabled: false,
        fileDrops: NOOP_FILE_DROPS,
        mentionRoots: [],
      }),
    );

    const pasted: PastedComposerImage = {
      fileName: "first-paste.jpg",
      mimeType: "image/jpeg",
      b64content: bytesToBase64(JPEG_BYTES),
    };

    let outcomes: ReadonlyArray<PastedComposerImageOutcome> = [];
    expect(() => {
      act(() => {
        outcomes = result.current.ingestPastedComposerImages([pasted]);
        // Mirrors what the real paste handler does in the same tick: it
        // inserts the pending b64 node under the id `ingestPastedComposerImages`
        // just minted, synchronously and before the background job's first
        // `await` can run, so the node exists by the time the job's rewrite
        // fires.
        for (const outcome of outcomes) {
          if (outcome.kind !== "accepted") continue;
          editor.handle.insertImageAttachments([
            {
              id: outcome.id,
              fileName: pasted.fileName,
              mimeType: pasted.mimeType,
              b64content: pasted.b64content,
              size: null,
              byHashEligible: false,
            },
          ]);
        }
      });
    }).not.toThrow();

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    if (outcome === undefined || outcome.kind !== "accepted") {
      throw new Error("expected the pasted image to be accepted");
    }

    await waitFor(() => {
      expect(editor.rewrites).toHaveLength(1);
    });
    // Not merely "some rewrite happened": the document-aware editor's
    // `rewriteImageAttachmentHashById` returns `false` for an id it holds no
    // node for, so a passing lookup by THIS id proves the job rewrote the
    // node the test actually inserted.
    const node = editor.imageNode(outcome.id);
    expect(node?.hash).toBe("fake-hash-remount-1");
    expect(node?.b64content).toBeNull();
    expect(node?.fileName).toBe("first-paste.jpg");
    expect(node?.mimeType).toBe("image/jpeg");
    // The document must carry whatever the rewrite itself reported for
    // `byHashEligible` - jsdom has no canvas/image decoding, so preparation
    // takes the unmodelable-format fallback here rather than the raster
    // success path a real browser would take for this JPEG; the point of
    // this assertion is that the two values are wired together, not which
    // one preparation happened to choose in this environment.
    expect(node?.byHashEligible).toBe(editor.rewrites[0]?.byHashEligible);
  });
});
