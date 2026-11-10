/**
 * The read-only bot session's transcript must withhold every row that can
 * act, not only the status surfaces: an MCP app's live, interactive bridge
 * falls back to the ordinary tool row, and a feedback draft's Send/Skip
 * collapse to the same static view a published, scope-less transcript gets.
 * `ChatStatusReadOnlyContext` wraps the whole `BotSessionView`; this suite
 * mounts the real view and a real tool-call block to prove the wiring
 * reaches these rows too, not just the status slot's own.
 */
import { StrictMode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  McpUiCspNormalized,
  ToolCallFeedbackDraftStamp,
  ToolCallMcpAppStamp,
} from "@traycer/protocol/persistence/epic/content-blocks";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

const mocks = vi.hoisted(() => ({
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  navigateToTabIntent: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: mocks.navigateToTabIntent,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
  useGuiHarnessesQueryForClient: () => ({ data: undefined, isPending: false }),
}));
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandConfigureIsPending: () => false,
    useManagedCommandRelaunchOnHostRestart: (
      _target: unknown,
      streamed: { relaunchOnHostRestart: boolean },
    ) => streamed.relaunchOnHostRestart,
    useManagedCommandConfigure: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeld: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeldIsPending: () => false,
  }),
);
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));
// The feedback-draft card's own host boundary (the card's `scope !== null`
// branch would need this if it ever mounted); kept inert since readOnly must
// never reach it.
vi.mock("@/hooks/chats/use-chat-feedback-draft", () => ({
  useChatFeedbackDraftSupported: () => true,
  useChatFeedbackDraftDecideMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    data: undefined,
  }),
  useChatFeedbackDraftPreviewQuery: () => ({ data: undefined }),
}));
// `LiveMcpApp`'s own host boundary (the `scope !== null` branch, which
// readOnly must never reach): a settled "text" snapshot so the live app
// actually mounts its `SandboxFrame` (a real iframe) rather than sitting on
// an unmocked, forever-pending query - a pending snapshot renders only a
// skeleton beside the same `server · tool` label line the fallback tool row
// also shows, which would make "no live app" pass whether or not the guard
// does anything.
vi.mock("@/hooks/files/use-artifact-object-text-query", () => ({
  useArtifactObjectTextQuery: () => ({
    data: { kind: "text", text: "<!doctype html><html><body></body></html>" },
    isPending: false,
    isError: false,
  }),
}));

import { BotSessionView } from "@/components/bots/bot-session-view";
import { BotSessionStatusDataContext } from "@/components/bots/bot-session-status-context";
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  scriptedSession,
  sessionPrompt,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/providers/theme-provider";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-tab";
const TRUNK_ID = "trunk-chat";

const IDENTITY: BotIdentity = {
  botId: BOT_ID,
  title: "Release Bot",
  owner: null,
};

const opened = {
  channel: vi.fn<(messageId: string | null) => void>(),
  thread: vi.fn<(threadId: string, messageId: string | null) => void>(),
  close: vi.fn<() => void>(),
};

const CSP: McpUiCspNormalized = {
  connectDomains: [],
  resourceDomains: [],
  frameDomains: [],
  baseUriDomains: [],
};

const MCP_APP_STAMP: ToolCallMcpAppStamp = {
  server: "server-budget",
  tool: "open_budget",
  resourceUri: "ui://sheets/budget",
  snapshot: { path: "files/mcp-apps/budget.html", sha256: "a".repeat(64) },
  csp: CSP,
  permissions: [],
  prefersBorder: false,
  toolInput: { year: 2026 },
  toolResult: { content: [{ type: "text", text: "ok" }] },
  source: {
    originChatId: TRUNK_ID,
    harnessId: "claude",
    nativeSessionId: "session-1",
    serverKey: "b".repeat(64),
  },
  modelContext: null,
};

const FEEDBACK_DRAFT_STAMP: ToolCallFeedbackDraftStamp = {
  category: "tool_problem",
  toolName: "traycer_run_shell",
  goal: "Restart a shell with a new working directory.",
  observed: "The process kept the old directory.",
  suggestion: null,
  suggestDiagnostics: true,
  state: "pending",
  decidedAt: null,
  failureReason: null,
};

function mcpAppBlock(): Extract<
  Message,
  { role: "assistant" }
>["blocks"][number] {
  return {
    type: "tool_call",
    blockId: `${TRUNK_ID}-mcp-app:call`,
    toolName: MCP_APP_STAMP.tool,
    inputSummary: "year: 2026",
    inputDetail: null,
    taskTodoItems: null,
    error: null,
    agentMessageSend: null,
    managedCommand: null,
    agentMessageReceipt: null,
    agentMessageDelivery: null,
    botSendReceipt: null,
    artifact: null,
    mcpApp: MCP_APP_STAMP,
    feedbackDraft: null,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    stopped: false,
    status: "completed",
    timestamp: 1_200,
    startedAt: 1_100,
    endedAt: 1_200,
    imageResults: [],
  };
}

function feedbackDraftBlock(): Extract<
  Message,
  { role: "assistant" }
>["blocks"][number] {
  return {
    type: "tool_call",
    blockId: `${TRUNK_ID}-feedback:call`,
    toolName: "traycer_draft_feedback",
    inputSummary: "tool_problem",
    inputDetail: null,
    taskTodoItems: null,
    error: null,
    agentMessageSend: null,
    managedCommand: null,
    agentMessageReceipt: null,
    agentMessageDelivery: null,
    botSendReceipt: null,
    artifact: null,
    mcpApp: null,
    feedbackDraft: FEEDBACK_DRAFT_STAMP,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    stopped: false,
    status: "completed",
    timestamp: 1_200,
    startedAt: 1_100,
    endedAt: 1_200,
    imageResults: [],
  };
}

/** A trunk session with a prompt and a reply carrying `block`, the row
 *  under test. */
function transcriptSession(
  chatId: string,
  block: Extract<Message, { role: "assistant" }>["blocks"][number],
): ChatSessionStoreHandle {
  const { handle } = scriptedSession(chatId, [
    sessionPrompt(`${chatId}-prompt`, 1_000),
    {
      role: "assistant",
      messageId: `${chatId}-turn`,
      sender: {
        type: "agent",
        harnessId: "claude",
        agentId: "claude-sonnet-4",
        displayName: "Claude Sonnet 4",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [block],
      startedAt: 1_100,
      timestamp: 1_200,
      turnId: null,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    },
  ]);
  handle.store.setState({ transcriptBaselineEpoch: 0, connectionEpoch: 0 });
  return handle;
}

function mountSession(): void {
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        {/* The live MCP app's touch-actions sheet reads the resolved
         * theme (`AppTouchActions` -> `TouchActionsSheet`), so a genuine
         * ablation needs this provider or the live row crashes before its
         * own markup ever renders - a crash, not the meaningful
         * "fallback vs. live" assertion failure this file is for. */}
        <ThemeProvider>
          <TooltipProvider>
            <BotIdentityContext value={IDENTITY}>
              <BotSessionStatusDataContext
                value={{ tasks: [], subscriptions: null }}
              >
                <BotSessionView
                  botId={BOT_ID}
                  hostId={HOST_ID}
                  botTitle="Release Bot"
                  session={{ chatId: TRUNK_ID, threadId: null, landOn: null }}
                  threads={[]}
                  resolveMember={UNRESOLVED_BOT_MEMBERS}
                  onClose={opened.close}
                  onOpenChannel={opened.channel}
                  onOpenThread={opened.thread}
                />
              </BotSessionStatusDataContext>
            </BotIdentityContext>
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

function view(): HTMLElement {
  return screen.getByTestId("bot-session-view");
}

beforeEach(() => {
  installLegendListTestClock();
  vi.clearAllMocks();
  installLegendListViewportMetrics();
  mocks.sessions = {};
});

afterEach(() => {
  cleanup();
  mocks.sessions = {};
});

describe("an MCP app's tool call, in a read-only bot session", () => {
  beforeEach(() => {
    mocks.sessions[TRUNK_ID] = transcriptSession(TRUNK_ID, mcpAppBlock());
  });

  it("falls back to the ordinary tool row - no live sandboxed app, no iframe", async () => {
    mountSession();
    await settleLegendList();

    expect(screen.getByText(/open_budget/)).toBeTruthy();
    expect(view().querySelector("iframe")).toBeNull();
  });
});

describe("a feedback draft's tool call, in a read-only bot session", () => {
  beforeEach(() => {
    mocks.sessions[TRUNK_ID] = transcriptSession(
      TRUNK_ID,
      feedbackDraftBlock(),
    );
  });

  it("shows the static read-only line, never a working Send or Skip", async () => {
    mountSession();
    await settleLegendList();

    expect(within(view()).getByText("This session is read-only.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });
});
