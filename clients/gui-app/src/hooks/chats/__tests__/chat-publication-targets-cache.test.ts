import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { queryKeys } from "@/lib/query-keys";
import { readCachedChatPublicationId } from "@/hooks/chats/use-chat-publication-targets";

const METHOD = "epic.listChatPublicationTargets" as const;
const HOST = "host-a";
const EPIC = "epic-a";

describe("readCachedChatPublicationId", () => {
  it("finds a redirect in the stable task-keyed cache entry", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>(HOST, METHOD, {
        epicId: EPIC,
        chatIds: [],
      }),
      { redirected: [{ chatId: "chat-1", publicationChatId: "clone-1" }] },
    );

    expect(readCachedChatPublicationId(queryClient, HOST, EPIC, "chat-1")).toBe(
      "clone-1",
    );
  });

  it("isolates redirects by host and task independently", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>("host-b", METHOD, {
        epicId: EPIC,
        chatIds: [],
      }),
      { redirected: [{ chatId: "chat-1", publicationChatId: "wrong-host" }] },
    );
    queryClient.setQueryData(
      queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>(HOST, METHOD, {
        epicId: "epic-b",
        chatIds: [],
      }),
      { redirected: [{ chatId: "chat-1", publicationChatId: "wrong-task" }] },
    );

    expect(
      readCachedChatPublicationId(queryClient, HOST, EPIC, "chat-1"),
    ).toBeNull();
  });
});
