import "./chat-tile-queue-edit-stubs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { readStagedWorktreeIntent } from "@/stores/worktree/worktree-intent-staging-store";
import {
  selectorCapture,
  submitCapture,
} from "./chat-tile-queue-edit-captures";
import {
  QUEUED_CONTENT,
  queuedPromptItem,
  editingPillQueueItemId,
  chatHarness,
  PROJECT_PATH,
  LOCAL_FOLDER,
  hostState,
  emitChatSnapshot,
  resetQueueEditTileTest,
  cleanUpQueueEditTileTest,
  renderChatTile,
  waitForChatTileLoaded,
  WORKTREE_A,
  LOCAL_PICK,
  IMPORT_B_PICK,
  QUEUE_ITEM_ID,
  shell,
  SHELL_UNDER_A,
  editRow,
  emitHostState,
  editSlot,
  pickInEdit,
  saveEdit,
  queueEditFrames,
} from "./chat-tile-queue-edit-harness";

beforeEach(resetQueueEditTileTest);
afterEach(cleanUpQueueEditTileTest);

describe("chat-tile saving a queued message's folders while a chat shell runs where the chat is bound", () => {
  it("asks before a Save that moves a folder off the worktree a shell runs in, and says Save", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(LOCAL_PICK);

    void saveEdit(submitCapture.onSubmitMessage);

    const dialog = await screen.findByTestId("teardown-commit-dialog");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBe(
      screen.getByTestId("teardown-commit-immediate"),
    );
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "npm run dev",
    );
    expect(queueEditFrames()).toEqual([]);
  });

  it("asks for a pick that imports another worktree over the bound one", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(IMPORT_B_PICK);

    void saveEdit(submitCapture.onSubmitMessage);

    expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();
    expect(queueEditFrames()).toEqual([]);
  });

  it("saves straight through when the folder is bound Local, whatever shell runs in the project", async () => {
    hostState.boundFolder = LOCAL_FOLDER;
    hostState.shells = [shell("sh-p", "npm run dev", `${PROJECT_PATH}/apps`)];
    chatHarness.teardown();
    chatHarness.install("owner", [
      queuedPromptItem(QUEUE_ITEM_ID, QUEUED_CONTENT),
    ]);
    renderChatTile();
    await waitForChatTileLoaded();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(selectorCapture.editSessionId).not.toBeNull();
    });
    pickInEdit(IMPORT_B_PICK);

    expect(saveEdit(submitCapture.onSubmitMessage)).toBe(true);

    expect(screen.queryByTestId("teardown-commit-dialog")).toBeNull();
    expect(queueEditFrames()).toHaveLength(1);
  });

  it("leaves the edit open with its text and pick when the dialog is cancelled", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(LOCAL_PICK);
    const outcome = saveEdit(submitCapture.onSubmitMessage);
    await screen.findByTestId("teardown-commit-dialog");

    fireEvent.click(screen.getByTestId("teardown-commit-cancel"));

    expect(await outcome).toBe(false);
    expect(queueEditFrames()).toEqual([]);
    expect(editingPillQueueItemId()).toBe(QUEUE_ITEM_ID);
    expect(screen.getByRole("textbox").textContent).toContain(
      "edited queue item",
    );
    expect(readStagedWorktreeIntent(editSlot())).toEqual(LOCAL_PICK);
  });

  it("sends the edit once, with the pick, when the dialog is confirmed, and ends the edit", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(LOCAL_PICK);
    const outcome = saveEdit(submitCapture.onSubmitMessage);
    await screen.findByTestId("teardown-commit-dialog");

    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

    expect(await outcome).toBe(true);
    const frames = queueEditFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "queueEdit",
      worktreeIntent: LOCAL_PICK,
    });
    expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();
  });

  it("saves nothing on confirm when the message began while the dialog was open, though the queue still lists it", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(LOCAL_PICK);
    const outcome = saveEdit(submitCapture.onSubmitMessage);
    await screen.findByTestId("teardown-commit-dialog");

    hostState.begunQueuedMessageIds = [
      queuedPromptItem(QUEUE_ITEM_ID, QUEUED_CONTENT).messageId,
    ];
    emitHostState(null, QUEUED_CONTENT, [SHELL_UNDER_A]);
    await waitFor(() => {
      expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();
    });
    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

    expect(await outcome).toBe(false);
    expect(queueEditFrames()).toEqual([]);
    expect(screen.queryByTestId("teardown-commit-dialog")).toBeNull();
  });

  it("asks again when the shells changed while the dialog was open, and sends only on the second confirm", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(LOCAL_PICK);
    const outcome = saveEdit(submitCapture.onSubmitMessage);
    await screen.findByTestId("teardown-commit-dialog");

    hostState.shells = [
      SHELL_UNDER_A,
      shell("sh-other", "sleep 1", `${WORKTREE_A}/lib`),
    ];
    act(() => {
      emitChatSnapshot(chatHarness.callbacks(), "owner", [
        queuedPromptItem(QUEUE_ITEM_ID, QUEUED_CONTENT),
      ]);
    });
    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

    expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "sleep 1",
    );
    expect(queueEditFrames()).toEqual([]);

    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

    expect(await outcome).toBe(true);
    expect(queueEditFrames()).toHaveLength(1);
  });

  it("lists only the shells under the worktree being left, not the running turn or a shell elsewhere", async () => {
    await editRow(null, [
      SHELL_UNDER_A,
      shell("sh-else", "tail -f log", "/Users/test/elsewhere"),
    ]);
    pickInEdit(LOCAL_PICK);

    void saveEdit(submitCapture.onSubmitMessage);

    await screen.findByTestId("teardown-commit-dialog");
    const labels = screen.getAllByTestId("teardown-holder-label");
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toContain("npm run dev");
    expect(screen.getByTestId("teardown-disclosure").textContent).not.toMatch(
      /agent is still working/,
    );
  });
});
