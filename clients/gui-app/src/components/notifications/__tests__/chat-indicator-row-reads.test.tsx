import { createElement, memo, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import {
  HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP,
  type HostNotificationsCloudFeedRow,
  type HostNotificationsIndicatorState,
  type HostNotificationsIndicatorStateRequest,
  type HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import { ChatIndicatorHostScopes } from "@/components/notifications/chat-indicator-host-scopes";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { chatIndicatorHostScopes } from "@/lib/notifications/chat-indicator-scopes";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";

/**
 * What the rows of a surface asking about several requests' worth of chats
 * show, and when they re-render, as the requests answer one by one. Every
 * answer is a read the test holds open and answers in a task of its own,
 * through a real `HostClient` over `MockHostMessenger`; the rows are real
 * `useSurfaceNotificationIndicatorState` readers under the real providers.
 */

const HOST_ID = mockLocalHostEntry.hostId;
const OTHER_HOST_ID = "host-other";
const CHUNK = HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP;
/** Three requests: CHUNK, CHUNK and one id. */
const CHAT_IDS = Array.from(
  { length: CHUNK * 2 + 1 },
  (_value, index) => `chat-${String(index).padStart(4, "0")}`,
);
/** One chat of each request, and a neighbour of the first. */
const FIRST = CHAT_IDS[0];
const NEIGHBOUR = CHAT_IDS[7];
const MIDDLE = CHAT_IDS[CHUNK + 100];
const LAST = CHAT_IDS[CHUNK * 2];

const clientsByHostId = vi.hoisted((): { value: Map<string, unknown> } => ({
  value: new Map(),
}));
const feedMode = vi.hoisted((): { value: "local" | "cloud" } => ({
  value: "local",
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : (clientsByHostId.value.get(hostId) ?? null),
}));

vi.mock("@/lib/notifications/notification-feed-mode", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/lib/notifications/notification-feed-mode")
    >();
  return {
    ...actual,
    useNotificationFeedMode: () => feedMode.value,
    useNotificationFeedModeSettling: () => false,
  };
});

interface IndicatorRead {
  readonly params: HostNotificationsIndicatorStateRequest;
  readonly answer: (response: HostNotificationsIndicatorStateResponse) => void;
  readonly fail: (error: Error) => void;
}

interface Harness {
  readonly queryClient: QueryClient;
  /** Every `host.notifications.indicatorState` request the host received, in order. */
  readonly reads: IndicatorRead[];
}

function createHarness(): Harness {
  const queryClient = createAppQueryClient();
  const reads: IndicatorRead[] = [];
  let requestId = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestId += 1;
        return `request-${String(requestId)}`;
      },
      handlers: {
        "host.notifications.indicatorState": (params) =>
          new Promise<HostNotificationsIndicatorStateResponse>(
            (resolve, reject) => {
              reads.push({
                params,
                answer: resolve,
                fail: (error) => {
                  reject(error);
                },
              });
            },
          ),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  clientsByHostId.value = new Map([
    [HOST_ID, spine.createRequester(mockLocalHostEntry)],
  ]);
  useAuthStore.setState({
    contextMetadata: { userId: "user-a", username: "user-a" },
  });
  return { queryClient, reads };
}

function lit(
  flags: Partial<HostNotificationsIndicatorState>,
): HostNotificationsIndicatorState {
  return {
    pendingApproval: false,
    pendingInterview: false,
    pendingFork: false,
    unreadFailure: false,
    unreadDone: false,
    unreadCount: 0,
    ...flags,
  };
}

type LitChats = Readonly<Record<string, HostNotificationsIndicatorState>>;

/** The chats each request's answer lights; every other chat of the request is answered dark. */
const LIT_BY_CHUNK: ReadonlyArray<LitChats> = [
  {
    [FIRST]: lit({ pendingFork: true }),
    [NEIGHBOUR]: lit({ pendingFork: true }),
  },
  { [MIDDLE]: lit({ pendingApproval: true }) },
  { [LAST]: lit({ pendingInterview: true }) },
];

function responseFor(
  read: IndicatorRead,
  litChats: LitChats,
): HostNotificationsIndicatorStateResponse {
  return {
    epics: {},
    chats: Object.fromEntries(
      read.params.chatIds.flatMap((chatId) =>
        Object.hasOwn(litChats, chatId) ? [[chatId, litChats[chatId]]] : [],
      ),
    ),
    complete: true,
  };
}

/** The reads of CHUNK-sized page `chunk` (0, 1, 2) of `CHAT_IDS`, oldest first. */
function readsFor(harness: Harness, chunk: number): IndicatorRead[] {
  const firstChatId = CHAT_IDS[chunk * CHUNK];
  return harness.reads.filter((read) => read.params.chatIds[0] === firstChatId);
}

function latestRead(harness: Harness, chunk: number): IndicatorRead {
  const read = readsFor(harness, chunk).at(-1);
  if (read === undefined) throw new Error(`no read for chunk ${String(chunk)}`);
  return read;
}

/** Runs `settle` in a task of its own, then lets the query layer's notifications through. */
async function inOwnTask(settle: () => void): Promise<void> {
  await act(async () => {
    settle();
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function answerRead(
  read: IndicatorRead,
  litChats: LitChats,
): Promise<void> {
  await inOwnTask(() => {
    read.answer(responseFor(read, litChats));
  });
}

async function answerChunk(
  harness: Harness,
  chunk: number,
  litChats: LitChats,
): Promise<void> {
  await answerRead(latestRead(harness, chunk), litChats);
}

async function failChunk(harness: Harness, chunk: number): Promise<void> {
  const read = latestRead(harness, chunk);
  await inOwnTask(() => {
    read.fail(new Error("indicator chunk failed"));
  });
}

async function answerEveryChunk(harness: Harness): Promise<void> {
  for (const [chunk, litChats] of LIT_BY_CHUNK.entries()) {
    await answerChunk(harness, chunk, litChats);
  }
}

async function expectReads(harness: Harness, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.reads).toHaveLength(count);
  });
}

/** Every read has been answered or failed, and the answers have reached the readers. */
async function expectNothingInFlight(harness: Harness): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.queryClient.isFetching()).toBe(0);
  });
  await inOwnTask(() => undefined);
}

function refresh(harness: Harness): void {
  act(() => {
    void harness.queryClient.invalidateQueries();
  });
}

interface RowSpec {
  readonly chatId: string;
  readonly originHostId: string | null;
}

interface RenderedRow {
  readonly rowId: string;
  readonly shown: string;
}

function rowIdOf(spec: RowSpec): string {
  return `${spec.originHostId ?? "all"}:${spec.chatId}`;
}

const BOUND_ROWS: ReadonlyArray<RowSpec> = CHAT_IDS.map((chatId) => ({
  chatId,
  originHostId: HOST_ID,
}));

const SPOT_ROWS: ReadonlyArray<RowSpec> = [FIRST, MIDDLE, LAST].map(
  (chatId) => ({ chatId, originHostId: HOST_ID }),
);

/** A row, as a sidebar draws one: memoised, so only what it reads can re-render it. */
const Row = memo(function Row(props: {
  readonly spec: RowSpec;
  readonly log: RenderedRow[];
}): ReactNode {
  const state = useSurfaceNotificationIndicatorState(
    { epicId: "epic-1", chatId: props.spec.chatId },
    props.spec.originHostId,
  );
  const shown = Object.entries(state)
    .filter(([, value]) => value === true)
    .map(([flag]) => flag)
    .join(",");
  props.log.push({ rowId: rowIdOf(props.spec), shown });
  return <span data-testid={`row-${rowIdOf(props.spec)}`}>{shown}</span>;
});

function rowsOf(
  specs: ReadonlyArray<RowSpec>,
  log: RenderedRow[],
): ReactNode[] {
  return specs.map((spec) => <Row key={rowIdOf(spec)} spec={spec} log={log} />);
}

function renderScope(
  harness: Harness,
  specs: ReadonlyArray<RowSpec>,
  log: RenderedRow[],
): RenderResult {
  const scopes = chatIndicatorHostScopes(
    CHAT_IDS.map((chatId) => ({ hostId: HOST_ID, chatId })),
  );
  return render(
    createElement(
      QueryClientProvider,
      { client: harness.queryClient },
      <ChatIndicatorHostScopes freshnessMode="base" scopes={scopes}>
        {rowsOf(specs, log)}
      </ChatIndicatorHostScopes>,
    ),
  );
}

function shownBy(spec: RowSpec): string | null {
  return screen.getByTestId(`row-${rowIdOf(spec)}`).textContent;
}

async function expectShown(spec: RowSpec, flags: string): Promise<void> {
  await vi.waitFor(() => {
    expect(shownBy(spec)).toBe(flags);
  });
}

/** What a row drew over time, each distinct picture once. */
function historyOf(log: RenderedRow[], spec: RowSpec): string[] {
  return log
    .filter((rendered) => rendered.rowId === rowIdOf(spec))
    .map((rendered) => rendered.shown)
    .filter((shown, index, all) => index === 0 || shown !== all[index - 1]);
}

const rowOf = (chatId: string): RowSpec => ({
  chatId,
  originHostId: HOST_ID,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  feedMode.value = "local";
  clientsByHostId.value = new Map();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useCloudNotificationsStore.setState(
    useCloudNotificationsStore.getInitialState(),
    true,
  );
  useAppLocalNotificationsStore.getState().resetForTests();
});

describe("rows of a surface whose requests answer one by one", () => {
  it("draws each request's dots as it answers, before the others have", async () => {
    const harness = createHarness();
    renderScope(harness, SPOT_ROWS, []);
    await expectReads(harness, 3);

    await answerChunk(harness, 0, LIT_BY_CHUNK[0]);
    await expectShown(rowOf(FIRST), "pendingFork");
    expect(shownBy(rowOf(MIDDLE))).toBe("");
    expect(shownBy(rowOf(LAST))).toBe("");

    await answerChunk(harness, 1, LIT_BY_CHUNK[1]);
    await expectShown(rowOf(MIDDLE), "pendingApproval");
    expect(shownBy(rowOf(LAST))).toBe("");

    await answerChunk(harness, 2, LIT_BY_CHUNK[2]);
    await expectShown(rowOf(LAST), "pendingInterview");
    expect(shownBy(rowOf(FIRST))).toBe("pendingFork");
  });

  it("re-renders only the rows an answer changed", async () => {
    const harness = createHarness();
    const log: RenderedRow[] = [];
    renderScope(harness, BOUND_ROWS, log);
    await expectReads(harness, 3);

    let mark = log.length;
    await answerChunk(harness, 0, LIT_BY_CHUNK[0]);
    await expectShown(rowOf(FIRST), "pendingFork");
    expect(log.length - mark).toBe(2);
    expect(new Set(log.slice(mark).map((rendered) => rendered.rowId))).toEqual(
      new Set([rowIdOf(rowOf(FIRST)), rowIdOf(rowOf(NEIGHBOUR))]),
    );

    mark = log.length;
    await answerChunk(harness, 1, LIT_BY_CHUNK[1]);
    await expectShown(rowOf(MIDDLE), "pendingApproval");
    expect(log.length - mark).toBe(1);

    mark = log.length;
    await answerChunk(harness, 2, LIT_BY_CHUNK[2]);
    await expectShown(rowOf(LAST), "pendingInterview");
    expect(log.length - mark).toBe(1);

    mark = log.length;
    refresh(harness);
    await expectReads(harness, 6);
    await answerEveryChunk(harness);
    await expectNothingInFlight(harness);
    expect(log.length - mark).toBe(0);
  });

  it("re-renders only the row whose app-local failure changed", async () => {
    const harness = createHarness();
    const log: RenderedRow[] = [];
    renderScope(harness, BOUND_ROWS, log);
    await expectReads(harness, 3);
    const mark = log.length;

    act(() => {
      const notifications = useAppLocalNotificationsStore.getState();
      notifications.activateIdentity("user-a");
      notifications.upsert({
        id: "terminal-closed",
        originHostId: HOST_ID,
        updatedAt: 1,
        readAt: null,
        kind: "terminal.closed",
        sourceRef: "terminal-closed",
        payload: { kind: "chat", epicId: "epic-1", chatId: MIDDLE },
        message: "Terminal closed",
        detail: null,
      });
    });

    await expectShown(rowOf(MIDDLE), "unreadFailure,unreadTerminalFailure");
    expect(log.length - mark).toBe(1);
    expect(log[mark].rowId).toBe(rowIdOf(rowOf(MIDDLE)));
  });

  it("keeps the dots of a failed request and still lights the others", async () => {
    const harness = createHarness();
    renderScope(harness, SPOT_ROWS, []);
    await expectReads(harness, 3);
    await answerEveryChunk(harness);
    await expectShown(rowOf(LAST), "pendingInterview");

    refresh(harness);
    await expectReads(harness, 6);
    await answerChunk(harness, 0, { [FIRST]: lit({ unreadDone: true }) });
    await failChunk(harness, 1);
    await answerChunk(harness, 2, {});

    await expectShown(rowOf(FIRST), "unreadDone");
    await expectShown(rowOf(LAST), "");
    expect(shownBy(rowOf(MIDDLE))).toBe("pendingApproval");
  });

  it("draws nothing of a refresh that was replaced before it answered", async () => {
    const harness = createHarness();
    const log: RenderedRow[] = [];
    renderScope(harness, SPOT_ROWS, log);
    await expectReads(harness, 3);
    await answerEveryChunk(harness);
    await expectShown(rowOf(LAST), "pendingInterview");

    refresh(harness);
    await expectReads(harness, 6);
    refresh(harness);
    await expectReads(harness, 9);
    for (const chunk of [0, 1, 2]) {
      await answerRead(readsFor(harness, chunk)[1], {
        [FIRST]: lit({ unreadFailure: true }),
        [MIDDLE]: lit({ unreadDone: true }),
        [LAST]: lit({ pendingFork: true }),
      });
    }
    await answerChunk(harness, 0, { [FIRST]: lit({ unreadDone: true }) });
    await answerChunk(harness, 1, {});
    await answerChunk(harness, 2, { [LAST]: lit({ pendingApproval: true }) });
    await expectNothingInFlight(harness);

    expect(historyOf(log, rowOf(FIRST))).toEqual([
      "",
      "pendingFork",
      "unreadDone",
    ]);
    expect(historyOf(log, rowOf(MIDDLE))).toEqual(["", "pendingApproval", ""]);
    expect(historyOf(log, rowOf(LAST))).toEqual([
      "",
      "pendingInterview",
      "pendingApproval",
    ]);
  });
});

describe("what the rows show for the answers of several requests", () => {
  const ANSWERS: ReadonlyArray<LitChats> = [
    { [FIRST]: lit({ pendingFork: true, unreadFailure: true }) },
    { [MIDDLE]: lit({ unreadDone: true }) },
    { [LAST]: lit({ pendingInterview: true }) },
  ];
  const IDS = [FIRST, MIDDLE, LAST, CHAT_IDS[5]];
  const BOUND_AND_UNBOUND: ReadonlyArray<RowSpec> = IDS.flatMap((chatId) => [
    { chatId, originHostId: HOST_ID },
    { chatId, originHostId: null },
  ]);

  async function answerWith(harness: Harness): Promise<void> {
    for (const [chunk, litChats] of ANSWERS.entries()) {
      await answerChunk(harness, chunk, litChats);
    }
    await expectNothingInFlight(harness);
  }

  it("shows the host's answers on bound and unbound rows in local mode", async () => {
    const harness = createHarness();
    renderScope(harness, BOUND_AND_UNBOUND, []);
    await expectReads(harness, 3);

    await answerWith(harness);

    for (const originHostId of [HOST_ID, null]) {
      expect(shownBy({ chatId: FIRST, originHostId })).toBe(
        "unreadFailure,unreadTerminalFailure,pendingFork",
      );
      expect(shownBy({ chatId: MIDDLE, originHostId })).toBe("unreadDone");
      expect(shownBy({ chatId: LAST, originHostId })).toBe("pendingInterview");
      expect(shownBy({ chatId: CHAT_IDS[5], originHostId })).toBe("");
    }
  });

  it("folds the home-local partitions into the cloud snapshot in cloud mode", async () => {
    feedMode.value = "cloud";
    const approval: HostNotificationsCloudFeedRow = {
      entryId: "entry-approval",
      originHostId: HOST_ID,
      coalesceKey: `approval.requested:${MIDDLE}`,
      entry: {
        id: "entry-approval",
        updatedAt: 1_100,
        readAt: null,
        kind: "approval.requested",
        sourceRef: "entry-approval",
        severity: "needs_action",
        outcome: null,
        resolvedAt: null,
        epicId: "epic-1",
        chatId: MIDDLE,
        payload: {
          kind: "approval",
          epicId: "epic-1",
          chatId: MIDDLE,
          approvalId: "entry-approval",
        },
      },
      presentation: { epicTitle: "Epic", chatTitle: "Chat" },
    };
    useCloudNotificationsStore.setState({
      rows: { "entry-approval": approval },
    });
    const harness = createHarness();
    renderScope(
      harness,
      [...BOUND_AND_UNBOUND, { chatId: MIDDLE, originHostId: OTHER_HOST_ID }],
      [],
    );
    await expectReads(harness, 3);

    await answerWith(harness);

    for (const originHostId of [HOST_ID, null]) {
      expect(shownBy({ chatId: FIRST, originHostId })).toBe(
        "unreadFailure,unreadTerminalFailure,pendingFork",
      );
      expect(shownBy({ chatId: MIDDLE, originHostId })).toBe(
        "pendingApproval,unreadDone",
      );
      expect(shownBy({ chatId: LAST, originHostId })).toBe("pendingInterview");
      expect(shownBy({ chatId: CHAT_IDS[5], originHostId })).toBe("");
    }
    expect(shownBy({ chatId: MIDDLE, originHostId: OTHER_HOST_ID })).toBe("");
  });
});

describe("a row's first render", () => {
  it("is lit when its provider already holds a lit map", () => {
    const log: RenderedRow[] = [];
    render(
      <NotificationIndicatorsProvider
        indicators={{
          epics: {},
          chats: { [FIRST]: lit({ pendingFork: true }) },
        }}
      >
        {rowsOf([{ chatId: FIRST, originHostId: null }], log)}
      </NotificationIndicatorsProvider>,
    );

    expect(log.map((rendered) => rendered.shown)).toEqual(["pendingFork"]);
  });

  it("is lit when the surface remounts over cached answers", async () => {
    const harness = createHarness();
    const first = renderScope(harness, SPOT_ROWS, []);
    await expectReads(harness, 3);
    await answerEveryChunk(harness);
    await expectShown(rowOf(LAST), "pendingInterview");
    first.unmount();

    const log: RenderedRow[] = [];
    renderScope(harness, SPOT_ROWS, log);

    expect(historyOf(log, rowOf(FIRST))).toEqual(["pendingFork"]);
    expect(historyOf(log, rowOf(MIDDLE))).toEqual(["pendingApproval"]);
    expect(historyOf(log, rowOf(LAST))).toEqual(["pendingInterview"]);
  });
});
