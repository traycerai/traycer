import { afterEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { queryKeys } from "@/lib/query-keys";
import { readCachedChatPublicationId } from "@/hooks/chats/use-chat-publication-targets";

const METHOD = "epic.listChatPublicationTargets" as const;
const HOST = "host-a";
const EPIC = "epic-a";

afterEach(() => resetNegotiatedManifests());

describe("readCachedChatPublicationId", () => {
  it("isolates redirects by host and task independently", () => {
    const queryClient = new QueryClient();
    recordNegotiatedHostManifest(HOST, {
      "epic.listChatRecords": { major: 1, minor: 5 },
    });
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
      readCachedChatPublicationId(queryClient, HOST, EPIC, {
        chatId: "chat-1",
        chatIds: ["chat-1"],
      }),
    ).toBeNull();
  });

  it("reads the stable task slot for a host that supports redirect revisions", () => {
    const queryClient = new QueryClient();
    recordNegotiatedHostManifest(HOST, {
      "epic.listChatRecords": { major: 1, minor: 5 },
    });
    queryClient.setQueryData(
      queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>(HOST, METHOD, {
        epicId: EPIC,
        chatIds: [],
      }),
      { redirected: [{ chatId: "chat-1", publicationChatId: "published-1" }] },
    );

    expect(
      readCachedChatPublicationId(queryClient, HOST, EPIC, {
        chatId: "chat-1",
        chatIds: ["chat-1", "chat-2"],
      }),
    ).toBe("published-1");
  });

  it("uses the sorted full chat-id key for an older host", () => {
    const queryClient = new QueryClient();
    recordNegotiatedHostManifest(HOST, {
      "epic.listChatRecords": { major: 1, minor: 4 },
    });
    queryClient.setQueryData(
      queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>(HOST, METHOD, {
        epicId: EPIC,
        chatIds: ["chat-a", "chat-z"],
      }),
      { redirected: [{ chatId: "chat-a", publicationChatId: "published-a" }] },
    );

    expect(
      readCachedChatPublicationId(queryClient, HOST, EPIC, {
        chatId: "chat-a",
        chatIds: ["chat-z", "chat-a"],
      }),
    ).toBe("published-a");
  });
});
