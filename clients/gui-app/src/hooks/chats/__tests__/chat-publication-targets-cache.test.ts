import { afterEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { queryKeys } from "@/lib/query-keys";
import { readCachedChatPublicationId } from "@/hooks/chats/use-chat-publication-targets";

const METHOD = "epic.listChatPublicationTargets" as const;
const HOST = "host-a";
const OTHER_HOST = "host-b";
const EPIC = "epic-a";
const OTHER_EPIC = "epic-b";
const VIEWER = "viewer-a";
const OTHER_VIEWER = "viewer-b";
const queryClients: QueryClient[] = [];

afterEach(() => {
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

function createQueryClient(): QueryClient {
  const queryClient = new QueryClient();
  queryClients.push(queryClient);
  return queryClient;
}

function seedTargets(
  queryClient: QueryClient,
  input: {
    readonly hostId: string;
    readonly epicId: string;
    readonly chatIds: readonly string[];
    readonly viewerUserId: string;
    readonly redirected: readonly {
      readonly chatId: string;
      readonly publicationChatId: string;
    }[];
    readonly updatedAt: number;
  },
): void {
  const queryKey = [
    ...queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>(
      input.hostId,
      METHOD,
      {
        epicId: input.epicId,
        chatIds: [...input.chatIds].sort(),
      },
    ),
    input.viewerUserId,
  ] as const;
  queryClient.setQueryData(
    queryKey,
    { redirected: input.redirected },
    { updatedAt: input.updatedAt },
  );
}

describe("readCachedChatPublicationId", () => {
  it("matches host, task and viewer before reading a partial chat-id entry", () => {
    const queryClient = createQueryClient();
    seedTargets(queryClient, {
      hostId: OTHER_HOST,
      epicId: EPIC,
      chatIds: [],
      viewerUserId: VIEWER,
      redirected: [{ chatId: "chat-1", publicationChatId: "wrong-host" }],
      updatedAt: 300,
    });
    seedTargets(queryClient, {
      hostId: HOST,
      epicId: OTHER_EPIC,
      chatIds: [],
      viewerUserId: VIEWER,
      redirected: [{ chatId: "chat-1", publicationChatId: "wrong-task" }],
      updatedAt: 300,
    });
    seedTargets(queryClient, {
      hostId: HOST,
      epicId: EPIC,
      chatIds: [],
      viewerUserId: OTHER_VIEWER,
      redirected: [{ chatId: "chat-1", publicationChatId: "wrong-viewer" }],
      updatedAt: 300,
    });

    expect(
      readCachedChatPublicationId(queryClient, HOST, EPIC, {
        chatId: "chat-1",
        viewerUserId: VIEWER,
      }),
    ).toBeNull();
  });

  it("finds a redirect cached under a different chatIds set", () => {
    const queryClient = createQueryClient();
    seedTargets(queryClient, {
      hostId: HOST,
      epicId: EPIC,
      chatIds: ["chat-a", "chat-b"],
      viewerUserId: VIEWER,
      redirected: [{ chatId: "chat-a", publicationChatId: "published-a" }],
      updatedAt: 100,
    });

    expect(
      readCachedChatPublicationId(queryClient, HOST, EPIC, {
        chatId: "chat-a",
        viewerUserId: VIEWER,
      }),
    ).toBe("published-a");
  });

  it("chooses the newest partial match across different sorted chat-id sets", () => {
    const queryClient = createQueryClient();
    seedTargets(queryClient, {
      hostId: HOST,
      epicId: EPIC,
      chatIds: ["chat-a", "chat-z"],
      viewerUserId: VIEWER,
      redirected: [
        { chatId: "chat-a", publicationChatId: "published-old" },
        { chatId: "chat-z", publicationChatId: "published-z" },
      ],
      updatedAt: 100,
    });
    seedTargets(queryClient, {
      hostId: HOST,
      epicId: EPIC,
      chatIds: ["chat-a"],
      viewerUserId: VIEWER,
      redirected: [{ chatId: "chat-a", publicationChatId: "published-new" }],
      updatedAt: 200,
    });

    expect(
      readCachedChatPublicationId(queryClient, HOST, EPIC, {
        chatId: "chat-a",
        viewerUserId: VIEWER,
      }),
    ).toBe("published-new");
    expect(
      readCachedChatPublicationId(queryClient, HOST, EPIC, {
        chatId: "chat-z",
        viewerUserId: VIEWER,
      }),
    ).toBe("published-z");
  });

  it("returns null without reading any viewer slot when the viewer is unknown", () => {
    const queryClient = createQueryClient();
    seedTargets(queryClient, {
      hostId: HOST,
      epicId: EPIC,
      chatIds: [],
      viewerUserId: VIEWER,
      redirected: [{ chatId: "chat-1", publicationChatId: "published-1" }],
      updatedAt: 100,
    });

    expect(
      readCachedChatPublicationId(queryClient, HOST, EPIC, {
        chatId: "chat-1",
        viewerUserId: null,
      }),
    ).toBeNull();
  });
});
