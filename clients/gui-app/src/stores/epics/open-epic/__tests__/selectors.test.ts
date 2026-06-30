import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";
import type {
  EpicStreamCallbacks,
  EpicStreamClient,
} from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { buildEpicNodeTree } from "@/lib/artifacts/node-display";
import type { EpicNodeRecord } from "@/lib/artifacts/node-display";
import {
  projectArtifactsSliceForTests as projectArtifacts,
  projectChatsSliceForTests as projectChats,
  projectTerminalAgentsSliceForTests as projectTerminalAgents,
} from "@/stores/epics/open-epic/__tests__/projection-helpers-test-shims";
import { projectTreeSlice } from "@/stores/epics/open-epic/projection-helpers";

interface BuildTreeRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly type:
    "chat" | "terminal-agent" | "spec" | "ticket" | "story" | "review";
}

function buildTreeRecords(
  doc: Y.Doc,
  currentUserId: string | null,
): ReadonlyArray<BuildTreeRow> {
  const artifacts = projectArtifacts(doc);
  const chats = projectChats(doc, currentUserId);
  const tuiAgents = projectTerminalAgents(doc, currentUserId);
  const tree = projectTreeSlice(artifacts, chats, tuiAgents);
  return Object.values(tree.nodeById).map((node) => ({
    id: node.id,
    parentId: node.parentId,
    name: node.title,
    type: node.type,
  }));
}

interface FakeStream {
  callbacks: EpicStreamCallbacks;
}

function fakeFactory(): {
  factory: EpicStreamClientFactory;
  handle: () => FakeStream;
} {
  let current: FakeStream | null = null;
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    current = { callbacks };
    const client: Pick<
      EpicStreamClient,
      | "applyUpdate"
      | "awareness"
      | "applyArtifactRoomUpdate"
      | "artifactRoomAwareness"
      | "retryMigration"
      | "close"
    > = {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
    return client;
  };
  return {
    factory,
    handle: () => {
      if (current === null) throw new Error("not invoked");
      return current;
    },
  };
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-x",
      title: "Epic X",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

function makeTerminalAgentProjectionDoc(
  terminalAgentArgs: unknown,
  shouldSetTerminalAgentArgs: boolean,
): Y.Doc {
  const doc = new Y.Doc();
  const epic = doc.getMap("epic");
  const tuiAgents = new Y.Map<unknown>();
  const terminalAgent = new Y.Map<unknown>();
  terminalAgent.set("id", "terminal-1");
  terminalAgent.set("harnessId", "codex");
  terminalAgent.set("title", "Codex");
  terminalAgent.set("parentId", null);
  terminalAgent.set("createdAt", 0);
  terminalAgent.set("updatedAt", 0);
  terminalAgent.set("userId", "user-1");
  terminalAgent.set("hostId", "host-1");
  terminalAgent.set("workspaceFolders", ["/repo"]);
  terminalAgent.set("model", null);
  terminalAgent.set("reasoningEffort", null);
  terminalAgent.set("agentMode", "regular");
  terminalAgent.set("harnessSessionId", null);
  if (shouldSetTerminalAgentArgs) {
    terminalAgent.set("terminalAgentArgs", terminalAgentArgs);
  }
  terminalAgent.set("terminalShellCommand", null);
  terminalAgent.set("terminalShellArgs", null);
  tuiAgents.set("terminal-1", terminalAgent);
  epic.set("tuiAgents", tuiAgents);
  return doc;
}

describe("open-epic-store doc projection", () => {
  beforeEach(() => {
    if (typeof window !== "undefined") {
      window.localStorage.clear();
    }
  });

  it("doc receives seeded artifacts after snapshot", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-x",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    const epic = donor.getMap("epic");
    const artifacts = new Y.Map<unknown>();
    const entry = new Y.Map<unknown>();
    entry.set("id", "spec-1");
    entry.set("kind", "spec");
    entry.set("title", "Spec 1");
    entry.set("parentId", null);
    entry.set("artifactRoomId", "artifact-room-0");
    artifacts.set("spec-1", entry);
    epic.set("artifacts", artifacts);

    const snapshotBytes = Y.encodeStateAsUpdate(donor);
    handle().callbacks.onSnapshot(makeMeta(), snapshotBytes);

    const liveArtifacts = opened.doc.getMap("epic").get("artifacts");
    expect(liveArtifacts).toBeInstanceOf(Y.Map);
    const liveEntry = (liveArtifacts as Y.Map<unknown>).get("spec-1");
    expect(liveEntry).toBeInstanceOf(Y.Map);
    expect((liveEntry as Y.Map<unknown>).get("title")).toBe("Spec 1");
    expect(
      opened.store.getState().artifacts.byId["spec-1"].artifactRoomId,
    ).toBe("artifact-room-0");
    opened.dispose();
  });

  it("surfaces review artifacts in buildTreeRecords", () => {
    const doc = new Y.Doc();
    const epic = doc.getMap("epic");
    const artifacts = new Y.Map<unknown>();
    const review = new Y.Map<unknown>();
    review.set("id", "review-1");
    review.set("kind", "review");
    review.set("title", "Code review");
    review.set("parentId", null);
    review.set("createdAt", 0);
    review.set("updatedAt", 0);
    review.set("content", new Y.XmlFragment());
    artifacts.set("review-1", review);
    epic.set("artifacts", artifacts);

    const records = buildTreeRecords(doc, null);
    const match = records.find((r) => r.id === "review-1");
    expect(match).toBeDefined();
    expect(match?.type).toBe("review");
    expect(match?.name).toBe("Code review");
  });

  it("rejects terminal agents without agentMode", () => {
    const doc = new Y.Doc();
    const epic = doc.getMap("epic");
    const tuiAgents = new Y.Map<unknown>();
    const terminalAgent = new Y.Map<unknown>();
    terminalAgent.set("id", "terminal-1");
    terminalAgent.set("harnessId", "codex");
    terminalAgent.set("title", "Codex");
    terminalAgent.set("parentId", null);
    terminalAgent.set("createdAt", 0);
    terminalAgent.set("updatedAt", 0);
    terminalAgent.set("hostId", "host-1");
    terminalAgent.set("workspaceFolders", ["/repo"]);
    terminalAgent.set("model", null);
    terminalAgent.set("harnessSessionId", null);
    terminalAgent.set("terminalShellCommand", null);
    terminalAgent.set("terminalShellArgs", null);
    tuiAgents.set("terminal-1", terminalAgent);
    epic.set("tuiAgents", tuiAgents);

    const projected = projectTerminalAgents(doc, null);

    expect(projected.byId["terminal-1"]).toBeUndefined();
  });

  it("projects durable terminal-agent args with fallback and override semantics", () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly rawValue: unknown;
      readonly shouldSetRawValue: boolean;
      readonly expected: string | null;
    }> = [
      {
        label: "missing legacy field",
        rawValue: undefined,
        shouldSetRawValue: false,
        expected: null,
      },
      {
        label: "explicit null",
        rawValue: null,
        shouldSetRawValue: true,
        expected: null,
      },
      {
        label: "explicit empty-string override",
        rawValue: "",
        shouldSetRawValue: true,
        expected: "",
      },
      {
        label: "non-empty override",
        rawValue: "--dangerously-skip-permissions",
        shouldSetRawValue: true,
        expected: "--dangerously-skip-permissions",
      },
    ];

    cases.forEach(({ label, rawValue, shouldSetRawValue, expected }) => {
      const projected = projectTerminalAgents(
        makeTerminalAgentProjectionDoc(rawValue, shouldSetRawValue),
        null,
      );

      expect(projected.byId["terminal-1"].terminalAgentArgs, label).toBe(
        expected,
      );
    });
  });

  it("rejects chat settings without agentMode", () => {
    const doc = new Y.Doc();
    const epic = doc.getMap("epic");
    const chats = new Y.Map<unknown>();
    const chat = new Y.Map<unknown>();
    chat.set("id", "chat-1");
    chat.set("title", "Chat");
    chat.set("parentId", null);
    chat.set("createdAt", 0);
    chat.set("updatedAt", 0);
    chat.set("userId", "user-1");
    chat.set("hostId", "host-1");
    chat.set("isTitleEditedByUser", false);
    chat.set("settings", {
      harnessId: "codex",
      model: null,
      permissionMode: "supervised",
      reasoningEffort: null,
    });
    chats.set("chat-1", chat);
    epic.set("chats", chats);

    const projected = projectChats(doc, null);

    expect(projected.byId["chat-1"].settings).toBeNull();
  });

  it("filters foreign-owner chats out of shim-built tree records", () => {
    const doc = new Y.Doc();
    const epic = doc.getMap("epic");
    const chats = new Y.Map<unknown>();

    const mine = new Y.Map<unknown>();
    mine.set("id", "mine");
    mine.set("title", "Mine");
    mine.set("parentId", null);
    mine.set("createdAt", 0);
    mine.set("updatedAt", 0);
    mine.set("userId", "user-a");
    chats.set("mine", mine);

    const theirs = new Y.Map<unknown>();
    theirs.set("id", "theirs");
    theirs.set("title", "Theirs");
    theirs.set("parentId", null);
    theirs.set("createdAt", 1);
    theirs.set("updatedAt", 1);
    theirs.set("userId", "user-b");
    chats.set("theirs", theirs);

    epic.set("chats", chats);

    const records = buildTreeRecords(doc, "user-a");

    expect(records.map((record) => record.id)).toEqual(["mine"]);
  });

  it("filters foreign-owner terminal agents out of shim-built tree records", () => {
    const doc = new Y.Doc();
    const epic = doc.getMap("epic");
    const tuiAgents = new Y.Map<unknown>();

    const makeAgent = (
      id: string,
      userId: string | null,
      title: string,
    ): Y.Map<unknown> => {
      const agent = new Y.Map<unknown>();
      agent.set("id", id);
      agent.set("harnessId", "codex");
      agent.set("title", title);
      agent.set("parentId", null);
      agent.set("createdAt", 0);
      agent.set("updatedAt", 0);
      if (userId !== null) agent.set("userId", userId);
      agent.set("hostId", "host-1");
      agent.set("workspaceFolders", ["/repo"]);
      agent.set("model", null);
      agent.set("reasoningEffort", null);
      agent.set("agentMode", "regular");
      agent.set("harnessSessionId", null);
      agent.set("terminalShellCommand", null);
      agent.set("terminalShellArgs", null);
      return agent;
    };

    tuiAgents.set("mine", makeAgent("mine", "user-a", "Mine"));
    tuiAgents.set("theirs", makeAgent("theirs", "user-b", "Theirs"));
    tuiAgents.set("legacy", makeAgent("legacy", null, "Legacy"));
    epic.set("tuiAgents", tuiAgents);

    const records = buildTreeRecords(doc, "user-a");

    expect(records.map((record) => record.id).sort()).toEqual([
      "legacy",
      "mine",
    ]);
  });

  it("preserves child-of-review parent links in buildEpicNodeTree", () => {
    const doc = new Y.Doc();
    const epic = doc.getMap("epic");
    const artifacts = new Y.Map<unknown>();

    const review = new Y.Map<unknown>();
    review.set("id", "review-1");
    review.set("kind", "review");
    review.set("title", "Review root");
    review.set("parentId", null);
    review.set("content", new Y.XmlFragment());
    artifacts.set("review-1", review);

    const story = new Y.Map<unknown>();
    story.set("id", "story-1");
    story.set("kind", "story");
    story.set("title", "Child story");
    story.set("parentId", "review-1");
    story.set("content", new Y.XmlFragment());
    artifacts.set("story-1", story);

    epic.set("artifacts", artifacts);

    const records: ReadonlyArray<EpicNodeRecord> = buildTreeRecords(
      doc,
      null,
    ).map((r) => ({
      id: r.id,
      parentId: r.parentId,
      name: r.name,
      type: r.type,
      hostId: "test-host",
    }));

    const tree = buildEpicNodeTree(records);
    expect(tree.length).toBe(1);
    expect(tree[0].id).toBe("review-1");
    const children = tree[0].children ?? [];
    expect(children.length).toBe(1);
    expect(children[0].id).toBe("story-1");
  });
});
