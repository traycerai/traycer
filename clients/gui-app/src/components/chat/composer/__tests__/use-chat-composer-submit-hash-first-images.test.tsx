import "../../../../../__tests__/test-browser-apis";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { DraftsPutBlobResponse } from "@traycer/protocol/host/drafts/schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host";

import { useChatComposerSubmit } from "@/components/chat/composer/use-chat-composer-submit";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import {
  recordNegotiatedStreamMethodVersions,
  resetNegotiatedStreamVersions,
} from "@traycer-clients/shared/host-transport/negotiated-stream-version-registry";
import type { HostRpcRegistry } from "@/lib/host";

const imageStoreMocks = vi.hoisted(() => ({
  sessionImageBytes: vi.fn<(hash: string) => Uint8Array | null>(() => null),
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
}));

vi.mock("@/lib/composer/composer-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/composer/composer-image-store")
    >();
  return {
    ...actual,
    sessionImageBytes: imageStoreMocks.sessionImageBytes,
    getImageBytes: imageStoreMocks.getImageBytes,
  };
});

const HASH = "hash-in-epic-image-1";
const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4]);

// A real-looking sha256 hex digest, for the by-hash arm below: `putDraftBlobs`
// keys the upload's idempotency on the hash itself, and `HostRequestCoordinator`
// validates that key against the wire's sha256 shape - the plain `HASH` label
// above never reaches that seam (the inline arm never uploads), so it was
// never validated against it either.
const BY_HASH_SHA256 =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";

function hashOnlyImageDoc(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "node-1",
              fileName: "shot.png",
              mimeType: "image/png",
              size: 4,
              byHashEligible: true,
              hash: HASH,
            },
          },
          { type: "text", text: "look" },
        ],
      },
    ],
  };
}

/** A hash-only doc whose text can be changed, standing in for the user typing. */
function hashOnlyImageDocWithText(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "node-1",
              fileName: "shot.png",
              mimeType: "image/png",
              size: 4,
              byHashEligible: true,
              hash: HASH,
            },
          },
          { type: "text", text },
        ],
      },
    ],
  };
}

/** Same shape as {@link hashOnlyImageDocWithText}, keyed on the by-hash arm's own sha256. */
function byHashDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "node-1",
              fileName: "shot.png",
              mimeType: "image/png",
              size: 4,
              byHashEligible: true,
              hash: BY_HASH_SHA256,
            },
          },
          { type: "text", text },
        ],
      },
    ],
  };
}

/** Every `text` node in a document, joined - enough to identify which one it is. */
function extractParagraphText(content: JsonContent): string {
  const parts: string[] = [];
  const walk = (node: JsonContent): void => {
    if (typeof node.text === "string") parts.push(node.text);
    for (const child of node.content ?? []) walk(child);
  };
  walk(content);
  return parts.join("");
}

/**
 * An editor whose document can change AFTER the submit has read it - which is
 * the whole situation the generation guard exists for. The real editor stays
 * editable across the image read; a fixed-content stub cannot express that.
 */
function mutableEditor(initial: JsonContent): {
  readonly handle: ComposerPromptEditorHandle;
  readonly setJSON: (next: JsonContent) => void;
  readonly clearCalls: () => number;
} {
  let current = initial;
  let clears = 0;
  const handle = fakeEditor(initial);
  return {
    handle: {
      ...handle,
      getJSON: () => current,
      clear: () => {
        clears += 1;
      },
    },
    setJSON: (next) => {
      current = next;
    },
    clearCalls: () => clears,
  };
}

function fakeEditor(content: JsonContent): ComposerPromptEditorHandle {
  return {
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
  };
}

function mountSubmit(args: {
  readonly taskId: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
}) {
  const toolbarStore = createComposerToolbarStore({
    seedKey: "hash-first-image-submit",
    values: {
      permission: "supervised",
      selection: {
        harnessId: "codex",
        modelSlug: "gpt-5",
        profileId: null,
      },
      reasoning: "medium",
      serviceTier: "auto",
    },
    onSettingsChange: null,
    tuiOnly: false,
    hostId: null,
  });
  return renderHook(() =>
    useChatComposerSubmit({
      taskId: args.taskId,
      hostId: args.hostId,
      hostClient: args.hostClient,
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
      draftReadOnly: false,
      onSubmitMessage: args.onSubmitMessage,
      onSideChat: null,
    }),
  );
}

// A real `HostClient` (not a bare mock) - `drafts.putBlob` dispatches through
// `requestWithOptions` with its own `responseTimeoutMs`, which `HostClient`
// validates against the registry-declared scheduling policy before the call
// ever reaches the messenger (see the epic-create-refusal-repair-host fixture
// for the same trap). Each `drafts.putBlob` call is held open until
// {@link release} is called, so a test can drive exactly when an upload
// settles relative to a generation-changing edit.
function createGatedByHashHostFixture(hostId: string): {
  readonly hostClient: HostClient<HostRpcRegistry>;
  readonly release: (ok: boolean) => void;
  readonly pendingCount: () => number;
  readonly putBlobCallCount: () => number;
} {
  // A QUEUE, not a single slot: an ablated `confirmAttachmentsByHash` (or any
  // other bug that re-uploads) issues a SECOND `drafts.putBlob` before the
  // test releases the first, and a one-shot gate then parks that second call
  // forever - the test times out waiting for the send instead of ever
  // reaching its call-count assertion, so the ablation "reddens" for a reason
  // that has nothing to do with the claim. A queue lets every call - real or
  // ablation-only - actually settle, so the assertion that follows is the one
  // that runs.
  // The response is the DISCRIMINATED UNION, not `{ ok: boolean }`: a failed
  // put also carries `reason`, so a boolean-shaped resolver does not satisfy
  // the handler's type. `release` below maps the caller's boolean onto the
  // matching member rather than widening the union here.
  const pending: Array<(response: DraftsPutBlobResponse) => void> = [];
  let callCount = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-chat-byhash-gated",
    handlers: {
      "drafts.putBlob": () => {
        callCount += 1;
        return new Promise<DraftsPutBlobResponse>((resolve) => {
          pending.push(resolve);
        });
      },
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const entry = { ...mockLocalHostEntry, hostId };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (candidate) => (candidate === hostId ? entry : null),
    messenger,
    schedulingPolicy: hostRpcSchedulingPolicy,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      identity: {
        userId: "user-byhash",
        username: "user-byhash",
        providerHandle: null,
      },
      origin: "renderer",
    }),
  );
  return {
    hostClient: spine.createRequester(entry),
    release: (ok) => {
      const resolve = pending.shift();
      if (resolve === undefined) {
        throw new Error("no drafts.putBlob call in flight");
      }
      resolve(ok ? { ok: true } : { ok: false, reason: "digest-mismatch" });
    },
    pendingCount: () => pending.length,
    putBlobCallCount: () => callCount,
  };
}

beforeEach(() => {
  imageStoreMocks.sessionImageBytes.mockReset();
  imageStoreMocks.sessionImageBytes.mockReturnValue(null);
  imageStoreMocks.getImageBytes.mockReset();
  imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
  resetDraftBlobTransportForTests();
});

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
  resetNegotiatedStreamVersions();
  resetDraftBlobTransportForTests();
});

describe("useChatComposerSubmit: hash-first image inline-at-submit", () => {
  it("(a) synchronous session-cache fast path - submitted payload carries b64content", async () => {
    imageStoreMocks.sessionImageBytes.mockReturnValue(IMAGE_BYTES);

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId: "chat-fast-path",
      editor: fakeEditor(hashOnlyImageDoc()),
      onSubmitMessage: submit,
      hostId: null,
      hostClient: null,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // The fast path never awaits: the send is dispatched synchronously in the
    // same stack frame, before any microtask can run.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(imageStoreMocks.getImageBytes).not.toHaveBeenCalled();

    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.b64content).toBe(
      btoa(String.fromCharCode(...IMAGE_BYTES)),
    );
    expect(atoms[0]?.hash).toBeNull();
  });

  it("(b) async IndexedDB fallback when the hash is session-cold - payload still carries b64content", async () => {
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId: "chat-cold-hash",
      editor: fakeEditor(hashOnlyImageDoc()),
      onSubmitMessage: submit,
      hostId: null,
      hostClient: null,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    // Not sent yet - the session cache missed and the store read is async.
    expect(submit).not.toHaveBeenCalled();
    expect(result.current.imageResolutionPending).toBe(true);

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledWith(HASH);

    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.b64content).toBe(
      btoa(String.fromCharCode(...IMAGE_BYTES)),
    );
    expect(result.current.imageResolutionPending).toBe(false);
  });

  it("(c) non-refusal: a hash with NO local bytes anywhere is left hash-only and the send STILL goes out", async () => {
    // Neither the session cache nor this window's IndexedDB has the bytes -
    // the shape of a hash that only the host's epic attachment store can
    // resolve. Unlike the landing composer, a chat surface never refuses this
    // send; it is best-effort.
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(undefined);

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId: "chat-host-only-hash",
      editor: fakeEditor(hashOnlyImageDoc()),
      onSubmitMessage: submit,
      hostId: null,
      hostClient: null,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(submit).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms).toHaveLength(1);
    // Left HASH-ONLY - never dropped from the document, never a b64content.
    expect(atoms[0]?.hash).toBe(HASH);
    expect(atoms[0]?.b64content).toBeNull();
    expect(result.current.imageResolutionPending).toBe(false);
  });

  // The async arm used to be `.then(dispatch).catch(() => dispatch(original))`.
  // A `catch` CHAINED after the success arm catches rejections from the success
  // HANDLER too, so a dispatch that threw was caught by its own error arm and
  // the message went out a SECOND time - un-inlined, and after the first send
  // had already been accepted. The arm is now a two-argument `then`, whose
  // failure handler answers only the READ failing. This pins that: a dispatch
  // that throws must be attempted exactly once.
  it("does not dispatch twice when the send handler itself throws on the async path", async () => {
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);
    const submit = vi.fn<(input: ChatComposerSubmitInput) => boolean>(() => {
      throw new Error("send blew up");
    });
    const { result } = mountSubmit({
      taskId: "chat-double-dispatch",
      editor: fakeEditor(hashOnlyImageDoc()),
      onSubmitMessage: submit,
      hostId: null,
      hostClient: null,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // Let every remaining microtask drain: with the old chained `.catch`, the
    // second dispatch landed here, one tick after the first one threw.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(submit).toHaveBeenCalledTimes(1);
    // The in-flight latch must still clear, or the composer would refuse every
    // later send after one throwing dispatch.
    await waitFor(() => {
      expect(result.current.imageResolutionPending).toBe(false);
    });
  });

  // The editor is NOT disabled across the image read, so the user can keep
  // typing between pressing Enter and the send going out. The arm used to
  // dispatch the document it had captured and then clear the CURRENT one, so
  // whatever was typed during the read was destroyed - never sent, never shown
  // again, and invisible to any test that does not type during the await.
  it("typing during the await is preserved: the send carries the NEW document, not the captured one", async () => {
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    let releaseRead: ((bytes: Uint8Array) => void) | null = null;
    imageStoreMocks.getImageBytes.mockImplementation(() => {
      // Only the FIRST read is held open; the re-resolution after the edit
      // resolves at once so the test does not have to drive two handoffs.
      if (releaseRead !== null) return Promise.resolve(IMAGE_BYTES);
      return new Promise<Uint8Array | undefined>((resolve) => {
        releaseRead = resolve;
      });
    });

    const taskId = "chat-typing-during-await";
    const editor = mutableEditor(hashOnlyImageDocWithText("first"));
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
      hostId: null,
      hostClient: null,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(submit).not.toHaveBeenCalled();

    // Both halves of what a real keystroke does: the document changes, and the
    // editor boundary records the mutation in the draft store (which bumps the
    // `revision` the submit generation is read from).
    const typed = hashOnlyImageDocWithText("first and then more");
    act(() => {
      editor.setJSON(typed);
      useComposerDraftStore.getState().setSnapshot(taskId, typed, null);
    });

    act(() => {
      releaseRead?.(IMAGE_BYTES);
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // The send carries the text typed DURING the read. With the captured
    // document this reads "first".
    expect(submit.mock.calls[0][0].contentText).toContain("and then more");
    // And the restore payload - what a refused send puts back - is the live
    // document too, not the stale capture.
    expect(
      extractParagraphText(submit.mock.calls[0][0].restore.content),
    ).toContain("and then more");
    // The stale capture was not sent and then patched up: the submit was
    // re-entered and the CURRENT document resolved from scratch.
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledTimes(2);
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms[0]?.b64content).toBe(
      btoa(String.fromCharCode(...IMAGE_BYTES)),
    );
    await waitFor(() => {
      expect(result.current.imageResolutionPending).toBe(false);
    });
  });

  // The guard used to sit INSIDE each async arm, which left the synchronous
  // path open: a first submit goes async on a session-cold hash, the paste then
  // warms the session cache, and a second Enter takes the synchronous fast path
  // and sends immediately - after which the first arm settles and sends the
  // same message a second time.
  it("a second submit during the await is a no-op, including via the synchronous fast path", async () => {
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    let releaseRead: ((bytes: Uint8Array) => void) | null = null;
    imageStoreMocks.getImageBytes.mockImplementation(
      () =>
        new Promise<Uint8Array | undefined>((resolve) => {
          releaseRead = resolve;
        }),
    );

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId: "chat-second-submit-during-await",
      editor: fakeEditor(hashOnlyImageDoc()),
      onSubmitMessage: submit,
      hostId: null,
      hostClient: null,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(submit).not.toHaveBeenCalled();
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledTimes(1);

    // The hash is session-warm by the time the user presses Enter again, so
    // this second submit would take the SYNCHRONOUS fast path - the one the
    // per-arm guard never covered.
    imageStoreMocks.sessionImageBytes.mockReturnValue(IMAGE_BYTES);
    act(() => {
      result.current.submitDraft("enter");
    });
    expect(submit).not.toHaveBeenCalled();

    act(() => {
      releaseRead?.(IMAGE_BYTES);
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // Drain every remaining microtask: a second dispatch would land here.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(submit).toHaveBeenCalledTimes(1);
    // The second submit never started a read of its own either.
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledTimes(1);
  });
});

// The BY-HASH arm's own generation guard - same `settleResolvedSend` seam as
// the cold-read arm above, but the async gap here is an UPLOAD
// (`drafts.putBlob`) rather than an IndexedDB read, and a stale-generation
// retry that lands on an already-confirmed hash must not re-upload it.
describe("useChatComposerSubmit: by-hash upload arm - generation guard and no-double-upload", () => {
  const HOST_ID = "host-chat-byhash";

  beforeEach(() => {
    recordNegotiatedStreamMethodVersions(
      HOST_ID,
      new Map([["chat.subscribe", { major: 1, minor: 11 }]]),
    );
    // The upload path reads local bytes through the SAME `getImageBytes` the
    // cold-read arm mocks above - `draft-blob-transport`'s `localBytesForHash`
    // calls it too, so this one setting covers both readers.
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);
  });

  // C-new-3: typing during the upload await is preserved, AND (since the
  // retry lands on an already-confirmed hash) doubles as the no-double-upload
  // control - the two facts share one run because the re-entry's upload skip
  // is what makes the resend possible without a second round trip.
  it("typing during the upload await is preserved, and the confirmed hash is not re-uploaded on retry", async () => {
    const fixture = createGatedByHashHostFixture(HOST_ID);
    const taskId = "chat-byhash-typing-preserved";
    const editor = mutableEditor(byHashDoc("first"));
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
      hostId: HOST_ID,
      hostClient: fixture.hostClient,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(submit).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(fixture.putBlobCallCount()).toBe(1);
    });

    // Both halves of a real keystroke: the document changes, and the editor
    // boundary bumps the draft store's `revision` (what the generation guard
    // reads).
    const typed = byHashDoc("first and then more");
    act(() => {
      editor.setJSON(typed);
      useComposerDraftStore.getState().setSnapshot(taskId, typed, null);
    });

    // Release every call the retry issues, not just the first: a memo bug
    // (confirmed-hash filter deleted) makes the re-entry re-upload, which
    // parks a SECOND `drafts.putBlob` with nobody to answer it. Draining the
    // queue here is what lets that ablation reach the call-count assertion
    // below instead of timing out on the `waitFor(submit)` first - a red from
    // a stuck queue proves the fixture is one-shot, not that the memo works.
    await act(async () => {
      fixture.release(true);
      await Promise.resolve();
    });
    while (fixture.pendingCount() > 0) {
      await act(async () => {
        fixture.release(true);
        await Promise.resolve();
      });
    }

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // The send carries the text typed DURING the upload, not the captured one.
    expect(submit.mock.calls[0][0].contentText).toContain("and then more");
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms[0]?.hash).toBe(BY_HASH_SHA256);
    expect(atoms[0]?.b64content).toBeNull();
    // Re-entered from the annotation stage (fresh `editor.getJSON()`), not
    // resent from the stale capture - and the re-derived plan finds the hash
    // already confirmed, so it never re-uploads it.
    expect(fixture.putBlobCallCount()).toBe(1);
    await waitFor(() => {
      expect(result.current.imageResolutionPending).toBe(false);
    });
  });

  // C-new-3's second fact: a second Enter while the upload is in flight must
  // not start a second upload or a second send.
  it("a second submit during the upload await is a no-op", async () => {
    const fixture = createGatedByHashHostFixture(HOST_ID);
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId: "chat-byhash-second-submit",
      editor: fakeEditor(byHashDoc("look")),
      onSubmitMessage: submit,
      hostId: HOST_ID,
      hostClient: fixture.hostClient,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(submit).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(fixture.putBlobCallCount()).toBe(1);
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(submit).not.toHaveBeenCalled();

    await act(async () => {
      fixture.release(true);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // Drain every remaining microtask: a second dispatch would land here.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(submit).toHaveBeenCalledTimes(1);
    // The second submit never started an upload of its own either.
    expect(fixture.putBlobCallCount()).toBe(1);
  });

  // C-new-4's failure-direction pair: when the FIRST pass's upload does not
  // confirm the hash (host digest-mismatch), the stale-generation retry has
  // nothing confirmed to skip and DOES re-upload - total calls go to 2, not 1.
  it("an unconfirmed hash's stale-generation retry DOES re-upload", async () => {
    const fixture = createGatedByHashHostFixture(HOST_ID);
    const taskId = "chat-byhash-unconfirmed-retry";
    const editor = mutableEditor(byHashDoc("first"));
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
      hostId: HOST_ID,
      hostClient: fixture.hostClient,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    await waitFor(() => {
      expect(fixture.putBlobCallCount()).toBe(1);
    });

    const typed = byHashDoc("first and then more");
    act(() => {
      editor.setJSON(typed);
      useComposerDraftStore.getState().setSnapshot(taskId, typed, null);
    });

    // Pass 1's upload digest-mismatches - the hash is never confirmed.
    await act(async () => {
      fixture.release(false);
      await Promise.resolve();
    });

    // The retry re-derives the plan, finds nothing confirmed, and uploads
    // again.
    await waitFor(() => {
      expect(fixture.putBlobCallCount()).toBe(2);
    });
    await act(async () => {
      fixture.release(true);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    expect(fixture.putBlobCallCount()).toBe(2);
  });
});
