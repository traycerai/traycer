/**
 * `readCachedChatPublicationId`'s partial query-key lookup
 * (`hooks/chats/use-chat-publication-targets.ts`).
 *
 * The sidebar's fold mounts `useChatPublicationTargets` with whatever id set
 * the projection currently holds, so the cache can accumulate several answers
 * for one epic under DIFFERENT `chatIds` arrays as that set churns.
 * `useEpicDeleteChat`'s `onMutate` reads this cache imperatively (it cannot
 * mount a hook) to resolve a chat's publication identity BEFORE the delete
 * removes the local row that would otherwise answer the same question, so its
 * lookup has to find an answer regardless of which id-set shape it was cached
 * under, and prefer the freshest one that actually says something about the
 * chat asked about.
 */
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { queryKeys } from "@/lib/query-keys";
import { readCachedChatPublicationId } from "@/hooks/chats/use-chat-publication-targets";

const METHOD = "epic.listChatPublicationTargets" as const;
const HOST_A = "host-a";
const HOST_B = "host-b";
const EPIC_A = "epic-a";
const EPIC_B = "epic-b";

interface Redirect {
  readonly chatId: string;
  readonly publicationChatId: string;
}

interface SeedArgs {
  readonly hostId: string;
  readonly epicId: string;
  readonly chatIds: readonly string[];
  readonly redirected: readonly Redirect[];
  readonly updatedAt: number;
}

function seed(queryClient: QueryClient, args: SeedArgs): void {
  queryClient.setQueryData(
    queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>(args.hostId, METHOD, {
      epicId: args.epicId,
      chatIds: [...args.chatIds],
    }),
    { redirected: [...args.redirected] },
    { updatedAt: args.updatedAt },
  );
}

describe("readCachedChatPublicationId", () => {
  it("returns null with no cached answer at all", () => {
    const queryClient = new QueryClient();
    expect(
      readCachedChatPublicationId(queryClient, HOST_A, EPIC_A, "chat-1"),
    ).toBeNull();
  });

  it("returns null when hostId is null, without consulting the cache", () => {
    const queryClient = new QueryClient();
    seed(queryClient, {
      hostId: HOST_A,
      epicId: EPIC_A,
      chatIds: ["chat-1"],
      redirected: [{ chatId: "chat-1", publicationChatId: "clone-1" }],
      updatedAt: 100,
    });
    expect(
      readCachedChatPublicationId(queryClient, null, EPIC_A, "chat-1"),
    ).toBeNull();
  });

  it("finds a redirect cached under a DIFFERENT chatIds set than the one asked about", () => {
    const queryClient = new QueryClient();
    // Seeded as if a sidebar render resolved the whole epic's id set at
    // once; the delete-time lookup asks about a single id.
    seed(queryClient, {
      hostId: HOST_A,
      epicId: EPIC_A,
      chatIds: ["chat-1", "chat-2", "chat-3"],
      redirected: [{ chatId: "chat-1", publicationChatId: "clone-1" }],
      updatedAt: 100,
    });
    expect(
      readCachedChatPublicationId(queryClient, HOST_A, EPIC_A, "chat-1"),
    ).toBe("clone-1");
  });

  it("prefers the NEWEST cached answer that actually contains the redirect", () => {
    const queryClient = new QueryClient();
    seed(queryClient, {
      hostId: HOST_A,
      epicId: EPIC_A,
      chatIds: ["chat-1"],
      redirected: [{ chatId: "chat-1", publicationChatId: "clone-old" }],
      updatedAt: 100,
    });
    seed(queryClient, {
      hostId: HOST_A,
      epicId: EPIC_A,
      chatIds: ["chat-1", "chat-2"],
      redirected: [{ chatId: "chat-1", publicationChatId: "clone-new" }],
      updatedAt: 200,
    });
    expect(
      readCachedChatPublicationId(queryClient, HOST_A, EPIC_A, "chat-1"),
    ).toBe("clone-new");
  });

  it("falls back to an older answer when the newest cached set never mentions this chat", () => {
    const queryClient = new QueryClient();
    // The newest sweep resolved a different id set and never asked about
    // "chat-1", so it has nothing to say about it either way - the older
    // answer is still the best evidence on hand.
    seed(queryClient, {
      hostId: HOST_A,
      epicId: EPIC_A,
      chatIds: ["chat-1"],
      redirected: [{ chatId: "chat-1", publicationChatId: "clone-old" }],
      updatedAt: 100,
    });
    seed(queryClient, {
      hostId: HOST_A,
      epicId: EPIC_A,
      chatIds: ["chat-2"],
      redirected: [],
      updatedAt: 200,
    });
    expect(
      readCachedChatPublicationId(queryClient, HOST_A, EPIC_A, "chat-1"),
    ).toBe("clone-old");
  });

  it("ignores a cache entry for a different epic", () => {
    const queryClient = new QueryClient();
    seed(queryClient, {
      hostId: HOST_A,
      epicId: EPIC_B,
      chatIds: ["chat-1"],
      redirected: [{ chatId: "chat-1", publicationChatId: "clone-1" }],
      updatedAt: 100,
    });
    expect(
      readCachedChatPublicationId(queryClient, HOST_A, EPIC_A, "chat-1"),
    ).toBeNull();
  });

  it("ignores a cache entry for a different host", () => {
    const queryClient = new QueryClient();
    seed(queryClient, {
      hostId: HOST_B,
      epicId: EPIC_A,
      chatIds: ["chat-1"],
      redirected: [{ chatId: "chat-1", publicationChatId: "clone-1" }],
      updatedAt: 100,
    });
    expect(
      readCachedChatPublicationId(queryClient, HOST_A, EPIC_A, "chat-1"),
    ).toBeNull();
  });

  it("returns null for a chat the cached redirect map never mentions", () => {
    const queryClient = new QueryClient();
    seed(queryClient, {
      hostId: HOST_A,
      epicId: EPIC_A,
      chatIds: ["chat-1", "chat-2"],
      redirected: [{ chatId: "chat-1", publicationChatId: "clone-1" }],
      updatedAt: 100,
    });
    expect(
      readCachedChatPublicationId(queryClient, HOST_A, EPIC_A, "chat-2"),
    ).toBeNull();
  });
});
