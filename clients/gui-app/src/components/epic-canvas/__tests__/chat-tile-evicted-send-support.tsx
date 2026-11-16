import { TestRouterProvider } from "@/__tests__/with-test-router";
import { expect } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { isValidElement } from "react";
import { toast } from "sonner";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
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
} from "@/components/chat/__tests__/legend-list-test-environment";
import { setHostHeldImageHashes } from "@/lib/composer/host-held-image-hashes";
import { composerContentImageRootHashes } from "@/lib/composer/composer-content-image-roots";
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
import { ListedEvicted } from "./chat-tile-evicted-send-listed";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { TestEpicSessionWrapper } from "./test-epic-session";
import { createEpicSessionTestHarness } from "./test-epic-session-harness";

import {
  HOST_ID,
  SAVED_CREATOR_USER_ID,
  TEAM_ENVIRONMENT_OWNER_ID,
  environmentListTestState,
  originSignInTestState,
  hostDirectoryTestState,
  hydrateBoundary,
} from "./chat-tile-evicted-send-mock-state";

export const EPIC_ID = "epic-evicted-send";
export const CHAT_ARTIFACT = {
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

export const TEAM_CREATOR_CHAT_SOURCE: ChatSourceFixture = {
  ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
  starterUserId: SAVED_CREATOR_USER_ID,
};

export const TEAM_ENVIRONMENT_LIST_RESPONSE = {
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

export const PERSONAL_AND_TEAM_VIEWER_ENVIRONMENT_LIST_RESPONSE = {
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
export const ADMITTED_SAVED_CREATOR_ACCESS: ChatAccessFixture = {
  role: "owner",
  ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
  canAct: true,
};
export const POOL_VIEWER_ACCESS: ChatAccessFixture = {
  role: "viewer",
  ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
  canAct: false,
};
export const HOST_VIEWER_ACCESS: ChatAccessFixture = {
  role: "viewer",
  ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
  canAct: false,
};
export const HASH = "a".repeat(64);
export const FIRST_TEXT = "fix the login bug";
export const SECOND_TEXT = "then update the tests";
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
export function draftOf(text: string): JsonContent {
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

export function textOnlyDraftOf(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

export function expectRetainedDraftToast(content: string): void {
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

export const streams: ChatStream[] = [];

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

export function sendFramesOf(stream: ChatStream): SendFrame[] {
  return stream.sent.filter(
    (frame): frame is SendFrame => frame.kind === "send",
  );
}

/** A stream opens and its peer's snapshot arrives. */
export function openStream(
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

export function acceptMessage(stream: ChatStream, frame: SendFrame): void {
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

export const hydrates: Hydrate[] = [];
const sentMessageUnsubscribers: Array<() => void> = [];

export function observeSentMessages(messages: SentChatMessage[]): void {
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
                <ListedEvicted
                  chatId={CHAT_ARTIFACT.id}
                  record={chatStarterRecord(
                    source.ownerUserId,
                    source.starterUserId,
                  )}
                >
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
export async function mountOnThePool(
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

export function putInComposer(text: string): void {
  act(() => {
    useComposerDraftStore
      .getState()
      .replaceDraft(CHAT_ARTIFACT.id, draftOf(text), null);
  });
}

export function stageRebind(): void {
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

export function runningShell(): ManagedCommand {
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

export function clickSend(): void {
  const button = screen.getByRole("button", { name: "Send" });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("expected the send button");
  }
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
}

export async function answerHydrate(index: number): Promise<void> {
  await waitFor(() => {
    expect(hydrates.length).toBeGreaterThan(index);
  });
  act(() => {
    hydrates[index]?.resolve({ outcome: "hydrated" });
  });
}

/** The transcript's status label of a send that has not been accepted. */
export function pendingRows(): HTMLElement[] {
  return screen.queryAllByText(/\bPending\b/);
}

export function rowsWithText(text: string): HTMLElement[] {
  return screen.queryAllByText(text);
}

export function imageRootHeld(): boolean {
  return composerContentImageRootHashes().includes(HASH);
}

export function textInContent(content: JsonContent): string {
  if (content.type === "text") return content.text ?? "";
  return content.content?.map(textInContent).join("") ?? "";
}

export function settleEvictedSendHostTier(): void {
  settleProcessHostRpcTierPlan(poolEntry);
}

export function resetEvictedSendFixture(): void {
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
}

export function teardownEvictedSendFixture(): void {
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
}
