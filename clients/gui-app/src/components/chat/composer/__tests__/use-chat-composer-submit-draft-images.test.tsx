import "../../../../../__tests__/test-browser-apis";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";

import { useChatComposerSubmit } from "@/components/chat/composer/use-chat-composer-submit";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import {
  createComposerEditorIncarnation,
  type ComposerEditorIncarnation,
} from "@/lib/composer/composer-editor-incarnation";
import {
  __resetHostHeldImageHashesForTests,
  setHostHeldImageHashes,
} from "@/lib/composer/host-held-image-hashes";
import {
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import { putImage } from "@/lib/composer/landing-image-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
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

// F5's tests need to hold the annotation-image leg open independently of the
// (already-mocked) draft-image resolver, so the flag-flip window has
// somewhere to sit. `getImageBytes` is the IndexedDB fallback leg
// `resolveAnnotationImageAtoms` reads when `sessionImageBytes` misses.
const annotationImageMocks = vi.hoisted(() => ({
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
  realGetImageBytes: null as
    | ((hash: string) => Promise<Uint8Array | undefined>)
    | null,
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  // Defaults to the REAL implementation: `draft-blob-transport.ts`'s own
  // `localBytesForHash` reads through this same binding to seed a confirmed
  // upload, and only the F5 tests below ever need to override it to hold the
  // annotation leg open.
  annotationImageMocks.realGetImageBytes = actual.getImageBytes;
  annotationImageMocks.getImageBytes.mockImplementation(actual.getImageBytes);
  return {
    ...actual,
    getImageBytes: annotationImageMocks.getImageBytes,
  };
});

const HASH_ONLY_IMAGE_HASH = "a".repeat(64);
const HOST_HELD_HASH = "b".repeat(64);
const UNRESOLVABLE_HASH = "c".repeat(64);
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function hashOnlyImageNode(hash: string): JsonContent {
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

function docWithHashOnlyImage(hash: string): JsonContent {
  return {
    type: "doc",
    content: [
      hashOnlyImageNode(hash),
      { type: "paragraph", content: [{ type: "text", text: "x" }] },
    ],
  };
}

function docWithText(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function fakeEditor(
  content: JsonContent,
  incarnation: ComposerEditorIncarnation | null,
): ComposerPromptEditorHandle {
  return {
    isReady: () => true,
    getEditorIncarnation: () => incarnation,
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
  };
}

/** A mutable handle whose document AND `clear()` call count can be observed and, for one test, whose editor incarnation can be swapped mid-flight. */
function mutableFakeEditor(
  initial: JsonContent,
  initialIncarnation: ComposerEditorIncarnation | null,
): {
  readonly handle: ComposerPromptEditorHandle;
  readonly setJSON: (next: JsonContent) => void;
  readonly setIncarnation: (next: ComposerEditorIncarnation | null) => void;
  clearCount: number;
} {
  let content = initial;
  let incarnation = initialIncarnation;
  const state = {
    handle: {
      ...fakeEditor(initial, initialIncarnation),
      getJSON: () => content,
      getEditorIncarnation: () => incarnation,
      clear: () => {
        state.clearCount += 1;
      },
    },
    setJSON: (next: JsonContent) => {
      content = next;
    },
    setIncarnation: (next: ComposerEditorIncarnation | null) => {
      incarnation = next;
    },
    clearCount: 0,
  };
  return state;
}

function mountSubmit(args: {
  readonly taskId: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
  readonly targetHostId?: string | null;
  readonly draftBlobBridgeSupported?: boolean;
}) {
  const toolbarStore = createComposerToolbarStore({
    seedKey: "draft-image-submit",
    values: {
      permission: "supervised",
      selection: { harnessId: "codex", modelSlug: "gpt-5", profileId: null },
      reasoning: "medium",
      serviceTier: "auto",
      identityId: null,
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: null,
  });
  return renderHook(() =>
    useChatComposerSubmit({
      taskId: args.taskId,
      editorRef: { current: args.editor },
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
      onSubmitMessage: args.onSubmitMessage,
      onSideChat: null,
      targetHostId: args.targetHostId ?? null,
      queueEditTargetId: null,
      // T5's gate is off by default in these fixtures: most predate it and
      // assert the inline behaviour, which is what `false` preserves exactly.
      getDraftBlobBridgeSupported: () => args.draftBlobBridgeSupported ?? false,
    }),
  );
}

beforeEach(() => {
  resolveMocks.resolveDraftImageBytes.mockReset();
  resolveMocks.resolveDraftImageBytes.mockResolvedValue(null);
  annotationImageMocks.getImageBytes.mockReset();
  if (annotationImageMocks.realGetImageBytes !== null) {
    annotationImageMocks.getImageBytes.mockImplementation(
      annotationImageMocks.realGetImageBytes,
    );
  }
  __resetHostHeldImageHashesForTests();
  installFreshIndexedDb();
});

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
  resetDraftBlobTransportForTests();
});

describe("useChatComposerSubmit draft images", () => {
  it("takes the synchronous path with no hash-only node: onSubmitMessage runs before any microtask turn", () => {
    const taskId = "chat-sync";
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(docWithText("hello"), null),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // No `act(async ...)`, no `waitFor` - if this needed a microtask turn the
    // assertion below would still see zero calls.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(resolveMocks.resolveDraftImageBytes).not.toHaveBeenCalled();
  });

  it("re-inlines a hash-only node injected into the document", async () => {
    const taskId = "chat-inline";
    resolveMocks.resolveDraftImageBytes.mockImplementation((hash) =>
      hash === HASH_ONLY_IMAGE_HASH
        ? Promise.resolve(IMAGE_BYTES)
        : Promise.resolve(null),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(HASH_ONLY_IMAGE_HASH), null),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.b64content).not.toBeNull();
    expect(atoms[0]?.hash).toBeNull();
  });

  it("leaves an unresolvable hash-only node hash-only, and still sends", async () => {
    const taskId = "chat-unresolvable";
    resolveMocks.resolveDraftImageBytes.mockResolvedValue(null);
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(UNRESOLVABLE_HASH), null),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // Nothing rejects the send client-side; the host's guard is the authority.
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.hash).toBe(UNRESOLVABLE_HASH);
    expect(atoms[0]?.b64content).toBeNull();
  });

  it("sends a host-held hash bare instead of re-inlining it", () => {
    const taskId = "chat-host-held";
    const incarnation = createComposerEditorIncarnation();
    setHostHeldImageHashes(taskId, incarnation, [HOST_HELD_HASH]);
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(HOST_HELD_HASH), incarnation),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // A host-held hash needs no resolution at all: the send is synchronous.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(resolveMocks.resolveDraftImageBytes).not.toHaveBeenCalled();
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms[0]?.hash).toBe(HOST_HELD_HASH);
    expect(atoms[0]?.b64content).toBeNull();
  });

  it("a keystroke during byte resolution is neither dropped nor cleared", async () => {
    const taskId = "chat-keystroke-during-resolve";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(IMAGE_BYTES);
        }),
    );
    const editor = mutableFakeEditor(
      docWithHashOnlyImage(HASH_ONLY_IMAGE_HASH),
      null,
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(editor.clearCount).toBe(0);

    // A keystroke lands while the byte read is in flight: both the text and
    // the (still hash-only, at this point) image move.
    const typedDoc: JsonContent = {
      type: "doc",
      content: [
        hashOnlyImageNode(HASH_ONLY_IMAGE_HASH),
        { type: "paragraph", content: [{ type: "text", text: "typed" }] },
      ],
    };
    act(() => {
      editor.setJSON(typedDoc);
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    const input = submit.mock.calls[0][0];
    expect(input.contentText).toBe("typed");
    const atoms = collectImageAtoms(input.content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.hash).toBeNull();
    expect(typeof atoms[0]?.b64content).toBe("string");
    // Cleared exactly once, and only after the send.
    expect(editor.clearCount).toBe(1);
  });

  // This case used to assert the send was ABANDONED here. It is the same
  // question as "the user typed during the read", asked through the other
  // carrier - the editor incarnation rather than the draft revision - and
  // answering it differently is what left the two guards able to disagree.
  // They are now asked together and both RE-ENTER: the submit re-runs against
  // whatever the live editor holds, which is the only way a user who pressed
  // Enter does not end up with nothing sent and no notice. The property the old
  // assertion was protecting is unchanged and pinned below - the captured
  // document is never what goes out, and nothing is cleared that was not sent.
  it("re-enters against the live editor when the incarnation changes mid-flight", async () => {
    const taskId = "chat-incarnation-change";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(() => {
      // One handoff only; the re-entered pass resolves at once.
      if (release !== null) return Promise.resolve(IMAGE_BYTES);
      return new Promise<Uint8Array | null>((resolve) => {
        release = () => resolve(IMAGE_BYTES);
      });
    });
    const firstIncarnation = createComposerEditorIncarnation();
    const editor = mutableFakeEditor(
      docWithHashOnlyImage(HASH_ONLY_IMAGE_HASH),
      firstIncarnation,
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // The editor was torn down and recreated while bytes were resolving, and
    // the user typed into the new one before the stale read came back.
    const typedAfterRecreate = docWithText("still here");
    act(() => {
      editor.setIncarnation(createComposerEditorIncarnation());
      editor.setJSON(typedAfterRecreate);
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // What went out is what the NEW editor holds, not the captured document -
    // which no longer exists anywhere the user can see.
    expect(submit.mock.calls[0][0].contentText).toBe("still here");
    expect(collectImageAtoms(submit.mock.calls[0][0].content)).toHaveLength(0);
    // Cleared exactly once, and only the document that was sent. Clearing a
    // document you did not send is the failure the guard exists for, and it is
    // untouched by re-entering rather than abandoning.
    expect(editor.clearCount).toBe(1);
    // The composer is not left stuck "preparing" - the `finally` ran.
    expect(result.current.annotationPreparationPending).toBe(false);
  });
});

// ─── T5's send gate, through the real submit hook ─────────────────────────

const GATE_HOST = "host-gate-submit";
const GATE_OWNER = "owner-gate-submit";

// BOTH members, and `requestWithOptions` is the load-bearing one: `drafts.putBlob`
// rides it, never the plain `request`, because it needs an idempotency key and a
// budget the default 30s unary one cannot give a multi-megabyte body. A fake
// carrying only `request` does not just fail to typecheck - the upload throws on
// an undefined member, nothing is ever confirmed, and every gate assertion below
// reads "not host-held" for a reason that has nothing to do with the gate.
const OK_CLIENT: DraftBlobClient = {
  request: ((_method, _params) =>
    Promise.resolve({
      ok: true as const,
    })) as HostRequester<HostRpcRegistry>["request"],
  requestWithOptions: ((_method, _params, _options) =>
    Promise.resolve({
      ok: true as const,
    })) as HostRequester<HostRpcRegistry>["requestWithOptions"],
};

async function seedConfirmedHash(): Promise<string> {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const hash = await putImage(bytes);
  const confirmed = await putDraftBlobs(
    GATE_HOST,
    OK_CLIENT,
    [hash],
    GATE_OWNER,
  );
  expect(confirmed).toEqual([hash]);
  return hash;
}

describe("useChatComposerSubmit draft images - T5 send gate", () => {
  beforeEach(() => {
    useAuthStore.setState({
      contextMetadata: { userId: GATE_OWNER, username: "gate-owner" },
    });
  });

  afterEach(() => {
    useAuthStore.setState({ contextMetadata: null });
  });

  it("flag true + confirmed: the submitted content carries hash and no b64content", async () => {
    const taskId = "chat-gate-confirmed";
    const hash = await seedConfirmedHash();
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(hash), null),
      onSubmitMessage: submit,
      targetHostId: GATE_HOST,
      draftBlobBridgeSupported: true,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // A confirmed, gate-eligible hash needs no resolution: synchronous send.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(resolveMocks.resolveDraftImageBytes).not.toHaveBeenCalled();
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms[0]?.hash).toBe(hash);
    expect(atoms[0]?.b64content).toBeNull();
  });

  it("flag true + UNCONFIRMED: the hash is re-inlined, not sent bare", async () => {
    // The gate being armed is not enough - the memo has to actually claim this
    // digest. Pre-T5 there was no gate at all so everything re-inlined; the
    // failure this guards against is the opposite direction, a gate that fires
    // on the flag alone and sends a bare hash the host was never given bytes
    // for. Deliberately NOT seeded: same host, same owner, same flag as the
    // passing case above, and the ONLY difference is the missing confirmation.
    const taskId = "chat-gate-unconfirmed";
    const hash = await putImage(IMAGE_BYTES);
    resolveMocks.resolveDraftImageBytes.mockImplementation((requested) =>
      requested === hash ? Promise.resolve(IMAGE_BYTES) : Promise.resolve(null),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(hash), null),
      onSubmitMessage: submit,
      targetHostId: GATE_HOST,
      draftBlobBridgeSupported: true,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // Resolution RAN - the positive control. An assertion that the node is
    // inline would also pass if the send had simply not happened.
    expect(resolveMocks.resolveDraftImageBytes).toHaveBeenCalled();
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms[0]?.hash).toBeNull();
    expect(typeof atoms[0]?.b64content).toBe("string");
  });

  it("flag true + confirmed but NO target host: the hash is re-inlined", async () => {
    // The memo is keyed by host, so a surface with no target host has no host
    // to ask - `confirmedDraftBlobHashes` is never consulted and the digest
    // cannot be gate-eligible however well confirmed it is elsewhere.
    const taskId = "chat-gate-no-host";
    const hash = await seedConfirmedHash();
    resolveMocks.resolveDraftImageBytes.mockImplementation((requested) =>
      requested === hash ? Promise.resolve(IMAGE_BYTES) : Promise.resolve(null),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(hash), null),
      onSubmitMessage: submit,
      targetHostId: null,
      draftBlobBridgeSupported: true,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    expect(resolveMocks.resolveDraftImageBytes).toHaveBeenCalled();
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms[0]?.hash).toBeNull();
    expect(typeof atoms[0]?.b64content).toBe("string");
  });

  it("flag false: the same confirmed hash is re-inlined, b64content present", async () => {
    const taskId = "chat-gate-off";
    const hash = await seedConfirmedHash();
    resolveMocks.resolveDraftImageBytes.mockImplementation((requested) =>
      requested === hash ? Promise.resolve(IMAGE_BYTES) : Promise.resolve(null),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(hash), null),
      onSubmitMessage: submit,
      targetHostId: GATE_HOST,
      draftBlobBridgeSupported: false,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms[0]?.hash).toBeNull();
    expect(typeof atoms[0]?.b64content).toBe("string");
  });
});

// ─── F5: live capability at the decision, not at preparation-start ────────

function annotationRecordFor(hash: string): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId: `ann-${hash.slice(0, 6)}`,
    tabId: "t-1",
    sessionId: "s-1",
    origin: "https://example.com",
    pageUrl: "https://example.com/",
    pageTitle: "Example Domain",
    capturedAt: 1_700_000_000_000,
    comment: "note",
    counts: { elements: 1, regions: 0, strokes: 0 },
    elements: [STUB_ANNOTATION_ELEMENT],
    imageFileName: `browser-annotation-ann-${hash.slice(0, 6)}.png`,
    imageHash: `crop-${hash.slice(0, 6)}`,
    droppedElementCount: 0,
  };
}

function mountSubmitRerenderable(initial: {
  readonly taskId: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
  readonly targetHostId: string | null;
  readonly draftBlobBridgeSupported: boolean;
  readonly steerCapable?: boolean;
  readonly steerProtocolSupported?: boolean;
  readonly activeTurnStatus?: ChatActiveTurn["status"] | null;
  readonly getActiveTurnForSteer?: () => ChatActiveTurn | null;
}) {
  const toolbarStore = createComposerToolbarStore({
    seedKey: "draft-image-submit-rerender",
    values: {
      permission: "supervised",
      selection: { harnessId: "codex", modelSlug: "gpt-5", profileId: null },
      reasoning: "medium",
      serviceTier: "auto",
      identityId: null,
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: null,
  });
  const bridgeSource = mutableBridgeSource(initial.draftBlobBridgeSupported);
  const rendered = renderHook(
    (_props: { readonly draftBlobBridgeSupported: boolean }) =>
      useChatComposerSubmit({
        taskId: initial.taskId,
        editorRef: { current: initial.editor },
        pickerStore: createComposerPickerStore(),
        toolbarStore,
        activeTurnStatus: initial.activeTurnStatus ?? null,
        steerCapable: initial.steerCapable ?? false,
        steerEnabled: true,
        steerProtocolSupported: initial.steerProtocolSupported ?? true,
        getActiveTurnForSteer: initial.getActiveTurnForSteer ?? (() => null),
        hasPendingApprovals: false,
        sendDisabled: false,
        workspaceBlocked: false,
        imagesUnsupported: false,
        attachmentPreparationPending: false,
        onSubmitMessage: initial.onSubmitMessage,
        onSideChat: null,
        targetHostId: initial.targetHostId,
        queueEditTargetId: null,
        // A STABLE getter over a mutable source, which is what production
        // supplies: `chat-tile.tsx` builds it with `useCallback(() =>
        // handle.store.getState().draftBlobBridgeSupported, [handle.store])`.
        // Modelling it as a per-render closure over props would recreate the
        // defect R5 fixed one level out - the submit continuation would hold
        // the getter from the render it started in, and read that render's
        // value forever. The point of a store-bound getter is that its
        // identity never changes and its ANSWER does.
        getDraftBlobBridgeSupported: bridgeSource.read,
      }),
    {
      initialProps: {
        draftBlobBridgeSupported: initial.draftBlobBridgeSupported,
      },
    },
  );
  return { ...rendered, bridgeSource };
}

/**
 * Stands in for the chat session store's projection of the bridge capability:
 * one stable reader, a value the test moves underneath it.
 */
function mutableBridgeSource(initial: boolean): {
  readonly read: () => boolean;
  readonly set: (next: boolean) => void;
} {
  let value = initial;
  return {
    read: () => value,
    set: (next: boolean) => {
      value = next;
    },
  };
}

describe("useChatComposerSubmit draft images - F5 live capability", () => {
  beforeEach(() => {
    useAuthStore.setState({
      contextMetadata: { userId: GATE_OWNER, username: "gate-owner" },
    });
  });

  afterEach(() => {
    useAuthStore.setState({ contextMetadata: null });
  });

  it("labels an annotation attachment by what its bytes ARE, not by what the capture path assumed (DRIVE RED)", async () => {
    // A crop is a PNG when the browser view captures it, and it is not one
    // after a stash round trip: the stash canonicalizes a large PNG to WebP and
    // re-points the record at those bytes. The submit hardcoded `image/png`, so
    // WebP bytes travelled labelled PNG - in the atom, in the media type and in
    // any data URL a preview builds from them.
    const taskId = "chat-annotation-mime";
    const hash = await seedConfirmedHash();
    // A minimal RIFF/WEBP container: `RIFF` + size + `WEBP`.
    const webpBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x4c,
    ]);
    annotationImageMocks.getImageBytes.mockResolvedValue(webpBytes);
    resolveMocks.resolveDraftImageBytes.mockResolvedValue(
      new Uint8Array([1, 2, 3, 4]),
    );
    useComposerDraftStore
      .getState()
      .addBrowserAnnotation(taskId, annotationRecordFor(hash));

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmitRerenderable({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(hash), null),
      onSubmitMessage: submit,
      targetHostId: GATE_HOST,
      draftBlobBridgeSupported: false,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    const crop = atoms.find((atom) =>
      atom.fileName.startsWith("browser-annotation-"),
    );
    expect(crop?.mimeType).toBe("image/webp");
  });

  it("(8) a bridge flag flip DURING the annotation/image read is read live at the final decision, not captured at preparation-start", async () => {
    // Pre-fix, `hostHeldFor`'s `bridgeSupported` was frozen wherever it was
    // captured, so a downgrade mid-read went unseen: zero resolver calls, and
    // the hash still travelled bare on a stream that could no longer bridge
    // it. `hostHeldFor` reads `draftBlobBridgeSupportedRef.current` at EVERY
    // call, including the final live re-read `prepareDraftImageInlining` does
    // after this document's own resolution pass finds nothing left to do.
    const taskId = "chat-stale-bridge-submit";
    const hash = await seedConfirmedHash();
    let releaseCrop: (() => void) | null = null;
    annotationImageMocks.getImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCrop = () => resolve(new Uint8Array([9, 9, 9]));
        }),
    );
    resolveMocks.resolveDraftImageBytes.mockImplementation((requested) =>
      requested === hash
        ? Promise.resolve(new Uint8Array([1, 2, 3, 4]))
        : Promise.resolve(null),
    );
    useComposerDraftStore
      .getState()
      .addBrowserAnnotation(taskId, annotationRecordFor(hash));

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result, rerender, bridgeSource } = mountSubmitRerenderable({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(hash), null),
      onSubmitMessage: submit,
      targetHostId: GATE_HOST,
      draftBlobBridgeSupported: true,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    // Held open on the annotation leg - the draft image itself is host-held
    // (confirmed + flag true) and needs no resolution YET.
    expect(resolveMocks.resolveDraftImageBytes).not.toHaveBeenCalled();

    // The flag flips false WHILE the annotation crop read is still in flight.
    // Moved at the SOURCE, the way a chat-stream transition moves the store -
    // the getter's identity is unchanged and its answer is not, which is the
    // whole property a store-bound getter has and a render-prop copy does not.
    // The re-render is kept so the hook also re-commits, proving the
    // continuation reads the new value rather than merely surviving it.
    bridgeSource.set(false);
    rerender({ draftBlobBridgeSupported: false });

    await act(async () => {
      releaseCrop?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // The resolver DID run - the positive control that this is measuring a
    // live re-decision, not a send that simply never happened.
    expect(resolveMocks.resolveDraftImageBytes).toHaveBeenCalled();
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    const draftAtom = atoms.find((atom) => atom.fileName === "screenshot.png");
    expect(draftAtom?.hash).toBeNull();
    expect(typeof draftAtom?.b64content).toBe("string");
  });

  it("(9) the deferred steer-restart confirm re-inlines against the LIVE flag, not the one at dialog-open", async () => {
    const taskId = "chat-stale-bridge-restart";
    const hash = await seedConfirmedHash();
    resolveMocks.resolveDraftImageBytes.mockImplementation((requested) =>
      requested === hash
        ? Promise.resolve(new Uint8Array([1, 2, 3, 4]))
        : Promise.resolve(null),
    );

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result, rerender, bridgeSource } = mountSubmitRerenderable({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(hash), null),
      onSubmitMessage: submit,
      targetHostId: GATE_HOST,
      draftBlobBridgeSupported: true,
      steerCapable: true,
      steerProtocolSupported: true,
      activeTurnStatus: "running",
      getActiveTurnForSteer: () => ({
        agentMode: "regular",
        sameTurnSteeringSupported: true,
        identityId: null,
        turnId: "turn-1",
        status: "running",
        harnessId: "codex",
        model: "a-different-model",
        profileId: null,
        userMessageId: null,
        startedAt: 0,
        updatedAt: 0,
        reasoningEffort: null,
        serviceTier: null,
      }),
    });

    // A confirmed, host-held hash sends synchronously as bare - but
    // `mod-enter` against a drifted running turn stages a restart confirm
    // instead of dispatching.
    act(() => {
      result.current.submitDraft("mod-enter");
    });
    expect(result.current.steerConflict.open).toBe(true);
    expect(submit).not.toHaveBeenCalled();

    // The flag goes false WHILE the dialog sits open.
    // Moved at the source, as in (8): the getter is stable and store-bound,
    // so a flip is a change of ANSWER, not of identity.
    bridgeSource.set(false);
    rerender({ draftBlobBridgeSupported: false });

    await act(async () => {
      result.current.steerConflict.onRestart();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms[0]?.hash).toBeNull();
    expect(typeof atoms[0]?.b64content).toBe("string");
    // Attachments are DERIVED from the content, so the re-inline has to
    // rebuild them too. Left as staged they still name a hash this document
    // no longer carries, and the optimistic pending message keeps them for
    // its gallery - which then shows an unavailable image beside the very
    // bytes that were just put back.
    const images = submit.mock.calls[0][0].attachments.filter(
      (attachment) => attachment.kind === "image",
    );
    expect(images.length).toBe(1);
    expect(images[0]?.hash).toBeNull();
    expect(images[0]?.dataUrl).toContain("base64,");
  });
});

// ─── Polish: `/btw` re-inlines a memo-confirmed hash before forking ───────

describe("useChatComposerSubmit draft images - /btw re-inlines before forking", () => {
  beforeEach(() => {
    useAuthStore.setState({
      contextMetadata: { userId: GATE_OWNER, username: "gate-owner" },
    });
  });

  afterEach(() => {
    useAuthStore.setState({ contextMetadata: null });
  });

  it("a memo-confirmed hash still reaches onSideChat INLINE, never bare - every create travels inline", async () => {
    // The ordinary send gate would happily leave this hash bare (it is
    // host-confirmed, and the flag is on) - `/btw` deliberately does not
    // consult that gate at all, because a fork is a CREATE and there is no
    // negotiated session on the new chat yet to have confirmed anything.
    const taskId = "chat-btw-inline";
    const hash = await seedConfirmedHash();
    resolveMocks.resolveDraftImageBytes.mockImplementation((requested) =>
      requested === hash
        ? Promise.resolve(new Uint8Array([1, 2, 3, 4]))
        : Promise.resolve(null),
    );
    const doc: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "/btw look at this" }],
        },
        {
          type: "imageAttachment",
          attrs: {
            id: "img-1",
            fileName: "screenshot.png",
            mimeType: "image/png",
            size: 128,
            hash,
          },
        },
      ],
    };
    const onSideChat = vi.fn(
      (_input: { readonly content: JsonContent; readonly settings: unknown }) =>
        true,
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const toolbarStore = createComposerToolbarStore({
      seedKey: "btw-inline-submit",
      values: {
        permission: "supervised",
        selection: { harnessId: "codex", modelSlug: "gpt-5", profileId: null },
        reasoning: "medium",
        serviceTier: "auto",
        identityId: null,
      },
      onSettingsChange: null,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: null,
    });
    const { result } = renderHook(() =>
      useChatComposerSubmit({
        taskId,
        editorRef: { current: fakeEditor(doc, null) },
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
        onSubmitMessage: submit,
        onSideChat,
        targetHostId: GATE_HOST,
        queueEditTargetId: null,
        getDraftBlobBridgeSupported: () => true,
      }),
    );

    act(() => {
      result.current.submitDraft("enter");
    });

    await waitFor(() => {
      expect(onSideChat).toHaveBeenCalledTimes(1);
    });
    expect(submit).not.toHaveBeenCalled();
    const atoms = collectImageAtoms(onSideChat.mock.calls[0][0].content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.hash).toBeNull();
    expect(typeof atoms[0]?.b64content).toBe("string");
  });
});
