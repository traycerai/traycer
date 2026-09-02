import { describe, expect, it } from "vitest";
import { dialPriorityForMethod } from "../dial-priority";

describe("dialPriorityForMethod", () => {
  it("classifies a method on the background list as background", () => {
    expect(dialPriorityForMethod("agent.gui.listModels")).toBe("background");
  });

  it("defaults an unlisted method to interactive, so a method nobody classified is never starved", () => {
    expect(dialPriorityForMethod("some.method.nobody.listed")).toBe(
      "interactive",
    );
  });

  it.each([
    "epic.status.subscribe",
    "epic.state.subscribe",
    "artifact.subscribe",
    "chat.subscribe",
    "terminal.subscribe",
    "epic.getWorkspaceContext",
  ])("keeps the mounted-surface method %s interactive", (method) => {
    expect(dialPriorityForMethod(method)).toBe("interactive");
  });

  it.each([
    "providers.list",
    "epic.recordViewed",
    "host.notifications.markRead",
    "host.chatFork.get",
    "host.notifications.feed.subscribe",
    "host.notifications.cloudFeed.subscribe",
    "resources.subscribe",
    "epic.chatBackupStatus",
    "browser.sessions",
    "epic.listCollaborators",
    "epic.listCommentThreads",
    "worktree.listBindingsForEpic",
  ])("classifies the re-measure method %s as background", (method) => {
    expect(dialPriorityForMethod(method)).toBe("background");
  });

  it.each([
    "epic.listTasks",
    "epic.listChatRecords",
    "epic.listTuiAgents",
    "epic.listCloudChats",
  ])(
    "keeps the row-source method %s interactive, since a late answer is a visibly incomplete row set",
    (method) => {
      expect(dialPriorityForMethod(method)).toBe("interactive");
    },
  );
});
