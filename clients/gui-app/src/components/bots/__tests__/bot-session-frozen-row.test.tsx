/**
 * A frozen turn's error row in a bot's own session, through the REAL
 * `BotSessionView` over the real `BotChatTranscript` and `ChatMessages`: the
 * row names the payer of the host that runs the bot (`boundHostId`), not of
 * the computer serving the tab, which is never a sandbox here. The channel
 * and a thread panel draw a bot's rows in their own layout and never this
 * row, so the session is where a reader sees the headline.
 */
import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

const mocks = vi.hoisted(() => ({
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  navigateToTabIntent: vi.fn<(...args: unknown[]) => void>(),
  hostClient: { getActiveHostId: () => "host-tab" } as {
    readonly getActiveHostId: () => string | null;
  } | null,
  /** Whether the viewer is the Admin of the team the bot's sandbox is on. */
  billingAdmin: false,
}));

// Who may buy a team's credits is the environment list's answer, read by its
// own hook; here a case says it.
vi.mock("@/hooks/sandboxes/use-team-billing-admin", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-team-billing-admin")
  >()),
  useTeamBillingAdmin: (teamId: string | null) =>
    teamId !== null && mocks.billingAdmin,
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
  installHostDirectoryRows,
  plainHostEntry,
  resetHostDirectoryRows,
  sandboxHostEntry,
  sandboxHostEntryWithoutOwner,
} from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
/** The computer serving the tab: the viewer's own, not a sandbox. */
const HOST_ID = "host-tab";
/** The host that runs the bot. */
const BOUND_HOST_ID = "host-runs-bot";
const TRUNK_ID = "trunk-chat";
const FROZEN_RAW =
  "SANDBOX_FROZEN: sandbox host 'sbx-1': the sandbox is paused";
const ENDED_TURN = "This sandbox ran out of credits, which ended the turn.";
const ACME = { id: "team-acme", name: "Acme" };

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

/** A session whose last turn the bot's sandbox ran out of credits on. */
function frozenSession(chatId: string): ChatSessionStoreHandle {
  const reply = botReply({
    messageId: `${chatId}-turn`,
    text: "",
    timestamp: 1_200,
  });
  const turn: Message = {
    ...reply,
    blocks: [
      {
        type: "error",
        blockId: `${chatId}-error:block`,
        status: "completed",
        timestamp: 1_200,
        parentBlockId: null,
        message: FROZEN_RAW,
        recoverable: false,
        code: "SANDBOX_FROZEN",
        failure: null,
      },
    ],
  };
  const { handle } = scriptedSession(chatId, [
    sessionPrompt(`${chatId}-prompt`, 1_000),
    turn,
  ]);
  handle.store.setState({ transcriptBaselineEpoch: 0, connectionEpoch: 0 });
  return handle;
}

/** The bot's session, as the tab mounts it: `boundHostId` is the host that runs the bot. */
async function mountSession(boundHostId: string | null): Promise<void> {
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <BotIdentityContext value={IDENTITY}>
            <BotSessionStatusDataContext
              value={{ tasks: [], subscriptions: null, boundHostId }}
            >
              <BotSessionView
                botId={BOT_ID}
                hostId={HOST_ID}
                boundHostId={boundHostId}
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
  await settleLegendList();
}

function errorRow(headline: string): HTMLElement {
  const row = screen.getByText(headline).closest("[data-failure-presentation]");
  if (!(row instanceof HTMLElement)) throw new Error("the error row is absent");
  return row;
}

beforeEach(() => {
  installLegendListTestClock();
  vi.clearAllMocks();
  installLegendListViewportMetrics();
  mocks.billingAdmin = false;
  const handle = frozenSession(TRUNK_ID);
  mocks.sessions = { [TRUNK_ID]: handle };
  mocks.hostClient = { getActiveHostId: () => HOST_ID };
  getChatSessionRegistry().acquire(
    { epicId: BOT_ID, chatId: TRUNK_ID, hostId: HOST_ID, scopeKey: "t" },
    () => handle,
  );
});

afterEach(() => {
  cleanup();
  resetHostDirectoryRows();
  getChatSessionRegistry().forceRelease(BOT_ID, TRUNK_ID, HOST_ID);
  mocks.sessions = {};
});

describe("a frozen turn's row in a bot's session, viewed from a computer that is not a sandbox", () => {
  it("keeps both sentences and the account headline for a bot on the viewer's own sandbox", async () => {
    installHostDirectoryRows([
      plainHostEntry(HOST_ID),
      sandboxHostEntry(BOUND_HOST_ID, null),
    ]);
    await mountSession(BOUND_HOST_ID);

    const row = errorRow("Paused: account out of credits");
    expect(row.textContent).toContain(
      `${ENDED_TURN} Add credits, then send a message to pick up where it stopped.`,
    );
    expect(screen.queryByText(FROZEN_RAW)).toBeNull();
  });

  it("tells a team's member the team's headline and line, with no remedy", async () => {
    installHostDirectoryRows([
      plainHostEntry(HOST_ID),
      sandboxHostEntry(BOUND_HOST_ID, ACME),
    ]);
    await mountSession(BOUND_HOST_ID);

    const row = errorRow("Paused: Acme is out of credits");
    expect(row.textContent).toContain(
      `${ENDED_TURN} Once Acme has credits again, send a message to pick up where it stopped.`,
    );
    expect(row.textContent).not.toContain("Add credits");
    expect(screen.queryByText("Paused: account out of credits")).toBeNull();
  });

  it("tells the team's billing Admin the team's headline and both sentences", async () => {
    mocks.billingAdmin = true;
    installHostDirectoryRows([
      plainHostEntry(HOST_ID),
      sandboxHostEntry(BOUND_HOST_ID, ACME),
    ]);
    await mountSession(BOUND_HOST_ID);

    const row = errorRow("Paused: Acme is out of credits");
    expect(row.textContent).toContain(
      `${ENDED_TURN} Add credits, then send a message to pick up where it stopped.`,
    );
  });

  it.each([
    [
      "no host runs the bot",
      [plainHostEntry(HOST_ID), sandboxHostEntry(BOUND_HOST_ID, null)],
      null,
    ],
    [
      "the bot runs on a computer that is not a sandbox",
      [plainHostEntry(HOST_ID), plainHostEntry(BOUND_HOST_ID)],
      BOUND_HOST_ID,
    ],
    [
      "the bot's sandbox row names no owner",
      [plainHostEntry(HOST_ID), sandboxHostEntryWithoutOwner(BOUND_HOST_ID)],
      BOUND_HOST_ID,
    ],
  ])(
    "reads the neutral headline and the cut when %s",
    async (_state, rows, boundHostId) => {
      installHostDirectoryRows(rows);
      await mountSession(boundHostId);

      const row = errorRow("This sandbox is out of credits.");
      expect(row.textContent).toContain(ENDED_TURN);
      expect(row.textContent).not.toContain("Add credits");
      expect(screen.queryByText("Paused: account out of credits")).toBeNull();
    },
  );
});
