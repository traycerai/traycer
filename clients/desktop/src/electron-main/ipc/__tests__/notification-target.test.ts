import { describe, expect, it } from "vitest";
import type {
  JsonValue,
  PerWindowSnapshot,
} from "../../../ipc-contracts/window-types";
import {
  findWindowIdForOpenArtifact,
  findWindowIdForOpenChat,
  findWindowIdForOpenTab,
  parseNotificationClickTarget,
  type NotificationTargetPerWindowState,
  type NotificationTargetWindowRegistry,
} from "../notification-target";

const VALID_FEED = { source: "host", id: "row-1" } as const;

const ALL_NULL_TARGET = {
  epicId: null,
  chatId: null,
  tabId: null,
  artifactId: null,
  originHostId: null,
} as const;

function emptySnapshot(): PerWindowSnapshot {
  return {
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
  };
}

function tileRef(
  id: string,
  options: {
    readonly type: string;
    readonly hostId: string | null;
  },
): JsonValue {
  if (options.hostId === null) {
    return { id, type: options.type };
  }
  return { id, type: options.type, hostId: options.hostId };
}

function canvasWithTiles(
  tiles: Readonly<Record<string, JsonValue>>,
): JsonValue {
  return { tilesByInstanceId: tiles };
}

function snapshotWithTile(options: {
  readonly tabId: string;
  readonly epicId: string;
  readonly tileId: string;
  readonly tileType: string;
  readonly hostId: string | null;
}): PerWindowSnapshot {
  return {
    epicTabs: [{ id: options.tabId, epicId: options.epicId, name: "Epic" }],
    activeTabId: options.tabId,
    canvasByTabId: {
      [options.tabId]: canvasWithTiles({
        "tile-1": tileRef(options.tileId, {
          type: options.tileType,
          hostId: options.hostId,
        }),
      }),
    },
    landingDrafts: [],
    activeLandingDraftId: null,
  };
}

class FakeRegistry implements NotificationTargetWindowRegistry {
  private readonly windowIds: string[];

  constructor(windowIds: readonly string[]) {
    this.windowIds = [...windowIds];
  }

  records(): ReadonlyArray<{ readonly windowId: string }> {
    return this.windowIds.map((windowId) => ({ windowId }));
  }
}

class FakePerWindowState implements NotificationTargetPerWindowState {
  private readonly snapshots: Map<string, PerWindowSnapshot>;

  constructor(entries: ReadonlyArray<readonly [string, PerWindowSnapshot]>) {
    this.snapshots = new Map(entries);
  }

  get(windowId: string): PerWindowSnapshot {
    return this.snapshots.get(windowId) ?? emptySnapshot();
  }
}

describe("parseNotificationClickTarget", () => {
  it("extracts nested route epicId/chatId and originHostId from a V1 envelope", () => {
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
        feed: VALID_FEED,
        originHostId: "host-1",
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: "chat-1",
      tabId: null,
      artifactId: null,
      originHostId: "host-1",
    });
  });

  it("ignores chatId for non-chat V1 route kinds", () => {
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: {
          kind: "epic",
          epicId: "epic-1",
          chatId: "should-be-ignored",
        },
        feed: VALID_FEED,
        originHostId: "host-1",
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: null,
      tabId: null,
      artifactId: null,
      originHostId: "host-1",
    });
  });

  it("parses a legacy raw chat payload with null originHostId", () => {
    expect(
      parseNotificationClickTarget({
        kind: "chat",
        epicId: "epic-legacy",
        chatId: "chat-legacy",
        originHostId: "should-be-ignored",
      }),
    ).toEqual({
      epicId: "epic-legacy",
      chatId: "chat-legacy",
      tabId: null,
      artifactId: null,
      originHostId: null,
    });
  });

  it("returns all-null for malformed or garbage payloads", () => {
    expect(parseNotificationClickTarget(null)).toEqual(ALL_NULL_TARGET);
    expect(parseNotificationClickTarget("not-an-object")).toEqual(
      ALL_NULL_TARGET,
    );
    expect(parseNotificationClickTarget([1, 2, 3])).toEqual(ALL_NULL_TARGET);
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: "not-a-route",
        feed: VALID_FEED,
        originHostId: null,
      }),
    ).toEqual(ALL_NULL_TARGET);
  });

  it("returns all-null for envelope-shaped payloads with unsupported version (no legacy fallthrough)", () => {
    // Top-level epicId must not leak through the legacy path.
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 2,
        epicId: "epic-top-level",
        chatId: "chat-top-level",
        route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
        feed: VALID_FEED,
        originHostId: "host-1",
      }),
    ).toEqual(ALL_NULL_TARGET);
  });

  it("returns all-null when originHostId is not string | null", () => {
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
        feed: VALID_FEED,
        originHostId: 42,
      }),
    ).toEqual(ALL_NULL_TARGET);
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
        feed: VALID_FEED,
        // missing originHostId key → undefined, not string|null
      }),
    ).toEqual(ALL_NULL_TARGET);
  });

  it("returns all-null when feed is missing or malformed", () => {
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
        originHostId: "host-1",
      }),
    ).toEqual(ALL_NULL_TARGET);
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
        feed: { source: "not-a-source", id: "row-1" },
        originHostId: "host-1",
      }),
    ).toEqual(ALL_NULL_TARGET);
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
        feed: { source: "host", id: "" },
        originHostId: "host-1",
      }),
    ).toEqual(ALL_NULL_TARGET);
  });

  it("yields no epicId/chatId for unknown route.kind inside a valid V1 envelope", () => {
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: {
          kind: "future-route-kind",
          epicId: "epic-1",
          chatId: "chat-1",
        },
        feed: VALID_FEED,
        originHostId: "host-1",
      }),
    ).toEqual({
      epicId: null,
      chatId: null,
      tabId: null,
      artifactId: null,
      originHostId: "host-1",
    });
  });

  it("yields null route fields for session route kind", () => {
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: { kind: "session", epicId: "epic-1", chatId: "chat-1" },
        feed: VALID_FEED,
        originHostId: "host-1",
      }),
    ).toEqual({
      epicId: null,
      chatId: null,
      tabId: null,
      artifactId: null,
      originHostId: "host-1",
    });
  });

  it("treats empty-string epicId/chatId as absent", () => {
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: { kind: "chat", epicId: "", chatId: "" },
        feed: VALID_FEED,
        originHostId: null,
      }),
    ).toEqual({
      epicId: null,
      chatId: null,
      tabId: null,
      artifactId: null,
      originHostId: null,
    });
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: { kind: "chat", epicId: "epic-1", chatId: "" },
        feed: VALID_FEED,
        originHostId: null,
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: null,
      tabId: null,
      artifactId: null,
      originHostId: null,
    });
  });

  it("returns null chatId/tabId/artifactId for legacy non-target epic routes", () => {
    expect(
      parseNotificationClickTarget({
        kind: "epic",
        epicId: "epic-1",
        chatId: "ignored",
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: null,
      tabId: null,
      artifactId: null,
      originHostId: null,
    });
  });

  it("preserves chatId for legacy approval/interview routes, same as chat", () => {
    expect(
      parseNotificationClickTarget({
        kind: "approval",
        epicId: "epic-1",
        chatId: "chat-1",
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: "chat-1",
      tabId: null,
      artifactId: null,
      originHostId: null,
    });
    expect(
      parseNotificationClickTarget({
        kind: "interview",
        epicId: "epic-1",
        chatId: "chat-1",
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: "chat-1",
      tabId: null,
      artifactId: null,
      originHostId: null,
    });
  });

  it("preserves chatId for approval/interview routes nested in a V1 envelope", () => {
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: { kind: "approval", epicId: "epic-1", chatId: "chat-1" },
        feed: VALID_FEED,
        originHostId: "host-1",
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: "chat-1",
      tabId: null,
      artifactId: null,
      originHostId: "host-1",
    });
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: { kind: "interview", epicId: "epic-1", chatId: "chat-1" },
        feed: VALID_FEED,
        originHostId: "host-1",
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: "chat-1",
      tabId: null,
      artifactId: null,
      originHostId: "host-1",
    });
  });

  it("extracts tabId (not chatId) for terminal routes", () => {
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: {
          kind: "terminal",
          epicId: "epic-1",
          tabId: "tab-1",
          terminalId: "term-1",
          paneId: "pane-1",
          tileInstanceId: "tile-1",
        },
        feed: VALID_FEED,
        originHostId: "host-1",
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: null,
      tabId: "tab-1",
      artifactId: null,
      originHostId: "host-1",
    });
    expect(
      parseNotificationClickTarget({
        kind: "terminal",
        epicId: "epic-1",
        tabId: "tab-1",
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: null,
      tabId: "tab-1",
      artifactId: null,
      originHostId: null,
    });
  });

  it("extracts artifactId (not chatId/tabId) for artifact routes", () => {
    expect(
      parseNotificationClickTarget({
        kind: "notificationActivation",
        version: 1,
        route: {
          kind: "artifact",
          epicId: "epic-1",
          artifactId: "artifact-1",
          threadId: "thread-1",
        },
        feed: VALID_FEED,
        originHostId: "host-1",
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: null,
      tabId: null,
      artifactId: "artifact-1",
      originHostId: "host-1",
    });
    expect(
      parseNotificationClickTarget({
        kind: "artifact",
        epicId: "epic-1",
        artifactId: "artifact-1",
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: null,
      tabId: null,
      artifactId: "artifact-1",
      originHostId: null,
    });
  });
});

describe("findWindowIdForOpenChat", () => {
  it("returns the non-MRU window that already has the chat open", () => {
    const registry = new FakeRegistry(["window-mru", "window-open"]);
    const state = new FakePerWindowState([
      ["window-mru", emptySnapshot()],
      [
        "window-open",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "chat-1",
          tileType: "chat",
          hostId: "host-1",
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-1", null),
    ).toBe("window-open");
  });

  it("returns null when the chat is not open anywhere", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      [
        "window-a",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "other-chat",
          tileType: "chat",
          hostId: null,
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-1", null),
    ).toBeNull();
  });

  it("returns null when the same epic is open but with a different chatId", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      [
        "window-a",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "chat-other",
          tileType: "chat",
          hostId: null,
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-wanted", null),
    ).toBeNull();
  });

  it("returns null when tile id matches but tile type is not chat/terminal-agent/terminal", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      [
        "window-a",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "chat-1",
          tileType: "artifact",
          hostId: null,
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-1", null),
    ).toBeNull();
  });

  it("returns null when originHostId is set and tile hostId differs", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      [
        "window-a",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "chat-1",
          tileType: "chat",
          hostId: "host-other",
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-1", "host-1"),
    ).toBeNull();
  });

  it("matches when originHostId is set and tile hostId agrees", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      [
        "window-a",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "chat-1",
          tileType: "chat",
          hostId: "host-1",
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-1", "host-1"),
    ).toBe("window-a");
  });

  it("does not require hostId when originHostId is null", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      [
        "window-a",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "chat-1",
          tileType: "chat",
          hostId: "host-anything",
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-1", null),
    ).toBe("window-a");
  });

  it("matches terminal-agent tile types", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      [
        "window-a",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "chat-1",
          tileType: "terminal-agent",
          hostId: null,
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-1", null),
    ).toBe("window-a");
  });

  it("matches a raw terminal tile type, for the legacy chatId-as-terminal-id shape", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      [
        "window-a",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "terminal-1",
          tileType: "terminal",
          hostId: null,
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenChat(registry, state, "epic-1", "terminal-1", null),
    ).toBe("window-a");
  });

  it("returns null without throwing for structurally malformed snapshots", () => {
    const registry = new FakeRegistry([
      "window-missing-canvas-entry",
      "window-odd-canvas",
      "window-odd-tiles",
      "window-tile-not-object",
    ]);
    const state = new FakePerWindowState([
      [
        "window-missing-canvas-entry",
        {
          epicTabs: [{ id: "tab-1", epicId: "epic-1", name: "Epic" }],
          activeTabId: "tab-1",
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        },
      ],
      [
        "window-odd-canvas",
        {
          epicTabs: [{ id: "tab-1", epicId: "epic-1", name: "Epic" }],
          activeTabId: "tab-1",
          canvasByTabId: { "tab-1": "not-an-object" },
          landingDrafts: [],
          activeLandingDraftId: null,
        },
      ],
      [
        "window-odd-tiles",
        {
          epicTabs: [{ id: "tab-1", epicId: "epic-1", name: "Epic" }],
          activeTabId: "tab-1",
          canvasByTabId: {
            "tab-1": { tilesByInstanceId: "not-an-object" },
          },
          landingDrafts: [],
          activeLandingDraftId: null,
        },
      ],
      [
        "window-tile-not-object",
        {
          epicTabs: [{ id: "tab-1", epicId: "epic-1", name: "Epic" }],
          activeTabId: "tab-1",
          canvasByTabId: {
            "tab-1": { tilesByInstanceId: { "tile-1": "not-a-tile" } },
          },
          landingDrafts: [],
          activeLandingDraftId: null,
        },
      ],
    ]);
    expect(() =>
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-1", null),
    ).not.toThrow();
    expect(
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-1", null),
    ).toBeNull();
  });

  it("skips registry windowIds that have no snapshot entry", () => {
    const registry = new FakeRegistry(["dead-window", "window-open"]);
    const state = new FakePerWindowState([
      [
        "window-open",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "chat-1",
          tileType: "chat",
          hostId: null,
        }),
      ],
    ]);
    expect(() =>
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-1", null),
    ).not.toThrow();
    expect(
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-1", null),
    ).toBe("window-open");
  });

  it("returns the first matching window in registry order", () => {
    const registry = new FakeRegistry(["window-first", "window-second"]);
    const state = new FakePerWindowState([
      [
        "window-first",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "chat-1",
          tileType: "chat",
          hostId: null,
        }),
      ],
      [
        "window-second",
        snapshotWithTile({
          tabId: "tab-2",
          epicId: "epic-1",
          tileId: "chat-1",
          tileType: "chat",
          hostId: null,
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenChat(registry, state, "epic-1", "chat-1", null),
    ).toBe("window-first");
  });
});

describe("findWindowIdForOpenArtifact", () => {
  it("returns the non-MRU window that already has the artifact open", () => {
    const registry = new FakeRegistry(["window-mru", "window-open"]);
    const state = new FakePerWindowState([
      ["window-mru", emptySnapshot()],
      [
        "window-open",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "artifact-1",
          tileType: "spec",
          hostId: null,
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenArtifact(
        registry,
        state,
        "epic-1",
        "artifact-1",
        null,
      ),
    ).toBe("window-open");
  });

  it("matches regardless of tile type, unlike findWindowIdForOpenChat", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      [
        "window-a",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "artifact-1",
          tileType: "workspace-file",
          hostId: null,
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenArtifact(
        registry,
        state,
        "epic-1",
        "artifact-1",
        null,
      ),
    ).toBe("window-a");
  });

  it("returns null when the artifact is not open anywhere", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      [
        "window-a",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "other-artifact",
          tileType: "spec",
          hostId: null,
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenArtifact(
        registry,
        state,
        "epic-1",
        "artifact-1",
        null,
      ),
    ).toBeNull();
  });

  it("returns null when originHostId is set and tile hostId differs", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      [
        "window-a",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "artifact-1",
          tileType: "spec",
          hostId: "host-other",
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenArtifact(
        registry,
        state,
        "epic-1",
        "artifact-1",
        "host-1",
      ),
    ).toBeNull();
  });

  it("matches when originHostId is set and tile hostId agrees", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      [
        "window-a",
        snapshotWithTile({
          tabId: "tab-1",
          epicId: "epic-1",
          tileId: "artifact-1",
          tileType: "spec",
          hostId: "host-1",
        }),
      ],
    ]);
    expect(
      findWindowIdForOpenArtifact(
        registry,
        state,
        "epic-1",
        "artifact-1",
        "host-1",
      ),
    ).toBe("window-a");
  });
});

describe("findWindowIdForOpenTab", () => {
  function snapshotWithTab(tabId: string, epicId: string): PerWindowSnapshot {
    return {
      epicTabs: [{ id: tabId, epicId, name: "Epic" }],
      activeTabId: tabId,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    };
  }

  it("returns the non-MRU window that already has the tab open", () => {
    const registry = new FakeRegistry(["window-mru", "window-open"]);
    const state = new FakePerWindowState([
      ["window-mru", emptySnapshot()],
      ["window-open", snapshotWithTab("tab-1", "epic-1")],
    ]);
    expect(findWindowIdForOpenTab(registry, state, "epic-1", "tab-1")).toBe(
      "window-open",
    );
  });

  it("returns null when the tab is not open anywhere", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      ["window-a", snapshotWithTab("other-tab", "epic-1")],
    ]);
    expect(
      findWindowIdForOpenTab(registry, state, "epic-1", "tab-1"),
    ).toBeNull();
  });

  it("returns null when the tab id matches but the epicId differs", () => {
    const registry = new FakeRegistry(["window-a"]);
    const state = new FakePerWindowState([
      ["window-a", snapshotWithTab("tab-1", "epic-other")],
    ]);
    expect(
      findWindowIdForOpenTab(registry, state, "epic-1", "tab-1"),
    ).toBeNull();
  });

  it("skips registry windowIds that have no snapshot entry", () => {
    const registry = new FakeRegistry(["dead-window", "window-open"]);
    const state = new FakePerWindowState([
      ["window-open", snapshotWithTab("tab-1", "epic-1")],
    ]);
    expect(() =>
      findWindowIdForOpenTab(registry, state, "epic-1", "tab-1"),
    ).not.toThrow();
    expect(findWindowIdForOpenTab(registry, state, "epic-1", "tab-1")).toBe(
      "window-open",
    );
  });

  it("returns the first matching window in registry order", () => {
    const registry = new FakeRegistry(["window-first", "window-second"]);
    const state = new FakePerWindowState([
      ["window-first", snapshotWithTab("tab-1", "epic-1")],
      ["window-second", snapshotWithTab("tab-1", "epic-1")],
    ]);
    expect(findWindowIdForOpenTab(registry, state, "epic-1", "tab-1")).toBe(
      "window-first",
    );
  });
});
