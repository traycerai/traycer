import { describe, expect, it } from "vitest";
import {
  buildFocusBackground,
  parseManagedCommandRowKey,
} from "@/lib/home-focus/focus-background";
import {
  makeFocusBackgroundChat,
  makeManagedCommand,
  makeRunningBackgroundItem,
  makeWakeupBackgroundItem,
} from "@/lib/home-focus/__tests__/fixtures";

describe("buildFocusBackground", () => {
  it("turns a running managed command into a managed-command row with startedAtMs, label and stoppable from hostId", () => {
    const chatWithHost = makeFocusBackgroundChat({
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "host-1",
      managedCommands: [
        makeManagedCommand({
          id: "cmd-1",
          description: "deploy watcher",
          status: { state: "running", pid: 42, startedAtMs: 12_345 },
        }),
      ],
    });
    const chatWithoutHost = makeFocusBackgroundChat({
      epicId: "epic-2",
      chatId: "chat-2",
      hostId: null,
      managedCommands: [
        makeManagedCommand({
          id: "cmd-2",
          description: "build watcher",
          status: { state: "running", pid: 43, startedAtMs: 99_999 },
        }),
      ],
    });

    const rows = buildFocusBackground([chatWithHost, chatWithoutHost], []);
    const byEpic = new Map(rows.map((row) => [row.epicId, row]));

    expect(byEpic.get("epic-1")).toMatchObject({
      kind: "managed-command",
      label: "deploy watcher",
      // A durable shell is not a node of a turn, so it has no kind on that
      // plane and the row does not invent one.
      itemKind: null,
      startedAtMs: 12_345,
      stoppable: true,
    });
    expect(byEpic.get("epic-2")).toMatchObject({
      kind: "managed-command",
      label: "build watcher",
      itemKind: null,
      startedAtMs: 99_999,
      stoppable: false,
    });
  });

  it("only surfaces root, non-wakeup background items; every one is unstoppable with no startedAtMs", () => {
    const chat = makeFocusBackgroundChat({
      epicId: "epic-1",
      chatId: "chat-1",
      backgroundItems: [
        makeRunningBackgroundItem({ taskId: "task-root", title: "Subagent" }),
        makeRunningBackgroundItem({
          taskId: "task-child",
          title: "Nested",
          parentTaskId: "task-root",
        }),
        makeWakeupBackgroundItem({
          taskId: "task-wakeup",
          title: "Scheduled wake",
          scheduledFor: 999,
        }),
      ],
    });

    const rows = buildFocusBackground([chat], []);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "background-item",
      label: "Subagent",
      itemKind: "subagent",
      startedAtMs: null,
      stoppable: false,
    });
  });

  // The row carries the item's own kind so Home can draw the same glyph the
  // chat's Background panel draws for it. Presentation only - nothing routes
  // on it - but it has to be the item's kind, not the plane's.
  it("carries each background item's own kind onto its row", () => {
    const chat = makeFocusBackgroundChat({
      epicId: "epic-1",
      chatId: "chat-1",
      backgroundItems: [
        makeRunningBackgroundItem({ taskId: "task-a", kind: "monitor" }),
        makeRunningBackgroundItem({ taskId: "task-b", kind: "subagent" }),
      ],
    });

    const rows = buildFocusBackground([chat], []);

    expect(rows.map((row) => row.itemKind)).toEqual(["monitor", "subagent"]);
  });

  it("orders rows by epic asc, then chat asc, then managed-command before background-item, then key asc", () => {
    const chatB = makeFocusBackgroundChat({
      epicId: "epic-b",
      chatId: "chat-1",
      hostId: "host-1",
      managedCommands: [makeManagedCommand({ id: "cmd-b" })],
    });
    const chatAChat2 = makeFocusBackgroundChat({
      epicId: "epic-a",
      chatId: "chat-2",
      hostId: "host-1",
      backgroundItems: [
        makeRunningBackgroundItem({ taskId: "task-a2", title: "A2" }),
      ],
    });
    const chatAChat1BackgroundItem = makeFocusBackgroundChat({
      epicId: "epic-a",
      chatId: "chat-1",
      backgroundItems: [
        makeRunningBackgroundItem({ taskId: "task-a1", title: "A1 item" }),
      ],
    });
    const chatAChat1ManagedCommand = makeFocusBackgroundChat({
      epicId: "epic-a",
      chatId: "chat-1",
      hostId: "host-1",
      // Two commands in the same epic/chat to exercise the final "key asc"
      // tie-break: their keys differ only by commandId.
      managedCommands: [
        makeManagedCommand({ id: "cmd-z" }),
        makeManagedCommand({ id: "cmd-a" }),
      ],
    });

    const rows = buildFocusBackground(
      [chatB, chatAChat2, chatAChat1BackgroundItem, chatAChat1ManagedCommand],
      [],
    );

    expect(
      rows.map((row) => ({
        epicId: row.epicId,
        chatId: row.chatId,
        kind: row.kind,
      })),
    ).toEqual([
      { epicId: "epic-a", chatId: "chat-1", kind: "managed-command" },
      { epicId: "epic-a", chatId: "chat-1", kind: "managed-command" },
      { epicId: "epic-a", chatId: "chat-1", kind: "background-item" },
      { epicId: "epic-a", chatId: "chat-2", kind: "background-item" },
      { epicId: "epic-b", chatId: "chat-1", kind: "managed-command" },
    ]);
    // The two epic-a/chat-1 managed-command rows tie on epic, chat and kind;
    // the key (which embeds commandId last) breaks the tie ascending.
    const epicAManagedCommandKeys = rows
      .filter(
        (row) => row.epicId === "epic-a" && row.kind === "managed-command",
      )
      .map((row) => row.key);
    expect(epicAManagedCommandKeys).toEqual(
      [...epicAManagedCommandKeys].sort(),
    );
  });

  describe("identity stability", () => {
    it("returns the same array reference when rebuilt from unchanged content", () => {
      const chat = makeFocusBackgroundChat({
        epicId: "epic-1",
        chatId: "chat-1",
        hostId: "host-1",
        managedCommands: [makeManagedCommand({ id: "cmd-1" })],
      });

      const first = buildFocusBackground([chat], []);
      const second = buildFocusBackground([chat], first);

      expect(second).toBe(first);
    });
  });
});

describe("parseManagedCommandRowKey", () => {
  it("round-trips a managed-command row's key back to {hostId, epicId, commandId}", () => {
    const chat = makeFocusBackgroundChat({
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "host-1",
      managedCommands: [makeManagedCommand({ id: "cmd-1" })],
    });

    const [row] = buildFocusBackground([chat], []);

    expect(parseManagedCommandRowKey(row.key)).toEqual({
      hostId: "host-1",
      epicId: "epic-1",
      commandId: "cmd-1",
    });
  });

  it("returns null for a background-item row's key", () => {
    const chat = makeFocusBackgroundChat({
      epicId: "epic-1",
      chatId: "chat-1",
      backgroundItems: [
        makeRunningBackgroundItem({ taskId: "task-1", title: "Subagent" }),
      ],
    });

    const [row] = buildFocusBackground([chat], []);

    expect(parseManagedCommandRowKey(row.key)).toBeNull();
  });

  it("returns null for a managed-command row built with hostId: null", () => {
    const chat = makeFocusBackgroundChat({
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: null,
      managedCommands: [makeManagedCommand({ id: "cmd-1" })],
    });

    const [row] = buildFocusBackground([chat], []);

    expect(parseManagedCommandRowKey(row.key)).toBeNull();
  });
});
