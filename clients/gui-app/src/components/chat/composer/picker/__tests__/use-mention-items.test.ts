import { describe, expect, it } from "vitest";

import {
  artifactsRefreshTargetKey,
  browserTabMentionEntriesFromSessions,
  browserTabMentionSourcesFrom,
  buildCurrentEpicArtifactMentionEntries,
  createBrowserTabMentionEntriesSnapshotCache,
  epicAgentMentionEntriesFromEpic,
  mentionNoMatchDismissVerdict,
  mergeCurrentEpicArtifactMentions,
  mergeTaskAndArtifactMentionEntries,
} from "../use-mention-items";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  ChatProjection,
  ChatsSlice,
  TerminalAgentsSlice,
  TuiAgentProjection,
} from "@/stores/epics/open-epic/types";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type { EpicMentionEntry } from "@/lib/composer/types";
import type { EpicMentionArtifactSuggestion } from "@traycer/protocol/host/epic/unary-schemas";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import {
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";

function chat(
  id: string,
  title: string,
  parentId: string | null,
  updatedAt: number,
): ChatProjection {
  return {
    id,
    title,
    parentId,
    createdAt: 0,
    updatedAt,
    userId: null,
    hostId: null,
    isTitleEditedByUser: false,
    // Ordinary registry-backed chat - this suite exercises mention-item
    // ordering, not doc residency.
    docResident: false,
    archivedAt: null,
    settings: null,
  };
}

function chatsSlice(chats: ReadonlyArray<ChatProjection>): ChatsSlice {
  return {
    byId: Object.fromEntries(chats.map((c) => [c.id, c])),
    allIds: chats.map((c) => c.id),
  };
}

function terminalAgent(fields: {
  id: string;
  harnessId: TuiHarnessId;
  title: string;
  parentId: string | null;
  updatedAt: number;
}): TuiAgentProjection {
  const { id, harnessId, title, parentId, updatedAt } = fields;
  return {
    id,
    // An ordinary registry-backed agent - this suite exercises mention-item
    // ordering, not doc residency.
    docResident: false,
    origin: "registry",
    harnessId,
    title,
    parentId,
    createdAt: 0,
    updatedAt,
    userId: null,
    hostId: "host-1",
    workspaceFolders: [],
    workspaceMode: undefined,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
    archivedAt: null,
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
  };
}

function terminalAgentsSlice(
  agents: ReadonlyArray<TuiAgentProjection>,
): TerminalAgentsSlice {
  return {
    byId: Object.fromEntries(agents.map((a) => [a.id, a])),
    allIds: agents.map((a) => a.id),
  };
}

const NO_TERMINAL_AGENTS = terminalAgentsSlice([]);
const NO_CHATS = chatsSlice([]);

describe("epicAgentMentionEntriesFromEpic", () => {
  it("projects each chat-interface Agent into an entry with the epic-scoped token", () => {
    const entries = epicAgentMentionEntriesFromEpic(
      chatsSlice([
        chat("c1", "Planning", null, 200),
        chat("c2", "Bugfix", "c1", 100),
      ]),
      NO_TERMINAL_AGENTS,
      "epic-1",
      "My Epic",
    );

    expect(entries).toEqual([
      {
        kind: "epic-chat",
        id: "chat:epic-1:c1",
        token: "chat:epic-1/c1",
        epicId: "epic-1",
        epicTitle: "My Epic",
        chatId: "c1",
        label: "Planning",
        description: "My Epic",
        parentId: null,
        updatedAt: 200,
        archived: false,
        agentInterface: "chat",
        runtimeSupportsMessageDelivery: true,
      },
      {
        kind: "epic-chat",
        id: "chat:epic-1:c2",
        token: "chat:epic-1/c2",
        epicId: "epic-1",
        epicTitle: "My Epic",
        chatId: "c2",
        label: "Bugfix",
        description: "My Epic",
        parentId: "c1",
        updatedAt: 100,
        archived: false,
        agentInterface: "chat",
        runtimeSupportsMessageDelivery: true,
      },
    ]);
  });

  it("projects terminal-interface Agents alongside chat-interface Agents", () => {
    const entries = epicAgentMentionEntriesFromEpic(
      chatsSlice([chat("c1", "Planning", null, 200)]),
      terminalAgentsSlice([
        terminalAgent({
          id: "t1",
          harnessId: "claude",
          title: "Refactor",
          parentId: "c1",
          updatedAt: 150,
        }),
      ]),
      "epic-1",
      "My Epic",
    );

    expect(entries.map((entry) => entry.kind)).toEqual([
      "epic-chat",
      "epic-terminal-agent",
    ]);
    expect(entries[1]).toEqual({
      kind: "epic-terminal-agent",
      id: "terminal-agent:epic-1:t1",
      token: "terminal-agent:epic-1/t1",
      epicId: "epic-1",
      epicTitle: "My Epic",
      terminalAgentId: "t1",
      harnessId: "claude",
      label: "Refactor",
      description: "My Epic",
      parentId: "c1",
      updatedAt: 150,
      archived: false,
      agentInterface: "terminal",
      runtimeSupportsMessageDelivery: true,
    });
  });

  it("marks entries archived from the record's archivedAt", () => {
    const archivedChat = { ...chat("c1", "Old run", null, 200), archivedAt: 5 };
    const archivedAgent = {
      ...terminalAgent({
        id: "t1",
        harnessId: "claude",
        title: "Old refactor",
        parentId: null,
        updatedAt: 150,
      }),
      archivedAt: 5,
    };
    const entries = epicAgentMentionEntriesFromEpic(
      chatsSlice([archivedChat, chat("c2", "Live run", null, 100)]),
      terminalAgentsSlice([archivedAgent]),
      "epic-1",
      "My Epic",
    );

    expect(
      entries.map((entry) => ({ id: entry.id, archived: entry.archived })),
    ).toEqual([
      { id: "chat:epic-1:c1", archived: true },
      { id: "chat:epic-1:c2", archived: false },
      { id: "terminal-agent:epic-1:t1", archived: true },
    ]);
  });

  it("keeps Codex and OpenCode Terminal Agents referenceable but not messageable", () => {
    const entries = epicAgentMentionEntriesFromEpic(
      NO_CHATS,
      terminalAgentsSlice([
        terminalAgent({
          id: "t1",
          harnessId: "codex",
          title: "Codex run",
          parentId: null,
          updatedAt: 10,
        }),
        terminalAgent({
          id: "t2",
          harnessId: "opencode",
          title: "OpenCode run",
          parentId: null,
          updatedAt: 20,
        }),
      ]),
      "epic-1",
      "My Epic",
    );

    expect(entries).toHaveLength(2);
    expect(
      entries.every((entry) => !entry.runtimeSupportsMessageDelivery),
    ).toBe(true);
    expect(entries.map((entry) => entry.token)).toEqual([
      "terminal-agent:epic-1/t1",
      "terminal-agent:epic-1/t2",
    ]);
  });

  it("excludes Cursor Terminal Agents, which the product does not expose yet", () => {
    const entries = epicAgentMentionEntriesFromEpic(
      NO_CHATS,
      terminalAgentsSlice([
        terminalAgent({
          id: "t1",
          harnessId: "cursor",
          title: "Cursor run",
          parentId: null,
          updatedAt: 10,
        }),
        terminalAgent({
          id: "t2",
          harnessId: "claude",
          title: "Claude run",
          parentId: null,
          updatedAt: 20,
        }),
      ]),
      "epic-1",
      "My Epic",
    );

    expect(entries.map((entry) => entry.label)).toEqual(["Claude run"]);
  });

  it("falls back to 'Untitled agent' for untitled Agents on BOTH interfaces", () => {
    const [chatEntry, terminalEntry] = epicAgentMentionEntriesFromEpic(
      chatsSlice([chat("c1", "", null, 0)]),
      terminalAgentsSlice([
        terminalAgent({
          id: "t1",
          harnessId: "codex",
          title: "",
          parentId: null,
          updatedAt: 0,
        }),
      ]),
      "epic-1",
      "",
    );

    // The picker addresses the durable Agent, so the fallback is
    // interface-agnostic - not "Untitled chat" / the harness label.
    expect(chatEntry.label).toBe("Untitled agent");
    expect(terminalEntry.label).toBe("Untitled agent");
    expect(chatEntry.epicTitle).toBe("Untitled task");
    expect(chatEntry.description).toBe("Untitled task");
  });

  it("preserves a historical literal 'Untitled chat' title instead of rewriting it", () => {
    const [chatEntry, terminalEntry] = epicAgentMentionEntriesFromEpic(
      chatsSlice([chat("c1", "Untitled chat", null, 0)]),
      terminalAgentsSlice([
        terminalAgent({
          id: "t1",
          harnessId: "claude",
          title: "Untitled terminal agent",
          parentId: null,
          updatedAt: 0,
        }),
      ]),
      "epic-1",
      "My Epic",
    );

    // Stored text is data, not a fallback - the system cannot tell a baked-in
    // synthetic title apart from one the user chose, so it is left alone.
    expect(chatEntry.label).toBe("Untitled chat");
    expect(terminalEntry.label).toBe("Untitled terminal agent");
  });

  it("keeps a literal Untitled epic title unchanged for Agent descriptions", () => {
    const [entry] = epicAgentMentionEntriesFromEpic(
      chatsSlice([chat("c1", "Planning", null, 0)]),
      NO_TERMINAL_AGENTS,
      "epic-1",
      "Untitled epic",
    );

    expect(entry.epicTitle).toBe("Untitled epic");
    expect(entry.description).toBe("Untitled epic");
  });

  it("skips Agent ids missing from the byId projections", () => {
    const entries = epicAgentMentionEntriesFromEpic(
      {
        byId: { c1: chat("c1", "Planning", null, 200) },
        allIds: ["missing", "c1"],
      },
      {
        byId: {
          t1: terminalAgent({
            id: "t1",
            harnessId: "claude",
            title: "Refactor",
            parentId: null,
            updatedAt: 100,
          }),
        },
        allIds: ["missing", "t1"],
      },
      "epic-1",
      "My Epic",
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.label)).toEqual([
      "Planning",
      "Refactor",
    ]);
  });

  it("returns the stable empty array when every Agent id is missing", () => {
    const missingChats: ChatsSlice = { byId: {}, allIds: ["missing"] };
    const missingAgents: TerminalAgentsSlice = {
      byId: {},
      allIds: ["missing"],
    };
    const a = epicAgentMentionEntriesFromEpic(
      missingChats,
      missingAgents,
      "epic-1",
      "My Epic",
    );
    const b = epicAgentMentionEntriesFromEpic(
      missingChats,
      missingAgents,
      "epic-1",
      "My Epic",
    );

    expect(a).toHaveLength(0);
    expect(a).toBe(b);
  });

  it("returns a stable empty array reference when there are no Agents", () => {
    const a = epicAgentMentionEntriesFromEpic(
      NO_CHATS,
      NO_TERMINAL_AGENTS,
      "epic-1",
      "My Epic",
    );
    const b = epicAgentMentionEntriesFromEpic(
      NO_CHATS,
      NO_TERMINAL_AGENTS,
      "epic-1",
      "My Epic",
    );
    expect(a).toHaveLength(0);
    // Same reference -> the gated `useMemo` in useMentionItems stays stable, so
    // the composer never re-renders for an epic with no Agents.
    expect(a).toBe(b);
  });
});

function artifact(
  id: string,
  kind: ArtifactProjection["kind"],
  fields: { title: string; updatedAt: number; status: number | null },
): ArtifactProjection {
  return {
    id,
    kind,
    title: fields.title,
    folderName: "",
    parentId: null,
    artifactRoomId: null,
    createdAt: 0,
    updatedAt: fields.updatedAt,
    status: fields.status,
    createdManually: false,
  };
}

function artifactsSlice(
  artifacts: ReadonlyArray<ArtifactProjection>,
): ArtifactsSlice {
  return {
    byId: Object.fromEntries(artifacts.map((a) => [a.id, a])),
    allIds: artifacts.map((a) => a.id),
  };
}

function cloudSpec(
  artifactId: string,
  epicId: string,
  label: string,
  updatedAt: number,
): EpicMentionArtifactSuggestion {
  return {
    kind: "epic-artifact",
    id: `spec:${epicId}:${artifactId}`,
    token: `spec:${epicId}/${artifactId}`,
    epicId,
    epicTitle: `Epic ${epicId}`,
    artifactId,
    artifactType: "spec",
    label,
    description: `Epic ${epicId}`,
    status: null,
    updatedAt,
  };
}

describe("buildCurrentEpicArtifactMentionEntries", () => {
  it("projects each artifact into an epic-scoped suggestion carrying updatedAt", () => {
    const entries = buildCurrentEpicArtifactMentionEntries(
      artifactsSlice([
        artifact("t1", "ticket", {
          title: "Wire ingest",
          updatedAt: 200,
          status: 1,
        }),
      ]),
      "epic-1",
      "My Epic",
      "",
    );
    expect(entries).toEqual([
      {
        kind: "epic-artifact",
        id: "ticket:epic-1:t1",
        token: "ticket:epic-1/t1",
        epicId: "epic-1",
        epicTitle: "My Epic",
        artifactId: "t1",
        artifactType: "ticket",
        label: "Wire ingest",
        description: "My Epic",
        status: 1,
        updatedAt: 200,
      },
    ]);
  });

  it("filters by a case-insensitive subsequence query", () => {
    const entries = buildCurrentEpicArtifactMentionEntries(
      artifactsSlice([
        artifact("s1", "spec", {
          title: "Checkout redirect",
          updatedAt: 100,
          status: null,
        }),
        artifact("s2", "spec", {
          title: "Login flow",
          updatedAt: 100,
          status: null,
        }),
      ]),
      "epic-1",
      "My Epic",
      "chkt",
    );
    expect(entries.map((e) => e.artifactId)).toEqual(["s1"]);
  });

  it("returns every artifact for an empty query", () => {
    const entries = buildCurrentEpicArtifactMentionEntries(
      artifactsSlice([
        artifact("s1", "spec", { title: "One", updatedAt: 100, status: null }),
        artifact("s2", "review", {
          title: "Two",
          updatedAt: 100,
          status: null,
        }),
      ]),
      "epic-1",
      "My Epic",
      "",
    );
    expect(entries).toHaveLength(2);
  });

  it("skips artifact ids missing from the byId projection", () => {
    const present = artifact("s1", "spec", {
      title: "Present",
      updatedAt: 100,
      status: null,
    });
    const entries = buildCurrentEpicArtifactMentionEntries(
      { byId: { s1: present }, allIds: ["missing", "s1"] },
      "epic-1",
      "My Epic",
      "",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.artifactId).toBe("s1");
  });

  it("returns a stable empty array reference when there are no artifacts", () => {
    const empty = artifactsSlice([]);
    const a = buildCurrentEpicArtifactMentionEntries(empty, "epic-1", "E", "");
    const b = buildCurrentEpicArtifactMentionEntries(empty, "epic-1", "E", "");
    expect(a).toHaveLength(0);
    expect(a).toBe(b);
  });
});

describe("mergeCurrentEpicArtifactMentions", () => {
  it("orders current-epic artifacts first, then other epics, each by recency", () => {
    const local = buildCurrentEpicArtifactMentionEntries(
      artifactsSlice([
        artifact("a1", "spec", {
          title: "Local A1",
          updatedAt: 100,
          status: null,
        }),
        artifact("a2", "spec", {
          title: "Local A2",
          updatedAt: 300,
          status: null,
        }),
      ]),
      "epic-cur",
      "Current Epic",
      "",
    );
    const cloud: ReadonlyArray<EpicMentionEntry> = [
      cloudSpec("b1", "epic-other", "Other B1", 500),
      cloudSpec("b2", "epic-other", "Other B2", 200),
    ];
    const merged = mergeCurrentEpicArtifactMentions(local, cloud, "epic-cur");
    // Current-epic group (a2 newer than a1) precedes the other-epic group
    // (b1 newer than b2), even though b1 is the most-recent overall.
    expect(merged.map((e) => e.id)).toEqual([
      "spec:epic-cur:a2",
      "spec:epic-cur:a1",
      "spec:epic-other:b1",
      "spec:epic-other:b2",
    ]);
  });

  it("de-dupes a current-epic artifact present in both, keeping the local copy", () => {
    const local = buildCurrentEpicArtifactMentionEntries(
      artifactsSlice([
        artifact("a1", "spec", {
          title: "Local A1",
          updatedAt: 100,
          status: null,
        }),
      ]),
      "epic-cur",
      "Current Epic",
      "",
    );
    const cloud: ReadonlyArray<EpicMentionEntry> = [
      cloudSpec("a1", "epic-cur", "Cloud A1 (stale)", 50),
    ];
    const merged = mergeCurrentEpicArtifactMentions(local, cloud, "epic-cur");
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("spec:epic-cur:a1");
    expect(merged[0]?.label).toBe("Local A1");
  });

  it("surfaces a current-epic artifact that is only in the local set (beyond the cloud cap)", () => {
    const local = buildCurrentEpicArtifactMentionEntries(
      artifactsSlice([
        artifact("only-local", "spec", {
          title: "Only Local",
          updatedAt: 100,
          status: null,
        }),
      ]),
      "epic-cur",
      "Current Epic",
      "",
    );
    const merged = mergeCurrentEpicArtifactMentions(local, [], "epic-cur");
    expect(merged.map((e) => e.id)).toEqual(["spec:epic-cur:only-local"]);
  });
});

describe("mergeTaskAndArtifactMentionEntries", () => {
  it("keeps cached task suggestions ahead of host fallback suggestions and de-dupes by id", () => {
    const local: ReadonlyArray<EpicMentionEntry> = [
      {
        kind: "epic",
        id: "epic:task-1",
        token: "epic:task-1",
        epicId: "task-1",
        label: "Cached task",
        description: "1 spec",
        status: "active",
        updatedAt: 20,
      },
    ];
    const cloud: ReadonlyArray<EpicMentionEntry> = [
      {
        kind: "epic",
        id: "epic:task-1",
        token: "epic:task-1",
        epicId: "task-1",
        label: "Host task",
        description: "1 spec",
        status: "active",
        updatedAt: 10,
      },
      {
        kind: "epic",
        id: "epic:task-2",
        token: "epic:task-2",
        epicId: "task-2",
        label: "Host-only task",
        description: "",
        status: "active",
        updatedAt: 30,
      },
    ];

    expect(
      mergeTaskAndArtifactMentionEntries(local, cloud).map((entry) => [
        entry.id,
        entry.label,
      ]),
    ).toEqual([
      ["epic:task-1", "Cached task"],
      ["epic:task-2", "Host-only task"],
    ]);
  });

  it("keeps literal host task labels unchanged while preserving mention tokens", () => {
    const [entry] = mergeTaskAndArtifactMentionEntries(
      [],
      [
        {
          kind: "epic",
          id: "epic:task-1",
          token: "epic:task-1",
          epicId: "task-1",
          label: "Untitled epic",
          description: "",
          status: "active",
          updatedAt: 10,
        },
      ],
    );

    expect(entry).toMatchObject({
      kind: "epic",
      id: "epic:task-1",
      token: "epic:task-1",
      epicId: "task-1",
      label: "Untitled epic",
    });
  });
});

describe("mentionNoMatchDismissVerdict", () => {
  const settledNoMatch = {
    active: true,
    stepKind: "root" as const,
    query: "ghost",
    debouncedQuery: "ghost",
    matchedCount: 0,
    loading: false,
    fetching: false,
    workspaceRequestCount: 1,
    workspaceError: null,
    epicRequestCount: 1,
    epicError: null,
    terminalRequested: true,
    terminalLoading: false,
    terminalFetching: false,
    terminalError: null,
    githubErrored: false,
    referenceQuery: false,
  };

  it("closes when every source, including the terminal list, has settled with no match", () => {
    expect(mentionNoMatchDismissVerdict(settledNoMatch)).toBe(true);
  });

  it("holds the menu open when a requested GitHub catalog read failed", () => {
    // A rejected cache-only read carries no rows and no scope, so zero
    // matches proves nothing - the PR/issue source never answered. Before the
    // GitHub error was folded in beside the other sources', retries
    // exhausting flipped `loading` false and the picker dismissed over rows
    // it never saw.
    expect(
      mentionNoMatchDismissVerdict({
        ...settledNoMatch,
        githubErrored: true,
      }),
    ).toBe(false);
  });

  // Without this the whole `referenceQuery` input can be deleted from the
  // verdict call and every other case in this suite stays green - the fixture
  // only ever sets it false, so nothing measures the exemption it exists for.
  it("holds the menu open for a reference-shaped query that matched nothing", () => {
    expect(
      mentionNoMatchDismissVerdict({
        ...settledNoMatch,
        query: "#123",
        debouncedQuery: "#123",
        referenceQuery: true,
      }),
    ).toBe(false);
  });

  it("holds the menu open while the terminal list is still loading", () => {
    expect(
      mentionNoMatchDismissVerdict({
        ...settledNoMatch,
        terminalLoading: true,
      }),
    ).toBe(false);
  });

  it("holds the menu open while the terminal list is refetching", () => {
    expect(
      mentionNoMatchDismissVerdict({
        ...settledNoMatch,
        terminalFetching: true,
      }),
    ).toBe(false);
  });

  it("treats a failed terminal list like any other errored source", () => {
    expect(
      mentionNoMatchDismissVerdict({
        ...settledNoMatch,
        terminalError: new Error("terminal.list failed"),
      }),
    ).toBe(false);
  });

  it("ignores terminal state when terminals were never requested (no open Task)", () => {
    expect(
      mentionNoMatchDismissVerdict({
        ...settledNoMatch,
        terminalRequested: false,
        terminalLoading: true,
        terminalError: new Error("irrelevant"),
      }),
    ).toBe(true);
  });

  it("never closes over an errored workspace source", () => {
    expect(
      mentionNoMatchDismissVerdict({
        ...settledNoMatch,
        workspaceError: new Error("search failed"),
      }),
    ).toBe(false);
  });
});

describe("artifactsRefreshTargetKey", () => {
  it("differs across hosts even when the epic id is empty - the landing composer's host-swap case", () => {
    expect(artifactsRefreshTargetKey("host-1", "")).not.toBe(
      artifactsRefreshTargetKey("host-2", ""),
    );
  });

  it("differs between a null host and a named host", () => {
    expect(artifactsRefreshTargetKey(null, "epic-1")).not.toBe(
      artifactsRefreshTargetKey("host-1", "epic-1"),
    );
  });

  it("is equal for identical host and epic pairs", () => {
    expect(artifactsRefreshTargetKey("host-1", "epic-1")).toBe(
      artifactsRefreshTargetKey("host-1", "epic-1"),
    );
  });
});

function browserSession(
  fields: Partial<BrowserSessionInfo> & { sessionId: string; hostId: string },
): BrowserSessionInfo {
  return sessionInfo({
    lastActivityAt: 0,
    runtime: { kind: "headless", revision: 0 },
    tabs: [
      tabInfo({
        tabId: "tab-1",
        url: "https://example.com",
        originTier: "external",
        title: "Example",
      }),
    ],
    ...fields,
  });
}

function browserSessionsState(
  fields: Partial<BrowserSessionsState> & { hostId: string | null },
): BrowserSessionsState {
  return {
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    items: [],
    errorMessage: null,
    retry: () => {},
    openTab: () => Promise.reject(new Error("not implemented")),
    closeTab: () => Promise.reject(new Error("not implemented")),
    ...fields,
  };
}

describe("browserTabMentionEntriesFromSessions", () => {
  // The picker used to see exactly ONE coordinator (the canvas host's) and
  // dropped its rows whenever that host was not the chat's - so a tab on
  // another host vanished from the menu entirely. Cross-host mentions (spec
  // decision #10) invert that: every host's tabs surface, and the chat's OWN
  // host is the only one whose tabs come back drivable.
  it("marks tabs on the chat's own host as drivable (contextOnly: false)", () => {
    const sessions = browserSessionsState({
      hostId: "chat-host",
      items: [browserSession({ sessionId: "s1", hostId: "chat-host" })],
    });
    const entries = browserTabMentionEntriesFromSessions(
      [{ key: "coord-1", state: sessions, hostLabel: null }],
      "chat-host",
      true,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tabId).toBe("tab-1");
    expect(entries[0]?.contextOnly).toBe(false);
    expect(entries[0]?.coordinatorKey).toBe("coord-1");
  });

  it("resolves each coordinator's host label once, tolerating an unresolved host", () => {
    // The picker's label lookup is a real directory read; the tests around it
    // hand `hostLabel` in pre-resolved, so nothing else pins the mapping.
    // Mutation: labelling by the coordinator KEY instead of `state.hostId`, or
    // dropping the null-host arm and calling the resolver with `""` - both
    // hand every row the wrong host's name.
    const named = browserSessionsState({
      hostId: "canvas-host",
      items: [browserSession({ sessionId: "s1", hostId: "canvas-host" })],
    });
    const unresolved = browserSessionsState({ hostId: null, items: [] });
    const asked: string[] = [];

    expect(
      browserTabMentionSourcesFrom(
        [
          { key: "coord-1", state: named },
          { key: "coord-2", state: unresolved },
        ],
        (hostId) => {
          asked.push(hostId);
          return hostId === "canvas-host" ? "Canvas Host" : null;
        },
      ),
    ).toEqual([
      { key: "coord-1", state: named, hostLabel: "Canvas Host" },
      { key: "coord-2", state: unresolved, hostLabel: null },
    ]);
    expect(asked).toEqual(["canvas-host"]);
  });

  // A tab on a host that is not the chat's own no longer disappears - it
  // comes back marked `contextOnly: true`, carrying the owning host's label,
  // because it can only ever be attached as snapshot context (url, title,
  // screenshot), never a `browser-tab:` drive token the agent could attach to
  // (spec decision #10).
  it("marks tabs on a different host as contextOnly instead of dropping them, and carries the host's label", () => {
    const sessions = browserSessionsState({
      hostId: "canvas-host",
      items: [browserSession({ sessionId: "s1", hostId: "canvas-host" })],
    });
    const entries = browserTabMentionEntriesFromSessions(
      [{ key: "coord-1", state: sessions, hostLabel: "Canvas Host" }],
      "chat-host",
      true,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tabId).toBe("tab-1");
    expect(entries[0]?.hostId).toBe("canvas-host");
    expect(entries[0]?.contextOnly).toBe(true);
    expect(entries[0]?.hostLabel).toBe("Canvas Host");
  });

  // A null chat host is "readiness has not resolved yet", not "this chat has
  // no host": comparing against it would mark the chat's OWN tabs contextOnly
  // for as long as that lasts, quietly downgrading them to snapshots.
  it("returns no entries while the chat's host is unresolved", () => {
    const sessions = browserSessionsState({
      hostId: "chat-host",
      items: [browserSession({ sessionId: "s1", hostId: "chat-host" })],
    });
    expect(
      browserTabMentionEntriesFromSessions(
        [{ key: "coord-1", state: sessions, hostLabel: null }],
        null,
        true,
      ),
    ).toEqual([]);
    const getSnapshot = createBrowserTabMentionEntriesSnapshotCache();
    expect(
      getSnapshot(
        [{ key: "coord-1", state: sessions, hostLabel: null }],
        null,
        true,
      ),
    ).toEqual([]);
  });

  it("aggregates two hosts, host-qualifying ids so an identical session/tab id on each host never collides", () => {
    const hostASessions = browserSessionsState({
      hostId: "host-a",
      items: [browserSession({ sessionId: "s1", hostId: "host-a" })],
    });
    const hostBSessions = browserSessionsState({
      hostId: "host-b",
      items: [browserSession({ sessionId: "s1", hostId: "host-b" })],
    });
    const entries = browserTabMentionEntriesFromSessions(
      [
        { key: "coord-a", state: hostASessions, hostLabel: null },
        { key: "coord-b", state: hostBSessions, hostLabel: "Host B" },
      ],
      "host-a",
      true,
    );

    expect(entries).toHaveLength(2);
    const [entryA, entryB] = entries;
    expect(entryA.hostId).toBe("host-a");
    expect(entryA.contextOnly).toBe(false);
    expect(entryB.hostId).toBe("host-b");
    expect(entryB.contextOnly).toBe(true);
    expect(entryB.hostLabel).toBe("Host B");
    // Same session/tab id minted on both hosts - only the host-qualified `id`
    // keeps the menu's de-dupe from merging the two rows.
    expect(entryA.tabId).toBe(entryB.tabId);
    expect(entryA.sessionId).toBe(entryB.sessionId);
    expect(entryA.id).not.toBe(entryB.id);
  });

  // `page.attachTab` auto-wakes a dormant session before leasing it (see
  // `SessionReplTabSource.attach` -> `ensureTabAttached` ->
  // `runDormantActivation`, ahead of the lease), so a dormant session's tabs
  // are fully attachable and must stay listed - excluding them would hide a
  // reference the agent can actually resolve.
  it("lists a dormant session's tabs and marks them dormant", () => {
    const sessions = browserSessionsState({
      hostId: "chat-host",
      items: [
        browserSession({
          sessionId: "s1",
          hostId: "chat-host",
          runtime: { kind: "dormant", revision: 0 },
          tabs: [
            {
              tabId: "tab-1",
              url: "https://example.com",
              originTier: "external",
              status: "dormant",
              title: "Example",
              viewed: false,
              drivenBy: [],
            },
          ],
        }),
      ],
    });
    const entries = browserTabMentionEntriesFromSessions(
      [{ key: "coord-1", state: sessions, hostLabel: null }],
      "chat-host",
      true,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tabId).toBe("tab-1");
    expect(entries[0]?.dormant).toBe(true);
  });

  it("marks a live tab as non-dormant", () => {
    const sessions = browserSessionsState({
      hostId: "chat-host",
      items: [browserSession({ sessionId: "s1", hostId: "chat-host" })],
    });
    const entries = browserTabMentionEntriesFromSessions(
      [{ key: "coord-1", state: sessions, hostLabel: null }],
      "chat-host",
      true,
    );
    expect(entries[0]?.dormant).toBe(false);
  });
});

describe("createBrowserTabMentionEntriesSnapshotCache", () => {
  // The bug this cache exists to fix: the host bumps `lastActivityAt` (and
  // mints a fresh sessions object) on essentially every frame, which used to
  // re-run the whole mention pipeline at frame rate even when no tab's
  // mention-relevant fields actually changed.
  it("returns the SAME array reference across snapshots whose sessions are content-identical for mention purposes", () => {
    const getSnapshot = createBrowserTabMentionEntriesSnapshotCache();
    const sourcesAt = (lastActivityAt: number) => [
      {
        key: "coord-1",
        state: browserSessionsState({
          hostId: "chat-host",
          items: [
            browserSession({
              sessionId: "s1",
              hostId: "chat-host",
              lastActivityAt,
            }),
          ],
        }),
        hostLabel: null,
      },
    ];

    const first = getSnapshot(sourcesAt(1), "chat-host", true);
    // A frame that only bumps `lastActivityAt` - every tab's
    // sessionId/tabId/title/url/viewed are unchanged - must not rebuild.
    const second = getSnapshot(sourcesAt(2), "chat-host", true);

    expect(second).toBe(first);
    expect(first).toHaveLength(1);
  });

  it("rebuilds when a tab's mention-relevant field actually changes", () => {
    const getSnapshot = createBrowserTabMentionEntriesSnapshotCache();
    const first = getSnapshot(
      [
        {
          key: "coord-1",
          state: browserSessionsState({
            hostId: "chat-host",
            items: [browserSession({ sessionId: "s1", hostId: "chat-host" })],
          }),
          hostLabel: null,
        },
      ],
      "chat-host",
      true,
    );
    const second = getSnapshot(
      [
        {
          key: "coord-1",
          state: browserSessionsState({
            hostId: "chat-host",
            items: [
              browserSession({
                sessionId: "s1",
                hostId: "chat-host",
                tabs: [
                  {
                    tabId: "tab-1",
                    url: "https://example.com/other",
                    originTier: "external",
                    status: "ready",
                    title: "Example",
                    viewed: false,
                    drivenBy: [],
                  },
                ],
              }),
            ],
          }),
          hostLabel: null,
        },
      ],
      "chat-host",
      true,
    );

    expect(second).not.toBe(first);
    expect(second[0]?.url).toBe("https://example.com/other");
  });

  // The dormancy flag comes from `tab.status`, which is not part of the old
  // key shape (title/url/viewed) - if `status` were left out of the content
  // key, a session waking (dormant -> headless) with an otherwise-identical
  // tab would keep serving the stale cached array, including its stale
  // `dormant: true` entry, until some unrelated field also changed.
  it("rebuilds with a new array identity when a session's runtime wakes and its tab's status flips", () => {
    const getSnapshot = createBrowserTabMentionEntriesSnapshotCache();
    const dormantTab = {
      tabId: "tab-1",
      url: "https://example.com",
      originTier: "external" as const,
      status: "dormant" as const,
      title: "Example",
      viewed: false,
      drivenBy: [],
    };
    const first = getSnapshot(
      [
        {
          key: "coord-1",
          state: browserSessionsState({
            hostId: "chat-host",
            items: [
              browserSession({
                sessionId: "s1",
                hostId: "chat-host",
                runtime: { kind: "dormant", revision: 0 },
                tabs: [dormantTab],
              }),
            ],
          }),
          hostLabel: null,
        },
      ],
      "chat-host",
      true,
    );
    expect(first[0]?.dormant).toBe(true);

    const second = getSnapshot(
      [
        {
          key: "coord-1",
          state: browserSessionsState({
            hostId: "chat-host",
            items: [
              browserSession({
                sessionId: "s1",
                hostId: "chat-host",
                runtime: { kind: "headless", revision: 1 },
                tabs: [{ ...dormantTab, status: "ready" }],
              }),
            ],
          }),
          hostLabel: null,
        },
      ],
      "chat-host",
      true,
    );

    expect(second).not.toBe(first);
    expect(second[0]?.dormant).toBe(false);
  });

  it("returns the shared empty constant while the picker is closed, without touching the sessions snapshot", () => {
    const getSnapshot = createBrowserTabMentionEntriesSnapshotCache();
    const sources = [
      {
        key: "coord-1",
        state: browserSessionsState({
          hostId: "chat-host",
          items: [browserSession({ sessionId: "s1", hostId: "chat-host" })],
        }),
        hostLabel: null,
      },
    ];

    const closed = getSnapshot(sources, "chat-host", false);
    expect(closed).toEqual([]);
  });

  // The host label rides the content key (not just the tab fields): it is
  // carried into the attached text line for a contextOnly entry, so a
  // renamed host must not keep serving the OLD label out of the cache even
  // though every tab field is unchanged.
  it("rebuilds when only the label a different host resolves to changes", () => {
    const getSnapshot = createBrowserTabMentionEntriesSnapshotCache();
    const sourcesWithLabel = (hostLabel: string | null) => [
      {
        key: "coord-1",
        state: browserSessionsState({
          hostId: "canvas-host",
          items: [browserSession({ sessionId: "s1", hostId: "canvas-host" })],
        }),
        hostLabel,
      },
    ];

    const first = getSnapshot(sourcesWithLabel("Old Name"), "chat-host", true);
    const second = getSnapshot(sourcesWithLabel("New Name"), "chat-host", true);

    expect(second).not.toBe(first);
    expect(first[0]?.hostLabel).toBe("Old Name");
    expect(second[0]?.hostLabel).toBe("New Name");
  });
});
