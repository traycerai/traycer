/**
 * T5 follow-ups (three P1/P2 findings in `use-chat-composer-submit.ts`, all
 * introduced by the PREVIOUS round's own fixes):
 *
 * R3 - the `/btw` re-inline used to run as a DETACHED submit phase, after the
 * prepared-draft commit: `reinlineRefusedSendContent(...).then(...)` froze the
 * document, left `annotationPreparationPending` false during the wait, and
 * then cleared the LIVE editor - so text typed during that read was sent to
 * nobody and wiped. The fix moves the decision PRE-FLIGHT: `sideChatPreflight`
 * converts the editor document the same way the commit does, and when it reads
 * as a side chat, every hash-only node joins the ordinary required set and is
 * resolved by the existing preparation loop. A hash surviving to the commit
 * means the user typed `/btw` DURING preparation - that case abandons (no
 * send, no clear) rather than forwarding a bare hash into a create.
 *
 * R4 - cancelling the steer-conflict dialog did not cancel its continuation:
 * `live !== staged` guarded only the state UPDATER, so `restartStagedConflict`
 * ran unconditionally and a cancelled/superseded dialog still sent the old
 * prompt and cleared a replacement draft. The fix gates the dispatch itself on
 * `conflictStagedRef` (read OUTSIDE any state updater), re-checks the submit
 * intent, and makes `conflictInliningFlight` single-owner.
 *
 * R5 - the capability getter could trail the store if it were captured as a
 * ref refreshed in an effect (the last committed EFFECT, not the store). The
 * fix is a GETTER argument bound directly to the session store
 * (`getDraftBlobBridgeSupported`), read live at every decision.
 */
import "../../../../../__tests__/test-browser-apis";
import { useEffect } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";

import { useChatComposerSubmit } from "@/components/chat/composer/use-chat-composer-submit";
import type {
  ChatComposerSideChatInput,
  ChatComposerSubmitResult,
} from "@/components/chat/composer/use-chat-composer-submit";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import {
  __resetHostHeldImageHashesForTests,
  setHostHeldImageHashes,
} from "@/lib/composer/host-held-image-hashes";
import {
  markDraftBlobUnbridgeable,
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import { putImage } from "@/lib/composer/landing-image-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { HostRpcRegistry } from "@/lib/host";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import { STUB_ANNOTATION_ELEMENT } from "@/lib/browser-view/annotation/__tests__/browser-annotation-fixtures";

const resolveMocks = vi.hoisted(() => ({
  resolveDraftImageBytes: vi.fn<
    (hash: string, target: unknown) => Promise<Uint8Array | null>
  >(() => Promise.resolve(null)),
}));

const sonnerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    info: sonnerMocks.info,
    error: sonnerMocks.error,
    success: sonnerMocks.success,
  },
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
  annotationImageMocks.realGetImageBytes = actual.getImageBytes;
  annotationImageMocks.getImageBytes.mockImplementation(actual.getImageBytes);
  return {
    ...actual,
    getImageBytes: annotationImageMocks.getImageBytes,
  };
});

const HASH_A = "a".repeat(64);
const GATE_HOST = "host-t5-followups";
const GATE_OWNER = "owner-t5-followups";

const OK_CLIENT: DraftBlobClient = {
  request: ((_method, _params) =>
    Promise.resolve({
      ok: true as const,
    })) as HostRequester<HostRpcRegistry>["request"],
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

function paragraph(text: string): JsonContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function docWithText(text: string): JsonContent {
  return { type: "doc", content: [paragraph(text)] };
}

function docWith(...nodes: JsonContent[]): JsonContent {
  return { type: "doc", content: [...nodes] };
}

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

/** A mutable handle whose document AND `clear()` call count can be observed. */
function mutableFakeEditor(initial: JsonContent): {
  readonly handle: ComposerPromptEditorHandle;
  readonly setJSON: (next: JsonContent) => void;
  clearCount: number;
} {
  let content = initial;
  const state = {
    handle: {
      isReady: () => true,
      getEditorIncarnation: () => null,
      hasFocus: () => false,
      focus: () => undefined,
      focusAtEnd: () => undefined,
      getJSON: () => content,
      isEmpty: () => false,
      clear: () => {
        state.clearCount += 1;
      },
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
    clearCount: 0,
  };
  return state;
}

function makeToolbarStore(seedKey: string) {
  return createComposerToolbarStore({
    seedKey,
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
}

interface MountArgs {
  readonly taskId: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
  readonly onSideChat?: ((input: ChatComposerSideChatInput) => boolean) | null;
  readonly targetHostId?: string | null;
  readonly getDraftBlobBridgeSupported?: () => boolean;
  readonly steerCapable?: boolean;
  readonly steerProtocolSupported?: boolean;
  readonly activeTurnStatus?: ChatActiveTurn["status"] | null;
  readonly getActiveTurnForSteer?: () => ChatActiveTurn | null;
  readonly queueEditTargetId?: string | null;
}

function mountSubmit(args: MountArgs) {
  const toolbarStore = makeToolbarStore(`t5-followups-${args.taskId}`);
  return renderHook(() =>
    useChatComposerSubmit({
      taskId: args.taskId,
      editorRef: { current: args.editor },
      pickerStore: createComposerPickerStore(),
      toolbarStore,
      activeTurnStatus: args.activeTurnStatus ?? null,
      steerCapable: args.steerCapable ?? false,
      steerEnabled: true,
      steerProtocolSupported: args.steerProtocolSupported ?? true,
      getActiveTurnForSteer: args.getActiveTurnForSteer ?? (() => null),
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
      imagesUnsupported: false,
      attachmentPreparationPending: false,
      draftReadOnly: false,
      onSubmitMessage: args.onSubmitMessage,
      onSideChat: args.onSideChat ?? null,
      targetHostId: args.targetHostId ?? null,
      queueEditTargetId: args.queueEditTargetId ?? null,
      getDraftBlobBridgeSupported:
        args.getDraftBlobBridgeSupported ?? (() => false),
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
  // An owner, file-wide: `submitHostHeldImageHashes` answers "nothing is
  // confirmed" for a null owner, so without this a memo-confirmed fixture is
  // silently treated as unconfirmed and every eligibility test measures the
  // wrong thing.
  useAuthStore.setState({
    contextMetadata: { userId: GATE_OWNER, username: "gate-owner" },
  });
});

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
  resetDraftBlobTransportForTests();
});

// ─── R3 (1): the /btw pre-flight decision ─────────────────────────────────

describe("R3 (1): /btw pre-flight is resolved in the SAME preparation window as an ordinary send", () => {
  it("keeps annotationPreparationPending true for the whole wait, sends onSideChat the INLINE content, and never silently drops a keystroke typed during the read", async () => {
    const taskId = "chat-r3-1-btw-inline-typing";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation((hash) =>
      hash === HASH_A
        ? new Promise((resolve) => {
            release = () => resolve(new Uint8Array([1, 2, 3, 4]));
          })
        : Promise.resolve(null),
    );
    const editor = mutableFakeEditor(
      docWith(paragraph("/btw check this"), hashOnlyImageNode(HASH_A)),
    );
    const onSideChat = vi.fn(
      (_input: ChatComposerSideChatInput): boolean => true,
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
      onSideChat,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    // The sharp assertion against the pre-fix behaviour: the detached
    // `.then()` re-inline left this flag false throughout its own wait,
    // because it ran AFTER the prepared-draft commit had already cleared the
    // flight. Pre-flight resolution runs inside the SAME preparation window
    // as an ordinary hash-only send, so it must be true here.
    expect(result.current.annotationPreparationPending).toBe(true);
    expect(onSideChat).not.toHaveBeenCalled();

    // A keystroke lands while the byte read is in flight - it must reach
    // whichever recipient the send goes to, never be silently dropped.
    act(() => {
      editor.setJSON(
        docWith(paragraph("/btw check this more"), hashOnlyImageNode(HASH_A)),
      );
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onSideChat).toHaveBeenCalledTimes(1);
    });
    expect(result.current.annotationPreparationPending).toBe(false);
    expect(submit).not.toHaveBeenCalled();

    const input = onSideChat.mock.calls[0][0];
    const text = input.content.content
      ?.flatMap((block) => block.content ?? [])
      .map((inline) => inline.text ?? "")
      .join("");
    expect(text).toBe("check this more");
    const atoms = collectImageAtoms(input.content);
    expect(atoms).toHaveLength(1);
    // Inline, not bare: the pre-flight required set forced its resolution.
    expect(atoms[0]?.hash).toBeNull();
    expect(typeof atoms[0]?.b64content).toBe("string");
    // Sent, not silently wiped: exactly one clear, and only because the send
    // went through.
    expect(editor.clearCount).toBe(1);
  });
});

// ─── R3 (2): the pre-flight/commit disagreement abandons ──────────────────

describe("R3 (2): a document that becomes a side chat DURING preparation abandons rather than forwarding a bare hash", () => {
  it("sends nothing and does not clear the editor when /btw is typed mid-read", async () => {
    const taskId = "chat-r3-2-race";
    // Host-held (inherited), so this hash needs no resolution and stays bare
    // through the ordinary send path regardless of side-chat status - the
    // pre-flight computed against the ORIGINAL (non-side-chat) document sees
    // it that way too, which is exactly what makes the race possible.
    setHostHeldImageHashes(taskId, null, [HASH_A]);
    useComposerDraftStore
      .getState()
      .addBrowserAnnotation(taskId, annotationRecordFor(HASH_A));
    let releaseCrop: (() => void) | null = null;
    annotationImageMocks.getImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCrop = () => resolve(new Uint8Array([9, 9, 9]));
        }),
    );
    const editor = mutableFakeEditor(
      docWith(paragraph("check this"), hashOnlyImageNode(HASH_A)),
    );
    const onSideChat = vi.fn(
      (_input: ChatComposerSideChatInput): boolean => true,
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
      onSideChat,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(result.current.annotationPreparationPending).toBe(true);

    // The user types `/btw` DURING the annotation read - the document is now
    // a side chat, but the pre-flight required set was computed against the
    // ORIGINAL document, which read as an ordinary send.
    act(() => {
      editor.setJSON(
        docWith(paragraph("/btw check this"), hashOnlyImageNode(HASH_A)),
      );
    });

    await act(async () => {
      releaseCrop?.();
      await Promise.resolve();
    });

    // Neither recipient gets it, and the flight is released so a retry works.
    expect(onSideChat).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(editor.clearCount).toBe(0);
    await waitFor(() => {
      expect(result.current.annotationPreparationPending).toBe(false);
    });
  });
});

// ─── R4: cancelling a steer conflict must cancel its continuation too ─────

function driftedTurn(): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: true,
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
  };
}

function mountSteerConflict(args: {
  readonly taskId: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
  /**
   * A stable reader over a value the test moves, mirroring production's
   * store-bound getter. Defaults to permanently false for the conflicts that
   * only need "capability is off".
   */
  readonly bridgeSupported?: () => boolean;
}) {
  return mountSubmit({
    taskId: args.taskId,
    editor: args.editor,
    onSubmitMessage: args.onSubmitMessage,
    targetHostId: GATE_HOST,
    getDraftBlobBridgeSupported: args.bridgeSupported ?? (() => false),
    steerCapable: true,
    steerProtocolSupported: true,
    activeTurnStatus: "running",
    getActiveTurnForSteer: driftedTurn,
  });
}

function openSteerConflict(result: {
  current: ChatComposerSubmitResult;
}): void {
  act(() => {
    result.current.submitDraft("mod-enter");
  });
  expect(result.current.steerConflict.open).toBe(true);
}

interface SteerConflictLiveBlockProps {
  readonly workspaceBlocked: boolean;
}

/**
 * The same steer-conflict shape as `mountSteerConflict`, but with
 * `workspaceBlocked` as a RERENDERABLE prop rather than a value fixed at
 * mount. RR3 needs the block to become true mid-flight, after the dialog is
 * already open and its re-inline read is already outstanding - a fixed
 * `mountSubmit` closure can never observe that, since `submitBlocked` (and
 * the ref `onRestart`'s continuation reads) is rebuilt only when the HOOK
 * itself re-renders with a new prop.
 */
function mountSteerConflictLiveBlock(args: {
  readonly taskId: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
  readonly bridgeSupported?: () => boolean;
}) {
  const toolbarStore = makeToolbarStore(`t5-rr3-${args.taskId}`);
  return renderHook(
    (props: SteerConflictLiveBlockProps) =>
      useChatComposerSubmit({
        taskId: args.taskId,
        editorRef: { current: args.editor },
        pickerStore: createComposerPickerStore(),
        toolbarStore,
        activeTurnStatus: "running",
        steerCapable: true,
        steerEnabled: true,
        steerProtocolSupported: true,
        getActiveTurnForSteer: driftedTurn,
        hasPendingApprovals: false,
        sendDisabled: false,
        workspaceBlocked: props.workspaceBlocked,
        imagesUnsupported: false,
        attachmentPreparationPending: false,
        draftReadOnly: false,
        onSubmitMessage: args.onSubmitMessage,
        onSideChat: null,
        targetHostId: GATE_HOST,
        queueEditTargetId: null,
        getDraftBlobBridgeSupported: args.bridgeSupported ?? (() => false),
      }),
    { initialProps: { workspaceBlocked: false } },
  );
}

describe("R4 (3, drive-red): cancelling the steer dialog cancels its re-inline continuation", () => {
  it("sends nothing and leaves a post-cancel replacement draft in the editor", async () => {
    const taskId = "chat-r4-3-cancel-during-read";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(new Uint8Array([1, 2, 3, 4]));
        }),
    );
    // MEMO-CONFIRMED, not inherited, and the distinction is load-bearing
    // since RR4. The conflict has to be staged with the hash bare (so
    // `onRestart` has a re-inline to cancel), AND that hash has to become
    // ineligible when the capability drops. An INHERITED host-held hash never
    // becomes ineligible - it is already an epic attachment, so re-inlining it
    // would put megabytes back on a wire that has carried a 64-character hash
    // since message editing existed. `onRestart` now asks
    // `submitHostHeldImageHashes` the whole eligibility question rather than
    // just the capability boolean, so an inherited hash correctly skips the
    // read entirely and this test would have nothing to cancel.
    const confirmedHash = await seedConfirmedHash();
    // Capability TRUE while the conflict is staged, so the confirmed hash is
    // eligible and the dialog holds it BARE; then false before the confirm, so
    // it becomes ineligible and `onRestart` has a re-inline to cancel. That
    // sequence is the RR4 scenario itself - the earlier fixture used a
    // permanently-false flag with an inherited hash, which no longer enters
    // the branch at all now that eligibility is asked as a whole question.
    let bridgeSupported = true;
    const editor = mutableFakeEditor(
      docWith(paragraph("hello"), hashOnlyImageNode(confirmedHash)),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSteerConflict({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
      bridgeSupported: () => bridgeSupported,
    });

    openSteerConflict(result);
    expect(submit).not.toHaveBeenCalled();

    bridgeSupported = false;
    act(() => {
      result.current.steerConflict.onRestart();
    });
    // Cancel WHILE the reinline read is outstanding. `act` flushes the
    // resulting state update AND the effect that mirrors it into
    // `conflictStagedRef` synchronously, so the continuation's live check
    // sees the cancellation.
    act(() => {
      result.current.steerConflict.onOpenChange(false);
    });
    expect(result.current.steerConflict.open).toBe(false);

    const replacement = docWithText("a replacement draft typed after cancel");
    act(() => {
      editor.setJSON(replacement);
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    expect(submit).not.toHaveBeenCalled();
    expect(editor.clearCount).toBe(0);
    expect(editor.handle.getJSON()).toEqual(replacement);
  });
});

describe("R4 (4): repeated confirmation is single-flighted", () => {
  it("starts exactly one read and sends exactly once", async () => {
    const taskId = "chat-r4-4-double-confirm";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(new Uint8Array([1, 2, 3, 4]));
        }),
    );
    setHostHeldImageHashes(taskId, null, [HASH_A]);
    const editor = mutableFakeEditor(
      docWith(paragraph("hello"), hashOnlyImageNode(HASH_A)),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSteerConflict({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
    });

    openSteerConflict(result);

    act(() => {
      result.current.steerConflict.onRestart();
      result.current.steerConflict.onRestart();
    });
    expect(resolveMocks.resolveDraftImageBytes).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    expect(resolveMocks.resolveDraftImageBytes).toHaveBeenCalledTimes(1);
  });
});

describe("R4 (5): the submit intent is re-checked after the read", () => {
  it("abandons the send when the document is REPLACED (resetEpoch bump) while the read is outstanding", async () => {
    const taskId = "chat-r4-5-intent-bump";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(new Uint8Array([1, 2, 3, 4]));
        }),
    );
    // Same memo-confirmed + capability-drop shape as R4 (3): an inherited
    // host-held hash never becomes ineligible, so it would not enter the
    // re-inline branch this test needs to interrupt.
    const confirmedHash = await seedConfirmedHash();
    let bridgeSupported = true;
    const editor = mutableFakeEditor(
      docWith(paragraph("hello"), hashOnlyImageNode(confirmedHash)),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSteerConflict({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
      bridgeSupported: () => bridgeSupported,
    });

    openSteerConflict(result);

    bridgeSupported = false;
    act(() => {
      result.current.steerConflict.onRestart();
    });
    // A document REPLACEMENT (not a keystroke) bumps `resetEpoch` - the same
    // distinction F1's queue-edit-intent suite exercises for the ordinary
    // submit path.
    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, docWithText("unrelated replacement"), null);
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    expect(submit).not.toHaveBeenCalled();
    expect(editor.clearCount).toBe(0);
  });
});

// ─── R5: the capability getter is read live, never cached ─────────────────

const useBridgeStore = create<{ readonly draftBlobBridgeSupported: boolean }>(
  () => ({ draftBlobBridgeSupported: true }),
);

/** Real React root (RTL's `render`, not `renderHook`) around the hook, with a
 * real Zustand `useStore`-style subscription forcing an ordinary React
 * re-render whenever the store changes - so the probe below is agnostic to
 * whether React ever gets a chance to re-render before the decision is made. */
function Harness(props: {
  readonly taskId: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
  readonly targetHostId: string | null;
  readonly steerCapable?: boolean;
  readonly activeTurnStatus?: ChatActiveTurn["status"] | null;
  readonly getActiveTurnForSteer?: () => ChatActiveTurn | null;
  readonly onReady: (api: ChatComposerSubmitResult) => void;
}) {
  // Real subscription: a store change re-renders this component through
  // ordinary React state, exactly like a live composer tile.
  useBridgeStore((state) => state.draftBlobBridgeSupported);
  const toolbarStore = makeToolbarStore(`t5-r5-${props.taskId}`);
  const api = useChatComposerSubmit({
    taskId: props.taskId,
    editorRef: { current: props.editor },
    pickerStore: createComposerPickerStore(),
    toolbarStore,
    activeTurnStatus: props.activeTurnStatus ?? null,
    steerCapable: props.steerCapable ?? false,
    steerEnabled: true,
    steerProtocolSupported: true,
    getActiveTurnForSteer: props.getActiveTurnForSteer ?? (() => null),
    hasPendingApprovals: false,
    sendDisabled: false,
    workspaceBlocked: false,
    imagesUnsupported: false,
    attachmentPreparationPending: false,
    draftReadOnly: false,
    onSubmitMessage: props.onSubmitMessage,
    onSideChat: null,
    targetHostId: props.targetHostId,
    queueEditTargetId: null,
    // The production shape (`chat-tile.tsx`): a STABLE getter bound directly
    // to the store, never to a value captured from this render.
    getDraftBlobBridgeSupported: () =>
      useBridgeStore.getState().draftBlobBridgeSupported,
  });
  // In an effect, not during render. Calling a prop callback while rendering is
  // a render-phase side effect, which react-doctor flags as an error and which
  // a concurrent render can run more than once per commit. No dependency array:
  // `api`'s identity changes every render and every render is exactly when this
  // harness wants to republish it, which is what the render-phase call did.
  useEffect(() => {
    props.onReady(api);
  });
  return null;
}

describe("R5 (6, drive-red): the bridge capability is read live at the decision, not cached across a scheduling gap", () => {
  beforeEach(() => {
    useAuthStore.setState({
      contextMetadata: { userId: GATE_OWNER, username: "gate-owner" },
    });
    useBridgeStore.setState({ draftBlobBridgeSupported: true });
  });

  afterEach(() => {
    useAuthStore.setState({ contextMetadata: null });
  });

  it("re-inlines a confirmed hash whose bridge capability drops WHILE the preceding annotation read is outstanding", async () => {
    // Real-scheduling probe, not an `act`-driven rerender: the store move is
    // queued onto the microtask queue from INSIDE the annotation crop
    // resolver's own resolution, landing between that leg's await and the
    // image leg's live re-read - the same gap `prepareDraftImageInlining`'s
    // module doc calls out as "no await in between" on the PRODUCTION side.
    // Pre-fix, a ref refreshed only in a `useEffect` could still be holding
    // the value from BEFORE this gap, because nothing forces React to flush
    // that effect inside this microtask turn - see the drive-red note below.
    const taskId = "chat-r5-6-scheduling-probe";
    const hash = await seedConfirmedHash();
    let releaseCrop: (() => void) | null = null;
    annotationImageMocks.getImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCrop = () => {
            queueMicrotask(() => {
              useBridgeStore.setState({ draftBlobBridgeSupported: false });
            });
            resolve(new Uint8Array([9, 9, 9]));
          };
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
    let api: ChatComposerSubmitResult | null = null;
    render(
      <Harness
        taskId={taskId}
        editor={{
          isReady: () => true,
          getEditorIncarnation: () => null,
          hasFocus: () => false,
          focus: () => undefined,
          focusAtEnd: () => undefined,
          getJSON: () => docWith(hashOnlyImageNode(hash), paragraph("x")),
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
        }}
        onSubmitMessage={submit}
        targetHostId={GATE_HOST}
        onReady={(next) => {
          api = next;
        }}
      />,
    );
    const submitApi = (): ChatComposerSubmitResult => {
      if (api === null) throw new Error("Harness did not mount");
      return api;
    };

    act(() => {
      submitApi().submitDraft("enter");
    });
    // Confirmed + bridge true at the start: nothing to resolve yet, held open
    // on the annotation leg only.
    expect(resolveMocks.resolveDraftImageBytes).not.toHaveBeenCalled();

    // ## What this test does NOT establish, and why
    //
    // It asserts the fix's mechanism. It does not catch the regression: put
    // the pre-fix shape back - a `useRef` seeded from the getter and refreshed
    // in a dependency-free `useEffect`, read by `hostHeldFor` - and this test
    // stays GREEN. Two independent attempts to invert it failed:
    //
    //  1. With the harness subscribed to the flipped slice (the faithful
    //     shape, since the pre-fix composer took the capability as a prop and
    //     re-rendered on it), React re-renders and settles the passive effect
    //     inside this microtask window, so the ref is current by the time the
    //     continuation reads it.
    //  2. Running the release with `IS_REACT_ACT_ENVIRONMENT` off and outside
    //     `act` - to leave the passive effect pending, which is the real gap -
    //     changes nothing.
    //
    // `chat-timeline.test.tsx` documents the same property for a different
    // finding: in this React version jsdom settles `useLayoutEffect` AND
    // `useEffect` synchronously, "including with `IS_REACT_ACT_ENVIRONMENT`
    // disabled and with `flushSync`". Removing the harness's subscription does
    // turn it red, but that is a weaker setup - "nothing ever re-renders"
    // rather than "a render is scheduled and its effect has not run yet".
    //
    // What makes the production fix correct is not this test: the getter reads
    // `store.getState()`, so its answer cannot depend on whether any render or
    // effect has happened. There is no longer a ref or an effect to be stale.
    // A reviewer's check for a regression here is the SHAPE - a ref or a
    // render-prop copy reappearing - not this assertion going red.
    await act(async () => {
      releaseCrop?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // The resolver DID run - the positive control that this measures a live
    // re-decision, not a send that simply never happened.
    expect(resolveMocks.resolveDraftImageBytes).toHaveBeenCalled();
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    const draftAtom = atoms.find((atom) => atom.fileName === "screenshot.png");
    expect(draftAtom?.hash).toBeNull();
    expect(typeof draftAtom?.b64content).toBe("string");
  });
});

describe("R5 (7): the deferred steer confirm reads the same live getter", () => {
  beforeEach(() => {
    useAuthStore.setState({
      contextMetadata: { userId: GATE_OWNER, username: "gate-owner" },
    });
    useBridgeStore.setState({ draftBlobBridgeSupported: true });
  });

  afterEach(() => {
    useAuthStore.setState({ contextMetadata: null });
  });

  it("re-inlines against the flag as of the confirm, not as of when the dialog opened", async () => {
    const taskId = "chat-r5-7-deferred-confirm";
    const hash = await seedConfirmedHash();
    resolveMocks.resolveDraftImageBytes.mockImplementation((requested) =>
      requested === hash
        ? Promise.resolve(new Uint8Array([1, 2, 3, 4]))
        : Promise.resolve(null),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    let api: ChatComposerSubmitResult | null = null;
    render(
      <Harness
        taskId={taskId}
        editor={{
          isReady: () => true,
          getEditorIncarnation: () => null,
          hasFocus: () => false,
          focus: () => undefined,
          focusAtEnd: () => undefined,
          getJSON: () => docWith(hashOnlyImageNode(hash), paragraph("x")),
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
        }}
        onSubmitMessage={submit}
        targetHostId={GATE_HOST}
        steerCapable
        activeTurnStatus="running"
        getActiveTurnForSteer={driftedTurn}
        onReady={(next) => {
          api = next;
        }}
      />,
    );
    const submitApi = (): ChatComposerSubmitResult => {
      if (api === null) throw new Error("Harness did not mount");
      return api;
    };

    // A confirmed, host-held hash against a drifted running turn stages a
    // restart confirm rather than dispatching.
    act(() => {
      submitApi().submitDraft("mod-enter");
    });
    expect(submitApi().steerConflict.open).toBe(true);
    expect(submit).not.toHaveBeenCalled();

    // The flag goes false WHILE the dialog sits open - a real store write,
    // not a prop rerender.
    act(() => {
      useBridgeStore.setState({ draftBlobBridgeSupported: false });
    });

    await act(async () => {
      submitApi().steerConflict.onRestart();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms[0]?.hash).toBeNull();
    expect(typeof atoms[0]?.b64content).toBe("string");
  });
});

// ─── RR3: the deferred steer confirm reads the LIVE blocking guards ───────

describe("RR3: onRestart's re-inline continuation reads submitBlocked LIVE, not as of the render that staged the dialog", () => {
  it("sends nothing when the workspace becomes blocked WHILE the re-inline read is outstanding", async () => {
    const taskId = "chat-rr3-workspace-blocked-mid-read";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(new Uint8Array([1, 2, 3, 4]));
        }),
    );
    // Memo-confirmed + capability-drop shape, same as R4 (3): an inherited
    // host-held hash never becomes ineligible, so it would not enter the
    // re-inline branch this test needs to interrupt.
    const confirmedHash = await seedConfirmedHash();
    let bridgeSupported = true;
    const editor = mutableFakeEditor(
      docWith(paragraph("hello"), hashOnlyImageNode(confirmedHash)),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result, rerender } = mountSteerConflictLiveBlock({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
      bridgeSupported: () => bridgeSupported,
    });

    openSteerConflict(result);
    expect(submit).not.toHaveBeenCalled();

    bridgeSupported = false;
    act(() => {
      result.current.steerConflict.onRestart();
    });

    // The workspace becomes blocked WHILE the re-inline read is outstanding -
    // a real hook re-render with a new `workspaceBlocked` prop, not a value
    // `restartStagedConflict`'s stale closure could ever see.
    rerender({ workspaceBlocked: true });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    // Pre-fix, `restartStagedConflict` closed over the `submitBlocked` of the
    // render that STAGED the dialog - a workspace that became blocked during
    // the byte read was invisible to it, so the old prompt went out and the
    // dialog was dismissed as if it had succeeded.
    expect(submit).not.toHaveBeenCalled();
    expect(editor.clearCount).toBe(0);
    // The dialog is dismissed rather than left open on a send nobody can
    // complete: `onRestart`'s continuation calls `setPendingConflict(null)`
    // when the live guard is blocking.
    expect(result.current.steerConflict.open).toBe(false);
  });

  it("positive control: the same shape sends when nothing becomes blocked", async () => {
    const taskId = "chat-rr3-control-unblocked";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(new Uint8Array([1, 2, 3, 4]));
        }),
    );
    const confirmedHash = await seedConfirmedHash();
    let bridgeSupported = true;
    const editor = mutableFakeEditor(
      docWith(paragraph("hello"), hashOnlyImageNode(confirmedHash)),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSteerConflictLiveBlock({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
      bridgeSupported: () => bridgeSupported,
    });

    openSteerConflict(result);
    bridgeSupported = false;
    act(() => {
      result.current.steerConflict.onRestart();
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    expect(editor.clearCount).toBe(1);
  });
});

// ─── RR4: onRestart re-checks the WHOLE eligibility question, not just the
//          capability boolean ─────────────────────────────────────────────

describe("RR4: a confirmation invalidated WHILE the dialog is open is caught even with the bridge capability still true", () => {
  it("re-inlines and dispatches inline content when the hash is marked unbridgeable mid-dialog", async () => {
    const taskId = "chat-rr4-marked-unbridgeable-mid-dialog";
    resolveMocks.resolveDraftImageBytes.mockImplementation((requested) =>
      requested === HASH_A
        ? Promise.resolve(new Uint8Array([1, 2, 3, 4]))
        : Promise.resolve(null),
    );
    const confirmedHash = await seedConfirmedHash();
    // The capability stays TRUE for the whole test - pre-fix, `onRestart`
    // asked only `!getDraftBlobBridgeSupported()`, which is false here, so it
    // never re-inlined and the stale hash went out bare.
    const editor = mutableFakeEditor(
      docWith(paragraph("hello"), hashOnlyImageNode(confirmedHash)),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSteerConflict({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
      bridgeSupported: () => true,
    });

    openSteerConflict(result);
    expect(submit).not.toHaveBeenCalled();

    // Invalidates the memo directly - a refusal on a DIFFERENT send (or a
    // mirror close/rebootstrap) can mark this exact digest unbridgeable while
    // this dialog sits open, with the capability flag untouched.
    markDraftBlobUnbridgeable(GATE_HOST, confirmedHash);
    resolveMocks.resolveDraftImageBytes.mockImplementation((requested) =>
      requested === confirmedHash
        ? Promise.resolve(new Uint8Array([5, 6, 7, 8]))
        : Promise.resolve(null),
    );

    await act(async () => {
      result.current.steerConflict.onRestart();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    // Inline, not bare: `submitHostHeldImageHashes` correctly excluded the
    // now-unbridgeable hash from "still held", forcing the re-inline this
    // test exists to prove happens even with the capability boolean true.
    expect(atoms[0]?.hash).toBeNull();
    expect(typeof atoms[0]?.b64content).toBe("string");
  });
});

// ─── RR6: the /btw bare-hash guard distinguishes a mid-read command from a
//          pre-flight that asked and every leg missed ────────────────────

describe("RR6: a pre-existing /btw whose image resolves NOWHERE keeps the draft and says so", () => {
  it("abandons with a notice rather than forwarding a bare hash into a unary create", async () => {
    const taskId = "chat-rr6-preexisting-btw-unresolved";
    // Every leg misses - the pre-flight DID ask, and nothing ever answers.
    resolveMocks.resolveDraftImageBytes.mockResolvedValue(null);
    const editor = mutableFakeEditor(
      docWith(paragraph("/btw check this"), hashOnlyImageNode(HASH_A)),
    );
    const onSideChat = vi.fn(
      (_input: ChatComposerSideChatInput): boolean => true,
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
      onSideChat,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    await waitFor(() => {
      expect(result.current.annotationPreparationPending).toBe(false);
    });

    // RR6 originally made this SEND, reasoning that an unresolved hash is the
    // host's dangling-hash guard to rule on - true of an ordinary send, and
    // false here. `startSideChat` is a unary `epic.createChat` with no
    // `chat.subscribe` session behind it: no negotiated bridge, no
    // `MISSING_ATTACHMENT_BYTES` to retry from, and `markFailedByAction`
    // makes the handoff terminal with nothing restoring the content to a
    // composer that has already been cleared. The prompt was simply lost.
    //
    // What RR6 was protecting is still protected, and it is the reason this
    // is not a plain revert: the old PRE-RR6 behaviour was a silent no-op
    // (two Enters, two reads, zero sends, zero toasts, a permanently dead
    // button). The abandonment is now ANNOUNCED, so the user knows the image
    // is the problem and can remove it.
    await waitFor(() => {
      expect(sonnerMocks.info).toHaveBeenCalledWith(
        "An image in this side question could not be loaded.",
        expect.objectContaining({
          description:
            "The draft has been kept - try removing and re-attaching it.",
        }),
      );
    });
    expect(onSideChat).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    // And nothing was cleared: the prompt and its image are still there.
    expect(editor.clearCount).toBe(0);
  });

  it("control: a /btw typed DURING the read still abandons rather than forwarding a bare hash (see also R3 (2))", async () => {
    const taskId = "chat-rr6-control-mid-read-btw";
    setHostHeldImageHashes(taskId, null, [HASH_A]);
    useComposerDraftStore
      .getState()
      .addBrowserAnnotation(taskId, annotationRecordFor(HASH_A));
    let releaseCrop: (() => void) | null = null;
    annotationImageMocks.getImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCrop = () => resolve(new Uint8Array([9, 9, 9]));
        }),
    );
    const editor = mutableFakeEditor(
      docWith(paragraph("check this"), hashOnlyImageNode(HASH_A)),
    );
    const onSideChat = vi.fn(
      (_input: ChatComposerSideChatInput): boolean => true,
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
      onSideChat,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(result.current.annotationPreparationPending).toBe(true);

    // The command appeared DURING the read: the pre-flight (computed against
    // the original, non-side-chat document) disagrees with the commit.
    act(() => {
      editor.setJSON(
        docWith(paragraph("/btw check this"), hashOnlyImageNode(HASH_A)),
      );
    });

    await act(async () => {
      releaseCrop?.();
      await Promise.resolve();
    });

    expect(onSideChat).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(editor.clearCount).toBe(0);
    await waitFor(() => {
      expect(result.current.annotationPreparationPending).toBe(false);
    });
  });
});
