import { TestRouterProvider } from "@/__tests__/with-test-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  advanceLegendListTime,
  installLegendListTestClock,
  installLegendListViewportMetrics,
  restoreLegendListTestClock,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { modLabel } from "@/lib/keybindings/platform";

interface ForkCreateRequest {
  readonly forkSource: {
    readonly interviewBlockId: string | null;
  };
}

const loadingSurfaceTestState = vi.hoisted(() => ({
  unresolvedWorkspaceRenderCount: 0,
}));
const forkCreateTestState = vi.hoisted(() => ({
  mutate: vi.fn<(input: ForkCreateRequest, options: object) => void>(),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: (props: {
      readonly surface: { readonly bindingResolved: boolean };
    }) => {
      if (!props.surface.bindingResolved) {
        loadingSurfaceTestState.unresolvedWorkspaceRenderCount += 1;
      }
      return (
        <div
          data-testid="host-workspace-selector"
          data-binding-resolved={String(props.surface.bindingResolved)}
        />
      );
    },
    ActiveHostWorkspaceControls: () => null,
  }),
);

const MOCK_HOST_CLIENT = {
  request: () => new Promise(() => {}),
  getActiveHostId: () => "host-test",
  getRequestContextUserId: () => "user-test",
  onChange: () => () => undefined,
};
const MOCK_HOST_ENTRY = {
  hostId: "host-test",
  label: "Test host",
  kind: "local" as const,
  websocketUrl: "ws://127.0.0.1:1/rpc",
  streamUrl: "ws://127.0.0.1:1/stream",
};
const MOCK_HOST_DIRECTORY = {
  onChange: () => ({ dispose() {} }),
  findById: (hostId: string) =>
    hostId === MOCK_HOST_ENTRY.hostId ? MOCK_HOST_ENTRY : null,
};

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostDirectory: () => MOCK_HOST_DIRECTORY,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostClient: () => MOCK_HOST_CLIENT,
}));

// useEpicCreateChatForHost (called inside ChatForkDialog) uses
// useTabHostClient, which calls useHostClient from @/lib/host/runtime
// directly (bypassing the barrel mock above). Mocking the hook directly avoids
// having to replicate the full @/lib/host/runtime export surface.
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => MOCK_HOST_CLIENT,
}));

// The tile subscribes to the command catalog itself, because its next-step /
// compact / implement-plan sends bypass the composer and its picker store. The
// mocked host client above never resolves a request, so without this the
// catalog would stay loading forever and every `$` prompt would (correctly) be
// left as prose. Serve one skill so the gated conversion has something to
// resolve; unknown names still fall through to the ungated `/` fallback.
vi.mock("@/hooks/composer/use-slash-commands", () => ({
  useSlashCommands: () => ({
    data: [
      {
        harnessId: "claude",
        name: "traycer-implement",
        description: "Implement a ticket",
        argumentHint: null,
        kind: "skill",
        metadata: { path: "/repo/.agents/skills/traycer-implement/SKILL.md" },
        source: "provider",
        preview: {
          kind: "text",
          primary: "Implement a ticket",
          secondary: null,
          mono: false,
        },
      },
    ],
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(undefined),
  }),
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/epic/use-epic-chat-mutations")
  >()),
  useEpicCreateChatForHost: () => ({
    mutate: forkCreateTestState.mutate,
    isPending: false,
  }),
}));

// HarnessModelPickerImpl (mounted inside the tile tree via the composer
// toolbar) resolves the create-profile gate's client through
// useHostClientForHostId, which unconditionally calls useHostClientFor,
// which calls useHostClient from @/lib/host/runtime directly (same barrel
// bypass as useTabHostClient above). Stub the hook directly, mirroring
// harness-model-picker.test.tsx's convention for this exact hook - null is a
// production-legitimate value (useProvidersListForClient/useHostQuery own the
// client === null disabled gate) so no consumer downstream needs a real
// client here.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

// The chat registry now OWNS its transport (built in its factory) and drives
// tests through the `__setChatStreamClientFactoryForTests` override, so it no
// longer consumes these per-tile hooks. They're stubbed only so any other
// consumer in the tile tree never builds a real socket under jsdom.
vi.mock("@/hooks/host/use-host-stream-client-for", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/host/use-host-stream-client-for")
  >()),
  useHostStreamClientFor: () => null,
  useHostStreamClientBindingFor: () => null,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  // No stream client means nothing has been negotiated yet, which is what
  // `null` says - the tile's Shells menu reads this and stays quiet.
  useStreamMethodSupport: () => null,
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-test",
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as Y from "yjs";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { ChatTile } from "@/components/epic-canvas/renderers/chat-tile";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { useChatTranscriptJumpStore } from "@/stores/chats/chat-transcript-jump-store";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import { scopedChatOpenId } from "@/stores/chats/open-store-scope";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __getChatSessionRegistryForTests,
  __setChatStreamClientFactoryForTests,
} from "@/lib/registries/chat-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { TestEpicSessionWrapper } from "./test-epic-session";
import { createEpicSessionTestHarness } from "./test-epic-session-harness";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatStreamClient } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatActiveTurn,
  ChatApprovalState,
  ChatPendingInterviewState,
  ChatQueuedItem,
  ChatRunSettings,
  ChatRunStatus,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import {
  getFocusedComposerControls,
  resetFocusedComposerControlsForTests,
} from "@/lib/commands/composer-controls-registry";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";

const EPIC_ID = "epic-chat-tile";
const CHAT_ARTIFACT = {
  id: "chat-1",
  instanceId: "inst-chat-1",
  type: "chat" as const,
  name: "Chat 1",
  hostId: "host-test",
};
const QUEUED_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Queued prompt" }],
    },
  ],
};
const SECOND_QUEUED_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Second queued prompt" }],
    },
  ],
};
const PENDING_DRAFT_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "pending message" }],
    },
  ],
};
const QUEUED_SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "queued-model",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};
const UPDATED_QUEUE_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-live",
  permissionMode: "full_access",
  reasoningEffort: "low",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};
const INITIAL_HANDOFF_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Initial landing prompt" }],
    },
  ],
};
const INITIAL_HANDOFF_SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-handoff",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};
const SESSION_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-live",
  permissionMode: "full_access",
  reasoningEffort: "low",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

interface ChatHarness {
  readonly sent: ChatSubscribeClientFrame[];
  install(
    access: "owner" | "viewer",
    queueItems: ReadonlyArray<ChatQueuedItem>,
  ): void;
  installWithSettings(
    access: "owner" | "viewer",
    queueItems: ReadonlyArray<ChatQueuedItem>,
    settings: ChatRunSettings | null,
  ): void;
  installDeferred(): void;
  streamCreations(): number;
  callbacks(): ChatStreamCallbacks;
  teardown(): void;
}

const harness = createEpicSessionTestHarness(EPIC_ID);
const chatHarness = createChatHarness();

function seedDocWithChat(doc: Y.Doc): void {
  const epic = doc.getMap("epic");
  const chats = new Y.Map<unknown>();
  const chat = new Y.Map<unknown>();
  chat.set("id", CHAT_ARTIFACT.id);
  chat.set("title", CHAT_ARTIFACT.name);
  chat.set("parentId", null);
  chat.set("createdAt", 0);
  chat.set("updatedAt", 0);
  const messages = new Y.Array<unknown>();
  messages.push([
    {
      role: "user",
      content: "Stale Epic Y.Doc chat content",
      timestamp: 1,
    },
  ]);
  chat.set("messages", messages);
  chats.set(CHAT_ARTIFACT.id, chat);
  epic.set("title", "Epic Chat Tile");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("chats", chats);
}

function createChatHarness(): ChatHarness {
  const sent: ChatSubscribeClientFrame[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  let streamCreations = 0;
  const installStream = (
    snapshot: {
      readonly access: "owner" | "viewer";
      readonly queueItems: ReadonlyArray<ChatQueuedItem>;
      readonly settings: ChatRunSettings | null;
    } | null,
  ): void => {
    __setChatStreamClientFactoryForTests((_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      streamCreations += 1;
      if (snapshot !== null) {
        setTimeout(() => {
          nextCallbacks.onConnectionStatus("open", null);
          emitChatSnapshot(
            nextCallbacks,
            snapshot.access,
            snapshot.queueItems,
            snapshot.settings,
          );
        }, 0);
      }
      const client: Pick<
        ChatStreamClient,
        "sendAction" | "close" | "sameTurnSteeringProtocolSupported"
      > = {
        sendAction: (frame) => {
          sent.push(frame);
        },
        sameTurnSteeringProtocolSupported: () => true,
        close: () => undefined,
      };
      return client;
    });
  };
  const installWithSettings = (
    access: "owner" | "viewer",
    queueItems: ReadonlyArray<ChatQueuedItem>,
    settings: ChatRunSettings | null,
  ): void => {
    installStream({
      access,
      queueItems,
      settings,
    });
  };
  return {
    sent,
    install: (access, queueItems) => {
      installWithSettings(access, queueItems, null);
    },
    installWithSettings,
    installDeferred: () => installStream(null),
    streamCreations: () => streamCreations,
    callbacks: () => {
      if (callbacks === null) throw new Error("expected chat callbacks");
      return callbacks;
    },
    teardown: () => {
      __setChatStreamClientFactoryForTests(null);
      __getChatSessionRegistryForTests().disposeAll();
      sent.length = 0;
      callbacks = null;
      streamCreations = 0;
    },
  };
}

function emitChatSnapshot(
  callbacks: ChatStreamCallbacks,
  access: "owner" | "viewer",
  queueItems: ReadonlyArray<ChatQueuedItem>,
  settings: ChatRunSettings | null,
): void {
  emitChatSnapshotWithMessages({
    callbacks,
    access,
    queueItems,
    settings,
    messages: [hostUserMessage()],
    activeTurn: null,
  });
}

function runStatusForActiveTurn(
  activeTurn: ChatActiveTurn | null,
): ChatRunStatus {
  if (activeTurn === null) return "idle";
  if (activeTurn.status === "stopping") return "stopping";
  return "running";
}

function emitChatSnapshotWithMessages(input: {
  readonly callbacks: ChatStreamCallbacks;
  readonly access: "owner" | "viewer";
  readonly queueItems: ReadonlyArray<ChatQueuedItem>;
  readonly settings: ChatRunSettings | null;
  readonly messages: ReadonlyArray<Message>;
  readonly activeTurn: ChatActiveTurn | null;
  readonly pendingInterviews?: ReadonlyArray<ChatPendingInterviewState>;
}): void {
  input.callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ARTIFACT.id,
    snapshot: {
      chat: {
        id: CHAT_ARTIFACT.id,
        parentId: null,
        userId: "owner-1",
        hostId: "test-host",
        title: CHAT_ARTIFACT.name,
        createdAt: 0,
        updatedAt: 0,
        isTitleEditedByUser: false,
        settings: input.settings,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [...input.messages],
        events: [],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: {
        role: input.access,
        ownerUserId: "owner-1",
        canAct: input.access === "owner",
      },
      queue: { status: "idle", items: [...input.queueItems] },
      runStatus: runStatusForActiveTurn(input.activeTurn),
      activeTurn: input.activeTurn,
      pendingApprovals: [],
      pendingInterviews: [...(input.pendingInterviews ?? [])],
      worktreeBinding: testWorktreeBinding(),
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
    },
  });
}

function testWorktreeBinding(): WorktreeBinding {
  return {
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
  };
}

function hostUserMessage(): Message {
  return {
    role: "user",
    messageId: "message-1",
    sender: { type: "user", userId: "owner-1" },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Host chat content" }],
          },
        ],
      },
    },
    timestamp: 1,
    sessionAnchor: null,
  };
}

const DELIVERED_A2A_MESSAGE_ID = "message-delivered-a2a";

/**
 * The shape a communication-graph `gui_message` origin ref points at: an A2A
 * message delivered into the RECEIVING chat, which lands as a user row.
 */
function deliveredA2aUserMessage(): Message {
  return {
    ...hostUserMessage(),
    messageId: DELIVERED_A2A_MESSAGE_ID,
    timestamp: 5,
  };
}

function nextStepsAssistantMessage(): Message {
  return {
    role: "assistant",
    messageId: "next-steps-msg",
    startedAt: 1,
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "codex",
      displayName: "Codex",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        type: "text",
        blockId: "next-steps-block",
        text: [
          "<TRAYCER_NEXT_STEPS>",
          "Implementation is complete.",
          "",
          "- [] /implementation-validation all",
          "</TRAYCER_NEXT_STEPS>",
        ].join("\n"),
        status: "completed",
        timestamp: 2,
        providerNotice: null,
      },
    ],
    timestamp: 2,
    turnId: "turn-next-steps",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  };
}

// The `$` sibling of the fixture above. Kept separate rather than parameterized
// because every other next-step case asserts against the `/` prompt text.
function skillNextStepsAssistantMessage(): Message {
  return {
    role: "assistant",
    messageId: "next-steps-msg",
    startedAt: 1,
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "codex",
      displayName: "Codex",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        type: "text",
        blockId: "next-steps-block",
        text: [
          "<TRAYCER_NEXT_STEPS>",
          "Implementation is complete.",
          "",
          "- [] $traycer-implement Implement the runtime ticket.",
          "</TRAYCER_NEXT_STEPS>",
        ].join("\n"),
        status: "completed",
        timestamp: 2,
        providerNotice: null,
      },
    ],
    timestamp: 2,
    turnId: "turn-next-steps",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  };
}

function streamingInterviewAssistantMessage(): Message {
  return {
    role: "assistant",
    messageId: "streaming-interview-msg",
    startedAt: 2,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "claude",
      displayName: "Claude",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        type: "interview",
        blockId: "question-1",
        status: "streaming",
        timestamp: 3,
        toolName: "AskUserQuestion",
        title: "Need input",
        description: "One decision is required.",
        questions: [
          {
            questionId: null,
            question: "Which path should we take?",
            header: null,
            options: [
              { label: "Option A", description: null, preview: null },
              { label: "Option B", description: null, preview: null },
            ],
            multiSelect: false,
          },
        ],
        answers: [],
        error: null,
        metadata: null,
      },
    ],
    timestamp: 3,
    turnId: "turn-interview",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  };
}

function answeredInterviewAssistantMessage(): Message {
  const message = streamingInterviewAssistantMessage();
  if (message.role !== "assistant") {
    throw new Error("expected assistant interview fixture");
  }
  return {
    ...message,
    blocks: [
      {
        type: "interview",
        blockId: "question-1",
        status: "completed",
        timestamp: 4,
        toolName: "AskUserQuestion",
        title: "Need input",
        description: "One decision is required.",
        questions: [
          {
            questionId: null,
            question: "Which path should we take?",
            header: null,
            options: [
              { label: "Option A", description: null, preview: null },
              { label: "Option B", description: null, preview: null },
            ],
            multiSelect: false,
          },
        ],
        answers: [
          {
            questionId: null,
            question: "Which path should we take?",
            values: ["Option A"],
            notes: null,
          },
        ],
        error: null,
        metadata: null,
      },
    ],
    timestamp: 4,
    turnId: "turn-active",
  };
}

function skippedInterviewAssistantMessage(): Message {
  const message = answeredInterviewAssistantMessage();
  if (message.role !== "assistant") {
    throw new Error("expected assistant interview fixture");
  }
  return {
    ...message,
    blocks: message.blocks.map((block) =>
      block.type === "interview"
        ? {
            ...block,
            status: "errored" as const,
            answers: [],
            error: "Skipped by user",
          }
        : block,
    ),
  };
}

function runningActiveTurn(): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId: "turn-active",
    status: "running",
    harnessId: "codex",
    model: "gpt-live",
    profileId: null,
    userMessageId: "message-1",
    startedAt: 3,
    updatedAt: 3,
    reasoningEffort: null,
    serviceTier: null,
  };
}

function stoppingActiveTurn(): ChatActiveTurn {
  return {
    ...runningActiveTurn(),
    status: "stopping",
  };
}

function approvalState(
  approvalId: string,
  kind: ChatApprovalState["kind"],
): ChatApprovalState {
  return {
    kind,
    approvalId,
    toolName: kind === "plan" ? "plan" : "bash",
    description: "Review action",
    input: null,
    planId: kind === "plan" ? "plan-1" : null,
    actions: [],
    requestedAt: 4,
  };
}

function renderChatTile() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(chatTileTestTree(queryClient, true));
}

function renderSwitchableChatTile() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const rendered = render(chatTileTestTree(queryClient, true));
  return {
    ...rendered,
    setChatVisible: (visible: boolean) => {
      rendered.rerender(chatTileTestTree(queryClient, visible));
    },
  };
}

function chatTileTestTree(queryClient: QueryClient, chatVisible: boolean) {
  return (
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
            <TestEpicSessionWrapper epicId={EPIC_ID}>
              <TabHostProvider hostId={CHAT_ARTIFACT.hostId}>
                {chatVisible ? (
                  <ChatTile
                    node={CHAT_ARTIFACT}
                    viewTabId="tab-test"
                    isActive
                  />
                ) : null}
              </TabHostProvider>
            </TestEpicSessionWrapper>
          </TooltipProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    </TestRouterProvider>
  );
}

async function waitForChatTileLoaded(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByTestId("chat-tile-loading")).toBeNull();
  });
  // LegendList needs a few frames (plus its scroll-finish fallback) to
  // bootstrap its initial scroll position and measure rows in jsdom before
  // any message content actually mounts - see legend-list-test-environment.ts.
  await settleLegendList();
  await waitFor(() => {
    expect(screen.getByText("Host chat content")).not.toBeNull();
  });
}

function getButtonByAriaLabel(label: string): HTMLButtonElement {
  const button = queryButtonByAriaLabel(label);
  if (button === null) {
    throw new Error(`Expected a button labelled ${label}`);
  }
  return button;
}

function queryButtonByAriaLabel(label: string): HTMLButtonElement | null {
  const button = document.querySelector(`button[aria-label="${label}"]`);
  if (button === null) return null;
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${label} to resolve to a button`);
  }
  return button;
}

function pasteInlineEditText(text: string): void {
  fireEvent.paste(screen.getByRole("textbox", { name: "Edit message" }), {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
}

function getButtonContainingText(text: string): HTMLButtonElement {
  const button = screen.getByText(text).closest("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${text} to be inside a button`);
  }
  return button;
}

function registerWaitingChatHandoff(): void {
  const scope = {
    hostId: "host-test",
    userId: "owner-1",
    epicId: EPIC_ID,
  };
  const store = useInitialChatHandoffStore.getState();
  store.register({
    ...scope,
    chatId: CHAT_ARTIFACT.id,
    content: INITIAL_HANDOFF_CONTENT,
    settings: INITIAL_HANDOFF_SETTINGS,
    worktreeIntent: null,
    placement: { kind: "active-tile" },
    messageId: "msg-test",
    clientActionId: "cai-test",
    createdAt: 1,
  });
  store.markChatCreated(scope, CHAT_ARTIFACT.id);
  store.markWaitingChat(scope);
}

describe("<ChatTile />", () => {
  beforeEach(() => {
    installLegendListViewportMetrics();
    installLegendListTestClock();
    window.localStorage.clear();
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "owner-1",
        userName: "Owner",
        email: "owner@example.com",
      },
      contextMetadata: { userId: "owner-1", username: "Owner" },
    });
    useComposerDraftStore.setState({
      drafts: {
        [CHAT_ARTIFACT.id]: {
          content: PENDING_DRAFT_CONTENT,
          selection: null,
          resetEpoch: 0,
          revision: 0,
        },
      },
    });
    useComposerRunSettingsStore.getState().resetForTests();
    useComposerHarnessMemoryStore.getState().resetForTests();
    loadingSurfaceTestState.unresolvedWorkspaceRenderCount = 0;
    forkCreateTestState.mutate.mockReset();
    // The composer gates Send on a resolved (non-empty) model slug. Without a
    // host binding the catalog never resolves the empty default, so seed a
    // concrete default model so the composer reaches a sendable state.
    useSettingsStore.setState({
      defaultSelection: {
        harnessId: "codex",
        modelSlug: "gpt-5-codex",
        profileId: null,
      },
    });
    harness.install(seedDocWithChat, "editor");
    chatHarness.install("owner", []);
    useInitialChatHandoffStore.getState().resetForTests();
    resetFocusedComposerControlsForTests();
  });

  afterEach(() => {
    cleanup();
    restoreLegendListTestClock();
    vi.restoreAllMocks();
    resetFocusedComposerControlsForTests();
    useChatTranscriptJumpStore.setState({ requestsByChatId: {} });
    harness.teardown();
    chatHarness.teardown();
    useInitialChatHandoffStore.getState().resetForTests();
    useComposerDraftStore.setState({
      drafts: {},
    });
    useComposerRunSettingsStore.getState().resetForTests();
    useComposerHarnessMemoryStore.getState().resetForTests();
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });

  it("does not open chat.subscribe until the chat record is in the projection", async () => {
    // Re-install the epic session with NO chat seeded so the tile's gate
    // (`chatRecord !== null`) stays closed. This is the local-first
    // subscribe-first race regression: the renderer must not open the epic via
    // `chat.subscribe` before the create has seeded the chat.
    harness.teardown();
    chatHarness.teardown();
    harness.install(null, "editor");
    const chatStreamSpy = vi.fn(() => {
      throw new Error("chat.subscribe must not open before the chat projects");
    });
    __setChatStreamClientFactoryForTests(chatStreamSpy);

    renderChatTile();
    // Flush the epic snapshot (fired via setTimeout(0)) + effects.
    await advanceLegendListTime(0);

    expect(chatStreamSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-tile-loading")).not.toBeNull();
  });

  it("keeps a cold sidebar-opened chat in one loading state until its first snapshot", async () => {
    chatHarness.teardown();
    chatHarness.installDeferred();

    renderChatTile();

    await waitFor(() => {
      expect(chatHarness.streamCreations()).toBe(1);
    });
    expect(
      screen.getByRole("status", { name: "Loading agent" }),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByTestId("host-workspace-selector")).toBeNull();
    expect(loadingSurfaceTestState.unresolvedWorkspaceRenderCount).toBe(0);

    act(() => {
      emitChatSnapshot(chatHarness.callbacks(), "owner", [], SESSION_SETTINGS);
    });

    await waitForChatTileLoaded();
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    expect(
      screen
        .getByTestId("host-workspace-selector")
        .getAttribute("data-binding-resolved"),
    ).toBe("true");
  });

  it("does not mount unresolved controls when switching back to a warm chat", async () => {
    const rendered = renderSwitchableChatTile();
    await waitForChatTileLoaded();
    expect(chatHarness.streamCreations()).toBe(1);

    rendered.setChatVisible(false);
    loadingSurfaceTestState.unresolvedWorkspaceRenderCount = 0;
    rendered.setChatVisible(true);

    await waitForChatTileLoaded();
    expect(chatHarness.streamCreations()).toBe(1);
    expect(loadingSurfaceTestState.unresolvedWorkspaceRenderCount).toBe(0);
    expect(screen.queryByRole("status", { name: "Loading agent" })).toBeNull();
    expect(
      screen
        .getByTestId("host-workspace-selector")
        .getAttribute("data-binding-resolved"),
    ).toBe("true");
  });

  it("renders host chat content and sends through chat.subscribe", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    expect(screen.getByText("You")).not.toBeNull();
    expect(screen.getByText("Host chat content")).not.toBeNull();
    expect(screen.queryByText("Stale Epic Y.Doc chat content")).toBeNull();

    const sendButton = screen.getByRole("button", { name: "Send" });
    if (!(sendButton instanceof HTMLButtonElement)) {
      throw new Error("expected send button");
    }
    expect(sendButton.disabled).toBe(false);

    fireEvent.click(sendButton);

    expect(chatHarness.sent).toHaveLength(1);
    expect(chatHarness.sent[0]?.kind).toBe("send");

    const handle = __getOpenEpicRegistryForTests().get(EPIC_ID);
    if (handle === null) {
      throw new Error("expected live epic handle");
    }
    const chats = handle.doc.getMap("epic").get("chats");
    if (!(chats instanceof Y.Map)) {
      throw new Error("expected chats map");
    }
    const entry: unknown = chats.get(CHAT_ARTIFACT.id);
    if (!(entry instanceof Y.Map)) {
      throw new Error("expected chat entry");
    }
    const messages: unknown = entry.get("messages");
    if (!(messages instanceof Y.Array)) {
      throw new Error("expected messages array");
    }
    expect(messages.length).toBe(1);
  });

  it("uses the composer send button as the running turn stop control", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      chatHarness.callbacks().onTurnStateChanged({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        runStatus: "running",
        activeTurn: {
          agentMode: "regular",
          sameTurnSteeringSupported: false,
          turnId: "turn-1",
          status: "running",
          harnessId: "claude",
          model: "haiku",
          profileId: null,
          userMessageId: "message-1",
          startedAt: 2,
          updatedAt: 2,
          reasoningEffort: null,
          serviceTier: null,
        },
      });
    });

    expect(screen.queryByText("Assistant turn")).toBeNull();
    // The in-progress indicator now shows a rotating, shimmering verb plus a
    // live timer, so assert on its stable test id rather than literal text.
    expect(screen.getByTestId("assistant-run-indicator")).not.toBeNull();

    const stopButton = screen.getByRole("button", { name: "Stop" });
    expect(stopButton).toBe(screen.getByTestId("chat-stop-button"));
    fireEvent.click(stopButton);

    expect(chatHarness.sent).toHaveLength(1);
    const frame = chatHarness.sent[0];
    if (frame.kind !== "stop") throw new Error("expected stop frame");
    expect(frame.turnId).toBe("turn-1");
  });

  it("sends delete-message-suffix after inline confirmation", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    fireEvent.click(getButtonByAriaLabel("Delete message"));
    expect(chatHarness.sent).toHaveLength(0);

    fireEvent.click(getButtonByAriaLabel("Confirm delete"));

    expect(chatHarness.sent).toHaveLength(1);
    const frame = chatHarness.sent[0];
    if (frame.kind !== "deleteMessageSuffix") {
      throw new Error("expected deleteMessageSuffix frame");
    }
    expect(frame.fromMessageId).toBe("message-1");
  });

  it("resubmits an unchanged inline message with current composer settings", async () => {
    useComposerRunSettingsStore.setState({
      globalLastRunSettings: QUEUED_SETTINGS,
    });
    renderChatTile();

    await waitForChatTileLoaded();

    const focusedComposer = getFocusedComposerControls();
    if (focusedComposer === null) {
      throw new Error("expected focused composer controls");
    }

    act(() => {
      focusedComposer.controls.selectModel(
        UPDATED_QUEUE_SETTINGS.harnessId,
        UPDATED_QUEUE_SETTINGS.model,
      );
      focusedComposer.controls.setPermission("full_access");
      focusedComposer.controls.setReasoning(
        UPDATED_QUEUE_SETTINGS.reasoningEffort ?? "",
      );
    });

    await waitForChatTileLoaded();

    fireEvent.click(getButtonByAriaLabel("Edit message"));
    const sendEditButton = getButtonByAriaLabel("Send edit");
    if (!(sendEditButton instanceof HTMLButtonElement)) {
      throw new Error("expected send edit button");
    }
    expect(sendEditButton.disabled).toBe(false);
    fireEvent.click(sendEditButton);

    expect(chatHarness.sent).toHaveLength(1);
    const frame = chatHarness.sent[0];
    if (frame.kind !== "editUserMessage") {
      throw new Error("expected editUserMessage frame");
    }
    expect(frame.targetMessageId).toBe("message-1");
    expect(frame.settings).toEqual(UPDATED_QUEUE_SETTINGS);
  });

  it("clears the inline editor after an edit action is accepted", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    fireEvent.click(getButtonByAriaLabel("Edit message"));
    pasteInlineEditText(" updated");
    expect(getButtonByAriaLabel("Send edit")).not.toBeNull();

    fireEvent.click(getButtonByAriaLabel("Send edit"));
    await waitFor(() => {
      const sendEditButton = getButtonByAriaLabel("Send edit");
      if (!(sendEditButton instanceof HTMLButtonElement)) {
        throw new Error("expected send edit button");
      }
      expect(sendEditButton.disabled).toBe(true);
    });

    const frame = chatHarness.sent[0];
    if (frame.kind !== "editUserMessage") {
      throw new Error("expected editUserMessage frame");
    }

    act(() => {
      chatHarness.callbacks().onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        clientActionId: frame.clientActionId,
        action: "editUserMessage",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
      });
    });

    await waitFor(() => {
      expect(queryButtonByAriaLabel("Send edit")).toBeNull();
    });
  });

  it("seeds composer settings from last-used local settings", async () => {
    useComposerRunSettingsStore.setState({
      globalLastRunSettings: SESSION_SETTINGS,
    });
    chatHarness.teardown();
    chatHarness.install("owner", []);

    renderChatTile();

    await waitForChatTileLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.settings).toEqual(SESSION_SETTINGS);
  });

  it("keeps permission editable during an active turn", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      chatHarness.callbacks().onTurnStateChanged({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        runStatus: "running",
        activeTurn: {
          agentMode: "regular",
          sameTurnSteeringSupported: false,
          turnId: "turn-1",
          status: "running",
          harnessId: "codex",
          model: "gpt-live",
          profileId: null,
          userMessageId: "message-1",
          startedAt: 2,
          updatedAt: 2,
          reasoningEffort: null,
          serviceTier: null,
        },
      });
    });

    // The toolbar stays editable mid-turn; the note only appears once the user
    // actually changes permission (live-mirror + steer reconcile the change).
    await waitFor(() => {
      expect(getButtonByAriaLabel("Full access").disabled).toBe(false);
      expect(
        screen.queryByText("New mode applies to the next turn"),
      ).toBeNull();
    });

    act(() => {
      chatHarness.callbacks().onTurnStateChanged({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        runStatus: "idle",
        activeTurn: null,
      });
    });

    await waitFor(() => {
      expect(getButtonByAriaLabel("Full access").disabled).toBe(false);
      expect(
        screen.queryByText("New mode applies to the next turn"),
      ).toBeNull();
    });
  });

  it("keeps completed assistant fork actions visible during a newer active turn", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: null,
        messages: [hostUserMessage(), nextStepsAssistantMessage()],
        activeTurn: runningActiveTurn(),
      });
    });

    await screen.findByText("Implementation is complete.");
    const forkButton = screen.getByTestId("assistant-fork-chat");

    if (!(forkButton instanceof HTMLButtonElement)) {
      throw new Error("expected fork button");
    }
    expect(forkButton.disabled).toBe(false);
  });

  it("seeds fork title from the latest projected chat title", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    const handle = __getOpenEpicRegistryForTests().get(EPIC_ID);
    if (handle === null) {
      throw new Error("expected live epic handle");
    }

    act(() => {
      handle.store.getState().renameArtifact(CHAT_ARTIFACT.id, "Latest title");
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: null,
        messages: [hostUserMessage(), nextStepsAssistantMessage()],
        activeTurn: null,
      });
    });

    await screen.findByText("Implementation is complete.");
    fireEvent.click(screen.getByTestId("assistant-fork-chat"));

    const titleInput = await screen.findByLabelText("Fork agent title");
    if (!(titleInput instanceof HTMLInputElement)) {
      throw new Error("expected fork title input");
    }
    expect(titleInput.value).toBe("Fork - Latest title");
  });

  it("keeps permission editable while approval is pending", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      chatHarness.callbacks().onTurnStateChanged({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        runStatus: "running",
        activeTurn: {
          agentMode: "regular",
          sameTurnSteeringSupported: false,
          turnId: "turn-1",
          status: "running",
          harnessId: "codex",
          model: "gpt-live",
          profileId: null,
          userMessageId: "message-1",
          startedAt: 2,
          updatedAt: 2,
          reasoningEffort: null,
          serviceTier: null,
        },
      });
      chatHarness.callbacks().onApprovalRequested({
        kind: "approvalRequested",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        approval: {
          kind: "tool",
          approvalId: "approval-1",
          toolName: "edit",
          description: "Apply change",
          input: null,
          planId: null,
          actions: [],
          requestedAt: 2,
        },
      });
    });

    expect(screen.getByTestId("approval-prompt")).not.toBeNull();

    // Approval-pending is still turn-in-progress, but the toolbar stays editable.
    await waitFor(() => {
      expect(getButtonByAriaLabel("Full access").disabled).toBe(false);
      expect(
        screen.queryByText("New mode applies to the next turn"),
      ).toBeNull();
    });

    act(() => {
      chatHarness.callbacks().onApprovalResolved({
        kind: "approvalResolved",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        approvalId: "approval-1",
        decision: { approved: true },
        resolvedAt: 3,
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByText("New mode applies to the next turn"),
      ).toBeNull();
    });
  });

  it("renders file-edit approvals before generic approvals in the composer slot", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      chatHarness.callbacks().onFileEditApprovalRequested({
        kind: "fileEditApprovalRequested",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        approval: {
          approvalId: "file-approval-1",
          toolName: "apply_patch",
          description: "Edit source files",
          paths: ["/repo/src/app.ts"],
          operation: "edit",
          input: null,
          requestedAt: 2,
        },
      });
      chatHarness.callbacks().onApprovalRequested({
        kind: "approvalRequested",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        approval: {
          kind: "tool",
          approvalId: "approval-1",
          toolName: "bash",
          description: "Run tests",
          input: {
            metadata: { command: "bun test | head -50" },
            pattern: ["bun test", "head -50"],
          },
          planId: null,
          actions: [],
          requestedAt: 3,
        },
      });
    });

    const fileQueue = screen.getByTestId("file-edit-approval-prompt");
    const genericQueue = screen.getByTestId("approval-prompt");
    expect(
      fileQueue.compareDocumentPosition(genericQueue) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(within(fileQueue).getByText("/repo/src/app.ts")).not.toBeNull();
    expect(within(fileQueue).getByText("Edit")).not.toBeNull();
    expect(
      within(genericQueue).getByText("bun test | head -50"),
    ).not.toBeNull();

    fireEvent.click(within(fileQueue).getByRole("button", { name: "Approve" }));

    expect(chatHarness.sent).toHaveLength(1);
    const frame = chatHarness.sent[0];
    if (frame.kind !== "fileEditApprovalDecision") {
      throw new Error("expected fileEditApprovalDecision frame");
    }
    expect(frame.approvalId).toBe("file-approval-1");
    expect(frame.decision).toEqual({ approved: true });
  });

  it("does not replace the composer for stale streaming interview blocks", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: SESSION_SETTINGS,
        messages: [hostUserMessage(), streamingInterviewAssistantMessage()],
        activeTurn: null,
        pendingInterviews: [],
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Which path should we take?")).toBeNull();
      expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    });
  });

  it("renders an interview composer card only while the host marks it pending", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: SESSION_SETTINGS,
        messages: [hostUserMessage(), streamingInterviewAssistantMessage()],
        activeTurn: null,
        pendingInterviews: [{ blockId: "question-1", requestedAt: 3 }],
      });
    });

    expect(screen.getByText("Which path should we take?")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByText("Regular Mode")).toBeNull();

    act(() => {
      chatHarness.callbacks().onInterviewErrored({
        kind: "interviewErrored",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        blockId: "question-1",
        reason: "interrupted",
        resolvedAt: 4,
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Which path should we take?")).toBeNull();
      expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    });
  });

  it("shows resolved Q&A fork actions while the assistant turn continues", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: SESSION_SETTINGS,
        messages: [hostUserMessage(), answeredInterviewAssistantMessage()],
        activeTurn: runningActiveTurn(),
      });
    });

    expect(
      await screen.findByRole("button", { name: "Cross Question" }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "A/B Fork" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cross Question" }));

    const titleInput = await screen.findByLabelText("Fork agent title");
    if (!(titleInput instanceof HTMLInputElement)) {
      throw new Error("expected fork title input");
    }
    expect(titleInput.value).toBe("Cross Question - Chat 1");

    const forkButton = screen.getByRole("button", { name: "Fork" });
    expect(within(forkButton).getByText(modLabel())).not.toBeNull();
    expect(within(forkButton).getByText("↵")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });

    const [forkCall] = forkCreateTestState.mutate.mock.calls;
    expect(forkCall[0].forkSource.interviewBlockId).toBe("question-1");
  });

  it("shows Q&A fork actions after the question is skipped", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: SESSION_SETTINGS,
        messages: [hostUserMessage(), skippedInterviewAssistantMessage()],
        activeTurn: runningActiveTurn(),
      });
    });

    expect(
      await screen.findByRole("button", { name: "Cross Question" }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "A/B Fork" })).not.toBeNull();
  });

  it("falls back to client-local last-used settings when the chat has no session settings", async () => {
    useComposerRunSettingsStore.setState({
      globalLastRunSettings: UPDATED_QUEUE_SETTINGS,
    });

    renderChatTile();

    await waitForChatTileLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.settings).toEqual(UPDATED_QUEUE_SETTINGS);
  });

  it("uses per-epic settings before global settings when the chat has no session settings", async () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(UPDATED_QUEUE_SETTINGS, 1);
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings(EPIC_ID, QUEUED_SETTINGS, 2);

    renderChatTile();

    await waitForChatTileLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.settings).toEqual(QUEUED_SETTINGS);
  });

  it("keeps an existing null-settings chat on its first copied epic settings", async () => {
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings(EPIC_ID, QUEUED_SETTINGS, 1);

    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      useComposerRunSettingsStore
        .getState()
        .setEpicRunSettings(EPIC_ID, UPDATED_QUEUE_SETTINGS, 2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.settings).toEqual(QUEUED_SETTINGS);
  });

  it("keeps a remounted null-settings chat on its first copied epic settings", async () => {
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings(EPIC_ID, QUEUED_SETTINGS, 1);

    const rendered = renderChatTile();

    await waitForChatTileLoaded();

    rendered.unmount();

    act(() => {
      useComposerRunSettingsStore
        .getState()
        .setEpicRunSettings(EPIC_ID, UPDATED_QUEUE_SETTINGS, 2);
    });

    renderChatTile();

    await waitForChatTileLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.settings).toEqual(QUEUED_SETTINGS);
  });

  it("seeds composer settings from persisted chat settings", async () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(UPDATED_QUEUE_SETTINGS, 1);
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings(EPIC_ID, QUEUED_SETTINGS, 2);
    chatHarness.teardown();
    chatHarness.installWithSettings("owner", [], SESSION_SETTINGS);

    renderChatTile();

    await waitForChatTileLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.settings).toEqual(SESSION_SETTINGS);
  });

  it("updates composer settings when the host publishes a changed settings snapshot", async () => {
    chatHarness.teardown();
    chatHarness.installWithSettings("owner", [], QUEUED_SETTINGS);

    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      emitChatSnapshot(chatHarness.callbacks(), "owner", [], SESSION_SETTINGS);
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.settings).toEqual(SESSION_SETTINGS);
  });

  it("keeps local composer settings when a host snapshot leaves persisted settings unchanged", async () => {
    chatHarness.teardown();
    chatHarness.installWithSettings("owner", [], QUEUED_SETTINGS);

    renderChatTile();

    await waitForChatTileLoaded();

    const focusedComposer = getFocusedComposerControls();
    if (focusedComposer === null) {
      throw new Error("expected focused composer controls");
    }

    act(() => {
      focusedComposer.controls.selectModel(
        SESSION_SETTINGS.harnessId,
        SESSION_SETTINGS.model,
      );
      focusedComposer.controls.setPermission(SESSION_SETTINGS.permissionMode);
      focusedComposer.controls.setReasoning(
        SESSION_SETTINGS.reasoningEffort ?? "",
      );
      emitChatSnapshot(chatHarness.callbacks(), "owner", [], QUEUED_SETTINGS);
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.settings).toEqual(SESSION_SETTINGS);
  });

  it("keeps live toolbar settings over persisted chat settings after remount", async () => {
    chatHarness.teardown();
    chatHarness.installWithSettings("owner", [], SESSION_SETTINGS);
    const rendered = renderChatTile();

    await waitForChatTileLoaded();

    const focusedComposer = getFocusedComposerControls();
    if (focusedComposer === null) {
      throw new Error("expected focused composer controls");
    }

    act(() => {
      focusedComposer.controls.selectModel(
        QUEUED_SETTINGS.harnessId,
        QUEUED_SETTINGS.model,
      );
      focusedComposer.controls.setPermission(QUEUED_SETTINGS.permissionMode);
      focusedComposer.controls.setReasoning(
        QUEUED_SETTINGS.reasoningEffort ?? "",
      );
    });

    rendered.unmount();
    renderChatTile();

    await waitForChatTileLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.settings).toEqual(QUEUED_SETTINGS);
  });

  it("toolbar changes inside an epic update that epic bucket immediately", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    const focusedComposer = getFocusedComposerControls();
    if (focusedComposer === null) {
      throw new Error("expected focused composer controls");
    }

    act(() => {
      focusedComposer.controls.selectModel(
        UPDATED_QUEUE_SETTINGS.harnessId,
        UPDATED_QUEUE_SETTINGS.model,
      );
      focusedComposer.controls.setPermission(
        UPDATED_QUEUE_SETTINGS.permissionMode,
      );
      focusedComposer.controls.setReasoning(
        UPDATED_QUEUE_SETTINGS.reasoningEffort ?? "",
      );
    });

    expect(
      useComposerRunSettingsStore.getState().getEpicRunSettings(EPIC_ID),
    ).toEqual(UPDATED_QUEUE_SETTINGS);
    expect(
      useComposerRunSettingsStore.getState().globalLastRunSettings,
    ).toBeNull();
  });

  it("sends next-step clicks as current-setting slash commands during active turns", async () => {
    useComposerRunSettingsStore.setState({
      globalLastRunSettings: QUEUED_SETTINGS,
    });

    renderChatTile();

    await waitForChatTileLoaded();

    const focusedComposer = getFocusedComposerControls();
    if (focusedComposer === null) {
      throw new Error("expected focused composer controls");
    }

    act(() => {
      focusedComposer.controls.selectModel(
        UPDATED_QUEUE_SETTINGS.harnessId,
        UPDATED_QUEUE_SETTINGS.model,
      );
      focusedComposer.controls.setPermission(
        UPDATED_QUEUE_SETTINGS.permissionMode,
      );
      focusedComposer.controls.setReasoning(
        UPDATED_QUEUE_SETTINGS.reasoningEffort ?? "",
      );
    });

    await advanceLegendListTime(0);

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: SESSION_SETTINGS,
        messages: [hostUserMessage(), nextStepsAssistantMessage()],
        activeTurn: runningActiveTurn(),
      });
    });

    const nextStepButton = getButtonContainingText(
      "/implementation-validation all",
    );
    expect(nextStepButton.disabled).toBe(false);

    fireEvent.click(nextStepButton);

    expect(chatHarness.sent).toHaveLength(1);
    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.sender).toEqual({ type: "user", userId: "owner-1" });
    expect(frame.settings).toEqual(UPDATED_QUEUE_SETTINGS);
    expect(frame.content).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "slashCommand",
              attrs: {
                commandName: "implementation-validation",
                trigger: "/",
              },
            },
            { type: "text", text: " all" },
          ],
        },
      ],
    });
  });

  // A next-step click never touches the composer, so the chip has to come out of
  // `buildSubmittedChatJSONContent`. When that converter was `/`-only the `$`
  // prompt stayed prose, which cost more than the pill: with neither a
  // `slashCommand` node nor a leading `/name` in the text, the host resolved no
  // invocation at all and the skill silently never ran.
  it("sends a $-prefixed next step as a skill chip", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: SESSION_SETTINGS,
        messages: [hostUserMessage(), skillNextStepsAssistantMessage()],
        activeTurn: runningActiveTurn(),
      });
    });

    const nextStepButton = getButtonContainingText(
      "$traycer-implement Implement the runtime ticket.",
    );
    expect(nextStepButton.disabled).toBe(false);

    fireEvent.click(nextStepButton);

    expect(chatHarness.sent).toHaveLength(1);
    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.content).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "slashCommand",
              attrs: {
                commandName: "traycer-implement",
                harnessId: "claude",
                kind: "skill",
                description: "Implement a ticket",
                argumentHint: null,
                path: "/repo/.agents/skills/traycer-implement/SKILL.md",
                trigger: "$",
              },
            },
            { type: "text", text: " Implement the runtime ticket." },
          ],
        },
      ],
    });
  });

  it("disables next-step sends while a turn is stopping", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: SESSION_SETTINGS,
        messages: [hostUserMessage(), nextStepsAssistantMessage()],
        activeTurn: stoppingActiveTurn(),
      });
    });

    const nextStepButton = getButtonContainingText(
      "/implementation-validation all",
    );
    expect(nextStepButton.disabled).toBe(true);

    fireEvent.click(nextStepButton);

    expect(chatHarness.sent).toHaveLength(0);
  });

  it("disables next-step sends while a stop request is pending", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: SESSION_SETTINGS,
        messages: [hostUserMessage(), nextStepsAssistantMessage()],
        activeTurn: runningActiveTurn(),
      });
    });

    const nextStepButton = getButtonContainingText(
      "/implementation-validation all",
    );
    expect(nextStepButton.disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(chatHarness.sent).toHaveLength(1);
    expect(chatHarness.sent[0]?.kind).toBe("stop");

    await waitFor(() => {
      expect(nextStepButton.disabled).toBe(true);
    });

    fireEvent.click(nextStepButton);

    expect(chatHarness.sent).toHaveLength(1);
  });

  it("disables next-step sends while a blocking approval is pending", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: SESSION_SETTINGS,
        messages: [hostUserMessage(), nextStepsAssistantMessage()],
        activeTurn: runningActiveTurn(),
      });
      chatHarness.callbacks().onApprovalRequested({
        kind: "approvalRequested",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        approval: approvalState("approval-1", "tool"),
      });
    });

    const nextStepButton = getButtonContainingText(
      "/implementation-validation all",
    );
    expect(nextStepButton.disabled).toBe(true);

    fireEvent.click(nextStepButton);

    expect(chatHarness.sent).toHaveLength(0);
  });

  it("keeps next-step sends enabled for plan-only approvals", async () => {
    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: SESSION_SETTINGS,
        messages: [hostUserMessage(), nextStepsAssistantMessage()],
        activeTurn: runningActiveTurn(),
      });
      chatHarness.callbacks().onApprovalRequested({
        kind: "approvalRequested",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        approval: approvalState("approval-plan-1", "plan"),
      });
    });

    const nextStepButton = getButtonContainingText(
      "/implementation-validation all",
    );
    expect(nextStepButton.disabled).toBe(false);

    fireEvent.click(nextStepButton);

    expect(chatHarness.sent).toHaveLength(1);
    expect(chatHarness.sent[0]?.kind).toBe("send");
  });

  it("sends active permission updates when the toolbar permission changes during a turn", async () => {
    useComposerRunSettingsStore.setState({
      globalLastRunSettings: QUEUED_SETTINGS,
    });

    renderChatTile();

    await waitForChatTileLoaded();

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: QUEUED_SETTINGS,
        messages: [hostUserMessage()],
        activeTurn: runningActiveTurn(),
      });
    });

    const focusedComposer = getFocusedComposerControls();
    if (focusedComposer === null) {
      throw new Error("expected focused composer controls");
    }

    act(() => {
      focusedComposer.controls.setPermission("full_access");
    });

    await waitFor(() => expect(chatHarness.sent).toHaveLength(1));
    const frame = chatHarness.sent[0];
    if (frame.kind !== "activePermissionModeUpdate") {
      throw new Error("expected activePermissionModeUpdate frame");
    }
    expect(frame.permissionMode).toBe("full_access");
  });

  it("sends an initial handoff through chat.subscribe after owner readiness exactly once", async () => {
    registerWaitingChatHandoff();

    renderChatTile();
    expect(chatHarness.sent).toHaveLength(0);

    await advanceLegendListTime(0);

    await waitFor(() => {
      expect(chatHarness.sent).toHaveLength(1);
    });

    act(() => {
      chatHarness.callbacks().onConnectionStatus("reconnecting", null);
      chatHarness.callbacks().onConnectionStatus("open", null);
    });

    expect(screen.getByText("Host chat content")).not.toBeNull();
    expect(chatHarness.sent).toHaveLength(1);
    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.sender).toEqual({ type: "user", userId: "owner-1" });
    expect(frame.content).toEqual(INITIAL_HANDOFF_CONTENT);
    expect(frame.settings).toEqual(INITIAL_HANDOFF_SETTINGS);

    act(() => {
      chatHarness.callbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        message: {
          role: "user",
          messageId: frame.messageId,
          sender: { type: "user", userId: "owner-1" },
          message: {
            kind: "user",
            content: INITIAL_HANDOFF_CONTENT,
          },
          timestamp: 3,
          sessionAnchor: null,
        },
      });
    });

    expect(
      Object.values(useInitialChatHandoffStore.getState().handoffs),
    ).toEqual([]);
    expect(chatHarness.sent).toHaveLength(1);
  });

  it("consumes an initial handoff after the send action is accepted", async () => {
    registerWaitingChatHandoff();

    renderChatTile();
    await advanceLegendListTime(0);
    await waitFor(() => {
      expect(chatHarness.sent).toHaveLength(1);
    });

    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");

    act(() => {
      chatHarness.callbacks().onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        clientActionId: frame.clientActionId,
        action: "send",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
      });
    });

    await waitFor(() => {
      expect(
        Object.values(useInitialChatHandoffStore.getState().handoffs),
      ).toEqual([]);
    });

    act(() => {
      chatHarness.callbacks().onConnectionStatus("reconnecting", null);
      chatHarness.callbacks().onConnectionStatus("open", null);
    });

    expect(chatHarness.sent).toHaveLength(1);
  });

  it("marks rejected initial handoffs failed and restores the prompt", async () => {
    registerWaitingChatHandoff();

    renderChatTile();
    await advanceLegendListTime(0);
    await waitFor(() => {
      expect(chatHarness.sent).toHaveLength(1);
    });

    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");

    act(() => {
      chatHarness.callbacks().onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        clientActionId: frame.clientActionId,
        action: "send",
        status: "rejected",
        reason: "Only the agent owner can perform this action.",
        code: "NOT_OWNER",
        backgroundStopTaskIds: [],
      });
    });

    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toMatchObject({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Initial landing prompt" }],
        },
      ],
    });
    expect(
      Object.values(useInitialChatHandoffStore.getState().handoffs)[0],
    ).toMatchObject({
      status: "failed",
      failureReason: "Only the agent owner can perform this action.",
    });
  });

  it("does not send an initial handoff while the chat opens read-only", async () => {
    harness.teardown();
    chatHarness.teardown();
    harness.install(seedDocWithChat, "editor");
    chatHarness.install("viewer", []);
    registerWaitingChatHandoff();

    renderChatTile();

    await waitForChatTileLoaded();

    expect(chatHarness.sent).toHaveLength(0);
    expect(
      Object.values(useInitialChatHandoffStore.getState().handoffs)[0],
    ).toMatchObject({
      status: "waitingChat",
      chatId: CHAT_ARTIFACT.id,
    });
    expect(
      await screen.findByText(
        "Read-only viewer. The agent owner can send prompts and manage this queue.",
      ),
    ).not.toBeNull();
  });

  it("shows read-only viewer state without owner actions", async () => {
    harness.teardown();
    chatHarness.teardown();
    harness.install(seedDocWithChat, "editor");
    chatHarness.install("viewer", []);

    renderChatTile();

    await waitForChatTileLoaded();

    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(
      screen.getByText(
        "Read-only viewer. The agent owner can send prompts and manage this queue.",
      ),
    ).not.toBeNull();
  });

  it("renders queued messages with compact row actions", async () => {
    chatHarness.teardown();
    const queueItems: ChatQueuedItem[] = [
      {
        kind: "prompt" as const,
        queueItemId: "queue-same-turn",
        messageId: "message-same-turn",
        message: {
          kind: "user",
          content: QUEUED_CONTENT,
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        delivery: "same_turn",
        status: "pending",
        targetTurnId: "turn-1",
        steerRequest: null,
        fallbackReason: null,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        kind: "prompt" as const,
        queueItemId: "queue-next-turn",
        messageId: "message-next-turn",
        message: {
          kind: "user",
          content: QUEUED_CONTENT,
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        delivery: "next_turn",
        status: "fallback",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: "This input cannot be safely steered.",
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    chatHarness.installWithSettings("owner", queueItems, QUEUED_SETTINGS);

    renderChatTile();

    await waitForChatTileLoaded();

    expect(screen.queryByTestId("queue-panel")).toBeNull();
    expect(screen.getByTestId("queued-message-rows")).not.toBeNull();
    expect(screen.getByTestId("queued-message-header")).not.toBeNull();
    expect(screen.getAllByTestId("queued-message-row")).toHaveLength(2);
    expect(screen.queryByText(/After next tool/)).toBeNull();
    expect(screen.queryByText(/After current turn/)).toBeNull();
    expect(screen.queryByText("This turn")).toBeNull();
    expect(screen.queryByText("Up next")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Queued message delivery details",
      }),
    ).toBeNull();
    expect(getButtonByAriaLabel("Steer queued message now").disabled).toBe(
      true,
    );

    act(() => {
      chatHarness.callbacks().onTurnStateChanged({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ARTIFACT.id,
        runStatus: "running",
        activeTurn: {
          agentMode: "regular",
          sameTurnSteeringSupported: false,
          turnId: "turn-1",
          status: "running",
          harnessId: QUEUED_SETTINGS.harnessId,
          model: QUEUED_SETTINGS.model,
          profileId: null,
          userMessageId: "message-active",
          startedAt: 4,
          updatedAt: 4,
          reasoningEffort: QUEUED_SETTINGS.reasoningEffort,
          serviceTier: QUEUED_SETTINGS.serviceTier,
        },
      });
    });
    const nextTurnRow = screen.getAllByTestId("queued-message-row").at(1);
    if (nextTurnRow === undefined) {
      throw new Error("Expected a next-turn queued row");
    }
    const steerButton = nextTurnRow.querySelector(
      'button[aria-label="Steer queued message now"]',
    );
    if (!(steerButton instanceof HTMLButtonElement)) {
      throw new Error("Expected steer action to render as a button");
    }
    expect(steerButton.disabled).toBe(false);

    fireEvent.click(steerButton);

    expect(chatHarness.sent.at(-1)).toMatchObject({
      kind: "queueSteerNow",
      queueItemId: "queue-next-turn",
    });
  });

  it("caps queued message list height and scrolls internally", async () => {
    chatHarness.teardown();
    chatHarness.install(
      "owner",
      Array.from({ length: 8 }, (_, index) => ({
        kind: "prompt" as const,
        queueItemId: `queue-${index}`,
        messageId: `message-${index}`,
        message: {
          kind: "user",
          content: QUEUED_CONTENT,
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        delivery: "next_turn" as const,
        status: "pending" as const,
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: index,
        updatedAt: index,
      })),
    );

    renderChatTile();

    await waitForChatTileLoaded();

    const list = screen.getByTestId("queued-message-list");
    expect(list.className).toContain("max-h-[min(40dvh,24rem)]");
    expect(list.className).toContain("overflow-y-auto");
    expect(screen.getAllByTestId("queued-message-row")).toHaveLength(8);
  });

  it("shows read-only queue chrome for viewers", async () => {
    chatHarness.teardown();
    chatHarness.install("viewer", [
      {
        kind: "prompt" as const,
        queueItemId: "queue-1",
        messageId: "message-queue-1",
        message: {
          kind: "user",
          content: QUEUED_CONTENT,
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        delivery: "next_turn",
        status: "pending",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    renderChatTile();

    await waitForChatTileLoaded();

    expect(screen.getByText("Owner manages queue")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit queued message" }),
    ).toBeNull();
  });

  it("updates queued item settings from composer toolbar while editing", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      {
        kind: "prompt" as const,
        queueItemId: "queue-1",
        messageId: "message-queue-1",
        message: {
          kind: "user",
          content: QUEUED_CONTENT,
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        delivery: "next_turn",
        status: "pending",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    renderChatTile();

    await waitForChatTileLoaded();

    expect(screen.getByTestId("queued-message-rows")).not.toBeNull();
    expect(screen.getByText("1 message")).not.toBeNull();
    expect(screen.queryByText("After current turn")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    const focusedComposer = getFocusedComposerControls();
    if (focusedComposer === null) {
      throw new Error("expected focused composer controls");
    }

    act(() => {
      focusedComposer.controls.selectModel(
        UPDATED_QUEUE_SETTINGS.harnessId,
        UPDATED_QUEUE_SETTINGS.model,
      );
      focusedComposer.controls.setPermission("full_access");
      focusedComposer.controls.setReasoning(
        UPDATED_QUEUE_SETTINGS.reasoningEffort ?? "",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(chatHarness.sent.map((frame) => frame.kind)).toEqual([
      "queueEdit",
      "queueSettingsUpdate",
    ]);
    const settingsFrame = chatHarness.sent.find(
      (
        frame,
      ): frame is Extract<
        ChatSubscribeClientFrame,
        { readonly kind: "queueSettingsUpdate" }
      > => frame.kind === "queueSettingsUpdate",
    );
    expect(settingsFrame?.queueItemId).toBe("queue-1");
    expect(settingsFrame?.settings).toEqual(UPDATED_QUEUE_SETTINGS);
  });

  // Decision 14 save-and-steer routing (mod-enter → after_safe_point →
  // queueEdit + queueSteerNow) lives in chat-tile-queue-edit-steer.test.tsx,
  // which drives the real useChatComposerSubmit + the tile's edit-arm logic
  // without depending on TipTap DOM key events under jsdom. Plain Enter edit
  // → queueSettingsUpdate remains covered by the settings-update test above.

  it("cancels queued edit mode from the composer and clears the queued content when there was no previous draft", async () => {
    useComposerDraftStore.setState({ drafts: {} });
    chatHarness.teardown();
    chatHarness.install("owner", [
      {
        kind: "prompt" as const,
        queueItemId: "queue-1",
        messageId: "message-queue-1",
        message: {
          kind: "user",
          content: QUEUED_CONTENT,
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        delivery: "next_turn",
        status: "pending",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    renderChatTile();

    await waitForChatTileLoaded();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    expect(screen.getByTestId("queue-edit-draft-pill")).not.toBeNull();
    expect(screen.getByTestId("composer-editor").textContent).toBe(
      "Queued prompt",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Cancel queued message editing",
      }),
    );

    await waitFor(() => {
      expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();
    });
    expect(screen.getByTestId("composer-editor").textContent).toBe("");

    const sendButton = screen.getByRole("button", { name: "Send" });
    if (!(sendButton instanceof HTMLButtonElement)) {
      throw new Error("expected send button");
    }
    expect(sendButton.disabled).toBe(true);
    expect(chatHarness.sent).toHaveLength(0);
  });

  it("cancels queued edit mode from the composer and restores the previous draft", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      {
        kind: "prompt" as const,
        queueItemId: "queue-1",
        messageId: "message-queue-1",
        message: {
          kind: "user",
          content: QUEUED_CONTENT,
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        delivery: "next_turn",
        status: "pending",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    renderChatTile();

    await waitForChatTileLoaded();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    expect(screen.getByTestId("queue-edit-draft-pill")).not.toBeNull();
    expect(screen.getByTestId("composer-editor").textContent).toBe(
      "Queued prompt",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Cancel queued message editing",
      }),
    );

    await waitFor(() => {
      expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();
    });
    expect(screen.getByTestId("composer-editor").textContent).toBe(
      "pending message",
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(chatHarness.sent).toHaveLength(1);
    const frame = chatHarness.sent[0];
    if (frame.kind !== "send") throw new Error("expected send frame");
    expect(frame.content).toEqual(PENDING_DRAFT_CONTENT);
  });

  it("keeps the original draft snapshot when switching queued items before cancelling edit", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      {
        kind: "prompt" as const,
        queueItemId: "queue-1",
        messageId: "message-queue-1",
        message: {
          kind: "user",
          content: QUEUED_CONTENT,
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        delivery: "next_turn",
        status: "pending",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        kind: "prompt" as const,
        queueItemId: "queue-2",
        messageId: "message-queue-2",
        message: {
          kind: "user",
          content: SECOND_QUEUED_CONTENT,
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        delivery: "next_turn",
        status: "pending",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: 3,
        updatedAt: 3,
      },
    ]);

    renderChatTile();

    await waitForChatTileLoaded();

    const editButtons = screen.getAllByRole("button", {
      name: "Edit queued message",
    });
    const firstEditButton = editButtons[0];
    const secondEditButton = editButtons[1];
    if (
      !(firstEditButton instanceof HTMLButtonElement) ||
      !(secondEditButton instanceof HTMLButtonElement)
    ) {
      throw new Error("expected queued edit buttons");
    }

    fireEvent.click(firstEditButton);
    expect(screen.getByTestId("composer-editor").textContent).toBe(
      "Queued prompt",
    );

    fireEvent.click(secondEditButton);
    expect(screen.getByTestId("composer-editor").textContent).toBe(
      "Second queued prompt",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Cancel queued message editing",
      }),
    );

    await waitFor(() => {
      expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();
    });
    expect(screen.getByTestId("composer-editor").textContent).toBe(
      "pending message",
    );
  });

  /**
   * Cross-tile transcript jumps (the communication-graph timeline parks one,
   * this tile performs it).
   *
   * The load-bearing case is a WARM tile: the graph stream and the chat stream
   * are independent, so the timeline routinely exposes a row before this tile's
   * own transcript has it. Consuming the request then would burn it - the
   * transcript marks the request handled and only afterwards finds it has no
   * index entry - and the row would arrive with nothing left parked.
   */
  it("holds a parked transcript jump until its target message streams in", async () => {
    renderChatTile();
    await waitForChatTileLoaded();

    act(() => {
      useChatTranscriptJumpStore.getState().requestJump(CHAT_ARTIFACT.id, {
        kind: "message",
        // A2A rows anchor on the DELIVERED message, which reaches the receiving
        // chat as a user row - and user rows are the ones keyed by `messageId`.
        messageId: DELIVERED_A2A_MESSAGE_ID,
      });
    });

    // Warm tile, target absent: the request must SURVIVE, not be swallowed.
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      useChatTranscriptJumpStore.getState().requestsByChatId[CHAT_ARTIFACT.id],
    ).not.toBeUndefined();

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: SESSION_SETTINGS,
        messages: [hostUserMessage(), deliveredA2aUserMessage()],
        activeTurn: null,
      });
    });

    await waitFor(() => {
      expect(
        useChatTranscriptJumpStore.getState().requestsByChatId[
          CHAT_ARTIFACT.id
        ],
      ).toBeUndefined();
    });
  });

  it("expands the target card once a parked block jump resolves", async () => {
    useToolOpenStore.getState().reset(CHAT_ARTIFACT.instanceId);
    renderChatTile();
    await waitForChatTileLoaded();

    act(() => {
      useChatTranscriptJumpStore.getState().requestJump(CHAT_ARTIFACT.id, {
        kind: "block",
        blockId: "next-steps-block",
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    // Nothing opened yet - the block's message has not arrived.
    expect(
      useToolOpenStore
        .getState()
        .openIds.has(
          scopedChatOpenId(CHAT_ARTIFACT.instanceId, "next-steps-block"),
        ),
    ).toBe(false);

    act(() => {
      emitChatSnapshotWithMessages({
        callbacks: chatHarness.callbacks(),
        access: "owner",
        queueItems: [],
        settings: SESSION_SETTINGS,
        messages: [hostUserMessage(), nextStepsAssistantMessage()],
        activeTurn: null,
      });
    });

    // The scroll path ran: landing on a card expands it.
    await waitFor(() => {
      expect(
        useToolOpenStore
          .getState()
          .openIds.has(
            scopedChatOpenId(CHAT_ARTIFACT.instanceId, "next-steps-block"),
          ),
      ).toBe(true);
    });
    expect(
      useChatTranscriptJumpStore.getState().requestsByChatId[CHAT_ARTIFACT.id],
    ).toBeUndefined();
  });

  it("drops a parked jump quietly when its target never arrives", async () => {
    // `shouldAdvanceTime` keeps every other timer in the tile running on the
    // real clock; only the jump's TTL is fast-forwarded.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderChatTile();
      await waitForChatTileLoaded();

      act(() => {
        useChatTranscriptJumpStore.getState().requestJump(CHAT_ARTIFACT.id, {
          kind: "message",
          messageId: "message-that-never-arrives",
        });
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        useChatTranscriptJumpStore.getState().requestsByChatId[
          CHAT_ARTIFACT.id
        ],
      ).not.toBeUndefined();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });

      // Cleared, with no error surfaced: the tile is open on the right agent,
      // which is the degrade this feature already accepts for anchor-less rows.
      expect(
        useChatTranscriptJumpStore.getState().requestsByChatId[
          CHAT_ARTIFACT.id
        ],
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // The composer render-count proof lives in `chat-tile-composer-rerender.test.tsx`
  // (it instruments composer renders directly). Behaviour coverage for the
  // stop/running transitions is exercised by the other tests above.
});
