import { describe, expect, it } from "vitest";

import {
  buildCurrentEpicArtifactMentionEntries,
  epicChatMentionEntriesFromChats,
  mergeCurrentEpicArtifactMentions,
  mergeTaskAndArtifactMentionEntries,
} from "../use-mention-items";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  ChatProjection,
  ChatsSlice,
} from "@/stores/epics/open-epic/types";
import type { EpicMentionEntry } from "@/lib/composer/types";
import type { EpicMentionArtifactSuggestion } from "@traycer/protocol/host/epic/unary-schemas";

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
    settings: null,
  };
}

function chatsSlice(chats: ReadonlyArray<ChatProjection>): ChatsSlice {
  return {
    byId: Object.fromEntries(chats.map((c) => [c.id, c])),
    allIds: chats.map((c) => c.id),
  };
}

describe("epicChatMentionEntriesFromChats", () => {
  it("projects each chat into a mention entry with the epic-scoped token", () => {
    const entries = epicChatMentionEntriesFromChats(
      chatsSlice([
        chat("c1", "Planning", null, 200),
        chat("c2", "Bugfix", "c1", 100),
      ]),
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
      },
    ]);
  });

  it("falls back to placeholder labels for empty chat / epic titles", () => {
    const [entry] = epicChatMentionEntriesFromChats(
      chatsSlice([chat("c1", "", null, 0)]),
      "epic-1",
      "",
    );
    expect(entry.label).toBe("Untitled chat");
    expect(entry.epicTitle).toBe("Untitled task");
    expect(entry.description).toBe("Untitled task");
  });

  it("keeps a literal Untitled epic title unchanged for chat descriptions", () => {
    const [entry] = epicChatMentionEntriesFromChats(
      chatsSlice([chat("c1", "Planning", null, 0)]),
      "epic-1",
      "Untitled epic",
    );

    expect(entry.epicTitle).toBe("Untitled epic");
    expect(entry.description).toBe("Untitled epic");
  });

  it("skips chat ids missing from the byId projection", () => {
    const presentChat = chat("c1", "Planning", null, 200);
    const entries = epicChatMentionEntriesFromChats(
      {
        byId: { c1: presentChat },
        allIds: ["missing", "c1"],
      },
      "epic-1",
      "My Epic",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.chatId).toBe("c1");
  });

  it("returns the stable empty array when every chat id is missing", () => {
    const missingOnly: ChatsSlice = {
      byId: {},
      allIds: ["missing"],
    };
    const a = epicChatMentionEntriesFromChats(missingOnly, "epic-1", "My Epic");
    const b = epicChatMentionEntriesFromChats(missingOnly, "epic-1", "My Epic");

    expect(a).toHaveLength(0);
    expect(a).toBe(b);
  });

  it("returns a stable empty array reference when there are no chats", () => {
    const empty = chatsSlice([]);
    const a = epicChatMentionEntriesFromChats(empty, "epic-1", "My Epic");
    const b = epicChatMentionEntriesFromChats(empty, "epic-1", "My Epic");
    expect(a).toHaveLength(0);
    // Same reference -> the gated `useMemo` in useMentionItems stays stable, so
    // the composer never re-renders for an epic with no chats.
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
    parentId: null,
    artifactRoomId: null,
    createdAt: 0,
    updatedAt: fields.updatedAt,
    status: fields.status,
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
