/**
 * A read-only bot session's transcript must withhold a failed turn's own
 * recovery affordances too: Report issue, the manual fallback rungs
 * (Retry/Switch/Wait) and the provider-outdated Update button all sit beside
 * the same error row and all read `ChatStatusReadOnlyContext` (wrapping the
 * whole `BotSessionView`) directly. This suite mounts the real view with a
 * real `error` content block to prove the wiring reaches this row too.
 */
import { StrictMode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_OUTDATED_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

const mocks = vi.hoisted(() => ({
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  navigateToTabIntent: vi.fn<(...args: unknown[]) => void>(),
  hostClient: { getActiveHostId: () => "host-tab" } as {
    readonly getActiveHostId: () => string | null;
  } | null,
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
// Both the Update button (`useHostClientForHostId`) and the rungs
// (`useExistingChatSessionHandle`, below `getChatSessionRegistry`, already
// real above) need a resolvable host - the shared bots-suite default of
// `null` would make either vacuously absent whatever the readOnly guard does.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => mocks.hostClient,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.hostClient,
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
// Named by `FallbackManualRungActions` itself: the error row has no epic
// identity of its own, so it reads this ambient handle.
vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => ({ epicId: BOT_ID }),
}));
// Named by the provider-outdated Update button (`useProviderUpdateForClient`):
// `canEnsure` gates on the host supporting the method, and the two mutation
// hooks only need to exist, never to be called, for this suite's assertion.
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));
vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", () => ({
  useProvidersEnsurePackForClient: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock(
  "@/hooks/providers/use-providers-refresh-pack-discovery-mutation",
  () => ({
    useProvidersRefreshPackDiscoveryForClient: () => ({
      mutateAsync: vi.fn(),
    }),
  }),
);

import { BotSessionView } from "@/components/bots/bot-session-view";
import { BotSessionStatusDataContext } from "@/components/bots/bot-session-status-context";
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  botReply,
  scriptedSession,
  sessionPrompt,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import {
  chatRunSettings,
  lastFailedAttempt,
} from "@/components/chat/fallback/__tests__/fallback-fixtures";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-tab";
const TRUNK_ID = "trunk-chat";
const TURN_ID = "turn-error-1";

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

function errorBlock(
  code: string | null,
): Extract<Message, { role: "assistant" }>["blocks"][number] {
  return {
    type: "error",
    blockId: `${TRUNK_ID}-error:block`,
    status: "completed",
    timestamp: 1_200,
    parentBlockId: null,
    message: "The turn could not be completed.",
    recoverable: false,
    code,
    failure: null,
  };
}

/** A trunk session with a prompt and a reply carrying one `error` block,
 *  with `turnId` set so `FallbackManualRungActions` can resolve a match. */
function transcriptSession(
  chatId: string,
  code: string | null,
): ChatSessionStoreHandle {
  const { handle } = scriptedSession(chatId, [
    sessionPrompt(`${chatId}-prompt`, 1_000),
    {
      ...botReply({
        messageId: `${chatId}-turn`,
        text: "",
        timestamp: 1_200,
      }),
      blocks: [errorBlock(code)],
      turnId: TURN_ID,
    },
  ]);
  handle.store.setState({
    transcriptBaselineEpoch: 0,
    connectionEpoch: 0,
    // The real failed-attempt envelope `FallbackManualRungActions` reads
    // through `useChatLastFailedAttempt` - genuinely offers Retry (via
    // `eligibleRungs`) once the session is registered below, so the readOnly
    // guard is what withholds it, not an empty fixture.
    lastFailedAttempt: lastFailedAttempt({
      userMessageId: `${chatId}-prompt`,
      turnId: TURN_ID,
      failure: { reason: "auth" },
      eligibleRungs: ["retry"],
      waitDisposition: "attempt_unavailable",
      switchDisposition: "eligible",
      failedTuple: chatRunSettings({
        harnessId: "claude",
        model: "claude-sonnet-4",
        profileId: null,
      }),
    }),
  });
  return handle;
}

function mountSession(): void {
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
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
  mocks.hostClient = { getActiveHostId: () => HOST_ID };
});

afterEach(() => {
  cleanup();
  getChatSessionRegistry().forceRelease(BOT_ID, TRUNK_ID, HOST_ID);
  mocks.sessions = {};
});

describe("a failed turn's error row, in a read-only bot session", () => {
  describe("plain failure (no provider-outdated code)", () => {
    beforeEach(() => {
      const handle = transcriptSession(TRUNK_ID, null);
      mocks.sessions[TRUNK_ID] = handle;
      // Registered into the REAL registry too, under the real registry's own
      // key - `FallbackManualRungActions` resolves its chat through
      // `useExistingChatSessionHandle`, which reads that registry directly
      // rather than the container-scoped mock above.
      getChatSessionRegistry().acquire(
        { epicId: BOT_ID, chatId: TRUNK_ID, hostId: HOST_ID, scopeKey: "t" },
        () => handle,
      );
    });

    it("shows no Report issue action and no manual fallback rungs", async () => {
      mountSession();
      await settleLegendList();

      // Positive control: the row itself is reached and the error block's
      // own message renders as plain text - proof the row genuinely mounted,
      // not that it was absent for an unrelated reason (a crash, a missing
      // mock) that would make the negative assertions below pass vacuously.
      expect(
        within(view()).getByText("The turn could not be completed."),
      ).toBeTruthy();
      expect(screen.queryByLabelText("Report issue")).toBeNull();
      expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
      expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    });
  });

  describe("provider-outdated failure", () => {
    beforeEach(() => {
      const handle = transcriptSession(TRUNK_ID, PROVIDER_OUTDATED_ERROR_CODE);
      mocks.sessions[TRUNK_ID] = handle;
      getChatSessionRegistry().acquire(
        { epicId: BOT_ID, chatId: TRUNK_ID, hostId: HOST_ID, scopeKey: "t" },
        () => handle,
      );
    });

    it("shows no provider Update button", async () => {
      mountSession();
      await settleLegendList();

      // Positive control: same reason as the sibling suite above - the row
      // itself rendered its error message, not merely "no Update button"
      // for an unrelated reason.
      expect(
        within(view()).getByText("The turn could not be completed."),
      ).toBeTruthy();
      expect(within(view()).queryByText("Update")).toBeNull();
    });
  });
});
