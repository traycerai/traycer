import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { toast } from "sonner";
import { ChatTileErrorNoticeToasts } from "../chat-tile-error-notice-toasts";
import { Toaster } from "@/components/ui/sonner";
import {
  CHAT_ID,
  EPIC_ID,
  OWNER_ID,
  createHarness,
  emitSnapshot,
  emitSnapshotWithQueue,
  sendTestMessage,
  type ChatTileHarness,
} from "./chat-tile-test-support";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "prompt" }] }],
};

const EDITED: JsonContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "edited prompt" }] },
  ],
};

const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

const OTHER_SETTINGS: ChatRunSettings = {
  ...SETTINGS,
  model: "gpt-5-mini",
};

const REASON = "That profile no longer exists. Choose a profile.";
const WORKTREE_COPY =
  "Its staged worktree a new branch feat/doomed from main no longer exists, so it was not restored.";
const SETTINGS_COPY =
  "It was going to run with model gpt-5-codex; the chat uses different settings now, so a resend will not match unless you set them back.";
const QUEUE_ITEM_ID = "queue-item-1";
const MESSAGE_ID = "queued-message-1";

interface ToastCase {
  readonly code: "removed-by-person" | "RPC_ERROR";
  readonly expected: string;
  readonly wrapped: boolean;
}

const WORKTREE_CASES: ReadonlyArray<ToastCase> = [
  {
    code: "removed-by-person",
    expected: `Was removed\n${WORKTREE_COPY}`,
    wrapped: true,
  },
  {
    code: "RPC_ERROR",
    expected: `${REASON} ${WORKTREE_COPY}`,
    wrapped: false,
  },
];

const RESTORATION_CASES: ReadonlyArray<ToastCase> = [
  {
    code: "removed-by-person",
    expected: `Was removed\n${SETTINGS_COPY}`,
    wrapped: true,
  },
  {
    code: "RPC_ERROR",
    expected: `${REASON} ${SETTINGS_COPY}`,
    wrapped: false,
  },
];

const RETURNED_TEXT_CASES: ReadonlyArray<ToastCase> = [
  {
    code: "removed-by-person",
    expected:
      "Was removed\nYour edit to a queued message was not saved. The edited text is back in the composer as an unsent draft. Nothing was sent again.",
    wrapped: true,
  },
  {
    code: "RPC_ERROR",
    expected:
      "Your edit to a queued message was not saved (That profile no longer exists. Choose a profile). The edited text is back in the composer as an unsent draft. Nothing was sent again.",
    wrapped: false,
  },
];

const SAVED_AFTER_RETURN_CASES: ReadonlyArray<ToastCase> = [
  {
    code: "removed-by-person",
    expected:
      "Was removed\nYour edit to a queued message was saved after all. Its settings/steering were not applied. The copy handed back to you is a duplicate - do not send it again.",
    wrapped: true,
  },
  {
    code: "RPC_ERROR",
    expected:
      "Your edit to a queued message was saved after all. Its settings/steering were not applied (That profile no longer exists. Choose a profile). The copy handed back to you is a duplicate - do not send it again.",
    wrapped: false,
  },
];

let harness: ChatTileHarness | null = null;

beforeEach(() => {
  installFreshIndexedDb();
  useWorktreeIntentStagingStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
  toast.dismiss();
  harness?.handle.dispose();
  harness = null;
  useWorktreeIntentStagingStore.getState().resetForTests();
});

describe("removed-profile notice line breaks in the real toaster", () => {
  it.each(WORKTREE_CASES)(
    "renders a swept-worktree rejection notice for $code",
    async ({ code, expected, wrapped }) => {
      harness = createHarness();
      emitSnapshot(harness.callbacks(), [], []);
      renderToastLayer(harness);

      const actionId = sendWithSweptWorktree(harness);
      rejectAction({
        target: harness,
        clientActionId: actionId,
        action: "send",
        code,
        reason: REASON,
      });

      await expectRenderedToast(expected, wrapped);
    },
  );

  it.each(RESTORATION_CASES)(
    "renders a returned-send restoration notice for $code",
    async ({ code, expected, wrapped }) => {
      harness = createHarness();
      emitSnapshot(harness.callbacks(), [], []);
      sendTestMessage(harness, CONTENT, SETTINGS);
      const pending = harness.handle.store.getState().pendingUserMessages.at(0);
      if (pending === undefined) throw new Error("expected a pending send");
      harness.handle.store
        .getState()
        .setCurrentComposerSettings(OTHER_SETTINGS);
      rejectAction({
        target: harness,
        clientActionId: pending.clientActionId,
        action: "send",
        code,
        reason: REASON,
      });

      renderToastLayer(harness);
      act(() => {
        harness?.handle.store
          .getState()
          .ackFailedSendRestoration(pending.clientActionId);
      });

      await expectRenderedToast(expected, wrapped);
    },
  );

  it.each(RETURNED_TEXT_CASES)(
    "renders a returned-text queue-edit notice for $code",
    async ({ code, expected, wrapped }) => {
      harness = createHarness();
      emitSnapshotWithQueue(harness.callbacks(), [], [], [queuedRow(CONTENT)]);
      renderToastLayer(harness);

      const editActionId = submitQueueEdit(harness);
      rejectAction({
        target: harness,
        clientActionId: editActionId,
        action: "queueEdit",
        code,
        reason: REASON,
      });
      act(() => {
        harness?.handle.store.getState().ackFailedSendRestoration(editActionId);
      });

      await expectRenderedToast(expected, wrapped);
    },
  );

  it.each(SAVED_AFTER_RETURN_CASES)(
    "renders a saved-after-return queue-edit notice for $code",
    async ({ code, expected, wrapped }) => {
      harness = createHarness();
      emitSnapshotWithQueue(harness.callbacks(), [], [], [queuedRow(CONTENT)]);
      renderToastLayer(harness);

      const { followUpActionId } = submitQueueEditAndFollowUp(harness);
      rejectAction({
        target: harness,
        clientActionId: followUpActionId,
        action: "queueSettingsUpdate",
        code,
        reason: REASON,
      });
      emitHostNotice(harness, followUpActionId);
      harness.callbacks().onConnectionStatus("closed", null, null, null);
      emitSnapshotWithQueue(harness.callbacks(), [], [], [queuedRow(CONTENT)]);
      emitQueue(harness, [queuedRow(EDITED)]);

      await expectRenderedToast(expected, wrapped);
      expect(harness.handle.store.getState().queueEditRecords).toEqual({});
    },
  );

  it("keeps an unrelated error's own newline in a plain text toast", async () => {
    harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);
    renderToastLayer(harness);
    const text = "Line one\nLine two";
    act(() => {
      harness?.callbacks().onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "RPC_ERROR",
          message: text,
          severity: "warning",
          clientActionId: null,
        },
      });
    });

    await expectRenderedToast(text, false);
  });

  it("renders a notice the store did not register as today", async () => {
    harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);
    const actionId = sendWithSweptWorktree(harness);
    rejectAction({
      target: harness,
      clientActionId: actionId,
      action: "send",
      code: "removed-by-person",
      reason: REASON,
    });
    const removedNotice = harness.handle.store
      .getState()
      .errorNotices.find((notice) => notice.clientActionId === actionId);
    if (removedNotice === undefined)
      throw new Error("expected the rejection notice");
    const copiedNotice = { ...removedNotice };
    harness.handle.store.setState({ errorNotices: [] });
    renderToastLayer(harness);
    act(() => {
      harness?.handle.store.setState({ errorNotices: [copiedNotice] });
    });

    await expectRenderedToast(`Was removed\n${WORKTREE_COPY}`, false);
  });
});

function renderToastLayer(target: ChatTileHarness): void {
  render(
    <>
      <ChatTileErrorNoticeToasts handle={target.handle} />
      <Toaster />
    </>,
  );
}

async function expectRenderedToast(
  expected: string,
  wrapped: boolean,
): Promise<void> {
  await waitFor(() => {
    const content = Array.from(
      document.querySelectorAll<HTMLElement>("[data-content]"),
    ).find((element) => element.textContent === expected);
    expect(content).toBeDefined();
    if (content === undefined)
      throw new Error("expected the rendered toast text");
    const preserved = content.querySelector(".whitespace-pre-wrap");
    expect(content.textContent).toBe(expected);
    if (wrapped) {
      expect(preserved).not.toBeNull();
      expect(preserved?.textContent).toBe(expected);
    } else {
      expect(preserved).toBeNull();
    }
  });
}

function sendWithSweptWorktree(target: ChatTileHarness): string {
  const intent: WorktreeIntent = {
    entries: [
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: null,
        isPrimary: true,
        branch: {
          type: "new",
          name: "feat/doomed",
          source: "main",
          carryUncommittedChanges: false,
        },
      },
    ],
  };
  useWorktreeIntentStagingStore.getState().setIntent(
    {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    },
    intent,
  );
  sendTestMessage(target, CONTENT, SETTINGS);
  const pending = target.handle.store.getState().pendingUserMessages.at(0);
  if (pending === undefined) throw new Error("expected a pending send");
  useWorktreeIntentStagingStore
    .getState()
    .purgeRemovedWorktreeIntents("host-a", {
      worktreePaths: new Set<string>(),
      branches: [{ repoIdentifier: null, branch: "main" }],
    });
  return pending.clientActionId;
}

interface RejectionInput {
  readonly target: ChatTileHarness;
  readonly clientActionId: string;
  readonly action: "send" | "queueEdit" | "queueSettingsUpdate";
  readonly code: ToastCase["code"];
  readonly reason: string;
}

function rejectAction(input: RejectionInput): void {
  const { target, clientActionId, action, code, reason } = input;
  target.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId,
    action,
    status: "rejected",
    reason,
    code,
    backgroundStopTaskIds: [],
    token: null,
  });
}

function queuedRow(content: JsonContent): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: QUEUE_ITEM_ID,
    messageId: MESSAGE_ID,
    message: { kind: "user", content, browserAnnotations: [] },
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    sentFromHostId: null,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function submitQueueEdit(target: ChatTileHarness): string {
  const actionId = target.handle.store.getState().submitQueueEdit({
    queueItemId: QUEUE_ITEM_ID,
    content: EDITED,
    restore: { content: EDITED, browserAnnotations: [] },
    settings: SETTINGS,
    intent: "save",
    steerRestartConfirmed: false,
    steerInitiatorId: "tile-1",
  });
  if (actionId === null) throw new Error("expected the queue edit to dispatch");
  return actionId;
}

function submitQueueEditAndFollowUp(target: ChatTileHarness): {
  readonly editActionId: string;
  readonly followUpActionId: string;
} {
  const editActionId = target.handle.store.getState().submitQueueEdit({
    queueItemId: QUEUE_ITEM_ID,
    content: EDITED,
    restore: { content: EDITED, browserAnnotations: [] },
    settings: OTHER_SETTINGS,
    intent: "save",
    steerRestartConfirmed: false,
    steerInitiatorId: "tile-1",
  });
  if (editActionId === null)
    throw new Error("expected the queue edit to dispatch");
  const editFrame = target.sent.at(-2);
  const followUpFrame = target.sent.at(-1);
  if (editFrame?.kind !== "queueEdit")
    throw new Error("expected a queue edit frame");
  if (followUpFrame?.kind !== "queueSettingsUpdate") {
    throw new Error("expected a queue settings frame");
  }
  expect(editFrame.clientActionId).toBe(editActionId);
  return { editActionId, followUpActionId: followUpFrame.clientActionId };
}

function emitHostNotice(target: ChatTileHarness, clientActionId: string): void {
  target.callbacks().onErrorNotice({
    kind: "errorNotice",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    notice: {
      code: "QUEUE_ITEM_NOT_FOUND",
      message: "The queued prompt is no longer pending.",
      severity: "warning",
      clientActionId,
    },
  });
}

function emitQueue(
  target: ChatTileHarness,
  items: ReadonlyArray<ChatQueuedPromptItem>,
): void {
  target.callbacks().onQueueChanged({
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    queue: { status: "idle", items: [...items] },
  });
}
