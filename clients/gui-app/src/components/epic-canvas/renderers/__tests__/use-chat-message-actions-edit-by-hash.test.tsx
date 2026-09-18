import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  HostClient,
  HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import {
  recordNegotiatedStreamMethodVersions,
  resetNegotiatedStreamVersions,
} from "@traycer-clients/shared/host-transport/negotiated-stream-version-registry";

import { useChatMessageActions } from "@/components/epic-canvas/renderers/use-chat-message-actions";
import type { ChatMessageActionsInput } from "@/components/epic-canvas/renderers/use-chat-message-actions";
import type { InlineEditState } from "@/components/epic-canvas/renderers/chat-tile-session-state";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import type { ChatMessage } from "@/stores/composer/chat-store";
import type { HostRpcRegistry } from "@/lib/host";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { putImage } from "@/lib/composer/composer-image-store";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { collectImageAtoms } from "@/lib/composer/image-atoms";

/**
 * Item A: EDIT-AND-RESEND GOES THROUGH THE BY-HASH GATE.
 *
 * An edit-and-resend is a send - same stream, same host-side materializer - and
 * it was the one send path still inlining unconditionally while the composer's
 * own submit had already been routed through `resolveSendContentByHash`. These
 * cases pin the three outcomes that distinguish the gate from the old
 * best-effort inline: a `@1.11` host gets hashes, a `@1.10` host gets base64,
 * and a MIXED message - one hash the host acks, one it refuses - inlines
 * exactly the refused node and leaves the other hash-only.
 *
 * Deliberately NOT mocking `composer-image-inlining` the way
 * `use-chat-message-actions-edit-session.test.tsx` does: that suite is about
 * the edit EPOCH across an await and mocks the read to control its timing,
 * whereas every claim here is about which bytes come out the other end. A
 * mocked inliner would answer the question this file exists to ask. So the real
 * image store runs on a fresh fake IndexedDB, and the only fake is the host's
 * `drafts.putBlob` answer - the one fact a renderer genuinely cannot produce.
 */

const HOST_ID = "host-edit-byhash";

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

function inlineEdit(content: JsonContent): InlineEditState {
  return {
    targetMessageId: TARGET_MESSAGE_ID,
    originalMessage: originalMessage(content),
    initialContent: content,
    currentContent: content,
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
  };
}

function inputFor(activeInlineEdit: InlineEditState): ChatMessageActionsInput {
  return {
    dispatchUi: vi.fn(),
    activeInlineEdit,
    canModifyMessages: true,
    canAct: true,
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
  };
}

/** Run the edit submit and wait for the async gate to dispatch. */
async function submitEdit(content: JsonContent): Promise<void> {
  const { result } = renderHook(() =>
    useChatMessageActions(inputFor(inlineEdit(content))),
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
  const call = editUserMessage.mock.calls[0]?.[0];
  if (call === undefined) throw new Error("no edit was dispatched");
  return call.content;
}

function negotiateChatSubscribe(minor: number): void {
  recordNegotiatedStreamMethodVersions(
    HOST_ID,
    new Map([["chat.subscribe", { major: 1, minor }]]),
  );
}

beforeEach(() => {
  installFreshIndexedDb();
  editUserMessage.mockClear();
  clientMocks.putBlobCalls.length = 0;
  clientMocks.ackedHashes.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  resetDraftBlobTransportForTests();
  resetNegotiatedStreamVersions();
});

describe("useChatMessageActions: edit-and-resend by-hash gate", () => {
  it("a @1.11 host receives hash-only content, with the bytes uploaded once", async () => {
    const hash = await putImage(pngBytes(1));
    clientMocks.ackedHashes.add(hash);
    negotiateChatSubscribe(11);

    await submitEdit(imageDoc([hash]));

    // The upload happened on this host...
    expect(clientMocks.putBlobCalls).toEqual([hash]);
    // ...and the wire carries the reference, not the bytes.
    const atoms = collectImageAtoms(dispatchedContent());
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.hash).toBe(hash);
    expect(atoms[0]?.b64content).toBeNull();
  });

  it("a @1.10 host receives inline base64 and uploads nothing", async () => {
    const hash = await putImage(pngBytes(2));
    // Acked if it were ever asked - so a red here is the GATE opening on a
    // 1.10 host, not the host refusing the blob.
    clientMocks.ackedHashes.add(hash);
    negotiateChatSubscribe(10);

    await submitEdit(imageDoc([hash]));

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
    negotiateChatSubscribe(11);

    await submitEdit(imageDoc([confirmedHash, refusedHash]));

    expect([...clientMocks.putBlobCalls].sort()).toEqual(
      [confirmedHash, refusedHash].sort(),
    );
    const atoms = collectImageAtoms(dispatchedContent());
    expect(atoms).toHaveLength(2);
    const confirmed = atoms.find((atom) => atom.hash === confirmedHash);
    expect(confirmed).toBeDefined();
    expect(confirmed?.b64content).toBeNull();
    // `inlineImageHashes` clears the `hash` on every node it inlines, so the
    // refused one is addressed by its BYTES here, not by its hash.
    const inlined = atoms.find((atom) => atom.hash === null);
    expect(inlined).toBeDefined();
    expect(inlined?.b64content).not.toBeNull();
  });
});
