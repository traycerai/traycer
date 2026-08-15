import { describe, expect, it } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { TreeNode } from "@/stores/epics/open-epic/types";
import {
  chatSearchTitle,
  chatSearchVisibleIds,
  filterCloudChatsBySearch,
  intersectVisibleIds,
} from "@/components/epic-canvas/sidebar/chat-search-fuzzy";

const CHATS_TREE_FILTER = (type: string | null | undefined): boolean =>
  type === "chat" || type === "terminal-agent";

function node(args: {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly parentId: string | null;
}): TreeNode {
  return {
    id: args.id,
    parentId: args.parentId,
    title: args.title,
    type: args.type as TreeNode["type"],
    status: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function nodeById(
  nodes: ReadonlyArray<TreeNode>,
): Readonly<Record<string, TreeNode>> {
  return Object.fromEntries(nodes.map((entry) => [entry.id, entry]));
}

function cloudChat(args: {
  readonly chatId: string;
  readonly title: string | null;
}): CloudChatSummary {
  return {
    identity: {
      taskId: "task-1",
      chatId: args.chatId,
      ownerUserId: "user-1",
    },
    ownerHostId: "host-1",
    createdAt: 0,
    visibility: "task",
    title: args.title,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 0,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer: true,
  };
}

describe("chatSearchTitle", () => {
  it("renders the same 'Untitled' fallback the row does", () => {
    // Searching by the visible label is the whole contract: a user who reads
    // "Untitled chat" on a row must be able to type it and find that row.
    expect(chatSearchTitle({ title: "", type: "chat" })).toBe("Untitled chat");
    expect(chatSearchTitle({ title: "", type: "terminal-agent" })).toBe(
      "Untitled terminal agent",
    );
  });

  it("keeps the raw title for a type the display map does not know", () => {
    // Inventing a kind label here would make the row searchable by text it
    // never renders.
    expect(chatSearchTitle({ title: "Raw", type: "not-a-kind" })).toBe("Raw");
  });
});

describe("chatSearchVisibleIds", () => {
  const nodes = nodeById([
    node({
      id: "c1",
      title: "Fix the auth handshake",
      type: "chat",
      parentId: null,
    }),
    node({
      id: "c2",
      title: "Refactor the sidebar",
      type: "chat",
      parentId: null,
    }),
    node({
      id: "t1",
      title: "Deploy runner",
      type: "terminal-agent",
      parentId: null,
    }),
    node({ id: "a1", title: "Auth spec", type: "spec", parentId: null }),
  ]);

  it("returns null for an empty or whitespace query", () => {
    // `null` is the shared "not narrowing" value, not an empty match set - an
    // empty set would blank the tree.
    expect(
      chatSearchVisibleIds({
        query: "",
        nodeById: nodes,
        treeFilter: CHATS_TREE_FILTER,
      }),
    ).toBeNull();
    expect(
      chatSearchVisibleIds({
        query: "   ",
        nodeById: nodes,
        treeFilter: CHATS_TREE_FILTER,
      }),
    ).toBeNull();
  });

  it("matches a title fuzzily and excludes non-matches", () => {
    const visible = chatSearchVisibleIds({
      query: "handshake",
      nodeById: nodes,
      treeFilter: CHATS_TREE_FILTER,
    });
    expect(visible?.has("c1")).toBe(true);
    expect(visible?.has("c2")).toBe(false);
  });

  it("tolerates a typo", () => {
    const visible = chatSearchVisibleIds({
      query: "sidbar",
      nodeById: nodes,
      treeFilter: CHATS_TREE_FILTER,
    });
    expect(visible?.has("c2")).toBe(true);
  });

  it("never matches a node the panel does not render", () => {
    // "Auth spec" would score against "auth", but an artifact is not an agent
    // and must not be revealed by the agent panel's search.
    const visible = chatSearchVisibleIds({
      query: "auth",
      nodeById: nodes,
      treeFilter: CHATS_TREE_FILTER,
    });
    expect(visible?.has("a1")).toBe(false);
  });

  it("includes a match's ancestors so a nested agent stays reachable", () => {
    const nested = nodeById([
      node({ id: "p1", title: "Parent agent", type: "chat", parentId: null }),
      node({ id: "c9", title: "Nested zebra", type: "chat", parentId: "p1" }),
    ]);
    const visible = chatSearchVisibleIds({
      query: "zebra",
      nodeById: nested,
      treeFilter: CHATS_TREE_FILTER,
    });
    expect(visible?.has("c9")).toBe(true);
    // The parent does not match the query; it is present only as the path to
    // the match. Dropping it would hide the match behind an unrendered branch.
    expect(visible?.has("p1")).toBe(true);
  });
});

describe("filterCloudChatsBySearch", () => {
  const chats = [
    cloudChat({ chatId: "r1", title: "Remote migration" }),
    cloudChat({ chatId: "r2", title: "Something else" }),
    cloudChat({ chatId: "r3", title: null }),
  ];

  it("passes every row through for an empty query", () => {
    expect(filterCloudChatsBySearch(chats, "  ")).toHaveLength(3);
  });

  it("narrows cloud rows by title alongside the local tree", () => {
    const matched = filterCloudChatsBySearch(chats, "migration");
    expect(matched.map((chat) => chat.identity.chatId)).toEqual(["r1"]);
  });

  it("matches a null-titled row by its rendered fallback", () => {
    const matched = filterCloudChatsBySearch(chats, "untitled");
    expect(matched.map((chat) => chat.identity.chatId)).toEqual(["r3"]);
  });
});

describe("intersectVisibleIds", () => {
  it("passes either side through when the other is not narrowing", () => {
    const filter = new Set(["a", "b"]);
    expect(intersectVisibleIds(filter, null)).toBe(filter);
    const search = new Set(["b"]);
    expect(intersectVisibleIds(null, search)).toBe(search);
    expect(intersectVisibleIds(null, null)).toBeNull();
  });

  it("intersects when both narrow", () => {
    // A row must survive BOTH the filter chips and the query; the union would
    // let search re-reveal rows the filters deliberately hid.
    const combined = intersectVisibleIds(
      new Set(["a", "b"]),
      new Set(["b", "c"]),
    );
    expect(combined === null ? [] : [...combined]).toEqual(["b"]);
  });
});
