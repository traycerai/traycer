import { describe, expect, it } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { uniteTaskChats } from "../compose-task-chat-list";

function chat(
  chatId: string,
  ownerUserId: string,
  title: string,
): CloudChatSummary {
  return {
    identity: { taskId: "task-1", chatId, ownerUserId },
    ownerHostId: "host-a",
    createdAt: 1,
    visibility: "task",
    title,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer: ownerUserId === "viewer",
  };
}

describe("uniteTaskChats", () => {
  it("keeps the viewer's rows in order and the viewer's row on a triple collision", () => {
    const viewer = [
      chat("b", "viewer", "viewer b"),
      chat("a", "viewer", "viewer a"),
    ];
    const arm = [chat("a", "viewer", "arm a"), chat("c", "member", "arm c")];

    const united = uniteTaskChats(viewer, arm);

    expect(united.map((row) => row.title)).toEqual([
      "viewer b",
      "viewer a",
      "arm c",
    ]);
  });

  it("keeps an arm row whose chatId matches but whose owner differs", () => {
    const united = uniteTaskChats(
      [chat("a", "viewer", "mine")],
      [chat("a", "member", "theirs")],
    );

    expect(united.map((row) => row.title)).toEqual(["mine", "theirs"]);
  });

  it("returns the same array for an empty arm and for an arm it adds nothing from", () => {
    const viewer = [chat("a", "viewer", "mine")];

    expect(uniteTaskChats(viewer, [])).toBe(viewer);
    expect(uniteTaskChats(viewer, [chat("a", "viewer", "dup")])).toBe(viewer);
  });
});
