import "./chat-tile-queue-edit-stubs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { submitCapture } from "./chat-tile-queue-edit-captures";
import {
  EPIC_ID,
  CHAT_ARTIFACT,
  QUEUED_CONTENT,
  chatHarness,
  LOCAL_FOLDER,
  hostState,
  resetQueueEditTileTest,
  cleanUpQueueEditTileTest,
  WORKTREE_A,
  LOCAL_PICK,
  IMPORT_B_PICK,
  SAVED_CONTENT,
  shell,
  SHELL_UNDER_A,
  editRow,
  BOUND_TO_A,
  renderRow,
  emitHostState,
  beginEdit,
  pickInEdit,
  saveEdit,
  queueEditFrames,
} from "./chat-tile-queue-edit-harness";

beforeEach(resetQueueEditTileTest);
afterEach(cleanUpQueueEditTileTest);

describe("chat-tile saving a queued message's folders while a chat shell runs where the chat is bound", () => {
  /** The host accepts every queue-edit frame sent so far. */
  function acceptQueueEditFrames(): void {
    act(() => {
      for (const frame of chatHarness.sent) {
        if (
          frame.kind !== "queueEdit" &&
          frame.kind !== "queueSettingsUpdate"
        ) {
          continue;
        }
        chatHarness.callbacks().onActionAck({
          kind: "actionAck",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: CHAT_ARTIFACT.id,
          clientActionId: frame.clientActionId,
          action: frame.kind,
          status: "accepted",
          reason: null,
          code: null,
          backgroundStopTaskIds: [],
          token: null,
        });
      }
    });
  }

  it("asks again about a shell in a worktree the message's own choice already left", async () => {
    await editRow(LOCAL_PICK, [SHELL_UNDER_A]);
    pickInEdit(IMPORT_B_PICK);

    void saveEdit(submitCapture.onSubmitMessage);

    await screen.findByTestId("teardown-commit-dialog");
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "npm run dev",
    );
    expect(queueEditFrames()).toEqual([]);
  });

  it("asks about the shell that started after an earlier save was applied, not about the earlier consent", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(IMPORT_B_PICK);
    const first = saveEdit(submitCapture.onSubmitMessage);
    await screen.findByTestId("teardown-commit-dialog");
    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));
    expect(await first).toBe(true);
    expect(queueEditFrames()).toHaveLength(1);

    // The host applied the edit (the row now chooses B) and a new shell runs in A.
    const later = shell("sh-later", "tail -f later.log", `${WORKTREE_A}/lib`);
    acceptQueueEditFrames();
    emitHostState(IMPORT_B_PICK, SAVED_CONTENT, [SHELL_UNDER_A, later]);
    await beginEdit();
    pickInEdit(LOCAL_PICK);
    void saveEdit(submitCapture.onSubmitMessage);

    await screen.findByTestId("teardown-commit-dialog");
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "tail -f later.log",
    );
    expect(queueEditFrames()).toHaveLength(1);
  });

  it("asks about a shell that started after an earlier save went straight through", async () => {
    await editRow(null, []);
    pickInEdit(IMPORT_B_PICK);
    expect(saveEdit(submitCapture.onSubmitMessage)).toBe(true);
    expect(queueEditFrames()).toHaveLength(1);

    acceptQueueEditFrames();
    emitHostState(IMPORT_B_PICK, SAVED_CONTENT, [SHELL_UNDER_A]);
    await beginEdit();
    pickInEdit(LOCAL_PICK);
    void saveEdit(submitCapture.onSubmitMessage);

    await screen.findByTestId("teardown-commit-dialog");
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "npm run dev",
    );
    expect(queueEditFrames()).toHaveLength(1);
  });

  it("asks about a shell in a worktree the chat was bound to after the message was queued", async () => {
    await renderRow(LOCAL_FOLDER, LOCAL_PICK, []);
    // A row ahead bound the folder to worktree A while this one waited.
    hostState.boundFolder = BOUND_TO_A;
    emitHostState(LOCAL_PICK, QUEUED_CONTENT, [SHELL_UNDER_A]);
    await beginEdit();
    pickInEdit(IMPORT_B_PICK);

    void saveEdit(submitCapture.onSubmitMessage);

    await screen.findByTestId("teardown-commit-dialog");
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "npm run dev",
    );
    expect(queueEditFrames()).toEqual([]);
  });

  it("saves a text-only edit straight through, though the message's own choice left a worktree a shell runs in", async () => {
    await editRow(LOCAL_PICK, [SHELL_UNDER_A]);

    expect(saveEdit(submitCapture.onSubmitMessage)).toBe(true);

    expect(screen.queryByTestId("teardown-commit-dialog")).toBeNull();
    expect(queueEditFrames()).toHaveLength(1);
  });

  it("judges a save by the picks made after the composer handed out its submit handler", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    const handedOutBeforeThePick = submitCapture.onSubmitMessage;
    pickInEdit(LOCAL_PICK);

    void saveEdit(handedOutBeforeThePick);

    await screen.findByTestId("teardown-commit-dialog");
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "npm run dev",
    );
    expect(queueEditFrames()).toEqual([]);
  });
});
