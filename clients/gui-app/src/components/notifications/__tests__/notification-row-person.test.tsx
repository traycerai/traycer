/**
 * A bell row about a member's post in a bot's conversation draws that member,
 * or its kind glyph when we do not know them; the bot's picture is for the
 * bot's own rows. The real `NotificationRow` under
 * the real `NotificationBotsProvider` and the real loaded-members read over the
 * page harness's fake authn, which serves the Members pages; the merged row and
 * the host's `bot.list` answer are the boundaries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { BotListResponse } from "@traycer/protocol/host/bot/schemas";
import type {
  ChatRecordSummaryV12,
  ChatRecordSummaryV15,
} from "@traycer/protocol/host/epic/chat-records";
import type { EnvironmentMembersResponseV12 } from "@traycer/protocol/host/environment/contracts";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { stubImmediateImage } from "@/__tests__/immediate-avatar-image";
import { TestEpicSessionWrapper } from "@/components/epic-canvas/__tests__/test-epic-session";
import { createEpicSessionTestHarness } from "@/components/epic-canvas/__tests__/test-epic-session-harness";
import { TestRouterProvider } from "@/__tests__/with-test-router";
import { useLoadedEnvironmentMembers } from "@/hooks/bots/use-environment-members-query";
import { useEnvironmentMembersPages } from "@/hooks/environment/use-environment-members-list";
import { PersonMembersContext } from "@/hooks/identity/use-person-identity";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { HostRuntimeProvider } from "@/lib/host/runtime";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  mountTeamPage,
  poolSource,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ENVIRONMENT_ID = "env-1";
type StarterStore = OpenEpicStoreHandle["store"];

const STARTER_EPIC_ID = "epic-notification-starter";
const STARTER_CHAT_ID = "chat-notification-starter";

const mocks = vi.hoisted(() => ({
  row: null as MergedNotificationRow | null,
  bots: undefined as BotListResponse | undefined,
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
vi.mock("@/providers/use-runner-host", async (importActual) => ({
  ...(await importActual<typeof import("@/providers/use-runner-host")>()),
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHost: () => ({
    hostId: mockLocalHostEntry.hostId,
    client: null,
  }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "bot.list",
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: (_client: unknown, enabled: boolean) => ({
    data: enabled ? mocks.bots : undefined,
    isFetched: enabled,
  }),
}));

import { NotificationRow } from "@/components/notifications/notification-row";
import { NotificationBotsProvider } from "@/components/notifications/notification-bots";

let harness: TeamPageHarness;
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

/** Publishes a page as the Members surface would have read it from authn. */
function cacheMembers(page: EnvironmentMembersResponseV12): void {
  const keys = renderHook(
    () => useEnvironmentMembersPages(ENVIRONMENT_ID, false),
    { wrapper: harness.Wrapper },
  );
  queryClient.setQueryData(
    keys.result.current.pageKey(ENVIRONMENT_ID, null),
    page,
  );
  keys.unmount();
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
    <harness.Wrapper>
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
    </harness.Wrapper>,
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
  memberRequests = 0;
  harness = mountTeamPage(poolSource("viewer"), {
    "environment.members": () => {
      memberRequests += 1;
      return membersPage({
        userId: "never",
        displayName: null,
        avatarUrl: null,
      });
    },
  });
  queryClient = harness.queryClient;
  stubImmediateImage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
  resetTeamPageHarness();
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

  it("asks authn for no members when none are cached", () => {
    renderRow(conversationRow(BOT_ID, "user-2"));

    expect(queryClient.isFetching()).toBe(0);
    expect(memberRequests).toBe(0);
  });
});

// Board C30 row 24 governs when a notification may replace its server body:
// the chat did not fail, its task is open in this session, a person started it.
describe("NotificationRow started-by attribution", () => {
  const epicHarness = createEpicSessionTestHarness(STARTER_EPIC_ID);
  let runnerHost: MockRunnerHost;
  let authnRequests: string[];

  beforeEach(async () => {
    authnRequests = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      authnRequests.push(requestUrl(input));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    runnerHost = new MockRunnerHost({
      signInUrl: "https://example.com",
      authnBaseUrl: "https://auth.example.com",
      localHost: {
        hostId: mockLocalHostEntry.hostId,
        websocketUrl: "ws://127.0.0.1:4917/rpc",
        version: "0.0.0-mock",
        pid: 1,
        systemHostName: "notification-test",
        displayName: "Notification test",
        availability: "available",
      },
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    runnerHost.selectionPreferredStore.save(
      "user-1",
      mockLocalHostEntry.hostId,
    );
    runnerHost.selectionIdentity.set("user-1");
    runnerHost.setHosts([]);
    await runnerHost.tokenStore.signIn(
      { token: "t1", refreshToken: "r1" },
      { id: "user-1", email: "v@example.com", name: "Viewer" },
    );
    epicHarness.install(null, "editor");
  });

  afterEach(() => {
    cleanup();
    epicHarness.teardown();
    useSelectionAuthorityStore.getState().reset();
  });

  it("keeps a failed chat's own text even when its open task has a starter", async () => {
    cacheMembers(
      membersPage({
        userId: "user-2",
        displayName: "Grace Hopper",
        avatarUrl: null,
      }),
    );
    render(startedRowTree(starterNotificationRow("errored"), true));
    const store = await waitForStarterStore();
    seedStarter(store, "user-2");

    const entry = await screen.findByTestId("notification-entry");
    expect(within(entry).getByText("The server's chat result")).not.toBeNull();
    expect(within(entry).queryByText(/Started by/)).toBeNull();
  });

  it("keeps a closed task's text without an authn lookup for its starter", () => {
    const cloudRequestsBefore = harness.cloudRequests.length;
    const entry = renderRow(starterNotificationRow("completed"));

    expect(within(entry).getByText("The server's chat result")).not.toBeNull();
    expect(within(entry).queryByText(/Started by/)).toBeNull();
    expect(queryClient.isFetching()).toBe(0);
    expect(harness.cloudRequests).toHaveLength(cloudRequestsBefore);
    expect(authnRequests).toEqual([]);
    expect(harness.messenger.calls).toEqual([]);
    expect(memberRequests).toBe(0);
  });

  it("replaces the same row's body once its open task supplies a named starter", async () => {
    cacheMembers(
      membersPage({
        userId: "user-2",
        displayName: "Grace Hopper",
        avatarUrl: "https://example.com/grace.png",
      }),
    );
    const row = starterNotificationRow("completed");
    const rendered = render(startedRowTree(row, false));
    expect(await screen.findByText("The server's chat result")).not.toBeNull();

    rendered.rerender(startedRowTree(row, true));
    const store = await waitForStarterStore();
    seedStarter(store, "user-2");

    const entry = await screen.findByTestId("notification-entry");
    expect(
      await within(entry).findByText("Started by Grace Hopper"),
    ).not.toBeNull();
    expect(within(entry).queryByText("The server's chat result")).toBeNull();
  });

  it("keeps the server body when the starter is system", async () => {
    render(startedRowTree(starterNotificationRow("completed"), true));
    const store = await waitForStarterStore();
    seedStarter(store, "system");

    const entry = await screen.findByTestId("notification-entry");
    expect(within(entry).getByText("The server's chat result")).not.toBeNull();
    expect(within(entry).queryByText(/Started by/)).toBeNull();
  });

  function starterNotificationRow(
    outcome: "completed" | "errored",
  ): MergedNotificationRow {
    return {
      ...conversationRow(STARTER_EPIC_ID, null),
      feedId: `host:${STARTER_CHAT_ID}`,
      sourceId: STARTER_CHAT_ID,
      body: "The server's chat result",
      payload: {
        kind: "chat",
        epicId: STARTER_EPIC_ID,
        chatId: STARTER_CHAT_ID,
      },
      outcome,
    };
  }

  /**
   * The row under the page harness's members read, over the session an open
   * task has. The members sit above the session so a task opening or closing
   * does not remount the read.
   */
  function startedRowTree(
    row: MergedNotificationRow,
    taskIsOpen: boolean,
  ): ReactNode {
    mocks.row = row;
    const feed = (
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
    );
    return (
      <harness.Wrapper>
        <LoadedMembers>
          <TestRouterProvider>
            <RunnerHostProvider runnerHost={runnerHost}>
              <HostRuntimeProvider
                registry={hostRpcRegistry}
                messengerFactory={sessionMessengerFactory}
                invalidator={null}
                requestId={null}
                remoteFetcher={noRemoteHosts}
                fallback={<div data-testid="session-runtime-fallback" />}
              >
                {taskIsOpen ? (
                  <TestEpicSessionWrapper epicId={STARTER_EPIC_ID}>
                    {feed}
                  </TestEpicSessionWrapper>
                ) : (
                  feed
                )}
              </HostRuntimeProvider>
            </RunnerHostProvider>
          </TestRouterProvider>
        </LoadedMembers>
      </harness.Wrapper>
    );
  }
});

/** The members the app has loaded from authn, as the bell's author avatar reads them. */
function LoadedMembers(props: { readonly children: ReactNode }): ReactNode {
  const resolveMember = useLoadedEnvironmentMembers(ENVIRONMENT_ID, true);
  return (
    <PersonMembersContext value={resolveMember}>
      {props.children}
    </PersonMembersContext>
  );
}

const sessionMessengerFactory = ({ registry }: { registry: HostRpcRegistry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => "notification-starter-runtime",
    handlers: {},
  });

const noRemoteHosts = () =>
  Promise.resolve({ kind: "hosts" as const, entries: [] });

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function waitForStarterStore(): Promise<StarterStore> {
  await waitFor(() => {
    expect(__getOpenEpicRegistryForTests().get(STARTER_EPIC_ID)).not.toBeNull();
  });
  const handle = __getOpenEpicRegistryForTests().get(STARTER_EPIC_ID);
  if (handle === null) throw new Error("Expected an open Epic session");
  return handle.store;
}

/** The host's chat record for the task's chat, as its chat-records read fills the store. */
function seedStarter(store: StarterStore, starterUserId: string): void {
  const record: ChatRecordSummaryV12 &
    Pick<ChatRecordSummaryV15, "starterUserId"> = {
    chatId: STARTER_CHAT_ID,
    ownerUserId: "user-1",
    originHostId: mockLocalHostEntry.hostId,
    title: "Started task",
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 1,
    visibility: "private",
    origin: "own",
    docResident: false,
    head: null,
    starterUserId,
  };
  act(() => {
    store.getState().applyChatRecords([record], null);
  });
  expect(Object.values(store.getState().chatRecordStarters)).toEqual([
    starterUserId,
  ]);
}
