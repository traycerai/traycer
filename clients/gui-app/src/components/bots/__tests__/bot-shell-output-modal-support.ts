/**
 * What the shell output modal suites share: the session view as the bot tab
 * mounts it, the shell fixtures and the drivers of the stream.
 */
import {
  StrictMode,
  useEffect,
  useState,
  type ReactElement,
  createElement,
} from "react";
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
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  managedCommandSchema,
  type ManagedCommand,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import { type FakeStreamSession } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import {
  installManagedCommandChatSession,
  type ManagedCommandChatSessionStub,
} from "@/stores/managed-commands/test-support/managed-command-chat-session";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";
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
import {
  transportOpens,
  hostClient,
  mocks,
  renewHostClient,
} from "@/components/bots/__tests__/bot-shell-output-modal-mocks";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

export const HOST_ID = "host-tab";

export const BOUND_HOST = "host-bound";

export const USER_A = { userId: "user-a", username: "ada" };

export const USER_B = { userId: "user-b", username: "bea" };

export const TRUNK_ID = "trunk-chat";

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

export const opened = {
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
export function sessionTree(input: {
  readonly chatId: string;
  readonly threadId: string | null;
  readonly boundHostId: string | null;
}): ReactElement {
  return createElement(
    StrictMode,
    null,
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        TooltipProvider,
        null,
        createElement(
          BotIdentityContext,
          { value: IDENTITY },
          createElement(
            BotSessionStatusDataContext,
            {
              value: {
                tasks: [],
                subscriptions: null,
                boundHostId: input.boundHostId,
              },
            },
            createElement(BotSessionView, {
              botId: BOT_ID,
              hostId: HOST_ID,
              boundHostId: null,
              botTitle: "Release Bot",
              session: {
                chatId: input.chatId,
                threadId: input.threadId,
                landOn: null,
              },
              threads: [],
              resolveMember: UNRESOLVED_BOT_MEMBERS,
              onClose: opened.close,
              onOpenChannel: opened.channel,
              onOpenThread: opened.thread,
            }),
          ),
        ),
      ),
    ),
  );
}

export function mountSession(input: {
  readonly chatId: string;
  readonly threadId: string | null;
  readonly boundHostId: string | null;
}): RenderResult {
  return render(sessionTree(input));
}

export const bindingControl: { set: (hostId: string | null) => void } = {
  set: () => undefined,
};

/** The session view whose binding the test moves from outside, even mid-render. */
export function ControlledSession(props: {
  readonly initialBoundHostId: string | null;
}): ReactElement {
  const [boundHostId, setBoundHostId] = useState(props.initialBoundHostId);
  useEffect(() => {
    bindingControl.set = setBoundHostId;
  }, []);
  return sessionTree({ chatId: TRUNK_ID, threadId: null, boundHostId });
}

export function view(): HTMLElement {
  return screen.getByTestId("bot-session-view");
}

/** Opens the background listing's own collapsible, closed by default. */
export function openBackground(): void {
  fireEvent.click(within(view()).getByRole("button", { name: /Background/ }));
}

const BOT_METHOD = "managedCommand.subscribeBotOutput";

export const COMMAND_ID = "shell-deploy";

export function runningCommand(id: string) {
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

export function endedCommand(id: string) {
  return managedCommandSchema.parse({
    ...runningCommand(id),
    status: { state: "exited", exitCode: 0, signal: null, exitedAtMs: 5_000 },
    updatedAtMs: 5_000,
  });
}

function streamLine(text: string) {
  return { channel: "stdout" as const, text, atMs: 3_000 };
}

export function emitSnapshot(
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

export function emitLiveness(
  stream: FakeStreamSession,
  state: "live" | "holding",
): void {
  act(() => {
    stream.emit({ kind: "liveness", state, hasBinaryPayload: false }, null);
  });
}

export async function openShellOutput(
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
export function onlyStream(): FakeStreamSession {
  const open = hostClient.sessions.filter((stream) => !stream.closed);
  expect(open).toHaveLength(1);
  return open[0];
}

export function expectEverySubscribeIs(commandId: string): void {
  expect(hostClient.subscribes.length).toBeGreaterThan(0);
  for (const open of hostClient.subscribes) {
    expect(open).toEqual({
      method: BOT_METHOD,
      params: { botId: BOT_ID, sessionChatId: TRUNK_ID, commandId },
    });
  }
}

export function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

const AUTH_AT_START = useAuthStore.getState();

export function signInAs(
  identity: { readonly userId: string; readonly username: string },
  status: "signed-in" | "unverified",
): void {
  act(() => {
    useAuthStore.setState({ status, contextMetadata: identity });
  });
}

export function signOut(): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-out",
      contextMetadata: null,
      profile: null,
    });
  });
}

export const ROW = `managed-command-background-row-${COMMAND_ID}`;

export function emitLateOutput(stream: FakeStreamSession, text: string): void {
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

export const REBINDINGS: ReadonlyArray<readonly [string, string | null]> = [
  ["another host", "host-rebound"],
  ["no host", null],
];

export async function openThenRebind(nextHostId: string | null): Promise<{
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

export function installShellSession(): ManagedCommandChatSessionStub {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: USER_A,
    profile: AUTH_AT_START.profile,
  });
  mocks.sessions[TRUNK_ID] = freshSession(TRUNK_ID, USAGE);
  const session = installManagedCommandChatSession({
    epicId: BOT_ID,
    chatId: TRUNK_ID,
    hostId: HOST_ID,
  });
  session.setCommands([runningCommand(COMMAND_ID)]);
  session.setConnectionStatus("open");
  return session;
}

export function teardownShellSession(
  session: ManagedCommandChatSessionStub,
): void {
  cleanup();
  session.dispose();
  useAuthStore.setState({
    profile: AUTH_AT_START.profile,
    status: AUTH_AT_START.status,
    contextMetadata: AUTH_AT_START.contextMetadata,
  });
}

export function installShellFixtureLifecycle(): void {
  beforeEach(() => {
    renewHostClient();
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
}
