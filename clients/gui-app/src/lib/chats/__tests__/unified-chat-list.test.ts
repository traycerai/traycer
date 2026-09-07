import { describe, expect, it } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { SortableNode } from "@/lib/epic-sort";
import {
  chatListLastActiveAtByKey,
  localChatLastActiveAtById,
  chatRowLastActiveAt,
  cloudChatLastActiveAt,
  cloudChatRowKey,
  cloudChatRowLastActiveAt,
  indexOwnCloudChatsByLocalId,
  localChatRowKey,
  mergeChatListEntries,
  selectUnfoldedCloudChats,
} from "@/lib/chats/unified-chat-list";
import { chatRecordKey } from "@/stores/epics/open-epic/chat-record-head";
import type { ChatProjection } from "@/stores/epics/open-epic/types";

/**
 * The fold and the interleave, driven by the geometry that motivated them.
 *
 * The fork numbers below are not invented: they are the live witness on task
 * `d60781ca` - a local chat `56254cae…` whose publication was redirected into
 * the derived clone row `d44cc96f…` after the other host's lineage kept the
 * original cloud row. Every wrong fold this file guards against was observable
 * on that task.
 */

const TASK = "d60781ca-e0d3-4318-bf2a-e03d8ce4e3a7";
const VIEWER = "user-1";
/** The local live agent. Its cloud row is now the clone below. */
const WALKTHROUGH = "56254cae-aa80-4d06-914c-5086cdd65e3c";
/** Where the local lineage stepped aside to. Server-derived; not guessable. */
const CLONE_ROW = "d44cc96fc1d364fe4a9e3cd2d5eb2eea";
const LOCAL_HOST = "host-a";
const OTHER_HOST = "host-b";

function cloudChat(overrides: {
  readonly chatId: string;
  readonly ownerHostId: string;
  readonly title: string | null;
  readonly publishedAt: number | null;
  readonly metadataUpdatedAt: number;
  readonly createdAt: number;
}): CloudChatSummary {
  return {
    identity: { taskId: TASK, chatId: overrides.chatId, ownerUserId: VIEWER },
    ownerHostId: overrides.ownerHostId,
    createdAt: overrides.createdAt,
    visibility: "task",
    title: overrides.title,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: overrides.metadataUpdatedAt,
    headSha256: null,
    publishedAt: overrides.publishedAt,
    throughRecordSeq: null,
    isOwnedByViewer: true,
  };
}

/** The incumbent: the other host's lineage, still holding the original id. */
const INCUMBENT_ROW = cloudChat({
  chatId: WALKTHROUGH,
  ownerHostId: OTHER_HOST,
  title: "Walkthrough",
  publishedAt: 300,
  metadataUpdatedAt: 300,
  createdAt: 100,
});

/** The clone: where THIS device's copy of the chat now backs up. */
const LOCAL_BACKUP_ROW = cloudChat({
  chatId: CLONE_ROW,
  ownerHostId: LOCAL_HOST,
  title: "Walkthrough",
  publishedAt: 500,
  metadataUpdatedAt: 500,
  createdAt: 100,
});

const FORK_REDIRECT = new Map([[WALKTHROUGH, CLONE_ROW]]);
const NO_REDIRECTS = new Map<string, string>();

describe("cloudChatLastActiveAt", () => {
  it("uses the published content time instead of a later metadata edit", () => {
    expect(
      cloudChatLastActiveAt(
        cloudChat({
          chatId: WALKTHROUGH,
          ownerHostId: LOCAL_HOST,
          title: "Renamed",
          publishedAt: 300,
          metadataUpdatedAt: 900,
          createdAt: 100,
        }),
      ),
    ).toBe(300);
  });

  it("falls back to metadata time before the first publication", () => {
    expect(
      cloudChatLastActiveAt(
        cloudChat({
          chatId: WALKTHROUGH,
          ownerHostId: LOCAL_HOST,
          title: "New chat",
          publishedAt: null,
          metadataUpdatedAt: 200,
          createdAt: 100,
        }),
      ),
    ).toBe(200);
  });
});

describe("chatRowLastActiveAt", () => {
  it("keeps the serving host's fresher record activity time", () => {
    expect(
      chatRowLastActiveAt({
        recordUpdatedAt: 900,
        ownerHostId: LOCAL_HOST,
        sessionHostId: LOCAL_HOST,
        cloudChat: LOCAL_BACKUP_ROW,
        recordHeadPublishedAt: null,
      }),
    ).toBe(900);
  });

  it("uses publication time for a record replicated from another host", () => {
    expect(
      chatRowLastActiveAt({
        recordUpdatedAt: 900,
        ownerHostId: OTHER_HOST,
        sessionHostId: LOCAL_HOST,
        cloudChat: INCUMBENT_ROW,
        recordHeadPublishedAt: null,
      }),
    ).toBe(300);
  });

  it("prefers the record head over a cloud row's own `publishedAt` for a foreign row, whenever the head is present", () => {
    // The head is pushed by the record stream as the owner publishes and is
    // fresher than the polled cloud list, which can lag it by up to its
    // stale window - so it wins even when it disagrees with `publishedAt`.
    expect(
      chatRowLastActiveAt({
        recordUpdatedAt: 900,
        ownerHostId: OTHER_HOST,
        sessionHostId: LOCAL_HOST,
        cloudChat: INCUMBENT_ROW, // publishedAt: 300
        recordHeadPublishedAt: 700,
      }),
    ).toBe(700);
  });

  it("falls back to the cloud row's `publishedAt` for a foreign row with no record head yet", () => {
    expect(
      chatRowLastActiveAt({
        recordUpdatedAt: 900,
        ownerHostId: OTHER_HOST,
        sessionHostId: LOCAL_HOST,
        cloudChat: INCUMBENT_ROW, // publishedAt: 300
        recordHeadPublishedAt: null,
      }),
    ).toBe(300);
  });

  it("ignores a record head on a NON-foreign row - the serving host's own record time wins regardless", () => {
    expect(
      chatRowLastActiveAt({
        recordUpdatedAt: 900,
        ownerHostId: LOCAL_HOST,
        sessionHostId: LOCAL_HOST,
        cloudChat: LOCAL_BACKUP_ROW,
        recordHeadPublishedAt: 700,
      }),
    ).toBe(900);
  });
});

describe("cloudChatRowLastActiveAt", () => {
  it("prefers the record head when the epic's record table holds one for this identity", () => {
    expect(cloudChatRowLastActiveAt(INCUMBENT_ROW, 700)).toBe(700);
  });

  it("falls back to the cloud row's own activity time when there is no record head", () => {
    expect(cloudChatRowLastActiveAt(INCUMBENT_ROW, null)).toBe(
      cloudChatLastActiveAt(INCUMBENT_ROW),
    );
  });
});

function node(
  id: string,
  title: string,
  updatedAt: number,
  createdAt: number,
): SortableNode {
  return { id, title, createdAt, updatedAt };
}

describe("selectUnfoldedCloudChats", () => {
  it("folds a chat's own backup row away", () => {
    const rows = selectUnfoldedCloudChats({
      chats: [
        cloudChat({
          chatId: "chat-a",
          ownerHostId: LOCAL_HOST,
          title: "A",
          publishedAt: 10,
          metadataUpdatedAt: 10,
          createdAt: 1,
        }),
      ],
      localChatIds: ["chat-a"],
      publicationChatIdByChatId: NO_REDIRECTS,
    });
    expect(rows).toEqual([]);
  });

  it("keeps a chat that lives only on another machine", () => {
    const rows = selectUnfoldedCloudChats({
      chats: [INCUMBENT_ROW],
      localChatIds: [],
      publicationChatIdByChatId: NO_REDIRECTS,
    });
    expect(rows).toEqual([INCUMBENT_ROW]);
  });

  describe("the live fork geometry on task d60781ca", () => {
    const inputs = {
      chats: [INCUMBENT_ROW, LOCAL_BACKUP_ROW],
      localChatIds: [WALKTHROUGH],
      publicationChatIdByChatId: FORK_REDIRECT,
    } as const;

    it("renders exactly two rows, never three", () => {
      // The local tree contributes "Walkthrough"; this must contribute exactly
      // one more. Three rows was the shipped behaviour this ticket replaces.
      expect(selectUnfoldedCloudChats(inputs)).toHaveLength(1);
    });

    it("folds the clone row the local chat now publishes into", () => {
      const kept = selectUnfoldedCloudChats(inputs);
      expect(kept.some((chat) => chat.identity.chatId === CLONE_ROW)).toBe(
        false,
      );
    });

    it("keeps the incumbent row even though it shares the local chat's id", () => {
      // The half a `chatId` fold gets wrong in the other direction: this is a
      // real chat on another machine, and folding it makes it vanish.
      const kept = selectUnfoldedCloudChats(inputs);
      expect(kept).toEqual([INCUMBENT_ROW]);
      expect(kept[0].ownerHostId).toBe(OTHER_HOST);
    });

    it("degrades to the pre-fork answer when the mapping is unavailable", () => {
      // An older host has no `epic.listChatPublicationTargets`. The fold then
      // keeps the clone and drops the incumbent - wrong, but it is the exact
      // behaviour that host could always support, and it still renders a list.
      const kept = selectUnfoldedCloudChats({
        ...inputs,
        publicationChatIdByChatId: NO_REDIRECTS,
      });
      expect(kept).toEqual([LOCAL_BACKUP_ROW]);
    });
  });
});

describe("indexOwnCloudChatsByLocalId", () => {
  it("leaves an unpublished local chat out of the map", () => {
    const byLocalId = indexOwnCloudChatsByLocalId({
      chats: [],
      localChatIds: ["chat-new"],
      publicationChatIdByChatId: NO_REDIRECTS,
    });
    expect(byLocalId.get("chat-new")).toBeUndefined();
  });

  it("joins a local chat to the cloud row it publishes into after a fork", () => {
    const byLocalId = indexOwnCloudChatsByLocalId({
      chats: [INCUMBENT_ROW, LOCAL_BACKUP_ROW],
      localChatIds: [WALKTHROUGH],
      publicationChatIdByChatId: FORK_REDIRECT,
    });
    expect(byLocalId.get(WALKTHROUGH)).toEqual(LOCAL_BACKUP_ROW);
  });

  it("does not fold another owner's row that happens to share the local id", () => {
    const foreign: CloudChatSummary = {
      ...INCUMBENT_ROW,
      isOwnedByViewer: false,
      identity: {
        ...INCUMBENT_ROW.identity,
        ownerUserId: "someone-else",
      },
    };
    const byLocalId = indexOwnCloudChatsByLocalId({
      chats: [foreign],
      localChatIds: [WALKTHROUGH],
      publicationChatIdByChatId: NO_REDIRECTS,
    });
    expect(byLocalId.get(WALKTHROUGH)).toBeUndefined();
  });
});

describe("mergeChatListEntries", () => {
  const nodeById: Readonly<Record<string, SortableNode>> = {
    "chat-old": node("chat-old", "Older local", 100, 50),
    "chat-new": node("chat-new", "Newer local", 900, 50),
  };

  it("interleaves cloud rows into the local list by recency", () => {
    // The point of the whole ticket: a cloud row sorts by when it last
    // published, among the local rows, rather than below all of them.
    const entries = mergeChatListEntries({
      localRootIds: ["chat-new", "chat-old"],
      nodeById,
      cloudChats: [INCUMBENT_ROW],
      comparator: null,
      lastActiveAtByKey: new Map(),
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      localChatRowKey("chat-new"),
      cloudChatRowKey(INCUMBENT_ROW.identity),
      localChatRowKey("chat-old"),
    ]);
  });

  it("preserves the projector's local order under the default sort", () => {
    // Re-applying DEFAULT_SORT_MODE must reproduce the incoming order, not
    // perturb it - the projector sorts the projection by the same rule.
    const entries = mergeChatListEntries({
      localRootIds: ["chat-new", "chat-old"],
      nodeById,
      cloudChats: [],
      comparator: null,
      lastActiveAtByKey: new Map(),
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      localChatRowKey("chat-new"),
      localChatRowKey("chat-old"),
    ]);
  });

  it("sorts a never-published cloud row by its metadata stamp", () => {
    const unpublished = cloudChat({
      chatId: "chat-unpublished",
      ownerHostId: OTHER_HOST,
      title: "Draft",
      publishedAt: null,
      metadataUpdatedAt: 500,
      createdAt: 400,
    });
    const entries = mergeChatListEntries({
      localRootIds: ["chat-new", "chat-old"],
      nodeById,
      cloudChats: [unpublished],
      comparator: null,
      lastActiveAtByKey: new Map(),
    });
    expect(entries[1].key).toBe(cloudChatRowKey(unpublished.identity));
  });

  it("keeps the two kinds of key in separate spaces", () => {
    // A cloud row and a local row can share a chat id after a fork; if the
    // keys collided React would reuse one row's element for the other.
    const entries = mergeChatListEntries({
      localRootIds: [],
      nodeById: {},
      cloudChats: [INCUMBENT_ROW],
      comparator: null,
      lastActiveAtByKey: new Map(),
    });
    expect(entries[0].key).not.toBe(localChatRowKey(WALKTHROUGH));
  });

  it("reorders a row given a `lastActiveAtByKey` override - a cloud row with a newer override sorts ahead of a local root", () => {
    // The override carries the SAME value the row's idle-time chip renders,
    // so the order and the chip must never disagree about which chat moved
    // last - even when it contradicts the row's own `updatedAt`.
    const entries = mergeChatListEntries({
      localRootIds: ["chat-new", "chat-old"],
      nodeById,
      cloudChats: [INCUMBENT_ROW], // updatedAt (publishedAt): 300
      comparator: null,
      lastActiveAtByKey: new Map([
        [cloudChatRowKey(INCUMBENT_ROW.identity), 950],
      ]),
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      cloudChatRowKey(INCUMBENT_ROW.identity),
      localChatRowKey("chat-new"),
      localChatRowKey("chat-old"),
    ]);
  });
});

describe("localChatLastActiveAtById / chatListLastActiveAtByKey", () => {
  function projection(overrides: {
    readonly id: string;
    readonly hostId: string | null;
    readonly userId: string | null;
    readonly updatedAt: number;
  }): ChatProjection {
    return {
      id: overrides.id,
      title: overrides.id,
      parentId: null,
      createdAt: 1,
      updatedAt: overrides.updatedAt,
      userId: overrides.userId,
      hostId: overrides.hostId,
      isTitleEditedByUser: false,
      settings: null,
      archivedAt: null,
    };
  }
  const HEAD = {
    headSha256: "a".repeat(64),
    throughRecordSeq: 3,
    publishedAt: 950,
  };

  it("enters a foreign root's record head and a cloud row's, and nothing for a local-host root", () => {
    // The same rule the chips render: a foreign record's clock is its record
    // head; a local-host root keeps its own stamp and is simply absent.
    const recordHeads = {
      [chatRecordKey(VIEWER, "foreign")]: HEAD,
      [chatRecordKey(VIEWER, "local")]: HEAD,
      [chatRecordKey(INCUMBENT_ROW.identity.ownerUserId, WALKTHROUGH)]: HEAD,
    };
    const byId = localChatLastActiveAtById({
      chatsById: {
        foreign: projection({
          id: "foreign",
          hostId: OTHER_HOST,
          userId: VIEWER,
          updatedAt: 100,
        }),
        local: projection({
          id: "local",
          hostId: LOCAL_HOST,
          userId: VIEWER,
          updatedAt: 100,
        }),
      },
      recordHeads,
      sessionHostId: LOCAL_HOST,
      ownCloudChatByLocalId: new Map(),
    });
    expect(byId.get("foreign")).toBe(950);
    expect(byId.has("local")).toBe(false);
    const byKey = chatListLastActiveAtByKey({
      localLastActiveAtById: byId,
      recordHeads,
      cloudChats: [INCUMBENT_ROW],
    });
    expect(byKey.get(localChatRowKey("foreign"))).toBe(950);
    expect(byKey.has(localChatRowKey("local"))).toBe(false);
    expect(byKey.get(cloudChatRowKey(INCUMBENT_ROW.identity))).toBe(950);
  });

  it("falls back to the folded cloud row for a foreign root without a head, and skips a cloud row without one", () => {
    const byId = localChatLastActiveAtById({
      chatsById: {
        foreign: projection({
          id: "foreign",
          hostId: OTHER_HOST,
          userId: VIEWER,
          updatedAt: 100,
        }),
      },
      recordHeads: {},
      sessionHostId: LOCAL_HOST,
      ownCloudChatByLocalId: new Map([["foreign", INCUMBENT_ROW]]),
    });
    const byKey = chatListLastActiveAtByKey({
      localLastActiveAtById: byId,
      recordHeads: {},
      cloudChats: [LOCAL_BACKUP_ROW],
    });
    expect(byKey.get(localChatRowKey("foreign"))).toBe(300);
    expect(byKey.has(cloudChatRowKey(LOCAL_BACKUP_ROW.identity))).toBe(false);
  });
});

describe("cross-owner folding", () => {
  /**
   * The reviewer's executable case. `chatId` is host-minted and not unique
   * under a task, and the cloud list carries every task-visible chat including
   * other people's - so an id-only fold can delete a collaborator's genuinely
   * different chat from the only agent list there now is.
   */
  const COLLABORATOR_ROW: CloudChatSummary = {
    ...cloudChat({
      chatId: "chat-a",
      ownerHostId: OTHER_HOST,
      title: "Their chat",
      publishedAt: 200,
      metadataUpdatedAt: 200,
      createdAt: 100,
    }),
    identity: { taskId: TASK, chatId: "chat-a", ownerUserId: "user-2" },
    isOwnedByViewer: false,
  };

  it("never folds another owner's row into a local entry", () => {
    const kept = selectUnfoldedCloudChats({
      chats: [COLLABORATOR_ROW],
      localChatIds: ["chat-a"],
      publicationChatIdByChatId: NO_REDIRECTS,
    });
    expect(kept).toEqual([COLLABORATOR_ROW]);
  });

  it("still folds the viewer's own backup with the same id", () => {
    // The owner check must not disable the fold it guards.
    const own = cloudChat({
      chatId: "chat-a",
      ownerHostId: LOCAL_HOST,
      title: "My chat",
      publishedAt: 200,
      metadataUpdatedAt: 200,
      createdAt: 100,
    });
    const kept = selectUnfoldedCloudChats({
      chats: [own, COLLABORATOR_ROW],
      localChatIds: ["chat-a"],
      publicationChatIdByChatId: NO_REDIRECTS,
    });
    expect(kept).toEqual([COLLABORATOR_ROW]);
  });
});
