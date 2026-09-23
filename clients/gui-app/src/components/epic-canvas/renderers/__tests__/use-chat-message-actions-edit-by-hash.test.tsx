import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  HostClient,
  HostRequester,
} from "@traycer-clients/shared/host-client/host-client";

import { useChatMessageActions } from "@/components/epic-canvas/renderers/use-chat-message-actions";
import type { ChatMessageActionsInput } from "@/components/epic-canvas/renderers/use-chat-message-actions";
import type { InlineEditState } from "@/components/epic-canvas/renderers/chat-tile-session-state";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import type { ChatMessage } from "@/stores/composer/chat-store";
import type { HostRpcRegistry } from "@/lib/host";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { putImage } from "@/lib/composer/landing-image-store";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Item A: EDIT-AND-RESEND UPLOADS THE IMAGES THE USER ADDED, AND SENDS THEM AS
 * HASHES.
 *
 * An edit-and-resend is a send - same stream, same host-side materializer - and
 * it was the one send path still inlining unconditionally after
 * `useChatComposerSubmit` had been routed through the draft-blob bridge. These
 * cases pin the outcomes that distinguish the arm from the plain re-inline: a
 * bridge-capable host gets hashes, one without the bridge gets base64, a MIXED
 * message inlines exactly the refused node, and a hash INHERITED from the sent
 * message is never uploaded at all.
 *
 * ## What is driven, and what is a parameter
 *
 * The capability is `getDraftBlobBridgeSupported`, an INPUT to the hook, so it
 * is passed here rather than negotiated. This file used to record a
 * `chat.subscribe` minor in the stream-version registry; it no longer can, and
 * should not - the hook does not read that registry, the tile does, and which
 * negotiated minor makes `ChatStreamClient.draftBlobBridgeSupported()` answer
 * true is that class's own claim to pin. Driving it from the registry here
 * would have this suite fail whenever the minor moved, for a reason that has
 * nothing to do with what it tests.
 *
 * Everything else is real. The image store runs on a fresh fake IndexedDB and
 * `putDraftBlobs` is the production function; the only fake is the host's
 * `drafts.putBlob` answer - the one fact a renderer genuinely cannot produce.
 * A mocked inliner would answer the question this file exists to ask.
 *
 * ## The seeded document is not the edited one
 *
 * Every case gives `initialContent` and `currentContent` separately, because the
 * distinction IS the subject: the editor is seeded from the sent message, whose
 * images the epic already holds, and only what the user added since is this
 * client's to place. A fixture that passed one document as both would make
 * every hash inherited, take the synchronous path, and prove nothing about the
 * upload.
 *
 * ## The owner
 *
 * `contextMetadata.userId` is seeded because confirmations are recorded and read
 * per account: under a null owner `putDraftBlobs` records nothing, the host-held
 * set never widens, and this suite's by-hash cases would either red or - worse,
 * for the bridge-down case - pass while reading "signed out" instead of "bridge
 * down".
 */

const HOST_ID = "host-edit-byhash";
const USER_ID = "user-edit-byhash";

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => HOST_ID,
}));

const clientMocks = vi.hoisted(() => ({
  putBlobCalls: [] as string[],
  ackedHashes: new Set<string>(),
}));

/**
 * A `DraftBlobClient`-shaped stub standing in for the tab's `HostClient`.
 *
 * `putDraftBlobs` calls `requestWithOptions("drafts.putBlob", …)` directly and
 * needs neither the real class' idempotency-key validation nor a scheduling
 * policy, so the two members it actually reaches are the two spelled here. The
 * cast is to the concrete requester member type, not through `unknown`: a
 * `Partial` behind a wider cast would hide a newly called member from the
 * compiler and fail only at runtime.
 */
function tabHostClientStub(): HostClient<HostRpcRegistry> {
  const client = {
    request: (() =>
      Promise.reject(
        new Error("unexpected request call"),
      )) as HostRequester<HostRpcRegistry>["request"],
    requestWithOptions: ((method: string, params: unknown) => {
      if (method !== "drafts.putBlob") {
        return Promise.reject(new Error(`unexpected method ${method}`));
      }
      const sha256 = (params as { readonly sha256: string }).sha256;
      clientMocks.putBlobCalls.push(sha256);
      return Promise.resolve(
        clientMocks.ackedHashes.has(sha256)
          ? { ok: true as const }
          : { ok: false as const, reason: "digest-mismatch" as const },
      );
    }) as HostRequester<HostRpcRegistry>["requestWithOptions"],
  };
  return client as HostClient<HostRpcRegistry>;
}

const TAB_CLIENT = tabHostClientStub();

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => TAB_CLIENT,
}));

const SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-sonnet",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
  identityId: null,
};

const TARGET_MESSAGE_ID = "persistent-message-1";

function imageDoc(hashes: ReadonlyArray<string>): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          ...hashes.map((hash, index) => ({
            type: "imageAttachment",
            attrs: {
              id: `img-${String(index)}`,
              fileName: `shot-${String(index)}.png`,
              mimeType: "image/png",
              size: 9,
              byHashEligible: true,
              hash,
            },
          })),
          { type: "text", text: "edited" },
        ],
      },
    ],
  };
}

/** The seeded document of an edit whose images the user added afterwards. */
function textDoc(): JsonContent {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
    ],
  };
}

function pngBytes(marker: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, marker]);
}

function originalMessage(content: JsonContent): ChatMessage {
  return {
    id: "message-1",
    role: "user",
    content: "before",
    segments: [],
    structuredContent: content,
    attachments: [],
    settings: SETTINGS,
    createdAt: 0,
    completedAt: null,
    stopped: null,
    persistentMessageId: TARGET_MESSAGE_ID,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function inlineEdit(edit: {
  readonly initialContent: JsonContent;
  readonly currentContent: JsonContent;
}): InlineEditState {
  return {
    sessionId: "edit-session-byhash",
    targetMessageId: TARGET_MESSAGE_ID,
    originalMessage: originalMessage(edit.initialContent),
    initialContent: edit.initialContent,
    currentContent: edit.currentContent,
    revision: 0,
    dirty: true,
    pendingClientActionId: null,
    pendingMessageId: null,
  };
}

const editUserMessage = vi.fn<ChatActions["editUserMessage"]>(() => ({
  clientActionId: "action-1",
  messageId: "sent-message-1",
}));

// Every member present and typed: a partial stub behind a cast would hide a
// newly called action from the compiler and fail only at runtime.
function chatActionsStub(): ChatActions {
  return {
    sendMessage: vi.fn(),
    deleteMessageSuffix: vi.fn(),
    editUserMessage,
    revertFileChanges: vi.fn(),
    stopTurn: vi.fn(),
    stopBackgroundItem: vi.fn(),
    stopAllBackgroundItems: vi.fn(),
    stopBackgroundSession: vi.fn(),
    pauseQueue: vi.fn(),
    resumeQueue: vi.fn(),
    queueEdit: vi.fn(),
    queueSettingsUpdate: vi.fn(),
    restampQueuedItemSettings: vi.fn(),
    updateActivePermissionMode: vi.fn(),
    updateActiveProfile: vi.fn(),
    queueCancel: vi.fn(),
    queueReorder: vi.fn(),
    queueSteerNow: vi.fn(),
    queueAbortSteer: vi.fn(),
    approvalDecision: vi.fn(),
    fileEditApprovalDecision: vi.fn(),
    restoreCheckpoint: vi.fn(),
    interviewAnswer: vi.fn(),
    interviewSkip: vi.fn(),
    interviewDeliveryRetry: vi.fn(),
    ackFailedSendRestoration: vi.fn(),
    ackAcceptedAction: vi.fn(),
    takeSetupFailedRestoration: vi.fn(),
    messageDeliveryRestored: vi.fn(),
  };
}

function inputFor(
  activeInlineEdit: InlineEditState,
  bridgeSupported: boolean,
): ChatMessageActionsInput {
  return {
    dispatchUi: vi.fn(),
    activeInlineEdit,
    canModifyMessages: true,
    canAct: true,
    messageDelivery: null,
    interviewDeliveryRetryProtocolSupported: true,
    currentComposerSettings: SETTINGS,
    editSettings: SETTINGS,
    slashCatalog: null,
    mentionRoots: [],
    fallbackToGlobalMentionRoots: false,
    currentEpicId: "epic-1",
    node: { id: "chat-1", instanceId: "instance-1", name: "Chat" },
    chatTitle: null,
    chatParentId: null,
    messages: [],
    events: [],
    transcriptWindow: null,
    profile: { userId: "user-1", userName: "Tester", email: "t@example.com" },
    chatActions: chatActionsStub(),
    pendingActions: {},
    acceptedActions: {},
    confirmingDeleteMessageId: null,
    setForkTarget: vi.fn(),
    worktreeBinding: null,
    revertOnEditOpen: false,
    queuedCount: 0,
    getDraftBlobBridgeSupported: () => bridgeSupported,
  };
}

/** Run the edit submit and wait for the async gate to dispatch. */
async function submitEdit(edit: {
  readonly initialContent: JsonContent;
  readonly currentContent: JsonContent;
  readonly bridgeSupported: boolean;
}): Promise<void> {
  const { result } = renderHook(() =>
    useChatMessageActions(
      inputFor(
        inlineEdit({
          initialContent: edit.initialContent,
          currentContent: edit.currentContent,
        }),
        edit.bridgeSupported,
      ),
    ),
  );
  act(() => {
    result.current.revertOnEdit.onDontRevert();
  });
  await waitFor(() => {
    expect(editUserMessage).toHaveBeenCalledTimes(1);
  });
}

/** The content the edit actually dispatched. */
function dispatchedContent(): JsonContent {
  // `.at(0)`, not `[0]`: without `noUncheckedIndexedAccess` a plain index read
  // is typed as the element however far past the end it is, so the guard below
  // compared against a value the type said could not occur and would have been
  // stripped as dead. `.at` types the miss, which is what makes the named
  // failure reachable instead of a `TypeError` two lines later.
  const call = editUserMessage.mock.calls.at(0)?.[0];
  if (call === undefined) throw new Error("no edit was dispatched");
  return call.content;
}

beforeEach(() => {
  installFreshIndexedDb();
  // `currentDraftBlobOwnerId()` reads `contextMetadata.userId`, NOT
  // `profile.userId`, and a null owner records and confirms NOTHING. Without
  // this every upload below would land and then be forgotten, the host-held set
  // would never widen, and the by-hash cases would be testing "signed out".
  useAuthStore.setState({
    profile: { userId: USER_ID, userName: "Tester", email: "t@example.com" },
    contextMetadata: { userId: USER_ID, username: USER_ID },
  });
  editUserMessage.mockClear();
  clientMocks.putBlobCalls.length = 0;
  clientMocks.ackedHashes.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ profile: null, contextMetadata: null });
  resetDraftBlobTransportForTests();
});

describe("useChatMessageActions: edit-and-resend by-hash arm", () => {
  it("a bridge-capable host receives hash-only content, with the bytes uploaded once", async () => {
    const hash = await putImage(pngBytes(1));
    clientMocks.ackedHashes.add(hash);

    await submitEdit({
      initialContent: textDoc(),
      currentContent: imageDoc([hash]),
      bridgeSupported: true,
    });

    // The upload happened on this host...
    expect(clientMocks.putBlobCalls).toEqual([hash]);
    // ...and the wire carries the reference, not the bytes.
    //
    // This is also the ORDER claim, and the only case that carries it. The
    // reconcile loop reads bytes for its `initialHashes` unconditionally on the
    // first pass, so a required set computed BEFORE the upload would be read,
    // base64'd and committed even though the host had just acked the digest -
    // and `b64content` here would be a string. Recomputing it after the upload
    // is what makes this null.
    const atoms = collectImageAtoms(dispatchedContent());
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.hash).toBe(hash);
    expect(atoms[0]?.b64content).toBeNull();
  });

  it("a host whose stream cannot bridge draft blobs receives inline base64 and uploads nothing", async () => {
    const hash = await putImage(pngBytes(2));
    // Acked if it were ever asked - so a red here is the ARM opening with the
    // bridge down, not the host refusing the blob.
    clientMocks.ackedHashes.add(hash);

    await submitEdit({
      initialContent: textDoc(),
      currentContent: imageDoc([hash]),
      bridgeSupported: false,
    });

    expect(clientMocks.putBlobCalls).toEqual([]);
    const atoms = collectImageAtoms(dispatchedContent());
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.b64content).not.toBeNull();
  });

  it("one unconfirmed hash of two inlines exactly that node and leaves the other by hash", async () => {
    const confirmedHash = await putImage(pngBytes(3));
    const refusedHash = await putImage(pngBytes(4));
    // The host takes the first and refuses the second. Both have local bytes,
    // so the refused one CAN be inlined - which is what makes this a test of
    // the per-hash split rather than of the best-effort fallback.
    clientMocks.ackedHashes.add(confirmedHash);

    await submitEdit({
      initialContent: textDoc(),
      currentContent: imageDoc([confirmedHash, refusedHash]),
      bridgeSupported: true,
    });

    expect([...clientMocks.putBlobCalls].sort()).toEqual(
      [confirmedHash, refusedHash].sort(),
    );
    const atoms = collectImageAtoms(dispatchedContent());
    expect(atoms).toHaveLength(2);
    const confirmed = atoms.find((atom) => atom.hash === confirmedHash);
    expect(confirmed).toBeDefined();
    expect(confirmed?.b64content).toBeNull();
    // `inlineHashOnlyImageBytes` clears the `hash` on every node it inlines, so
    // the refused one is addressed by its BYTES here, not by its hash.
    const inlined = atoms.find((atom) => atom.hash === null);
    expect(inlined).toBeDefined();
    expect(inlined?.b64content).not.toBeNull();
  });

  it("a hash INHERITED from the sent message is sent bare and never uploaded, bridge or no bridge", async () => {
    // The bytes are local, the host acks, the bridge is up - every condition
    // that would make an ADDED image upload. It still must not, because this
    // digest is already an epic attachment: the editor was seeded with it. An
    // upload here would be a `drafts.putBlob` round trip per Save on the
    // commonest edit there is, and it is the one this suite can most easily
    // lose by "simplifying" the inherited set away.
    const hash = await putImage(pngBytes(5));
    clientMocks.ackedHashes.add(hash);
    const seeded = imageDoc([hash]);

    await submitEdit({
      initialContent: seeded,
      currentContent: seeded,
      bridgeSupported: true,
    });

    expect(clientMocks.putBlobCalls).toEqual([]);
    const atoms = collectImageAtoms(dispatchedContent());
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.hash).toBe(hash);
    expect(atoms[0]?.b64content).toBeNull();
  });
});
