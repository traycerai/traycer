import "./chat-tile-queue-edit-stubs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ChatSubscribeClientFrame } from "@traycer/protocol/host/agent/gui/subscribe";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { pendingSend } from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";
import {
  submitCapture,
  createChatCapture,
  tileSlashLookups,
} from "./chat-tile-queue-edit-captures";
import {
  CHAT_ARTIFACT,
  QUEUED_CONTENT,
  QUEUED_SETTINGS,
  SIDE_CHAT_CONTENT,
  queuedPromptItem,
  editingPillQueueItemId,
  chatHarness,
  PROJECT_PATH,
  WORKTREE_A,
  LOCAL_PICK,
  hostState,
  resetQueueEditTileTest,
  cleanUpQueueEditTileTest,
  renderChatTile,
  waitForChatTileLoaded,
} from "./chat-tile-queue-edit-harness";

function unrelatedCreateChatError(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "host unreachable",
    requestId: "req-side-chat-cancel",
    method: "epic.createChat",
    fatalDetails: null,
  });
}

beforeEach(resetQueueEditTileTest);
afterEach(cleanUpQueueEditTileTest);

/**
 * The real ChatTile edit arm:
 * mount ChatTile → open queue-row edit → drive the actual submitMessage path
 * (queueEdit + queueSteerNow for after_safe_point vs queueEdit +
 * queueSettingsUpdate for auto). Captures the tile's onSubmitMessage so
 * deliveryPolicy can be driven without TipTap DOM key events under jsdom.
 * A change to chat-tile.tsx's edit branch fails these assertions.
 */
describe("chat-tile queue edit save-and-steer routing (decision 14)", () => {
  it("routes after_safe_point edit submit to queueEdit + queueSteerNow via real ChatTile submitMessage", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      {
        kind: "prompt",
        queueItemId: "queue-steer-edit",
        messageId: "message-queue-steer-edit",
        message: {
          kind: "user",
          content: QUEUED_CONTENT,
          browserAnnotations: [],
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        sentFromHostId: null,
        delivery: "next_turn",
        status: "pending",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(submitCapture.onSubmitMessage).not.toBeNull();
    });

    const onSubmitMessage = submitCapture.onSubmitMessage;
    if (onSubmitMessage === null) {
      throw new Error("expected ChatTile to wire onSubmitMessage");
    }

    act(() => {
      const accepted = onSubmitMessage({
        content: QUEUED_CONTENT,
        contentText: "edited queue item",
        attachments: [],
        settings: QUEUED_SETTINGS,
        deliveryPolicy: "after_safe_point",
        restore: { content: QUEUED_CONTENT, browserAnnotations: [] },
        restartConfirmed: false,
      });
      expect(accepted).toBe(true);
    });

    expect(chatHarness.sent.map((frame) => frame.kind)).toEqual([
      "queueEdit",
      "queueSteerNow",
    ]);
    expect(chatHarness.sent[0]).toMatchObject({
      kind: "queueEdit",
      queueItemId: "queue-steer-edit",
      content: QUEUED_CONTENT,
    });
    const steerFrame = chatHarness.sent.find(
      (
        frame,
      ): frame is Extract<
        ChatSubscribeClientFrame,
        { readonly kind: "queueSteerNow" }
      > => frame.kind === "queueSteerNow",
    );
    if (steerFrame === undefined) {
      throw new Error("Expected queueSteerNow frame");
    }
    expect(steerFrame.queueItemId).toBe("queue-steer-edit");
    expect(steerFrame.newSettings).toMatchObject({
      harnessId: "claude",
      model: "claude-sonnet",
    });
  });

  it("leaves a queue-edit steer unconfirmed when the composer did not ask, settings changed or not", async () => {
    // A harness that cannot steer mid-turn skips the composer's settings
    // dialog, so a changed model reaches here unconfirmed: the steer must go
    // out unconfirmed for the host to refuse it and the queue's dialog to ask.
    chatHarness.teardown();
    chatHarness.install("owner", [
      queuedPromptItem("queue-steer-unasked", QUEUED_CONTENT),
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(submitCapture.onSubmitMessage).not.toBeNull();
    });
    const onSubmitMessage = submitCapture.onSubmitMessage;
    if (onSubmitMessage === null) {
      throw new Error("expected ChatTile to wire onSubmitMessage");
    }

    act(() => {
      const accepted = onSubmitMessage({
        content: QUEUED_CONTENT,
        contentText: "edited queue item",
        attachments: [],
        settings: { ...QUEUED_SETTINGS, model: "claude-opus" },
        deliveryPolicy: "after_safe_point",
        restore: { content: QUEUED_CONTENT, browserAnnotations: [] },
        restartConfirmed: false,
      });
      expect(accepted).toBe(true);
    });

    expect(
      chatHarness.sent.find((frame) => frame.kind === "queueSteerNow"),
    ).toMatchObject({
      queueItemId: "queue-steer-unasked",
      newSettings: { model: "claude-opus" },
      restartConfirmed: false,
    });
  });

  it("routes auto edit submit to queueEdit + queueSettingsUpdate via real ChatTile submitMessage", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      {
        kind: "prompt",
        queueItemId: "queue-edit",
        messageId: "message-queue-edit",
        message: {
          kind: "user",
          content: QUEUED_CONTENT,
          browserAnnotations: [],
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        sentFromHostId: null,
        delivery: "next_turn",
        status: "pending",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(submitCapture.onSubmitMessage).not.toBeNull();
    });

    const onSubmitMessage = submitCapture.onSubmitMessage;
    if (onSubmitMessage === null) {
      throw new Error("expected ChatTile to wire onSubmitMessage");
    }

    act(() => {
      const accepted = onSubmitMessage({
        content: QUEUED_CONTENT,
        contentText: "edited queue item",
        attachments: [],
        settings: QUEUED_SETTINGS,
        deliveryPolicy: "auto",
        restore: { content: QUEUED_CONTENT, browserAnnotations: [] },
        restartConfirmed: false,
      });
      expect(accepted).toBe(true);
    });

    expect(chatHarness.sent.map((frame) => frame.kind)).toEqual([
      "queueEdit",
      "queueSettingsUpdate",
    ]);
    expect(
      chatHarness.sent.some((frame) => frame.kind === "queueSteerNow"),
    ).toBe(false);
  });
});

/**
 * `startSideChatFromComposer` (chat-tile.tsx): `/btw` from a queue-row edit
 * must release the edit it started - the "Editing" pill clears SYNCHRONOUSLY
 * on accept (matching the composer's own immediate draft clear), and the
 * queue item captured at that moment is cancelled only once the create
 * actually SUCCEEDS. Cancellation reads the value captured at accept time,
 * never a live read of `editingQueueItemId` in the success callback, so a
 * delayed success can never clobber a NEW edit started while the create was
 * still pending.
 */
describe("chat-tile queue-edit /btw side chat cancellation (decision 14 refinement)", () => {
  it("clears the edit pill synchronously on accept and cancels the captured queue item only once the side chat create succeeds", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      queuedPromptItem("queue-edit-target", QUEUED_CONTENT),
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(editingPillQueueItemId()).toBe("queue-edit-target");
    });

    await waitFor(() => {
      expect(submitCapture.onSideChat).not.toBeNull();
    });
    const onSideChat = submitCapture.onSideChat;
    if (onSideChat === null) {
      throw new Error("expected ChatTile to wire onSideChat");
    }

    act(() => {
      const accepted = onSideChat({
        command: "side",
        content: SIDE_CHAT_CONTENT,
        settings: QUEUED_SETTINGS,
      });
      expect(accepted).toBe(true);
    });

    // Cleared synchronously on accept - before the create has resolved at all.
    expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();
    expect(createChatCapture.calls).toHaveLength(1);
    expect(chatHarness.sent.some((frame) => frame.kind === "queueCancel")).toBe(
      false,
    );

    act(() => {
      createChatCapture.calls[0].callbacks.onSuccess({
        chatId: "side-chat-1",
        initialTurnStarted: false,
      });
    });

    expect(chatHarness.sent).toContainEqual(
      expect.objectContaining({
        kind: "queueCancel",
        queueItemId: "queue-edit-target",
      }),
    );
  });

  it("does not cancel any queue item for an ordinary (non-edit) side chat", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      queuedPromptItem("queue-untouched", QUEUED_CONTENT),
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    await waitFor(() => {
      expect(submitCapture.onSideChat).not.toBeNull();
    });
    const onSideChat = submitCapture.onSideChat;
    if (onSideChat === null) {
      throw new Error("expected ChatTile to wire onSideChat");
    }

    act(() => {
      const accepted = onSideChat({
        command: "side",
        content: SIDE_CHAT_CONTENT,
        settings: QUEUED_SETTINGS,
      });
      expect(accepted).toBe(true);
    });

    expect(createChatCapture.calls).toHaveLength(1);

    act(() => {
      createChatCapture.calls[0].callbacks.onSuccess({
        chatId: "side-chat-2",
        initialTurnStarted: false,
      });
    });

    expect(chatHarness.sent.some((frame) => frame.kind === "queueCancel")).toBe(
      false,
    );
  });

  it("retains the queued item (no cancellation) when the side chat create fails", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      queuedPromptItem("queue-retained", QUEUED_CONTENT),
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(editingPillQueueItemId()).toBe("queue-retained");
    });

    await waitFor(() => {
      expect(submitCapture.onSideChat).not.toBeNull();
    });
    const onSideChat = submitCapture.onSideChat;
    if (onSideChat === null) {
      throw new Error("expected ChatTile to wire onSideChat");
    }

    act(() => {
      const accepted = onSideChat({
        command: "side",
        content: SIDE_CHAT_CONTENT,
        settings: QUEUED_SETTINGS,
      });
      expect(accepted).toBe(true);
    });

    // The pill still clears on accept, regardless of the eventual outcome -
    // the composer's own draft clears immediately too, independent of the
    // create's result.
    expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();

    expect(createChatCapture.calls).toHaveLength(1);
    act(() => {
      createChatCapture.calls[0].callbacks.onError(unrelatedCreateChatError());
    });

    expect(chatHarness.sent.some((frame) => frame.kind === "queueCancel")).toBe(
      false,
    );
    // The queued item itself is untouched by the failed side chat.
    expect(
      screen.getByRole("button", { name: "Edit queued message" }),
    ).not.toBeNull();
  });

  it("does not let a stale side-chat success touch a NEW edit started while the create was pending", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      queuedPromptItem("queue-a", QUEUED_CONTENT),
      queuedPromptItem("queue-b", QUEUED_CONTENT),
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    const editButtons = (): HTMLElement[] =>
      screen.getAllByRole("button", { name: "Edit queued message" });

    fireEvent.click(editButtons()[0]);
    await waitFor(() => {
      expect(editingPillQueueItemId()).toBe("queue-a");
    });

    await waitFor(() => {
      expect(submitCapture.onSideChat).not.toBeNull();
    });
    const onSideChatForA = submitCapture.onSideChat;
    if (onSideChatForA === null) {
      throw new Error("expected ChatTile to wire onSideChat");
    }

    act(() => {
      const accepted = onSideChatForA({
        command: "side",
        content: SIDE_CHAT_CONTENT,
        settings: QUEUED_SETTINGS,
      });
      expect(accepted).toBe(true);
    });

    expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();
    expect(createChatCapture.calls).toHaveLength(1);

    // Start a NEW edit on a DIFFERENT queued item while A's create is still
    // pending - this is the exact overlap the refinement guards against.
    fireEvent.click(editButtons()[1]);
    await waitFor(() => {
      expect(editingPillQueueItemId()).toBe("queue-b");
    });

    act(() => {
      createChatCapture.calls[0].callbacks.onSuccess({
        chatId: "side-chat-a",
        initialTurnStarted: false,
      });
    });

    // Only the CAPTURED item (A) is cancelled - B, the live edit, is untouched.
    const queueCancelFrames = chatHarness.sent.filter(
      (frame) => frame.kind === "queueCancel",
    );
    expect(queueCancelFrames).toHaveLength(1);
    expect(queueCancelFrames[0]).toMatchObject({
      kind: "queueCancel",
      queueItemId: "queue-a",
    });

    // B's edit pill is still showing - A's stale success must not have
    // cleared or otherwise touched the CURRENT edit target.
    expect(editingPillQueueItemId()).toBe("queue-b");
  });
});

describe("chat-tile's ready line for an agent whose first message waited for its sandbox", () => {
  afterEach(() => {
    usePendingSandboxSendStore.setState({ sends: {} });
  });

  it("shows Sandbox ready above the conversation once the message was delivered into this chat, and nothing for another chat", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", []);
    usePendingSandboxSendStore.getState().add(
      pendingSend({
        id: "send-ready",
        userId: "owner-1",
        text: "fix the login bug",
        delivery: {
          chatId: CHAT_ARTIFACT.id,
          hostId: "sbx-host",
          sandboxId: "sbx-1",
          readySeconds: 24,
        },
      }),
    );
    renderChatTile();
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid^="chat-tile-pre-content-"]'),
      ).toBeNull();
    });

    const line = await screen.findByTestId("sandbox-ready-line");
    expect(line.textContent).toContain("Sandbox ready");
    expect(line.textContent).toContain("24 s");
  });

  it("shows no ready line for a chat no waiting message was delivered into", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", []);
    usePendingSandboxSendStore.getState().add(
      pendingSend({
        id: "send-other",
        userId: "owner-1",
        delivery: {
          chatId: "some-other-chat",
          hostId: "sbx-host",
          sandboxId: "sbx-1",
          readySeconds: 24,
        },
      }),
    );
    renderChatTile();
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid^="chat-tile-pre-content-"]'),
      ).toBeNull();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("sandbox-ready-line")).toBeNull();
  });
});

describe("chat-tile composer folders while a queued message is edited", () => {
  /**
   * The chat runs in a worktree; the queued message asked for Local. Resolves
   * to how many slash-command lookups the tile had made when the edit began.
   */
  async function renderEditingLocalMessage(): Promise<number> {
    hostState.boundFolder = { mode: "worktree", worktreePath: WORKTREE_A };
    chatHarness.teardown();
    chatHarness.install("owner", [
      {
        ...queuedPromptItem("queue-edit-target", QUEUED_CONTENT),
        worktreeIntent: LOCAL_PICK,
      },
    ]);
    renderChatTile();
    await waitForChatTileLoaded();
    await waitFor(() => {
      expect(submitCapture.mentionRoots).toEqual([WORKTREE_A]);
    });
    expect(submitCapture.runWorkingDirectory).toBe(WORKTREE_A);
    const lookupsBeforeEdit = tileSlashLookups.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(editingPillQueueItemId()).toBe("queue-edit-target");
    });
    return lookupsBeforeEdit;
  }

  /** Every lookup the tile made after `count`, each kept as its own record. */
  function lookupsSince(count: number): ReadonlyArray<ReadonlyArray<string>> {
    return tileSlashLookups
      .slice(count)
      .map((lookup) => lookup.workingDirectories);
  }

  it("points the composer's discovery at the edited message's folders, not the chat's worktree", async () => {
    await renderEditingLocalMessage();

    await waitFor(() => {
      expect(submitCapture.mentionRoots).toEqual([PROJECT_PATH]);
    });
    expect(submitCapture.runWorkingDirectory).toBe(PROJECT_PATH);
  });

  it("keeps the tile's own send paths looking up slash commands in the chat's next-send folders", async () => {
    const lookupsBeforeEdit = await renderEditingLocalMessage();

    const lookups = lookupsSince(lookupsBeforeEdit);
    expect(lookups.length).toBeGreaterThan(0);
    for (const directories of lookups) {
      expect(directories).toEqual([WORKTREE_A]);
    }
  });

  it("keeps the inline edit of a sent message looking up slash commands in the chat's next-send folders", async () => {
    // A sent message can be edited only while no turn runs.
    hostState.turnRunning = false;
    await renderEditingLocalMessage();
    const lookupsBeforeInlineEdit = tileSlashLookups.length;

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    await waitFor(() => {
      expect(screen.getAllByRole("textbox")).toHaveLength(2);
    });

    const lookups = lookupsSince(lookupsBeforeInlineEdit);
    expect(lookups.length).toBeGreaterThan(0);
    for (const directories of lookups) {
      expect(directories).toEqual([WORKTREE_A]);
    }
  });

  it("starts a /btw side chat from the edit in the edited message's folders", async () => {
    await renderEditingLocalMessage();
    const onSideChat = submitCapture.onSideChat;
    if (onSideChat === null) {
      throw new Error("expected ChatTile to wire onSideChat");
    }

    act(() => {
      onSideChat({
        command: "side",
        content: SIDE_CHAT_CONTENT,
        settings: QUEUED_SETTINGS,
      });
    });

    expect(createChatCapture.calls).toHaveLength(1);
    expect(createChatCapture.calls[0].request.worktreeIntent?.entries).toEqual([
      expect.objectContaining({ kind: "local", workspacePath: PROJECT_PATH }),
    ]);
  });
});
