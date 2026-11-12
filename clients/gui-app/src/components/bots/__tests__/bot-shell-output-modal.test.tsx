/**
 * The read-only shell output modal over a bot session: the real session view,
 * background listing, modal and shared output body, over a drivable host
 * stream. Only the transport, the host reachability read and navigation are
 * replaced.
 */
import { StrictMode, useEffect, useState, type ReactElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  managedCommandSchema,
  type ManagedCommand,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { StreamMethodSupport } from "@traycer/protocol/host-transport/stream-session";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import {
  installManagedCommandChatSession,
  type ManagedCommandChatSessionStub,
} from "@/stores/managed-commands/test-support/managed-command-chat-session";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";

const mocks = vi.hoisted(() => ({
  reachable: true,
  unreachableHosts: new Set<string>(),
  onTransportOpen: null as (() => void) | null,
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
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => ({
    status:
      mocks.reachable && !mocks.unreachableHosts.has(hostId)
        ? "reachable"
        : "unreachable",
  }),
}));
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory:
    () =>
    (hostId: string): DurableStreamTransport => {
      transportOpens.push(hostId);
      mocks.onTransportOpen?.();
      return { wsStreamClient: hostClient, close: () => undefined };
    },
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
// The one faked boundary the background listing needs beyond the session
// registry: the host RPCs behind the managed-command rows (same fake
// `chat-background-items-panel.test.tsx` uses - this suite is about the
// bot session's status surfaces, not managed-command lifecycle RPCs).
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
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-tab";
const BOUND_HOST = "host-bound";
const USER_A = { userId: "user-a", username: "ada" };
const USER_B = { userId: "user-b", username: "bea" };
const TRUNK_ID = "trunk-chat";

const IDENTITY: BotIdentity = {
  botId: BOT_ID,
  title: "Release Bot",
  owner: null,
};

const USAGE: TokenUsage = {
  inputTokens: 50_000,
  outputTokens: 1_000,
  totalTokens: 51_000,
  contextTokens: 50_000,
  contextWindow: 200_000,
};

const transportOpens: string[] = [];

class SupportScriptedClient extends FakeStreamClient {
  support: StreamMethodSupport = "unknown";

  override getMethodSupport(): StreamMethodSupport {
    return this.support;
  }
}

let hostClient = new SupportScriptedClient(true);

const opened = {
  channel: vi.fn<(messageId: string | null) => void>(),
  thread: vi.fn<(threadId: string, messageId: string | null) => void>(),
  close: vi.fn<() => void>(),
};

/** A viewed session's own store, made "fresh" (as `BackgroundItemsPanel`
 *  reads it) and carrying `usage` for the chip. */
function freshSession(
  chatId: string,
  usage: TokenUsage | null,
): ChatSessionStoreHandle {
  const { handle } = scriptedSession(chatId, [
    sessionPrompt(`${chatId}-prompt`, 1_000),
  ]);
  handle.store.setState({
    transcriptBaselineEpoch: 0,
    connectionEpoch: 0,
    liveTurnUsage: usage,
  });
  return handle;
}

let queryClient = new QueryClient();

/**
 * The session view as the bot tab mounts it: `HOST_ID` is the host serving the
 * tab, `boundHostId` the host the bot is bound to (`snapshot.boundHost.hostId`,
 * nullable), which the tab hands the status surface beside the tasks.
 */
function sessionTree(input: {
  readonly chatId: string;
  readonly threadId: string | null;
  readonly boundHostId: string | null;
}): ReactElement {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <BotIdentityContext value={IDENTITY}>
            <BotSessionStatusDataContext
              value={{
                tasks: [],
                subscriptions: null,
                boundHostId: input.boundHostId,
              }}
            >
              <BotSessionView
                botId={BOT_ID}
                hostId={HOST_ID}
                botTitle="Release Bot"
                session={{
                  chatId: input.chatId,
                  threadId: input.threadId,
                  landOn: null,
                }}
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
    </StrictMode>
  );
}

function mountSession(input: {
  readonly chatId: string;
  readonly threadId: string | null;
  readonly boundHostId: string | null;
}): RenderResult {
  return render(sessionTree(input));
}

const bindingControl: { set: (hostId: string | null) => void } = {
  set: () => undefined,
};

/** The session view whose binding the test moves from outside, even mid-render. */
function ControlledSession(props: {
  readonly initialBoundHostId: string | null;
}): ReactElement {
  const [boundHostId, setBoundHostId] = useState(props.initialBoundHostId);
  useEffect(() => {
    bindingControl.set = setBoundHostId;
  }, []);
  return sessionTree({ chatId: TRUNK_ID, threadId: null, boundHostId });
}

function view(): HTMLElement {
  return screen.getByTestId("bot-session-view");
}

/** Opens the background listing's own collapsible, closed by default. */
function openBackground(): void {
  fireEvent.click(within(view()).getByRole("button", { name: /Background/ }));
}

beforeEach(() => {
  hostClient = new SupportScriptedClient(true);
  queryClient = new QueryClient();
  transportOpens.length = 0;
  mocks.reachable = true;
  mocks.unreachableHosts.clear();
  mocks.onTransportOpen = null;
  installLegendListTestClock();
  vi.clearAllMocks();
  installLegendListViewportMetrics();
  mocks.sessions = {};
});

afterEach(() => {
  cleanup();
  mocks.sessions = {};
});
const BOT_METHOD = "managedCommand.subscribeBotOutput";
const COMMAND_ID = "shell-deploy";

function runningCommand(id: string) {
  return managedCommandSchema.parse({
    id,
    monitoring: true,
    description: "deploy watcher",
    command: "tail -f deploy.log",
    cwd: "/work/repo",
    cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
    status: { state: "running", pid: 42, startedAtMs: 2_000 },
    chatId: TRUNK_ID,
    relaunchOnHostRestart: false,
    createdAtMs: 2_000,
    updatedAtMs: 2_000,
  });
}

function endedCommand(id: string) {
  return managedCommandSchema.parse({
    ...runningCommand(id),
    status: { state: "exited", exitCode: 0, signal: null, exitedAtMs: 5_000 },
    updatedAtMs: 5_000,
  });
}

function streamLine(text: string) {
  return { channel: "stdout" as const, text, atMs: 3_000 };
}

function emitSnapshot(
  stream: FakeStreamSession,
  texts: readonly string[],
  command: ManagedCommand,
): void {
  act(() => {
    stream.emit(
      {
        kind: "snapshot",
        command,
        lines: texts.map(streamLine),
        start: { segmentId: "seg-1", byteOffset: 0 },
        reachedStart: true,
        hasBinaryPayload: false,
      },
      null,
    );
  });
}

function emitLiveness(
  stream: FakeStreamSession,
  state: "live" | "holding",
): void {
  act(() => {
    stream.emit({ kind: "liveness", state, hasBinaryPayload: false }, null);
  });
}

async function openShellOutput(
  rowTestId: string,
  boundHostId: string | null,
): Promise<{
  readonly row: HTMLElement;
  readonly trigger: HTMLElement;
  readonly mounted: RenderResult;
}> {
  const mounted = mountSession({
    chatId: TRUNK_ID,
    threadId: null,
    boundHostId,
  });
  await settleLegendList();
  openBackground();
  const row = within(view()).getByTestId(rowTestId);
  const trigger = within(row).getByRole("button");
  trigger.focus();
  fireEvent.click(trigger);
  return { row, trigger, mounted };
}

/** StrictMode opens the window's stream twice and closes the first. */
function onlyStream(): FakeStreamSession {
  const open = hostClient.sessions.filter((stream) => !stream.closed);
  expect(open).toHaveLength(1);
  return open[0];
}

function expectEverySubscribeIs(commandId: string): void {
  expect(hostClient.subscribes.length).toBeGreaterThan(0);
  for (const open of hostClient.subscribes) {
    expect(open).toEqual({
      method: BOT_METHOD,
      params: { botId: BOT_ID, sessionChatId: TRUNK_ID, commandId },
    });
  }
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

const AUTH_AT_START = useAuthStore.getState();

function signInAs(
  identity: { readonly userId: string; readonly username: string },
  status: "signed-in" | "unverified",
): void {
  act(() => {
    useAuthStore.setState({ status, contextMetadata: identity });
  });
}

function signOut(): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-out",
      contextMetadata: null,
      profile: null,
    });
  });
}

const ROW = `managed-command-background-row-${COMMAND_ID}`;

function emitLateOutput(stream: FakeStreamSession, text: string): void {
  act(() => {
    stream.emit(
      {
        kind: "output",
        lines: [streamLine(text)],
        start: { segmentId: "seg-1", byteOffset: 100 },
        hasBinaryPayload: false,
      },
      null,
    );
  });
}

describe("the read-only shell output modal over a bot session", () => {
  let session: ManagedCommandChatSessionStub;

  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: USER_A,
      profile: AUTH_AT_START.profile,
    });
    mocks.sessions[TRUNK_ID] = freshSession(TRUNK_ID, USAGE);
    session = installManagedCommandChatSession({
      epicId: BOT_ID,
      chatId: TRUNK_ID,
      hostId: HOST_ID,
    });
    session.setCommands([runningCommand(COMMAND_ID)]);
    session.setConnectionStatus("open");
  });

  afterEach(() => {
    cleanup();
    session.dispose();
    useAuthStore.setState({
      profile: AUTH_AT_START.profile,
      status: AUTH_AT_START.status,
      contextMetadata: AUTH_AT_START.contextMetadata,
    });
  });

  it("opens from a running shell row on the bound host with the bot, the viewed session and the command, and reads Loading until the first snapshot", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );

    expect(transportOpens.length).toBeGreaterThan(0);
    expect(transportOpens.every((id) => id === BOUND_HOST)).toBe(true);
    expectEverySubscribeIs(COMMAND_ID);
    expect(within(dialog()).getByText("Shell output")).toBeTruthy();
    expect(within(dialog()).getByText(/Loading output/)).toBeTruthy();
  });

  it("shows the lines live once the snapshot and the live word have both arrived, with no lifecycle or input control", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();

    emitSnapshot(
      stream,
      ["listening on 3000", "ready"],
      runningCommand(COMMAND_ID),
    );
    emitLiveness(stream, "live");

    expect(within(dialog()).getByText(/listening on 3000/)).toBeTruthy();
    expect(
      within(dialog()).queryByTestId("bot-shell-output-not-live"),
    ).toBeNull();
    expect(
      within(dialog()).queryByTestId("bot-shell-output-unavailable"),
    ).toBeNull();
    // The output itself is a read-only region; nothing in the window takes input.
    for (const box of within(dialog()).queryAllByRole("textbox")) {
      expect(box.getAttribute("aria-readonly")).toBe("true");
    }
    expect(
      within(dialog()).queryByRole("button", {
        name: /stop|restart|delete|start|send|run|deliver/i,
      }),
    ).toBeNull();
  });

  it("shows the ended status once the shell ends while the window is open", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();
    emitSnapshot(stream, ["building"], runningCommand(COMMAND_ID));
    emitLiveness(stream, "live");

    act(() => {
      stream.emit(
        {
          kind: "status",
          command: endedCommand(COMMAND_ID),
          hasBinaryPayload: false,
        },
        null,
      );
    });

    expect(within(dialog()).getByText(/exited|ended|finished/i)).toBeTruthy();
    expect(within(dialog()).getByText(/building/)).toBeTruthy();
  });

  it("keeps the lines and says Not live while the host holds, and again when it resumes", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();
    emitSnapshot(stream, ["tail-1"], runningCommand(COMMAND_ID));
    emitLiveness(stream, "live");

    emitLiveness(stream, "holding");
    expect(
      within(dialog()).getByTestId("bot-shell-output-not-live"),
    ).toBeTruthy();
    expect(within(dialog()).getByText(/tail-1/)).toBeTruthy();

    emitLiveness(stream, "live");
    expect(
      within(dialog()).queryByTestId("bot-shell-output-not-live"),
    ).toBeNull();
  });

  it("keeps the lines and says Not live when the connection drops", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();
    emitSnapshot(stream, ["tail-1"], runningCommand(COMMAND_ID));
    emitLiveness(stream, "live");

    act(() => stream.emitStatus("reconnecting"));

    expect(
      within(dialog()).getByTestId("bot-shell-output-not-live"),
    ).toBeTruthy();
    expect(within(dialog()).getByText(/tail-1/)).toBeTruthy();
  });

  it("keeps the lines and says Not live while the bound host is unreachable, though the stream says live", async () => {
    mocks.reachable = false;
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();

    emitSnapshot(stream, ["tail-1"], runningCommand(COMMAND_ID));
    emitLiveness(stream, "live");

    expect(
      within(dialog()).getByTestId("bot-shell-output-not-live"),
    ).toBeTruthy();
    expect(within(dialog()).getByText(/tail-1/)).toBeTruthy();
  });

  it("clears the lines and reads Output unavailable when the host denies access", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();
    emitSnapshot(stream, ["secret-1"], runningCommand(COMMAND_ID));
    emitLiveness(stream, "live");

    act(() =>
      stream.emitFatalWithCode("MANAGED_COMMAND_UNAVAILABLE", "denied"),
    );

    expect(within(dialog()).queryByText(/secret-1/)).toBeNull();
    expect(
      within(dialog()).getByTestId("bot-shell-output-unavailable"),
    ).toBeTruthy();
  });

  it("keeps the lines but reads Output unavailable when the command is deleted after open", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();
    emitSnapshot(stream, ["tail-1"], runningCommand(COMMAND_ID));
    emitLiveness(stream, "live");

    act(() => stream.emit({ kind: "deleted", hasBinaryPayload: false }, null));

    expect(within(dialog()).getByText(/tail-1/)).toBeTruthy();
    expect(
      within(dialog()).getByTestId("bot-shell-output-unavailable"),
    ).toBeTruthy();
  });

  it("reads Output unavailable on a host that lacks the bot stream, with no epic subscription", async () => {
    hostClient.support = "unsupported";

    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );

    expect(
      within(dialog()).getByTestId("bot-shell-output-unavailable"),
    ).toBeTruthy();
    expect(
      hostClient.subscribes.some(
        (open) => open.method === "managedCommand.subscribeOutput",
      ),
    ).toBe(false);
  });

  it("returns focus to the row that opened it when the modal closes", async () => {
    const { trigger } = await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.keyDown(dialog(), { key: "Escape", code: "Escape" });
    // Radix restores focus on a zero-delay timer once the content unmounts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  describe("when the row that opened the modal is gone by the time it closes", () => {
    const OTHER = "shell-other";

    async function closeWithTriggerRowGone(
      remaining: ManagedCommand[],
    ): Promise<void> {
      await openShellOutput(ROW, BOUND_HOST);
      act(() => {
        session.setCommands(remaining);
      });
      fireEvent.keyDown(dialog(), { key: "Escape", code: "Escape" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    }

    function focusIsInsideTheSessionView(): boolean {
      const active = document.activeElement;
      return (
        active !== null && active !== document.body && view().contains(active)
      );
    }

    it("lands focus inside the session view when other rows remain", async () => {
      await closeWithTriggerRowGone([runningCommand(OTHER)]);

      expect(focusIsInsideTheSessionView()).toBe(true);
    });

    it("lands focus inside the session view when it was the last row", async () => {
      await closeWithTriggerRowGone([]);

      expect(focusIsInsideTheSessionView()).toBe(true);
    });
  });

  it("opens from a held shell row too", async () => {
    session.setHeldUpdates([
      { commandId: "shell-held", description: "held watcher", heldAtMs: 4_000 },
    ]);
    mountSession({
      chatId: TRUNK_ID,
      threadId: null,
      boundHostId: BOUND_HOST,
    });
    await settleLegendList();
    openBackground();

    const heldRow = within(view()).getByText("Held").closest("button");
    if (heldRow === null) throw new Error("the held row is not a button");
    fireEvent.click(heldRow);

    expectEverySubscribeIs("shell-held");
  });
  describe("when the signed-in account changes under an open window", () => {
    async function openWithLines(): Promise<FakeStreamSession> {
      await openShellOutput(ROW, BOUND_HOST);
      const stream = onlyStream();
      emitSnapshot(stream, ["alpha-secret"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");
      expect(within(dialog()).getByText(/alpha-secret/)).toBeTruthy();
      return stream;
    }

    it("closes the modal and drops the lines at once for a different account, and a late frame from the old stream cannot bring them back", async () => {
      const stream = await openWithLines();
      const subscribesBefore = hostClient.subscribes.length;

      signInAs(USER_B, "signed-in");

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(/alpha-secret/)).toBeNull();
      expect(stream.closed).toBe(true);

      emitLateOutput(stream, "alpha-late");
      emitSnapshot(stream, ["alpha-resnap"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        screen.queryByText(/alpha-late|alpha-resnap|alpha-secret/),
      ).toBeNull();
      expect(hostClient.subscribes).toHaveLength(subscribesBefore);
    });

    it("clears when the account signs out", async () => {
      const stream = await openWithLines();

      signOut();

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(/alpha-secret/)).toBeNull();
      expect(stream.closed).toBe(true);
    });

    it("offers no shell opener while no account is admitted, and opens nothing from the row", async () => {
      signOut();
      mountSession({
        chatId: TRUNK_ID,
        threadId: null,
        boundHostId: BOUND_HOST,
      });
      await settleLegendList();
      openBackground();

      const row = within(view()).getByTestId(ROW);
      expect(within(row).queryByRole("button")).toBeNull();
      fireEvent.click(row);

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(transportOpens).toEqual([]);
    });

    it("keeps the held lines when the same account goes unverified, as the same identity", async () => {
      const stream = await openWithLines();
      const subscribesBefore = hostClient.subscribes.length;

      signInAs(USER_A, "unverified");

      expect(within(dialog()).getByText(/alpha-secret/)).toBeTruthy();
      expect(stream.closed).toBe(false);
      expect(hostClient.subscribes).toHaveLength(subscribesBefore);
    });
  });

  describe("when the viewing host is not the bot's bound host", () => {
    it("subscribes on the bound host only, never on the viewing host", async () => {
      await openShellOutput(ROW, BOUND_HOST);

      expect(transportOpens.length).toBeGreaterThan(0);
      expect(transportOpens).not.toContain(HOST_ID);
      expect(new Set(transportOpens)).toEqual(new Set([BOUND_HOST]));
    });

    const REBINDINGS: ReadonlyArray<readonly [string, string | null]> = [
      ["another host", "host-rebound"],
      ["no host", null],
    ];

    async function openThenRebind(nextHostId: string | null): Promise<{
      readonly stream: FakeStreamSession;
      readonly subscribesAtRebind: number;
    }> {
      const { mounted } = await openShellOutput(ROW, BOUND_HOST);
      const stream = onlyStream();
      emitSnapshot(stream, ["pinned-1"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");
      expect(
        within(dialog()).queryByTestId("bot-shell-output-not-live"),
      ).toBeNull();
      const subscribesAtRebind = hostClient.subscribes.length;
      mounted.rerender(
        sessionTree({
          chatId: TRUNK_ID,
          threadId: null,
          boundHostId: nextHostId,
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      return { stream, subscribesAtRebind };
    }

    it.each(REBINDINGS)(
      "keeps its lines and reads Not live at once, still on the old host, after the binding moves to %s",
      async (_label, nextHostId) => {
        const { subscribesAtRebind } = await openThenRebind(nextHostId);

        expect(new Set(transportOpens)).toEqual(new Set([BOUND_HOST]));
        expect(hostClient.subscribes).toHaveLength(subscribesAtRebind);
        expect(within(dialog()).getByText(/pinned-1/)).toBeTruthy();
        expect(
          within(dialog()).getByTestId("bot-shell-output-not-live"),
        ).toBeTruthy();
      },
    );

    it.each(REBINDINGS)(
      "accepts no later output, snapshot or liveness frame from the old host after the binding moves to %s",
      async (_label, nextHostId) => {
        const { stream } = await openThenRebind(nextHostId);

        emitLateOutput(stream, "pinned-late");
        emitSnapshot(stream, ["pinned-resnap"], runningCommand(COMMAND_ID));
        emitLiveness(stream, "live");
        act(() => {
          stream.emit(
            {
              kind: "status",
              command: endedCommand(COMMAND_ID),
              hasBinaryPayload: false,
            },
            null,
          );
          stream.emit({ kind: "deleted", hasBinaryPayload: false }, null);
        });

        expect(
          within(dialog()).queryByText(/pinned-late|pinned-resnap/),
        ).toBeNull();
        expect(
          within(dialog()).queryByTestId("bot-shell-output-unavailable"),
        ).toBeNull();
        expect(
          within(dialog()).queryByText(/exited|ended|finished/i),
        ).toBeNull();
        expect(within(dialog()).getByText(/pinned-1/)).toBeTruthy();
        expect(
          within(dialog()).getByTestId("bot-shell-output-not-live"),
        ).toBeTruthy();
      },
    );

    it("stays frozen when the binding returns to the host it opened on", async () => {
      const { mounted } = await openShellOutput(ROW, BOUND_HOST);
      const stream = onlyStream();
      emitSnapshot(stream, ["pinned-1"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");
      for (const boundHostId of ["host-rebound", BOUND_HOST]) {
        mounted.rerender(
          sessionTree({ chatId: TRUNK_ID, threadId: null, boundHostId }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
      }

      emitLateOutput(stream, "pinned-late");
      emitLiveness(stream, "live");

      expect(
        within(dialog()).getByTestId("bot-shell-output-not-live"),
      ).toBeTruthy();
      expect(within(dialog()).getByText(/pinned-1/)).toBeTruthy();
      expect(within(dialog()).queryByText(/pinned-late/)).toBeNull();
      expect(new Set(transportOpens)).toEqual(new Set([BOUND_HOST]));
    });

    it.each(REBINDINGS)(
      "clears the held lines when the old host then denies access, after the binding moves to %s",
      async (_label, nextHostId) => {
        const { stream } = await openThenRebind(nextHostId);
        expect(within(dialog()).getByText(/pinned-1/)).toBeTruthy();

        act(() =>
          stream.emitFatalWithCode("MANAGED_COMMAND_UNAVAILABLE", "denied"),
        );

        expect(within(dialog()).queryByText(/pinned-1/)).toBeNull();
        expect(
          within(dialog()).getByTestId("bot-shell-output-unavailable"),
        ).toBeTruthy();
      },
    );

    it.each(REBINDINGS)(
      "never shows the first snapshot that arrives after the binding moved to %s",
      async (_label, nextHostId) => {
        const { mounted } = await openShellOutput(ROW, BOUND_HOST);
        const stream = onlyStream();
        expect(within(dialog()).getByText(/Loading output/)).toBeTruthy();

        mounted.rerender(
          sessionTree({
            chatId: TRUNK_ID,
            threadId: null,
            boundHostId: nextHostId,
          }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        emitSnapshot(stream, ["stale-first"], runningCommand(COMMAND_ID));
        emitLiveness(stream, "live");

        expect(within(dialog()).queryByText(/stale-first/)).toBeNull();
        expect(within(dialog()).queryByText(/Loading output/)).toBeNull();
        expect(
          within(dialog()).queryByTestId("bot-shell-output-not-live"),
        ).not.toBeNull();
      },
    );

    it("leaves no dialog and no lines when the bot surface drops the session view", async () => {
      const { mounted } = await openShellOutput(ROW, BOUND_HOST);
      const stream = onlyStream();
      emitSnapshot(stream, ["pinned-1"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");

      mounted.rerender(<StrictMode>{null}</StrictMode>);

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(/pinned-1/)).toBeNull();
      expect(stream.closed).toBe(true);
    });

    it("stays frozen when the binding moves before the output session exists and is back on the opened host before the stream is created", async () => {
      render(<ControlledSession initialBoundHostId={BOUND_HOST} />);
      await settleLegendList();
      openBackground();
      const trigger = within(within(view()).getByTestId(ROW)).getByRole(
        "button",
      );
      // The stream is created inside the view's effect; the binding returns in
      // the same batch as the session, never having been seen with a session.
      mocks.onTransportOpen = () => bindingControl.set(BOUND_HOST);

      act(() => {
        fireEvent.click(trigger);
        bindingControl.set("host-rebound");
      });
      const stream = onlyStream();
      emitSnapshot(stream, ["stale-first"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");

      expect(within(dialog()).queryByText(/stale-first/)).toBeNull();
      expect(within(dialog()).queryByText(/Loading output/)).toBeNull();
      expect(
        within(dialog()).getByTestId("bot-shell-output-not-live"),
      ).toBeTruthy();
    });

    it.each(REBINDINGS)(
      "reads the new binding on a fresh reopen after the binding moved to %s",
      async (_label, nextHostId) => {
        const { mounted } = await openShellOutput(ROW, BOUND_HOST);
        const stream = onlyStream();
        emitSnapshot(stream, ["pinned-1"], runningCommand(COMMAND_ID));
        emitLiveness(stream, "live");
        mounted.rerender(
          sessionTree({
            chatId: TRUNK_ID,
            threadId: null,
            boundHostId: nextHostId,
          }),
        );
        fireEvent.keyDown(dialog(), { key: "Escape", code: "Escape" });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        expect(screen.queryByRole("dialog")).toBeNull();
        const opensBefore = transportOpens.length;

        fireEvent.click(
          within(within(view()).getByTestId(ROW)).getByRole("button"),
        );

        if (nextHostId === null) {
          expect(
            within(dialog()).getByTestId("bot-shell-output-unavailable"),
          ).toBeTruthy();
          expect(transportOpens).toHaveLength(opensBefore);
        } else {
          expect(transportOpens.length).toBeGreaterThan(opensBefore);
          expect(transportOpens.slice(opensBefore)).toContain(nextHostId);
          expect(transportOpens.slice(opensBefore)).not.toContain(BOUND_HOST);
          expect(within(dialog()).queryByText(/pinned-1/)).toBeNull();
        }
      },
    );

    it("keeps the lines and says Not live when the bound host is unreachable, though the viewing host is reachable", async () => {
      mocks.unreachableHosts.add(BOUND_HOST);
      await openShellOutput(ROW, BOUND_HOST);
      const stream = onlyStream();

      emitSnapshot(stream, ["bound-1"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");

      expect(
        within(dialog()).getByTestId("bot-shell-output-not-live"),
      ).toBeTruthy();
      expect(within(dialog()).getByText(/bound-1/)).toBeTruthy();
      expect(transportOpens).not.toContain(HOST_ID);
    });

    it("reads live when the bound host is reachable even though the viewing host is not", async () => {
      mocks.unreachableHosts.add(HOST_ID);
      await openShellOutput(ROW, BOUND_HOST);
      const stream = onlyStream();

      emitSnapshot(stream, ["bound-1"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");

      expect(
        within(dialog()).queryByTestId("bot-shell-output-not-live"),
      ).toBeNull();
      expect(within(dialog()).getByText(/bound-1/)).toBeTruthy();
    });

    it("reads Output unavailable and dials no host when the bot has no bound host", async () => {
      await openShellOutput(ROW, null);

      expect(
        within(dialog()).getByTestId("bot-shell-output-unavailable"),
      ).toBeTruthy();
      expect(transportOpens).toEqual([]);
      expect(hostClient.subscribes).toEqual([]);
    });
  });
});
