import { describe, expect, it } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { SortableNode } from "@/lib/epic-sort";
import {
  cloudChatRowKey,
  localChatRowKey,
  mergeChatListEntries,
  selectUnfoldedCloudChats,
} from "@/lib/chats/unified-chat-list";

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
    });
    expect(entries[0].key).not.toBe(localChatRowKey(WALKTHROUGH));
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
