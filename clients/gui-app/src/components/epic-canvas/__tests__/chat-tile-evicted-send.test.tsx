import { TestRouterProvider } from "@/__tests__/with-test-router";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { isValidElement, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type {
  AuthEra,
  RequestContextListener,
} from "@traycer-clients/shared/auth/request-context-provider";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  poolEntry,
  teamSandboxEntry,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatServing } from "@traycer/protocol/host/chat-serving/index";
import type { HydrateChatResponse } from "@traycer/protocol/host/epic/chat-hydration";
import type {
  ChatRecordSummaryV12,
  ChatRecordSummaryV15,
} from "@traycer/protocol/host/epic/chat-records";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { WorktreeFolderIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { ChatTile } from "@/components/epic-canvas/renderers/chat-tile";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { composerDraftIsEmpty } from "@/hooks/chats/use-initial-chat-handoff-driver";
import { setHostHeldImageHashes } from "@/lib/composer/host-held-image-hashes";
import { composerContentImageRootHashes } from "@/lib/composer/composer-content-image-roots";
import { SYSTEM_ACTOR_ID } from "@/lib/identity/person-identity";
import {
  subscribeSentChatMessages,
  type SentChatMessage,
} from "@/components/share-on-x/sent-messages";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { resetFocusedComposerControlsForTests } from "@/lib/commands/composer-controls-registry";
import {
  __getChatSessionRegistryForTests,
  __setChatStreamClientFactoryForTests,
} from "@/lib/registries/chat-session-registry";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { ChatServingWitnessContext } from "@/lib/chats/chat-serving-witness";
import { PoolChatServingWitness } from "@/lib/chats/pool-chat-serving-witness";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { teamSubscription } from "@/lib/sandboxes/__tests__/auth-user-fixture";
import { TestEpicSessionWrapper } from "./test-epic-session";
import { createEpicSessionTestHarness } from "./test-epic-session-harness";

/**
 * A message to a chat its host dropped the records of, through the real tile:
 * the pool serves the transcript (a copy that cannot act), the message is
 * parked and drawn as a pending send, the host is asked for the chat
 * (`epic.hydrateChat`), and once the host answers the session moves there and
 * sends the message by the ordinary road. Faked: the chat streams, the
 * serving witness's stream and the `epic.hydrateChat` RPC. Everything between
 * the composer and the transcript is the real code.
 */

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => <div data-testid="host-workspace-selector" />,
    ActiveHostWorkspaceControls: () => null,
  }),
);

const { HOST_ID, SAVED_CREATOR_USER_ID, TEAM_ENVIRONMENT_OWNER_ID } =
  vi.hoisted(() => ({
    HOST_ID: "host-test",
    SAVED_CREATOR_USER_ID: "owner-1",
    TEAM_ENVIRONMENT_OWNER_ID: "env-team-1",
  }));

const environmentListTestState = vi.hoisted(() => ({
  data: undefined as EnvironmentListResponseV11 | undefined,
}));

const originSignInTestState = vi.hoisted(() => ({
  userId: "owner-1",
  generation: 0,
  listeners: new Set<RequestContextListener>(),
}));

const hostDirectoryTestState = vi.hoisted(() => ({
  teamSandboxForCurrentChat: false,
}));

function requestContextFor(userId: string | null) {
  return userId === null
    ? null
    : createRequestContextFixture({
        identity: { userId, username: userId, providerHandle: null },
        origin: "renderer",
        bearerToken: `test-bearer-${userId}`,
      });
}

function emitOriginSignInChange(): void {
  const context = requestContextFor(originSignInTestState.userId);
  const era: AuthEra = {
    identity: originSignInTestState.userId,
    credentialGeneration: originSignInTestState.generation,
  };
  for (const listener of [...originSignInTestState.listeners]) {
    listener(context, era);
  }
}

const hydrateBoundary = vi.hoisted(
  (): { client: HostClient<HostRpcRegistry> | null } => ({ client: null }),
);

const MOCK_HOST_CLIENT = {
  request: () => new Promise(() => {}),
  // A pool build reads the pool tier's client through the surface's.
  createRequesterForHostId: () => MOCK_HOST_CLIENT,
  getActiveHostId: () => HOST_ID,
  getRequestContextUserId: () =>
    useAuthStore.getState().profile?.userId ?? SAVED_CREATOR_USER_ID,
  onChange: () => () => undefined,
};
const MOCK_HOST_ENTRY = {
  hostId: HOST_ID,
  label: "Test host",
  kind: "local" as const,
  websocketUrl: "ws://127.0.0.1:1/rpc",
  streamUrl: "ws://127.0.0.1:1/stream",
};
const MOCK_TEAM_SANDBOX_ENTRY = {
  ...teamSandboxEntry,
  hostId: HOST_ID,
};
const MOCK_HOST_DIRECTORY = {
  onChange: () => ({ dispose() {} }),
  getLocalEntry: () =>
    hostDirectoryTestState.teamSandboxForCurrentChat ? null : MOCK_HOST_ENTRY,
  getLocalHostId: () =>
    hostDirectoryTestState.teamSandboxForCurrentChat
      ? null
      : MOCK_HOST_ENTRY.hostId,
  findById: (hostId: string) => {
    if (hostId === MOCK_HOST_ENTRY.hostId) {
      return hostDirectoryTestState.teamSandboxForCurrentChat
        ? MOCK_TEAM_SANDBOX_ENTRY
        : MOCK_HOST_ENTRY;
    }
    return hostId === poolEntry.hostId ? poolEntry : null;
  },
};

// ENUMERATES deliberately, as `chat-tile-queue-edit-steer.test.tsx` does: the
// barrel's un-overridden residue is provider-coupled and throws.
// The one binding carries the directory `useHostDirectory` answers, as in the
// app: `useHostDirectoryEntry` reads it off the binding.
const MOCK_HOST_BINDING = {
  directory: MOCK_HOST_DIRECTORY,
  hostClient: {
    ...MOCK_HOST_CLIENT,
    resolveHostById: (hostId: string) => MOCK_HOST_DIRECTORY.findById(hostId),
  },
  auth: {
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
    getRequestContextProvider: () => ({
      current: () => requestContextFor(originSignInTestState.userId),
      onChange: (listener: RequestContextListener) => {
        originSignInTestState.listeners.add(listener);
        return () => {
          originSignInTestState.listeners.delete(listener);
        };
      },
    }),
    environmentCloud: () => {
      const generation = originSignInTestState.generation;
      return {
        onOriginSignIn: () => generation === originSignInTestState.generation,
      };
    },
    fetchAuthenticatedUser: () => {
      if (!hostDirectoryTestState.teamSandboxForCurrentChat) {
        return Promise.reject(new Error("No TeamSandbox fixture is active"));
      }
      const user = createAuthenticatedUserFixture(undefined);
      return Promise.resolve({
        ...user,
        user: { ...user.user, id: SAVED_CREATOR_USER_ID },
        teamSubscriptions: [
          {
            ...teamSubscription(0),
            userID: SAVED_CREATOR_USER_ID,
          },
        ],
      });
    },
    getTeamEnvironment: () =>
      Promise.resolve(
        hostDirectoryTestState.teamSandboxForCurrentChat
          ? { kind: "ok" as const, environmentId: TEAM_ENVIRONMENT_OWNER_ID }
          : { kind: "not-a-member" as const },
      ),
    listSandboxes: () =>
      Promise.resolve({
        ...(hostDirectoryTestState.teamSandboxForCurrentChat
          ? {
              kind: "ok" as const,
              response: {
                sandboxes: [
                  sandboxSummaryFixture({
                    hostId: HOST_ID,
                    displayName: "Team sandbox",
                    environmentId: TEAM_ENVIRONMENT_OWNER_ID,
                    state: "suspended",
                  }),
                ],
              },
            }
          : {
              kind: "unavailable" as const,
              reason: "No TeamSandbox fixture is active",
            }),
      }),
  },
};
vi.mock("@/lib/host", () => ({
  useHostBinding: () => MOCK_HOST_BINDING,
  useOptionalHostClient: () => MOCK_HOST_CLIENT,
  useHostDirectory: () => MOCK_HOST_DIRECTORY,
  useAuthService: () =>
    hostDirectoryTestState.teamSandboxForCurrentChat
      ? MOCK_HOST_BINDING.auth
      : {
          revalidateCurrentContext: () =>
            Promise.resolve({ kind: "valid" as const }),
        },
  useHostClient: () => MOCK_HOST_CLIENT,
  useHostRuntimeClient: () => MOCK_HOST_CLIENT,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => MOCK_HOST_CLIENT,
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/epic/use-epic-chat-mutations")
  >()),
  useEpicCreateChatForHost: () => ({
    mutate: () => undefined,
    isPending: false,
  }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/host/use-host-client-for-host-id")
  >()),
  useHostClientForHostId: () => null,
  useHostDirectoryEntryForHostId: (hostId: string | null) =>
    hostId === null ? null : MOCK_HOST_DIRECTORY.findById(hostId),
}));
vi.mock("@/hooks/host/use-host-stream-client-for", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/host/use-host-stream-client-for")
  >()),
  useHostStreamClientFor: () => null,
  useHostStreamClientBindingFor: () => null,
}));
vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () => null,
}));
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => null,
  useStreamMethodSchemaVersion: () => null,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => HOST_ID,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => HOST_ID,
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: environmentListTestState.data,
    error: null,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));

// The real hydrate mutation, sent on the test's own host client: the one
// boundary the tile does not own.
vi.mock("@/hooks/chats/use-chat-hydrate-mutation", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/hooks/chats/use-chat-hydrate-mutation")
    >();
  return {
    ...actual,
    useChatHydrateMutation: (input: {
      readonly client: HostClient<HostRpcRegistry> | null;
      readonly hostId: string;
      readonly chatId: string;
    }) =>
      actual.useChatHydrateMutation({
        ...input,
        client: hydrateBoundary.client,
      }),
  };
});

const EPIC_ID = "epic-evicted-send";
const CHAT_ARTIFACT = {
  id: "chat-1",
  instanceId: "inst-chat-1",
  type: "chat" as const,
  name: "Chat 1",
  hostId: HOST_ID,
};
interface ChatSourceFixture {
  readonly ownerUserId: string;
  readonly starterUserId: string | null;
}

const TEAM_CREATOR_CHAT_SOURCE: ChatSourceFixture = {
  ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
  starterUserId: SAVED_CREATOR_USER_ID,
};

const TEAM_ENVIRONMENT_LIST_RESPONSE = {
  environments: [
    {
      environmentId: TEAM_ENVIRONMENT_OWNER_ID,
      ownerKind: "organization",
      ownerId: "team-1",
      roomId: "room-team-1",
      label: "Team",
      effectiveRole: "owner",
      kind: "team",
      hostCount: 1,
      providerHandle: "team",
    },
  ],
} satisfies EnvironmentListResponseV11;

const PERSONAL_ENVIRONMENT_LIST_RESPONSE = {
  environments: [
    {
      environmentId: SAVED_CREATOR_USER_ID,
      ownerKind: "user",
      ownerId: SAVED_CREATOR_USER_ID,
      roomId: "room-personal-1",
      label: "Personal",
      effectiveRole: "owner",
      kind: "personal",
      hostCount: 1,
      providerHandle: null,
    },
  ],
} satisfies EnvironmentListResponseV11;

const PERSONAL_AND_TEAM_VIEWER_ENVIRONMENT_LIST_RESPONSE = {
  environments: [
    ...PERSONAL_ENVIRONMENT_LIST_RESPONSE.environments,
    {
      ...TEAM_ENVIRONMENT_LIST_RESPONSE.environments[0],
      effectiveRole: "viewer",
    },
  ],
} satisfies EnvironmentListResponseV11;

type ChatAccessFixture =
  | {
      readonly role: "owner";
      readonly ownerUserId: string;
      readonly canAct: true;
    }
  | {
      readonly role: "viewer";
      readonly ownerUserId: string;
      readonly canAct: false;
    };

// The admitted saved creator may act on the machine host. The pool's actual
// snapshot stays viewer-only while the tile parks a message for that host.
const ADMITTED_SAVED_CREATOR_ACCESS = {
  role: "owner",
  ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
  canAct: true,
} as const satisfies ChatAccessFixture;
const POOL_VIEWER_ACCESS = {
  role: "viewer",
  ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
  canAct: false,
} as const satisfies ChatAccessFixture;
const HOST_VIEWER_ACCESS = {
  role: "viewer",
  ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
  canAct: false,
} as const satisfies ChatAccessFixture;
const HASH = "a".repeat(64);
const FIRST_TEXT = "fix the login bug";
const SECOND_TEXT = "then update the tests";
const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

/** What the composer holds: text, and an image only its hash names. */
function draftOf(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text }] },
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "image-1",
              fileName: "screenshot.png",
              b64content: null,
              hash: HASH,
              mimeType: "image/png",
              size: 68,
              byHashEligible: true,
            },
          },
        ],
      },
    ],
  };
}

function textOnlyDraftOf(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function expectRetainedDraftToast(content: string): void {
  const retained = toast
    .getToasts()
    .find(
      (entry) =>
        "title" in entry &&
        "duration" in entry &&
        entry.duration === Number.POSITIVE_INFINITY,
    );
  const title: unknown =
    retained !== undefined && "title" in retained ? retained.title : null;
  if (!isValidElement<{ children: unknown }>(title)) {
    throw new Error("expected retained draft notice content");
  }
  expect(title.props.children).toContain(content);
}

const epicHarness = createEpicSessionTestHarness(EPIC_ID);

function seedDocWithChat(doc: Y.Doc): void {
  const epic = doc.getMap("epic");
  const chats = new Y.Map<unknown>();
  const chat = new Y.Map<unknown>();
  chat.set("id", CHAT_ARTIFACT.id);
  chat.set("title", CHAT_ARTIFACT.name);
  chat.set("parentId", null);
  chat.set("createdAt", 0);
  chat.set("updatedAt", 0);
  chat.set("messages", new Y.Array<unknown>());
  chats.set(CHAT_ARTIFACT.id, chat);
  epic.set("title", "Epic Evicted Send");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("chats", chats);
}

type SendFrame = Extract<ChatSubscribeClientFrame, { readonly kind: "send" }>;

/** One chat stream the tile opened: the pool's first, then the host's. */
interface ChatStream {
  readonly callbacks: ChatStreamCallbacks;
  readonly sent: ChatSubscribeClientFrame[];
}

const streams: ChatStream[] = [];

function installChatStreams(): void {
  __setChatStreamClientFactoryForTests((_epicId, _chatId, callbacks) => {
    const sent: ChatSubscribeClientFrame[] = [];
    streams.push({ callbacks, sent });
    return {
      sendAction: (frame) => {
        sent.push(frame);
      },
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => true,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    };
  });
}

function sendFramesOf(stream: ChatStream): SendFrame[] {
  return stream.sent.filter(
    (frame): frame is SendFrame => frame.kind === "send",
  );
}

/** A stream opens and its peer's snapshot arrives. */
function openStream(
  stream: ChatStream,
  access: ChatAccessFixture,
  managedCommands: readonly ManagedCommand[] | undefined,
  ownerUserId: string,
): void {
  if (
    access.role === "owner" &&
    (access.ownerUserId !== ownerUserId ||
      useAuthStore.getState().profile?.userId !== SAVED_CREATOR_USER_ID)
  ) {
    throw new Error("expected live access for the saved creator");
  }
  act(() => {
    stream.callbacks.onConnectionStatus("open", null, null, null);
    stream.callbacks.onSnapshot({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ARTIFACT.id,
      snapshot: {
        chat: {
          id: CHAT_ARTIFACT.id,
          parentId: null,
          userId: ownerUserId,
          hostId: HOST_ID,
          title: CHAT_ARTIFACT.name,
          createdAt: 0,
          updatedAt: 0,
          archivedAt: null,
          pinnedUserProviderHandle: null,
          lastDeliveredRolesDigest: null,
          isTitleEditedByUser: false,
          settings: SETTINGS,
          activeSessionChain: null,
          claudePendingWakes: [],
          messages: [
            {
              role: "user",
              messageId: "message-earlier",
              sender: { type: "user", userId: "owner-1" },
              message: {
                kind: "user",
                content: {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "An earlier message" }],
                    },
                  ],
                },
                browserAnnotations: [],
              },
              timestamp: 1,
              sessionAnchor: null,
            },
          ],
          events: [],
        },
        access: {
          role: access.role,
          ownerUserId: access.ownerUserId,
          canAct: access.canAct,
        },
        queue: { status: "idle", items: [] },
        runStatus: "idle",
        activeTurn: null,
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: {
          entries: [
            {
              workspacePath: "/Users/test/project",
              mode: "local",
              repoIdentifier: null,
              worktreePath: null,
              branch: "main",
              isPrimary: true,
              isImported: false,
              setupState: "not_required",
              setupTerminalSessionId: null,
              setupExitCode: null,
              setupFailedAt: null,
              createdAt: 1,
              ownedSubmodules: [],
            },
          ],
        },
        missingWorktreePaths: [],
        pendingFileEditApprovals: [],
        accumulatedFileChanges: [],
        managedCommands: [...(managedCommands ?? [])],
        heldUpdates: [],
        portForwards: [],
      },
    });
  });
}

function acceptMessage(stream: ChatStream, frame: SendFrame): void {
  act(() => {
    stream.callbacks.onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ARTIFACT.id,
      message: {
        role: "user",
        messageId: frame.messageId,
        sender: frame.sender,
        message: {
          kind: "user",
          content: frame.content,
          browserAnnotations: frame.browserAnnotations,
        },
        timestamp: 5,
        sessionAnchor: null,
      },
    });
  });
}

interface Hydrate {
  readonly params: unknown;
  readonly resolve: (response: HydrateChatResponse) => void;
}

const hydrates: Hydrate[] = [];
const sentMessageUnsubscribers: Array<() => void> = [];

function observeSentMessages(messages: SentChatMessage[]): void {
  sentMessageUnsubscribers.push(
    subscribeSentChatMessages((message) => messages.push(message)),
  );
}

function buildHydrateClient(
  queryClient: QueryClient,
): HostClient<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-hydrate-${String(hydrates.length + 1)}`,
    handlers: {
      "epic.hydrateChat": (params) =>
        new Promise<HydrateChatResponse>((resolve) => {
          hydrates.push({ params, resolve });
        }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

function chatStarterRecord(
  ownerUserId: string,
  starterUserId: string | null,
): ChatRecordSummaryV12 & Pick<ChatRecordSummaryV15, "starterUserId"> {
  return {
    chatId: CHAT_ARTIFACT.id,
    ownerUserId,
    originHostId: HOST_ID,
    title: CHAT_ARTIFACT.name,
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    archivedAt: null,
    runSettingsSummary: null,
    revision: 1,
    visibility: "private",
    origin: "own",
    docResident: false,
    head: null,
    ...(starterUserId === null ? {} : { starterUserId }),
  };
}

/** The epic's chat list, which names this chat as one its host dropped. */
function ListedEvicted(props: {
  readonly children: ReactNode;
  readonly source: ChatSourceFixture;
}): ReactNode {
  const handle = useOpenEpicHandle();
  const [listed] = useState(() => {
    const store = handle.store.getState();
    store.applyChatRecords(
      [chatStarterRecord(props.source.ownerUserId, props.source.starterUserId)],
      null,
    );
    store.applyChatRecordEvictions([
      { chatId: CHAT_ARTIFACT.id, evicted: true },
    ]);
    return true;
  });
  return listed ? props.children : null;
}

const AT_REST: ChatServing = {
  ownerHostId: HOST_ID,
  state: "at-rest",
  catchingUp: null,
};

interface Mounted {
  readonly witnessClient: FakeStreamClient;
  readonly witness: PoolChatServingWitness;
}

function mountEvictedTile(source: ChatSourceFixture): Mounted {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  hydrateBoundary.client = buildHydrateClient(queryClient);
  const witnessClient = new FakeStreamClient(true);
  const witness = new PoolChatServingWitness();
  witness.setStreamClient(witnessClient);
  render(
    <TestRouterProvider>
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider
          runnerHost={
            new MockRunnerHost({
              signInUrl: "https://example.com",
              authnBaseUrl: "https://auth.example.com",
              localHost: null,
              hosts: [],
              workspaceFolderPickerPaths: undefined,
              hasLocalHost: undefined,
              traycerCli: undefined,
            })
          }
        >
          <TooltipProvider>
            <ChatServingWitnessContext.Provider value={witness}>
              <TestEpicSessionWrapper epicId={EPIC_ID}>
                <ListedEvicted source={source}>
                  <TabHostProvider hostId={HOST_ID}>
                    <ChatTile
                      node={CHAT_ARTIFACT}
                      viewTabId="tab-evicted-send"
                      tileId="pane-evicted-send"
                      isActive
                    />
                  </TabHostProvider>
                </ListedEvicted>
              </TestEpicSessionWrapper>
            </ChatServingWitnessContext.Provider>
          </TooltipProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    </TestRouterProvider>,
  );
  return { witnessClient, witness };
}

/** The tile on the pool: the witness read the chat at rest and the pool's stream is up. */
async function mountOnThePool(
  access: ChatAccessFixture,
  source: ChatSourceFixture,
): Promise<Mounted> {
  const mounted = mountEvictedTile(source);
  await waitFor(() => {
    expect(mounted.witnessClient.sessions).toHaveLength(1);
  });
  act(() => {
    mounted.witnessClient.sessions[0]?.emit(
      { kind: "serving", hasBinaryPayload: false, serving: AT_REST },
      null,
    );
  });
  await waitFor(() => {
    expect(streams).toHaveLength(1);
  });
  openStream(
    streams[0],
    { ...access, ownerUserId: source.ownerUserId },
    undefined,
    source.ownerUserId,
  );
  await waitFor(() => {
    expect(screen.getByText("An earlier message")).not.toBeNull();
  });
  return mounted;
}

function putInComposer(text: string): void {
  act(() => {
    useComposerDraftStore
      .getState()
      .replaceDraft(CHAT_ARTIFACT.id, draftOf(text), null);
  });
}

function stageRebind(): void {
  const entry: WorktreeFolderIntent = {
    kind: "import",
    workspacePath: "/Users/test/project",
    repoIdentifier: null,
    isPrimary: true,
    worktreePath: "/worktrees/consent-test",
  };
  useWorktreeIntentStagingStore.getState().stageIntent(
    {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ARTIFACT.id,
    },
    { entries: [entry] },
  );
}

function runningShell(): ManagedCommand {
  return {
    id: "shell-consent-test",
    monitoring: false,
    description: "watch",
    command: "npm run dev",
    cwd: "/Users/test/project/apps",
    cadence: null,
    status: { state: "running", pid: 42, startedAtMs: 1 },
    chatId: CHAT_ARTIFACT.id,
    relaunchOnHostRestart: false,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function clickSend(): void {
  const button = screen.getByRole("button", { name: "Send" });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("expected the send button");
  }
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
}

async function answerHydrate(index: number): Promise<void> {
  await waitFor(() => {
    expect(hydrates.length).toBeGreaterThan(index);
  });
  act(() => {
    hydrates[index]?.resolve({ outcome: "hydrated" });
  });
}

/** The transcript's status label of a send that has not been accepted. */
function pendingRows(): HTMLElement[] {
  return screen.queryAllByText(/\bPending\b/);
}

function rowsWithText(text: string): HTMLElement[] {
  return screen.queryAllByText(text);
}

function imageRootHeld(): boolean {
  return composerContentImageRootHashes().includes(HASH);
}

function textInContent(content: JsonContent): string {
  if (content.type === "text") return content.text ?? "";
  return content.content?.map(textInContent).join("") ?? "";
}

beforeAll(() => {
  settleProcessHostRpcTierPlan(poolEntry);
});

beforeEach(() => {
  installLegendListViewportMetrics();
  installLegendListTestClock();
  window.localStorage.clear();
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: SAVED_CREATOR_USER_ID,
      userName: "Owner",
      email: "owner@example.com",
    },
    contextMetadata: { userId: SAVED_CREATOR_USER_ID, username: "Owner" },
  });
  environmentListTestState.data = TEAM_ENVIRONMENT_LIST_RESPONSE;
  originSignInTestState.userId = SAVED_CREATOR_USER_ID;
  originSignInTestState.generation = 0;
  originSignInTestState.listeners.clear();
  hostDirectoryTestState.teamSandboxForCurrentChat = false;
  useComposerDraftStore.setState({ drafts: {} });
  useComposerRunSettingsStore.getState().resetForTests();
  useComposerHarnessMemoryStore.getState().resetForTests();
  useSettingsStore.setState({
    defaultSelection: {
      harnessId: "claude",
      modelSlug: "claude-sonnet",
      profileId: null,
    },
  });
  resetFocusedComposerControlsForTests();
  // The image's bytes are already on the chat's host, so its hash goes bare.
  setHostHeldImageHashes(CHAT_ARTIFACT.id, null, [HASH]);
  streams.length = 0;
  hydrates.length = 0;
  installChatStreams();
  epicHarness.install(seedDocWithChat, "editor");
});

afterEach(() => {
  for (const unsubscribe of sentMessageUnsubscribers.splice(0)) unsubscribe();
  cleanup();
  toast.dismiss();
  __setChatStreamClientFactoryForTests(null);
  __getChatSessionRegistryForTests().disposeAll();
  epicHarness.teardown();
  __getOpenEpicRegistryForTests().disposeAll();
  resetFocusedComposerControlsForTests();
  setHostHeldImageHashes(CHAT_ARTIFACT.id, null, []);
  hydrateBoundary.client = null;
});

describe("a message sent to a chat the pool serves because its host dropped the records", () => {
  it("keeps a noncreator pool viewer read-only without staging a send", async () => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "viewer-2",
        userName: "Viewer",
        email: "viewer@example.com",
      },
      contextMetadata: { userId: "viewer-2", username: "Viewer" },
    });

    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);

    expect(screen.getByText("Read-only viewer.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Clone agent" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    putInComposer(FIRST_TEXT);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toEqual(draftOf(FIRST_TEXT));
    expect(streams.flatMap(sendFramesOf)).toEqual([]);
    expect(hydrates).toEqual([]);
  });

  it.each([
    {
      cause: "no saved starter",
      source: {
        ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
        starterUserId: null,
      },
      environmentList: TEAM_ENVIRONMENT_LIST_RESPONSE,
    },
    {
      cause: "a system starter",
      source: {
        ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
        starterUserId: SYSTEM_ACTOR_ID,
      },
      environmentList: TEAM_ENVIRONMENT_LIST_RESPONSE,
    },
    {
      cause: "a different saved starter",
      source: {
        ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
        starterUserId: "creator-elsewhere",
      },
      environmentList: TEAM_ENVIRONMENT_LIST_RESPONSE,
    },
    {
      cause: "an owner outside the answered team list",
      source: {
        ownerUserId: "env-team-not-listed",
        starterUserId: SAVED_CREATOR_USER_ID,
      },
      environmentList: TEAM_ENVIRONMENT_LIST_RESPONSE,
    },
    {
      cause: "an unanswered team list",
      source: TEAM_CREATOR_CHAT_SOURCE,
      environmentList: undefined,
    },
  ] as const)(
    "does not park a message for $cause",
    async ({ source, environmentList }) => {
      environmentListTestState.data = environmentList;
      await mountOnThePool(POOL_VIEWER_ACCESS, source);

      expect(screen.getByText("Read-only viewer.")).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Clone agent" }),
      ).not.toBeNull();
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
      putInComposer(FIRST_TEXT);
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
      expect(
        useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
      ).toEqual(draftOf(FIRST_TEXT));
      expect(streams.flatMap(sendFramesOf)).toEqual([]);
      expect(hydrates).toEqual([]);
    },
  );

  it("does not use a person-owned V15 fallback row to park on a team host", async () => {
    environmentListTestState.data =
      PERSONAL_AND_TEAM_VIEWER_ENVIRONMENT_LIST_RESPONSE;
    hostDirectoryTestState.teamSandboxForCurrentChat = true;
    await mountOnThePool(POOL_VIEWER_ACCESS, {
      ownerUserId: SAVED_CREATOR_USER_ID,
      starterUserId: SAVED_CREATOR_USER_ID,
    });

    expect(await screen.findByText("Read-only viewer.")).not.toBeNull();
    expect(screen.getByText(/Team sandbox is suspended/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Clone agent" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    putInComposer(FIRST_TEXT);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toEqual(draftOf(FIRST_TEXT));
    expect(streams.flatMap(sendFramesOf)).toEqual([]);
    expect(hydrates).toEqual([]);
  });

  it("restores a parked draft when the host's fresh snapshot is viewer-only", async () => {
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    putInComposer(FIRST_TEXT);
    clickSend();
    await waitFor(() => {
      expect(pendingRows()).toHaveLength(1);
      expect(hydrates).toHaveLength(1);
    });

    await answerHydrate(0);
    await waitFor(() => {
      expect(streams).toHaveLength(2);
    });
    openStream(
      streams[1],
      HOST_VIEWER_ACCESS,
      undefined,
      TEAM_ENVIRONMENT_OWNER_ID,
    );

    await waitFor(() => {
      expect(pendingRows()).toHaveLength(0);
    });
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toEqual(draftOf(FIRST_TEXT));
    expect(streams.flatMap(sendFramesOf)).toEqual([]);
    expect(hydrates).toHaveLength(1);
  });

  it("does not take, send, or restore a parked message after its sign-in ends", async () => {
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    const listenersBeforePending = originSignInTestState.listeners.size;
    putInComposer(FIRST_TEXT);
    clickSend();
    await waitFor(() => {
      expect(pendingRows()).toHaveLength(1);
      expect(hydrates).toHaveLength(1);
    });
    await waitFor(() => {
      expect(originSignInTestState.listeners.size).toBe(
        listenersBeforePending + 1,
      );
    });

    originSignInTestState.generation += 1;
    originSignInTestState.userId = "viewer-2";
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "viewer-2",
        userName: "Viewer",
        email: "viewer@example.com",
      },
      contextMetadata: { userId: "viewer-2", username: "Viewer" },
    });
    emitOriginSignInChange();
    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(
          CHAT_ARTIFACT.id,
          textOnlyDraftOf("another account's draft"),
          null,
        );
    });

    await answerHydrate(0);
    await waitFor(() => {
      expect(pendingRows()).toHaveLength(0);
      expect(originSignInTestState.listeners.size).toBe(listenersBeforePending);
    });

    expect(rowsWithText(FIRST_TEXT)).toHaveLength(0);
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toEqual(textOnlyDraftOf("another account's draft"));
    expect(imageRootHeld()).toBe(false);
    expect(streams.flatMap(sendFramesOf)).toEqual([]);
    expect(hydrates).toHaveLength(1);
    expect(toast.getToasts()).toHaveLength(0);
  });

  it("is drawn as pending, sent once by the host after it answers, and read back as sent", async () => {
    const reported: SentChatMessage[] = [];
    observeSentMessages(reported);
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    putInComposer(FIRST_TEXT);

    clickSend();

    // Cleared like any send, pending, nothing sent, nothing toasted.
    expect(composerDraftIsEmpty(CHAT_ARTIFACT.id)).toBe(true);
    await waitFor(() => {
      expect(pendingRows()).toHaveLength(1);
    });
    expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
    expect(streams[0].sent).toEqual([]);
    expect(toast.getToasts()).toHaveLength(0);
    expect(reported).toEqual([]);
    await waitFor(() => {
      expect(hydrates).toHaveLength(1);
    });
    expect(hydrates[0]?.params).toEqual({
      epicId: EPIC_ID,
      chatId: CHAT_ARTIFACT.id,
    });

    // The host answers, the session moves there, and one send goes out.
    await answerHydrate(0);
    await waitFor(() => {
      expect(streams).toHaveLength(2);
    });
    openStream(
      streams[1],
      ADMITTED_SAVED_CREATOR_ACCESS,
      undefined,
      TEAM_ENVIRONMENT_OWNER_ID,
    );
    await waitFor(() => {
      expect(sendFramesOf(streams[1])).toHaveLength(1);
    });
    expect(sendFramesOf(streams[0])).toEqual([]);
    const frame = sendFramesOf(streams[1])[0];
    expect(textInContent(frame.content)).toBe(FIRST_TEXT);
    expect(JSON.stringify(frame.content)).toContain(HASH);

    // The parked row was swapped for the store's own.
    expect(pendingRows()).toHaveLength(1);
    expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);

    // The host accepted it: the row is the sent message.
    acceptMessage(streams[1], frame);
    await waitFor(() => {
      expect(pendingRows()).toHaveLength(0);
    });
    expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
    expect(composerDraftIsEmpty(CHAT_ARTIFACT.id)).toBe(true);
    expect(toast.getToasts()).toHaveLength(0);
    expect(streams).toHaveLength(2);
    expect(sendFramesOf(streams[1])).toHaveLength(1);
    expect(reported).toEqual([
      { text: FIRST_TEXT, epicId: EPIC_ID, hostId: HOST_ID },
    ]);
  });

  it("holds a second message behind the first and sends both once, in order", async () => {
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    putInComposer(FIRST_TEXT);
    clickSend();
    await waitFor(() => {
      expect(hydrates).toHaveLength(1);
    });
    putInComposer(SECOND_TEXT);

    clickSend();

    await waitFor(() => {
      expect(pendingRows()).toHaveLength(2);
    });
    expect(composerDraftIsEmpty(CHAT_ARTIFACT.id)).toBe(true);
    expect(streams[0].sent).toEqual([]);
    expect(hydrates).toHaveLength(1);

    await answerHydrate(0);
    await waitFor(() => {
      expect(streams).toHaveLength(2);
    });
    openStream(
      streams[1],
      ADMITTED_SAVED_CREATOR_ACCESS,
      undefined,
      TEAM_ENVIRONMENT_OWNER_ID,
    );
    await waitFor(() => {
      expect(sendFramesOf(streams[1])).toHaveLength(2);
    });
    await settleLegendList();
    const texts = sendFramesOf(streams[1]).map((frame) =>
      textInContent(frame.content),
    );
    expect(texts).toEqual([FIRST_TEXT, SECOND_TEXT]);
    expect(sendFramesOf(streams[0])).toEqual([]);
    expect(hydrates).toHaveLength(1);
    // The first send started the turn, so the second is the host's queued
    // message: each text is on screen once, the second in the queue.
    await waitFor(() => {
      expect(pendingRows()).toHaveLength(1);
      expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
      expect(rowsWithText(SECOND_TEXT)).toHaveLength(1);
      expect(
        within(screen.getByTestId("queued-message-rows")).getByText(
          SECOND_TEXT,
        ),
      ).not.toBeNull();
    });
    expect(toast.getToasts()).toHaveLength(0);
  });

  it.each(["unmount", "pagehide", "confirm-close"] as const)(
    "settles consent correctly during %s",
    async (lifecycle) => {
      const reported: SentChatMessage[] = [];
      observeSentMessages(reported);
      stageRebind();
      await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
      putInComposer(FIRST_TEXT);
      clickSend();
      await waitFor(() => expect(pendingRows()).toHaveLength(1));
      putInComposer(SECOND_TEXT);
      clickSend();
      await waitFor(() => expect(pendingRows()).toHaveLength(2));
      expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
      expect(rowsWithText(SECOND_TEXT)).toHaveLength(1);
      await settleLegendList();
      await answerHydrate(0);
      await settleLegendList();
      await waitFor(() => expect(streams).toHaveLength(2));
      await settleLegendList();
      openStream(
        streams[1],
        ADMITTED_SAVED_CREATOR_ACCESS,
        [runningShell()],
        TEAM_ENVIRONMENT_OWNER_ID,
      );
      await settleLegendList();
      expect(
        await screen.findByTestId("teardown-commit-dialog"),
      ).not.toBeNull();
      expect(pendingRows()).toHaveLength(2);
      expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
      expect(rowsWithText(SECOND_TEXT)).toHaveLength(1);
      expect(reported).toEqual([]);

      if (lifecycle === "confirm-close") {
        const confirm = screen.getByTestId("teardown-commit-immediate");
        act(() => {
          fireEvent.click(confirm);
          cleanup();
        });
        await waitFor(() => {
          expect(sendFramesOf(streams[1])).toHaveLength(1);
        });
        await waitFor(() => {
          expect(reported).toEqual([
            { text: FIRST_TEXT, epicId: EPIC_ID, hostId: HOST_ID },
          ]);
        });
        expect(sendFramesOf(streams[0])).toEqual([]);
        expect(textInContent(sendFramesOf(streams[1])[0].content)).toBe(
          FIRST_TEXT,
        );
        expect(
          useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
        ).toEqual(draftOf(SECOND_TEXT));
        expect(
          toast
            .getToasts()
            .filter(
              (entry) =>
                "duration" in entry &&
                entry.duration === Number.POSITIVE_INFINITY,
            ),
        ).toEqual([]);
        expect(pendingRows()).toHaveLength(0);
        expect(imageRootHeld()).toBe(false);
      } else if (lifecycle === "pagehide") {
        act(() => {
          window.dispatchEvent(new Event("pagehide"));
        });
      } else {
        cleanup();
      }

      if (lifecycle !== "confirm-close") {
        expect(
          useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
        ).toEqual(draftOf(FIRST_TEXT));
        expectRetainedDraftToast(SECOND_TEXT);
        expect(imageRootHeld()).toBe(false);
        expect(screen.queryByTestId("teardown-commit-dialog")).toBeNull();
        expect(pendingRows()).toHaveLength(0);
        expect(streams.flatMap(sendFramesOf)).toEqual([]);
        expect(hydrates).toHaveLength(1);
        expect(reported).toEqual([]);
      }
    },
  );

  it("serializes consent for two parked sends and dispatches them in order", async () => {
    const reported: SentChatMessage[] = [];
    observeSentMessages(reported);
    stageRebind();
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    putInComposer(FIRST_TEXT);
    clickSend();
    await waitFor(() => expect(pendingRows()).toHaveLength(1));
    putInComposer(SECOND_TEXT);
    clickSend();
    await waitFor(() => expect(pendingRows()).toHaveLength(2));
    await settleLegendList();
    await answerHydrate(0);
    await settleLegendList();
    await waitFor(() => expect(streams).toHaveLength(2));
    await settleLegendList();
    openStream(
      streams[1],
      ADMITTED_SAVED_CREATOR_ACCESS,
      [runningShell()],
      TEAM_ENVIRONMENT_OWNER_ID,
    );
    await settleLegendList();

    expect(await screen.findByTestId("teardown-commit-dialog")).not.toBeNull();
    expect(pendingRows()).toHaveLength(2);
    expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
    expect(rowsWithText(SECOND_TEXT)).toHaveLength(1);
    expect(sendFramesOf(streams[1])).toEqual([]);
    expect(reported).toEqual([]);

    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));
    await waitFor(() => expect(sendFramesOf(streams[1])).toHaveLength(2));
    await waitFor(() => expect(reported).toHaveLength(2));
    expect(
      sendFramesOf(streams[1]).map((frame) => textInContent(frame.content)),
    ).toEqual([FIRST_TEXT, SECOND_TEXT]);
    expect(reported).toEqual([
      { text: FIRST_TEXT, epicId: EPIC_ID, hostId: HOST_ID },
      { text: SECOND_TEXT, epicId: EPIC_ID, hostId: HOST_ID },
    ]);
    expect(composerDraftIsEmpty(CHAT_ARTIFACT.id)).toBe(true);
    const [first, second] = sendFramesOf(streams[1]);
    acceptMessage(streams[1], first);
    acceptMessage(streams[1], second);
    await waitFor(() => expect(pendingRows()).toHaveLength(0));
  });

  it("restores both parked sends when each consent is cancelled", async () => {
    const reported: SentChatMessage[] = [];
    observeSentMessages(reported);
    stageRebind();
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    putInComposer(FIRST_TEXT);
    clickSend();
    await waitFor(() => expect(pendingRows()).toHaveLength(1));
    putInComposer(SECOND_TEXT);
    clickSend();
    await waitFor(() => expect(pendingRows()).toHaveLength(2));
    await settleLegendList();
    await answerHydrate(0);
    await settleLegendList();
    await waitFor(() => expect(streams).toHaveLength(2));
    await settleLegendList();
    openStream(
      streams[1],
      ADMITTED_SAVED_CREATOR_ACCESS,
      [runningShell()],
      TEAM_ENVIRONMENT_OWNER_ID,
    );
    await settleLegendList();

    expect(await screen.findByTestId("teardown-commit-dialog")).not.toBeNull();
    expect(pendingRows()).toHaveLength(2);
    fireEvent.click(screen.getByTestId("teardown-commit-cancel"));
    await waitFor(() => expect(pendingRows()).toHaveLength(1));
    expect(sendFramesOf(streams[1])).toEqual([]);
    expect(reported).toEqual([]);

    expect(await screen.findByTestId("teardown-commit-dialog")).not.toBeNull();
    fireEvent.click(screen.getByTestId("teardown-commit-cancel"));
    await waitFor(() => expect(pendingRows()).toHaveLength(0));
    expect(sendFramesOf(streams[1])).toEqual([]);
    expect(streams[0].sent).toEqual([]);
    expect(reported).toEqual([]);
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toEqual(draftOf(FIRST_TEXT));
    expectRetainedDraftToast(SECOND_TEXT);
  });
});
