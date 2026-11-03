/**
 * A bell row about a member's post in a bot's conversation draws that member,
 * or its kind glyph when we do not know them; the bot's picture is for the
 * bot's own rows. The real `NotificationRow` under
 * the real `NotificationBotsProvider` and the real loaded-members read over a
 * mock messenger; the merged row and the host's `bot.list` answer are the
 * boundaries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { BotListResponse } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentMembersResponseV12 } from "@traycer/protocol/host/environment/contracts";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { stubImmediateImage } from "@/__tests__/immediate-avatar-image";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ENVIRONMENT_ID = "env-1";

const mocks = vi.hoisted(() => ({
  row: null as MergedNotificationRow | null,
  bots: undefined as BotListResponse | undefined,
  client: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/stores/notifications/merged-notifications", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/stores/notifications/merged-notifications")
    >();
  return {
    ...actual,
    useMergedNotificationRow: () => mocks.row,
  };
});
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/host/use-reactive-local-host-entry", () => ({
  useReactiveLocalHostEntry: () => null,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useRemoteSessionPollReadiness: () => false,
  useHostReachability: () => ({ status: "reachable" }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHost: () => ({
    hostId: mockLocalHostEntry.hostId,
    client: mocks.client,
  }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "bot.list",
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (
    client: { getActiveHostId: () => string | null } | null,
  ) => {
    const hostId = client === null ? null : client.getActiveHostId();
    return {
      hostId,
      requestContextUserId: "user-1",
      isReady: hostId !== null,
      hasRpcEndpoint: hostId !== null,
      canExecute: hostId !== null,
    };
  },
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: (_client: unknown, enabled: boolean) => ({
    data: enabled ? mocks.bots : undefined,
    isFetched: enabled,
  }),
}));

import { NotificationRow } from "@/components/notifications/notification-row";
import { NotificationBotsProvider } from "@/components/notifications/notification-bots";

let queryClient: QueryClient;
let memberRequests: number;

function membersPage(member: {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
}): EnvironmentMembersResponseV12 {
  return {
    members: [
      {
        ...member,
        email: `${member.userId}@acme.test`,
        effectiveRole: "viewer",
        linkedPlan: false,
        inviteState: null,
        invitedAddress: null,
      },
    ],
    nextCursor: null,
    legacyRoleNoticeSeenAt: null,
    legacyMembers: [],
  };
}

function cacheMembers(page: EnvironmentMembersResponseV12): void {
  queryClient.setQueryData(
    queryKeys.hostMethod<HostRpcRegistry, "environment.members">(
      mockLocalHostEntry.hostId,
      "environment.members",
      { environmentId: ENVIRONMENT_ID, cursor: null },
    ),
    page,
  );
}

function conversationRow(
  botId: string,
  botAuthorUserId: string | null,
): MergedNotificationRow {
  return {
    feedId: "host:conversation-1",
    source: "host",
    sourceId: "conversation-1",
    createdAt: 1_000,
    readAt: null,
    title: "Tracy",
    body: "A question for Tracy",
    payload: {
      kind: "chat",
      epicId: botId,
      chatId: "thread-1",
      bot: { botId, threadId: "thread-1", messageId: "message-1" },
    },
    hostKind: "host.operation.finished",
    appLocalKind: null,
    globalEntry: null,
    severity: "done",
    outcome: null,
    resolvedAt: null,
    sourceRef: null,
    originHostId: null,
    category: "task",
    botAuthorUserId,
  };
}

function renderRow(row: MergedNotificationRow): HTMLElement {
  mocks.row = row;
  render(
    <QueryClientProvider client={queryClient}>
      <NotificationBotsProvider>
        <ul>
          <NotificationRow
            feedId={row.feedId}
            highlightRelocation={false}
            onActivate={vi.fn()}
            onAcknowledge={vi.fn()}
          />
        </ul>
      </NotificationBotsProvider>
    </QueryClientProvider>,
  );
  return screen.getByTestId("notification-entry");
}

beforeEach(() => {
  mocks.row = null;
  mocks.bots = {
    bots: [
      {
        botId: BOT_ID,
        environmentId: ENVIRONMENT_ID,
        createdByUserId: "user-1",
        title: "Tracy",
        harness: "claude",
        model: "claude-opus-5-5",
        effort: null,
        profile: null,
        trunkChatId: "trunk-1",
        boundHostId: mockLocalHostEntry.hostId,
        hostEpoch: 0,
        createdAt: 1,
        archivedAt: null,
        directive: null,
        replyMode: "direct",
        appConversationChatId: null,
      },
    ],
    mainBotIds: {},
  };
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-1", userName: "Viewer", email: "v@example.com" },
      { userId: "user-1", username: "Viewer" },
      [],
    );
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  memberRequests = 0;
  let requestCount = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${String((requestCount += 1))}`,
      handlers: {
        "environment.members": () => {
          memberRequests += 1;
          return membersPage({
            userId: "never",
            displayName: null,
            avatarUrl: null,
          });
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  mocks.client = spine.createRequester(mockLocalHostEntry);
  stubImmediateImage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
  useAuthStore.getState().setSignedOut();
});

describe("<NotificationRow /> about a member's post", () => {
  it("draws the member who wrote it, with their picture, in place of the bot", async () => {
    cacheMembers(
      membersPage({
        userId: "user-2",
        displayName: "Grace Hopper",
        avatarUrl: "https://example.com/grace.png",
      }),
    );

    const entry = renderRow(conversationRow(BOT_ID, "user-2"));

    const person = within(entry).getByTestId("person-avatar");
    await waitFor(() => {
      expect(person.querySelector("img")?.getAttribute("src")).toBe(
        "https://example.com/grace.png",
      );
    });
    expect(within(entry).queryByTestId("bot-avatar")).toBeNull();
  });

  it("keeps the bot's picture on a row the bot wrote, though its members are cached", () => {
    cacheMembers(
      membersPage({
        userId: "user-2",
        displayName: "Grace Hopper",
        avatarUrl: "https://example.com/grace.png",
      }),
    );

    const entry = renderRow(conversationRow(BOT_ID, null));

    expect(within(entry).getByTestId("bot-avatar")).toBeTruthy();
    expect(within(entry).queryByTestId("person-avatar")).toBeNull();
  });

  it("keeps the kind glyph, not the bot, when the author is not among the cached members", () => {
    cacheMembers(
      membersPage({
        userId: "user-2",
        displayName: "Grace Hopper",
        avatarUrl: "https://example.com/grace.png",
      }),
    );

    const entry = renderRow(conversationRow(BOT_ID, "user-9"));

    expect(within(entry).queryByTestId("bot-avatar")).toBeNull();
    expect(within(entry).queryByTestId("person-avatar")).toBeNull();
    expect(entry.querySelector("svg.lucide")).not.toBeNull();
  });

  it("keeps the kind glyph for a member known by id alone, never initials from the id", () => {
    cacheMembers(
      membersPage({ userId: "user-2", displayName: null, avatarUrl: null }),
    );

    const entry = renderRow(conversationRow(BOT_ID, "user-2"));

    expect(within(entry).queryByTestId("person-avatar")).toBeNull();
    expect(within(entry).queryByTestId("bot-avatar")).toBeNull();
    expect(entry.querySelector("svg.lucide")).not.toBeNull();
  });

  it("asks the host for no members when none are cached", () => {
    renderRow(conversationRow(BOT_ID, "user-2"));

    expect(queryClient.isFetching()).toBe(0);
    expect(memberRequests).toBe(0);
  });
});
