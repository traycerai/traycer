/**
 * F4 (batch-1 review, P2): an image added DURING resolution could be sent
 * without ever trying to resolve its bytes. The hash list is captured once,
 * before the await; if hash A is resolving and a new hash-only image B
 * appears in the live document, the final re-read included B but the byte
 * map did not, so B was sent bare even though this client could resolve it.
 * The fix, `prepareDraftImageInlining`, reconciles the live document's
 * required hashes against the attempted set before the send. (Its
 * synchronous-commit contract - R2 of the re-review - is tested directly in
 * `draft-image-inlining.test.ts`; the annotation-ordering half is the R2(a)
 * block at the bottom of this file.)
 */
import "../../../../../__tests__/test-browser-apis";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { useChatComposerSubmit } from "@/components/chat/composer/use-chat-composer-submit";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { __resetHostHeldImageHashesForTests } from "@/lib/composer/host-held-image-hashes";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import { STUB_ANNOTATION_ELEMENT } from "@/lib/browser-view/annotation/__tests__/browser-annotation-fixtures";

const resolveMocks = vi.hoisted(() => ({
  resolveDraftImageBytes: vi.fn<
    (hash: string, target: unknown) => Promise<Uint8Array | null>
  >(() => Promise.resolve(null)),
}));

vi.mock("@/lib/drafts/resolve-draft-image-bytes", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/drafts/resolve-draft-image-bytes")
    >();
  return {
    ...actual,
    resolveDraftImageBytes: resolveMocks.resolveDraftImageBytes,
  };
});

const imageStoreMocks = vi.hoisted(() => ({
  sessionImageBytes: vi.fn<(hash: string) => Uint8Array | null>(() => null),
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return {
    ...actual,
    sessionImageBytes: imageStoreMocks.sessionImageBytes,
    getImageBytes: imageStoreMocks.getImageBytes,
  };
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const BYTES_A = new Uint8Array([1, 2, 3, 4]);
const BYTES_B = new Uint8Array([5, 6, 7, 8]);

function imageNode(hash: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id: `img-${hash.slice(0, 6)}`,
      fileName: "screenshot.png",
      mimeType: "image/png",
      size: 128,
      hash,
    },
  };
}

function docWith(...nodes: JsonContent[]): JsonContent {
  return {
    type: "doc",
    content: [
      ...nodes,
      { type: "paragraph", content: [{ type: "text", text: "x" }] },
    ],
  };
}

function mutableFakeEditor(initial: JsonContent): {
  readonly handle: ComposerPromptEditorHandle;
  readonly setJSON: (next: JsonContent) => void;
} {
  let content = initial;
  return {
    handle: {
      isReady: () => true,
      getEditorIncarnation: () => null,
      hasFocus: () => false,
      focus: () => undefined,
      focusAtEnd: () => undefined,
      getJSON: () => content,
      isEmpty: () => false,
      clear: () => undefined,
      setContent: () => undefined,
      syncContent: () => undefined,
      insertImageAttachments: () => undefined,
      insertMentionAttachment: () => false,
      beginPathInsertion: () => null,
      removeImageAttachmentById: () => undefined,
      rewriteImageAttachmentHashById: () => false,
      insertDictatedText: () => undefined,
      dismissActiveSuggestion: () => false,
    },
    setJSON: (next: JsonContent) => {
      content = next;
    },
  };
}

function mountSubmit(
  taskId: string,
  editor: ComposerPromptEditorHandle,
  onSubmitMessage: (input: ChatComposerSubmitInput) => boolean,
) {
  const toolbarStore = createComposerToolbarStore({
    seedKey: "reconcile-submit",
    values: {
      permission: "supervised",
      selection: { harnessId: "codex", modelSlug: "gpt-5", profileId: null },
      reasoning: "medium",
      serviceTier: "auto",
    },
    onSettingsChange: null,
    tuiOnly: false,
    hostId: null,
  });
  return renderHook(() =>
    useChatComposerSubmit({
      taskId,
      editorRef: { current: editor },
      pickerStore: createComposerPickerStore(),
      toolbarStore,
      activeTurnStatus: null,
      steerCapable: false,
      steerEnabled: true,
      steerProtocolSupported: true,
      getActiveTurnForSteer: () => null,
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
      imagesUnsupported: false,
      attachmentPreparationPending: false,
      onSubmitMessage,
      onSideChat: null,
      targetHostId: null,
      queueEditTargetId: null,
      // T5's gate is off in these fixtures: they predate it and assert the
      // inline behaviour, which is what `false` preserves exactly.
      getDraftBlobBridgeSupported: () => false,
    }),
  );
}

const ANNOTATION_ID = "ann-r2a";
const ANNOTATION_IMAGE_HASH = "hash-ann-r2a";
const CROP_BYTES = new Uint8Array([9, 9, 9]);

function annotationRecord(): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId: ANNOTATION_ID,
    tabId: "t-1",
    sessionId: "s-1",
    origin: "https://example.com",
    pageUrl: "https://example.com/",
    pageTitle: "Example Domain",
    capturedAt: 1_700_000_000_000,
    comment: "Make this hero section pop more",
    counts: { elements: 1, regions: 0, strokes: 0 },
    elements: [STUB_ANNOTATION_ELEMENT],
    imageFileName: `browser-annotation-${ANNOTATION_ID}.png`,
    imageHash: ANNOTATION_IMAGE_HASH,
    droppedElementCount: 0,
  };
}

beforeEach(() => {
  resolveMocks.resolveDraftImageBytes.mockReset();
  __resetHostHeldImageHashesForTests();
  imageStoreMocks.sessionImageBytes.mockReset();
  imageStoreMocks.sessionImageBytes.mockReturnValue(null);
  imageStoreMocks.getImageBytes.mockReset();
  imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
});

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
});

describe("F4: reconciled resolution (chat composer)", () => {
  it("asks the resolver for an image added DURING resolution, and inlines it too", async () => {
    const taskId = "chat-reconcile";
    let releaseA: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation((hash) => {
      if (hash === HASH_A) {
        return new Promise((resolve) => {
          releaseA = () => resolve(BYTES_A);
        });
      }
      if (hash === HASH_B) return Promise.resolve(BYTES_B);
      return Promise.resolve(null);
    });
    const editor = mutableFakeEditor(docWith(imageNode(HASH_A)));
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit(taskId, editor.handle, submit);

    act(() => {
      result.current.submitDraft("enter");
    });

    // B appears in the live document WHILE A is still resolving - the
    // hash list was captured before this happened.
    act(() => {
      editor.setJSON(docWith(imageNode(HASH_A), imageNode(HASH_B)));
    });

    await act(async () => {
      releaseA?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    // The failure mode this guards against: B sent bare because it was
    // never asked for at all.
    expect(resolveMocks.resolveDraftImageBytes).toHaveBeenCalledWith(
      HASH_B,
      expect.anything(),
    );
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms).toHaveLength(2);
    for (const atom of atoms) {
      expect(atom.hash).toBeNull();
      expect(typeof atom.b64content).toBe("string");
    }
  });
});

/**
 * R2(a) (re-review): the annotation leg used to run BESIDE the image leg in a
 * `Promise.all`, so the image leg could finish resolving A while the
 * annotation crop read was still pending - and an image added during that
 * remaining wait was never asked for. The fix awaits the annotation read
 * FIRST, entirely, before `prepareDraftImageInlining` ever starts, so there is
 * no window where the image leg has already stopped looking while something
 * else is still in flight.
 */
describe("R2(a): the image reconcile must not run BESIDE a still-pending annotation read", () => {
  it("asks for a hash-only image added while the annotation crop is still resolving", async () => {
    const taskId = "chat-r2a-annotation-ordering";
    useComposerDraftStore
      .getState()
      .addBrowserAnnotation(taskId, annotationRecord());
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    let releaseCrop: (() => void) | null = null;
    imageStoreMocks.getImageBytes.mockImplementation((hash) => {
      if (hash === ANNOTATION_IMAGE_HASH) {
        return new Promise((resolve) => {
          releaseCrop = () => resolve(CROP_BYTES);
        });
      }
      return Promise.resolve(undefined);
    });
    resolveMocks.resolveDraftImageBytes.mockImplementation((hash) => {
      if (hash === HASH_A) return Promise.resolve(BYTES_A);
      if (hash === HASH_B) return Promise.resolve(BYTES_B);
      return Promise.resolve(null);
    });
    const editor = mutableFakeEditor(docWith(imageNode(HASH_A)));
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit(taskId, editor.handle, submit);

    act(() => {
      result.current.submitDraft("enter");
    });

    // THE ORDERING CHECKPOINT, and the whole point of this test.
    //
    // Flush every microtask that is currently queued while the crop is still
    // pending. Under the OLD parallel `Promise.all` shape the image leg would
    // have run here and finished with A - and would then never look again, so
    // the B inserted below reached the send unattempted. Under the fixed
    // ordering no image read has started at all yet, because the annotation
    // read is awaited first.
    //
    // Without this assertion the test passes on BOTH implementations: inserting
    // B in a second synchronous `act` puts it in place before the old leg's
    // first reconciliation check, so the old code would have asked for it too.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resolveMocks.resolveDraftImageBytes).not.toHaveBeenCalled();

    // NOW B appears - after the point where a parallel image leg would already
    // have settled, and while the crop is still pending.
    act(() => {
      editor.setJSON(docWith(imageNode(HASH_A), imageNode(HASH_B)));
    });

    await act(async () => {
      releaseCrop?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    expect(resolveMocks.resolveDraftImageBytes).toHaveBeenCalledWith(
      HASH_B,
      expect.anything(),
    );
    const input = submit.mock.calls[0][0];
    // The annotation's own crop atom rode along too.
    expect(input.attachments).toContainEqual(
      expect.objectContaining({
        kind: "image",
        name: `browser-annotation-${ANNOTATION_ID}.png`,
      }),
    );
    // A, B and the annotation's own crop atom.
    const atoms = collectImageAtoms(input.content);
    expect(atoms).toHaveLength(3);
    // A and B went through the hash-only rewrite, which drops `hash`.
    const reinlined = atoms.filter((atom) => atom.hash === null);
    expect(reinlined).toHaveLength(2);
    for (const atom of reinlined) {
      expect(typeof atom.b64content).toBe("string");
    }
    // The annotation crop atom keeps its own hash alongside its bytes -
    // `appendImageAttachmentAtoms`'s shape, untouched by the rewrite.
    const cropAtom = atoms.find((atom) => atom.hash === ANNOTATION_IMAGE_HASH);
    expect(cropAtom).toBeDefined();
    expect(typeof cropAtom?.b64content).toBe("string");
  });
});
