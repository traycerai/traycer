import "./chat-tile-queue-edit-stubs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { submitCapture } from "./chat-tile-queue-edit-captures";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import {
  BEGUN_DIALOG,
  BEGUN_NOTICE,
  CHAT_ARTIFACT,
  EPIC_ID,
  LOCAL_FOLDER,
  QUEUE_ITEM_ID,
  QUEUED_CONTENT,
  REMOVED_DIALOG,
  REMOVED_NOTICE,
  beginEdit,
  chatHarness,
  cleanUpQueueEditTileTest,
  emitChatSnapshot,
  editRow,
  editingPillQueueItemId,
  hostState,
  LOCAL_PICK,
  pickInEdit,
  queueEditFrames,
  queuedPromptItem,
  renderChatTile,
  renderRow,
  saveEdit,
  SHELL_UNDER_A,
  resetQueueEditTileTest,
  toastTitles,
  waitForChatTileLoaded,
} from "./chat-tile-queue-edit-harness";

beforeEach(resetQueueEditTileTest);
afterEach(cleanUpQueueEditTileTest);

function composerText(): string {
  return screen.getByTestId("composer-editor").textContent;
}

function draftText(): string {
  const draft = useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id];
  return draft === undefined
    ? ""
    : extractPlainTextFromComposerJSONContent(draft.content);
}

/** Types into the composer the way the browser does: the editor reads the DOM change. */
async function typeAtEnd(suffix: string): Promise<void> {
  const paragraph = screen
    .getByTestId("composer-editor")
    .querySelector('[contenteditable="true"] p');
  const text = paragraph?.firstChild;
  if (text === null || text === undefined || text.nodeType !== Node.TEXT_NODE) {
    throw new Error("expected the composer's text node");
  }
  const before = text.textContent ?? "";
  act(() => {
    text.textContent = `${before}${suffix}`;
  });
  await waitFor(() => {
    expect(draftText()).toBe(`${before}${suffix}`);
  });
}

/** The host begins the queued row: its message is in the transcript and the queue no longer lists it. */
function startQueuedRow(): void {
  hostState.begunQueuedMessageIds = [
    queuedPromptItem(QUEUE_ITEM_ID, QUEUED_CONTENT).messageId,
  ];
  act(() => {
    emitChatSnapshot(chatHarness.callbacks(), "owner", []);
  });
}

/**
 * Another window cancelled the queued row. The queue stops listing it (a
 * snapshot also resets the transcript's events), then the cancel event names it.
 */
function removeQueuedRowElsewhere(): void {
  act(() => {
    emitChatSnapshot(chatHarness.callbacks(), "owner", []);
    chatHarness.callbacks().onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ARTIFACT.id,
      event: {
        eventId: "event-queue-cancelled",
        type: "queue.cancelled",
        timestamp: 20,
        clientActionId: null,
        actor: null,
        message: null,
        turnId: null,
        messageId: queuedPromptItem(QUEUE_ITEM_ID, QUEUED_CONTENT).messageId,
        queueItemId: QUEUE_ITEM_ID,
        approvalId: null,
        blockId: null,
        severity: "info",
        metadata: {},
      },
    });
  });
}

async function editEnded(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();
  });
}

function seedEarlierDraft(): void {
  useComposerDraftStore.getState().replaceDraft(
    CHAT_ARTIFACT.id,
    {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "earlier" }] },
      ],
    },
    null,
  );
}

describe("chat-tile: a queued message leaves the queue while its edit is open", () => {
  it("keeps the edited text as the draft and says so once when the row begins", async () => {
    await renderRow(LOCAL_FOLDER, null, []);
    await beginEdit();
    await typeAtEnd(", and more");

    startQueuedRow();
    await editEnded();

    expect(composerText()).toBe("edited queue item, and more");
    expect(draftText()).toBe("edited queue item, and more");
    expect(toastTitles()).toEqual([BEGUN_NOTICE]);

    act(() => {
      emitChatSnapshot(chatHarness.callbacks(), "owner", []);
    });
    expect(toastTitles()).toEqual([BEGUN_NOTICE]);
  });

  it("puts the edited text above the earlier draft when the row begins", async () => {
    seedEarlierDraft();
    await renderRow(LOCAL_FOLDER, null, []);
    await beginEdit();
    await typeAtEnd(", and more");

    startQueuedRow();
    await editEnded();

    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "edited queue item, and more" }],
        },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "earlier" }] },
      ],
    });
    // The composer shows that document: three paragraphs, the middle empty.
    expect(composerText()).toBe("edited queue item, and moreearlier");
    expect(toastTitles()).toEqual([BEGUN_NOTICE]);
  });

  it("restores the earlier draft without a notice when the row begins with the text unchanged", async () => {
    seedEarlierDraft();
    await renderRow(LOCAL_FOLDER, null, []);
    await beginEdit();

    startQueuedRow();
    await editEnded();

    expect(composerText()).toBe("earlier");
    expect(draftText()).toBe("earlier");
    expect(toastTitles()).toEqual([]);
  });

  it("judges the row the edit switched to, so that row beginning unchanged restores the earlier draft", async () => {
    seedEarlierDraft();
    const firstRow = queuedPromptItem("queue-first", {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "first queue item" }],
        },
      ],
    });
    chatHarness.teardown();
    chatHarness.install("owner", [
      firstRow,
      queuedPromptItem(QUEUE_ITEM_ID, QUEUED_CONTENT),
    ]);
    renderChatTile();
    await waitForChatTileLoaded();
    const [editFirst, editTarget] = screen.getAllByRole("button", {
      name: "Edit queued message",
    });
    fireEvent.click(editFirst);
    fireEvent.click(editTarget);
    await waitFor(() => {
      expect(editingPillQueueItemId()).toBe(QUEUE_ITEM_ID);
    });

    hostState.begunQueuedMessageIds = [
      queuedPromptItem(QUEUE_ITEM_ID, QUEUED_CONTENT).messageId,
    ];
    act(() => {
      emitChatSnapshot(chatHarness.callbacks(), "owner", [firstRow]);
    });
    await editEnded();

    expect(composerText()).toBe("earlier");
    expect(toastTitles()).toEqual([]);
  });

  it("keeps the edited text and says the message was removed when another window cancels the row", async () => {
    await renderRow(LOCAL_FOLDER, null, []);
    await beginEdit();
    await typeAtEnd(", and more");

    removeQueuedRowElsewhere();
    await editEnded();

    expect(composerText()).toBe("edited queue item, and more");
    expect(toastTitles()).toEqual([REMOVED_NOTICE]);
  });
});

describe("chat-tile: a queued message leaves the queue while the folder dialog is open for its Save", () => {
  it("closes the dialog by itself when the row begins and saves nothing, then the notice follows", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    await typeAtEnd(", and more");
    pickInEdit(LOCAL_PICK);
    const staleSubmit = submitCapture.onSubmitMessage;
    const outcome = saveEdit(staleSubmit);
    await screen.findByTestId("teardown-commit-dialog");

    startQueuedRow();

    expect(await outcome).toBe(false);
    await editEnded();
    expect(screen.queryByTestId("teardown-commit-dialog")).toBeNull();
    expect(toastTitles()).toEqual([BEGUN_DIALOG, BEGUN_NOTICE]);
    expect(queueEditFrames()).toEqual([]);
    expect(await saveEdit(staleSubmit)).toBe(false);
    expect(queueEditFrames()).toEqual([]);
  });

  it("closes the dialog and says the message was removed when another window cancels the row", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(LOCAL_PICK);
    const outcome = saveEdit(submitCapture.onSubmitMessage);
    await screen.findByTestId("teardown-commit-dialog");

    removeQueuedRowElsewhere();

    expect(await outcome).toBe(false);
    await editEnded();
    expect(screen.queryByTestId("teardown-commit-dialog")).toBeNull();
    expect(toastTitles()).toEqual([REMOVED_DIALOG]);
  });

  it("says the message started when Save is pressed on a row the queue no longer lists but no one removed", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(LOCAL_PICK);
    const outcome = saveEdit(submitCapture.onSubmitMessage);
    await screen.findByTestId("teardown-commit-dialog");

    act(() => {
      emitChatSnapshot(chatHarness.callbacks(), "owner", []);
    });
    expect(screen.getByTestId("teardown-commit-dialog")).toBeTruthy();
    expect(toastTitles()).toEqual([]);
    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

    expect(await outcome).toBe(false);
    expect(screen.queryByTestId("teardown-commit-dialog")).toBeNull();
    expect(toastTitles()).toEqual([BEGUN_DIALOG]);
    expect(queueEditFrames()).toEqual([]);
  });
});
