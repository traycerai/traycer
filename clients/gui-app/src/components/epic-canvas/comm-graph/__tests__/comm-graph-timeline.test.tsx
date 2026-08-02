import "../../../../../__tests__/test-browser-apis";

const useHostNotificationIndicatorsMock = vi.hoisted(() =>
  vi.fn(() => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  })),
);
vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: useHostNotificationIndicatorsMock,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/lib/host", () => ({
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  // This branch's `EpicSessionProvider` folds the host binding's owner
  // identity into its rebuild decision; a null binding is the legitimate
  // "directory not bound yet" state and keeps the identity key null.
  useHostBinding: () => null,
}));

const openTransportStub = vi.hoisted(() => () => {
  throw new Error("openTransport must not be called in this test");
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => openTransportStub,
}));

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: "light" as const,
    themePreset: "default",
  }),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-a",
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

const tileNavigationMocks = vi.hoisted(() => ({
  openTileInEpic: vi.fn(),
  openTileInTab: vi.fn(),
  openTilePreviewInEpic: vi.fn(),
  openTilePreviewInTab: vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => tileNavigationMocks,
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EpicCommunicationGraphEvent } from "@traycer/protocol/host/epic/communication-graph";
import { CommGraphTile } from "@/components/epic-canvas/renderers/comm-graph-tile";
import { __setCommGraphSubscriptionOpenerForTests } from "@/lib/comm-graph/comm-graph-opener-override";
import {
  __commGraphSubscriptionRefCountForTests,
  __resetCommGraphRegistryForTests,
} from "@/lib/comm-graph/comm-graph-registry";
import { useCommGraphTimelineStore } from "@/stores/epics/comm-graph-timeline-store";
import { useCommGraphRowOpenStore } from "@/stores/epics/comm-graph-row-open-store";
import type {
  CommGraphSubscriptionHandlers,
  CommGraphSubscriptionRequest,
} from "@/lib/comm-graph/comm-graph-subscription";
import { useChatTranscriptJumpStore } from "@/stores/chats/chat-transcript-jump-store";
import { makeCommGraphTileRef } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import { TestEpicSessionWrapper } from "@/components/epic-canvas/__tests__/test-epic-session";
import { createEpicSessionTestHarness } from "@/components/epic-canvas/__tests__/test-epic-session-harness";

const EPIC_ID = "epic-comm-timeline";
const CHAT_ID = "chat-1";
const LATE_CHAT_ID = "chat-late";
const TUI_ID = "tui-1";
const TUI_B_ID = "tui-b";
const HOST_A = "host-a";
// A second host makes the per-host initialization boundary observable: hosts
// hand over their snapshots independently, so one host's history can arrive
// long after another host is already live.
const HOST_B = "host-b";
const LATE_CREATED_AT = 5_000;

const harness = createEpicSessionTestHarness(EPIC_ID);
let queryClient: QueryClient;
const openedByHost = new Map<string, CommGraphSubscriptionHandlers>();
const openRequests: CommGraphSubscriptionRequest[] = [];

function seedDoc(doc: Y.Doc): void {
  const epic = doc.getMap("epic");
  const chats = new Y.Map<unknown>();

  const chat = new Y.Map<unknown>();
  chat.set("id", CHAT_ID);
  chat.set("title", "Orchestrator");
  chat.set("parentId", null);
  chat.set("createdAt", 1);
  chat.set("updatedAt", 1);
  chat.set("hostId", HOST_A);
  chat.set("messages", new Y.Array<unknown>());
  chats.set(CHAT_ID, chat);

  // Created long after the first events - a replay must not show it early.
  const late = new Y.Map<unknown>();
  late.set("id", LATE_CHAT_ID);
  late.set("title", "Latecomer");
  late.set("parentId", null);
  late.set("createdAt", LATE_CREATED_AT);
  late.set("updatedAt", LATE_CREATED_AT);
  late.set("hostId", HOST_A);
  late.set("messages", new Y.Array<unknown>());
  chats.set(LATE_CHAT_ID, late);

  const tuiAgents = new Y.Map<unknown>();
  const tui = new Y.Map<unknown>();
  tui.set("id", TUI_ID);
  tui.set("harnessId", "claude");
  tui.set("harnessSessionId", "session-1");
  tui.set("agentMode", "regular");
  tui.set("title", "Reviewer");
  tui.set("parentId", CHAT_ID);
  tui.set("createdAt", 2);
  tui.set("updatedAt", 2);
  tui.set("hostId", HOST_A);
  tuiAgents.set(TUI_ID, tui);

  const tuiB = new Y.Map<unknown>();
  tuiB.set("id", TUI_B_ID);
  tuiB.set("harnessId", "claude");
  tuiB.set("harnessSessionId", "session-b");
  tuiB.set("agentMode", "regular");
  tuiB.set("title", "Remote reviewer");
  tuiB.set("parentId", CHAT_ID);
  tuiB.set("createdAt", 3);
  tuiB.set("updatedAt", 3);
  tuiB.set("hostId", HOST_B);
  tuiAgents.set(TUI_B_ID, tuiB);

  epic.set("title", "Epic");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", tuiAgents);
  epic.set("chats", chats);
}

function message(
  overrides: Partial<EpicCommunicationGraphEvent> & {
    readonly id: number;
    readonly timestamp: number;
  },
): EpicCommunicationGraphEvent {
  return {
    kind: "a2a_message",
    senderAgentId: CHAT_ID,
    receiverAgentId: TUI_ID,
    responseId: "r1",
    inReplyTo: null,
    expectReply: false,
    messageText: "review this",
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    ...overrides,
  };
}

async function renderTile(): Promise<void> {
  await renderSurfaces(
    <CommGraphTile node={makeCommGraphTileRef(EPIC_ID)} viewTabId={EPIC_ID} />,
  );
}

async function renderSurfaces(children: ReactNode): Promise<void> {
  render(
    <QueryClientProvider client={queryClient}>
      <TestEpicSessionWrapper epicId={EPIC_ID}>
        {children}
      </TestEpicSessionWrapper>
    </QueryClientProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(openedByHost.has(HOST_A)).toBe(true);
    expect(openedByHost.has(HOST_B)).toBe(true);
  });
}

function deliverSnapshot(
  events: ReadonlyArray<EpicCommunicationGraphEvent>,
): void {
  deliverSnapshotFrom(HOST_A, events);
}

function deliverSnapshotFrom(
  hostId: string,
  events: ReadonlyArray<EpicCommunicationGraphEvent>,
): void {
  act(() => {
    openedByHost.get(hostId)?.onSnapshot(
      [...events],
      // Faithful default: the log's head at handoff is the snapshot's own
      // last row whenever the fixture is not exercising a capped snapshot.
      events.length === 0 ? null : Math.max(...events.map((e) => e.id)),
    );
  });
}

function deliverEventFrom(
  hostId: string,
  event: EpicCommunicationGraphEvent,
): void {
  act(() => {
    openedByHost.get(hostId)?.onEvent(event);
  });
}

/**
 * A message whose counterpart is NOT on this canvas. Both-endpoints-on-canvas
 * rows pulse their edge, and React Flow edges do not mount in jsdom - so the
 * boundary tests below, whose subject is arrival-vs-history rather than which
 * element lights up, use a half-edge whose node pulse is observable.
 */
function halfEdge(
  overrides: Partial<EpicCommunicationGraphEvent> & {
    readonly id: number;
    readonly timestamp: number;
  },
): EpicCommunicationGraphEvent {
  return message({ receiverAgentId: "agent-outside-this-epic", ...overrides });
}

/**
 * Jump-to-source lives on the receiver endpoint in a DETAIL row (the timeline
 * list went with the sidebar panel), so reaching it means opening an agent's
 * detail first.
 */
async function openAgentDetailJump(id: number): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId(`comm-graph-node-${CHAT_ID}`)).toBeDefined();
  });
  fireEvent.click(screen.getByTestId(`comm-graph-node-${CHAT_ID}`));
  fireEvent.click(
    await screen.findByTestId(`comm-graph-detail-${HOST_A}-${id}-receiver`),
  );
}

function pulsingOf(agentId: string): string | null {
  return screen
    .getByTestId(`comm-graph-node-${agentId}`)
    .getAttribute("data-pulsing");
}

/** The transport marker for a host-A row - one tick per captured event. */
function markerTestId(id: number): string {
  return `comm-graph-transport-marker-${HOST_A}:${id}`;
}

async function track(): Promise<HTMLElement> {
  return screen.findByTestId("comm-graph-transport-track");
}

/**
 * Seek to a zero-based position on the track through the REAL control path.
 * Pointer seeking needs a laid-out track, which jsdom does not have, so the
 * keyboard path is the one an integrated test can drive - and it is the same
 * seek the pointer performs.
 */
async function seekToIndex(index: number): Promise<void> {
  const element = await track();
  fireEvent.keyDown(element, { key: "Home" });
  for (let step = 0; step < index; step += 1) {
    fireEvent.keyDown(element, { key: "ArrowRight" });
  }
}

beforeEach(() => {
  openedByHost.clear();
  __resetCommGraphRegistryForTests();
  useCommGraphTimelineStore.setState({ stateByEpicId: {} });
  useCommGraphRowOpenStore.setState({ openRowKeysByEpicId: {} });
  tileNavigationMocks.openTileInEpic.mockClear();
  useChatTranscriptJumpStore.setState({ requestsByChatId: {} });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  harness.install(seedDoc, "owner");
  openRequests.length = 0;
  __setCommGraphSubscriptionOpenerForTests((request) => {
    openRequests.push(request);
    openedByHost.set(request.hostId, request.handlers);
    return { close: () => undefined };
  });
});

afterEach(() => {
  __setCommGraphSubscriptionOpenerForTests(null);
  __resetCommGraphRegistryForTests();
  useCommGraphTimelineStore.setState({ stateByEpicId: {} });
  harness.teardown();
  queryClient.clear();
  cleanup();
});

/**
 * Integrated: real epic projection, real canvas store, real timeline state -
 * only the stream boundary and Virtuoso's layout engine are faked.
 *
 * KNOWN jsdom GAP (unchanged from the tile ticket): React Flow mounts an edge
 * only once BOTH endpoint nodes have been measured, and jsdom reports every box
 * as 0x0 with a ResizeObserver that never fires, so edges never render here.
 * NOTHING drawn on an edge is covered below - not the traveling message, not the
 * open-thread dash, not the "awaiting reply" chip, and not the base stroke's
 * uniformity under activity. What IS covered is every DECISION those visuals
 * spend: `commGraphPulseForEvent` and `commGraphEdgeTravel` (direction, kind,
 * and declining to animate) plus `aggregateCommGraphEdges`'s open-thread
 * lifecycle, all unit-tested under `lib/comm-graph/__tests__/`. The rendering
 * itself belongs to the dev-app pass, and is stated as unverified rather than
 * implied to be green.
 *
 * That gap extends to REACHING an edge at all: `getEdgePosition` bails unless
 * both endpoints carry DOM-measured `handleBounds`, so `EdgeWrapper` renders no
 * <g> here - nothing to dispatch at, no tab stop to land on. Everything in
 * `commGraphEdgeInteraction` is therefore a dev-app check, unlike its
 * `onNodeClick` twin below, which a mounted node wrapper does let us pin.
 */
describe("CommGraphTile projection", () => {
  it("reveals an agent only once the cursor reaches its createdAt", async () => {
    await renderTile();
    deliverSnapshot([
      message({ id: 1, timestamp: 100 }),
      message({ id: 2, timestamp: LATE_CREATED_AT + 100 }),
    ]);

    await waitFor(() => {
      expect(
        screen.getByTestId(`comm-graph-node-${LATE_CHAT_ID}`),
      ).toBeDefined();
    });

    await seekToIndex(0);

    await waitFor(() => {
      expect(
        screen.queryByTestId(`comm-graph-node-${LATE_CHAT_ID}`),
      ).toBeNull();
    });
    // The agent that already existed is untouched.
    expect(screen.getByTestId(`comm-graph-node-${CHAT_ID}`)).toBeDefined();
  });

  it("pulses a row that ARRIVES while live, without flashing the initial snapshot", async () => {
    await renderTile();
    // The snapshot draws this host's initialization line; it is history this
    // client is learning, not activity. Flashing it would be "animate on event
    // frame" by another name.
    deliverSnapshot([message({ id: 1, timestamp: 100 })]);
    await waitFor(() => {
      expect(screen.getByTestId(markerTestId(1))).toBeDefined();
    });
    expect(pulsingOf(CHAT_ID)).toBe("false");

    deliverEventFrom(HOST_A, halfEdge({ id: 2, timestamp: 200 }));

    // Live mode holds no cursor row, so the pulse has to come from arrival.
    await waitFor(() => {
      expect(pulsingOf(CHAT_ID)).toBe("true");
    });
    expect(
      screen
        .getByTestId("comm-graph-transport-follow-live")
        .getAttribute("data-following"),
    ).toBe("true");
  });

  it("pulses the first live row of a FRESH epic, whose snapshot was empty", async () => {
    await renderTile();
    // An empty snapshot is a real boundary, not a missing one. Treating it as
    // "not initialized yet" would spend the epic's very first row on seeding,
    // so a brand-new epic would never pulse its opening move.
    deliverSnapshot([]);
    deliverSnapshotFrom(HOST_B, []);

    deliverEventFrom(HOST_A, halfEdge({ id: 1, timestamp: 100 }));

    await waitFor(() => {
      expect(pulsingOf(CHAT_ID)).toBe("true");
    });
  });

  it("does not pulse a second host's history that lands after the first host is live", async () => {
    await renderTile();
    deliverSnapshot([message({ id: 1, timestamp: 100 })]);
    await waitFor(() => {
      expect(screen.getByTestId(markerTestId(1))).toBeDefined();
    });

    // Host B hands over its whole history LATE, and its rows sort above
    // everything host A has. Against a single global mark this reads as a burst
    // of activity; against host B's OWN boundary it is exactly what it is.
    deliverSnapshotFrom(HOST_B, [
      message({
        id: 1,
        timestamp: 300,
        senderAgentId: TUI_B_ID,
        receiverAgentId: CHAT_ID,
      }),
      message({
        id: 2,
        timestamp: 400,
        senderAgentId: TUI_B_ID,
        receiverAgentId: CHAT_ID,
      }),
    ]);

    await waitFor(() => {
      expect(
        screen.getByTestId(`comm-graph-transport-marker-${HOST_B}:2`),
      ).toBeDefined();
    });
    expect(pulsingOf(TUI_B_ID)).toBe("false");
    expect(pulsingOf(CHAT_ID)).toBe("false");
  });

  it("pulses live rows from every host once each has its own boundary", async () => {
    await renderTile();
    deliverSnapshot([message({ id: 1, timestamp: 100 })]);
    deliverSnapshotFrom(HOST_B, [
      message({
        id: 1,
        timestamp: 300,
        senderAgentId: TUI_B_ID,
        receiverAgentId: CHAT_ID,
      }),
    ]);
    await waitFor(() => {
      expect(
        screen.getByTestId(`comm-graph-transport-marker-${HOST_B}:1`),
      ).toBeDefined();
    });

    deliverEventFrom(HOST_A, halfEdge({ id: 2, timestamp: 500 }));
    await waitFor(() => {
      expect(pulsingOf(CHAT_ID)).toBe("true");
    });

    deliverEventFrom(
      HOST_B,
      halfEdge({ id: 2, timestamp: 600, senderAgentId: TUI_B_ID }),
    );
    await waitFor(() => {
      expect(pulsingOf(TUI_B_ID)).toBe("true");
    });
  });

  it("pulses a host's backlog overflow, because it is above that host's boundary", async () => {
    await renderTile();
    deliverSnapshot([message({ id: 5, timestamp: 500 })]);
    await waitFor(() => {
      expect(screen.getByTestId(markerTestId(5))).toBeDefined();
    });

    // ACCEPTED CONSEQUENCE, pinned here so it is a decision and not a surprise.
    // The boundary is drawn at the snapshot handoff, so rows past the host's
    // snapshot ceiling - which continue as event frames - land above it and
    // pulse even though their timestamps are older. Only a >50k-row backlog
    // reaches this path, one pulse is held at a time and it decays, so the cost
    // is a brief flurry during the drain. Timestamp-based suppression was the
    // alternative and it is what made the boundary global, which was wrong in
    // both directions.
    deliverEventFrom(HOST_A, halfEdge({ id: 6, timestamp: 50 }));

    expect(await screen.findByTestId(markerTestId(6))).toBeDefined();
    await waitFor(() => {
      expect(pulsingOf(CHAT_ID)).toBe("true");
    });
  });

  it("pulses an arriving A2A row on the endpoint that is on the canvas", async () => {
    await renderTile();
    deliverSnapshot([message({ id: 1, timestamp: 100 })]);
    await waitFor(() => {
      expect(screen.getByTestId(markerTestId(1))).toBeDefined();
    });

    act(() => {
      // Half-edge: the receiver is not an agent this epic projects, so there is
      // no drawable edge - the visible endpoint pulses instead.
      openedByHost.get(HOST_A)?.onEvent(
        message({
          id: 2,
          timestamp: 200,
          senderAgentId: TUI_ID,
          receiverAgentId: "outside-agent",
        }),
      );
    });

    await waitFor(() => {
      expect(
        screen
          .getByTestId(`comm-graph-node-${TUI_ID}`)
          .getAttribute("data-pulsing"),
      ).toBe("true");
    });
  });

  it("jumps a gui_block row to its chat and parks a transcript scroll", async () => {
    await renderTile();
    deliverSnapshot([
      // Capture-faithful shape: a message's origin lives in the RECEIVER's
      // chat, so the receiving agent here must be the GUI chat.
      message({
        id: 1,
        timestamp: 100,
        senderAgentId: TUI_ID,
        receiverAgentId: CHAT_ID,
        originKind: "gui_block",
        originChatId: CHAT_ID,
        originRefId: "block-9",
      }),
    ]);

    await openAgentDetailJump(1);

    expect(tileNavigationMocks.openTileInEpic).toHaveBeenCalledWith(
      EPIC_ID,
      expect.objectContaining({ id: CHAT_ID, type: "chat", hostId: HOST_A }),
    );
    expect(
      useChatTranscriptJumpStore.getState().requestsByChatId[CHAT_ID]?.target,
    ).toEqual({ kind: "block", blockId: "block-9" });
  });

  it("jumps a gui_message row to the RECEIVER's transcript", async () => {
    await renderTile();
    deliverSnapshot([
      // Capture-faithful shape: receiver-side origin, so the receiver is the
      // GUI chat the anchor lives in.
      message({
        id: 1,
        timestamp: 100,
        senderAgentId: TUI_ID,
        receiverAgentId: CHAT_ID,
        originKind: "gui_message",
        originChatId: CHAT_ID,
        originRefId: "message-3",
      }),
    ]);

    await openAgentDetailJump(1);

    expect(
      useChatTranscriptJumpStore.getState().requestsByChatId[CHAT_ID]?.target,
    ).toEqual({ kind: "message", messageId: "message-3" });
  });

  it("parks a sender-side sent-message jump from the SENDER name", async () => {
    await renderTile();
    deliverSnapshot([
      // Origin-less message: the receiver side has nothing to scroll to, but
      // the SENDER is a projected GUI chat, so its own "Sent message" card is
      // resolvable at jump time - receiver + verbatim text + capture clock.
      message({ id: 1, timestamp: 100, messageText: "review this" }),
    ]);

    await waitFor(() => {
      expect(screen.getByTestId(`comm-graph-node-${CHAT_ID}`)).toBeDefined();
    });
    fireEvent.click(screen.getByTestId(`comm-graph-node-${CHAT_ID}`));
    fireEvent.click(
      await screen.findByTestId(`comm-graph-detail-${HOST_A}-1-sender`),
    );

    expect(tileNavigationMocks.openTileInEpic).toHaveBeenCalledWith(
      EPIC_ID,
      expect.objectContaining({ id: CHAT_ID, type: "chat", hostId: HOST_A }),
    );
    expect(
      useChatTranscriptJumpStore.getState().requestsByChatId[CHAT_ID]?.target,
    ).toEqual({
      kind: "sent-message",
      receiverAgentId: TUI_ID,
      messageText: "review this",
      timestamp: 100,
    });
  });

  it("parks a first-message jump from a Created row's GUI child", async () => {
    await renderTile();
    deliverSnapshot([
      message({
        id: 1,
        timestamp: 100,
        kind: "agent_created",
        senderAgentId: TUI_ID,
        receiverAgentId: CHAT_ID,
        responseId: null,
        expectReply: null,
        messageText: null,
      }),
    ]);

    await waitFor(() => {
      expect(screen.getByTestId(`comm-graph-node-${CHAT_ID}`)).toBeDefined();
    });
    fireEvent.click(screen.getByTestId(`comm-graph-node-${CHAT_ID}`));
    fireEvent.click(
      await screen.findByTestId(`comm-graph-detail-${HOST_A}-1-receiver`),
    );

    expect(tileNavigationMocks.openTileInEpic).toHaveBeenCalledWith(
      EPIC_ID,
      expect.objectContaining({ id: CHAT_ID, type: "chat", hostId: HOST_A }),
    );
    expect(
      useChatTranscriptJumpStore.getState().requestsByChatId[CHAT_ID]?.target,
    ).toEqual({ kind: "first-message" });
  });

  it("opens a Notice row's idle GUI agent with NO parked jump", async () => {
    await renderTile();
    deliverSnapshot([
      // The CHAT went idle on a thread the TUI agent was awaiting: displayed
      // direction reverses, so the idle chat is the arrow's sender.
      message({
        id: 1,
        timestamp: 100,
        kind: "a2a_notice",
        senderAgentId: TUI_ID,
        receiverAgentId: CHAT_ID,
        noticeReason: "turn-ended",
        messageText: null,
      }),
    ]);

    await waitFor(() => {
      expect(screen.getByTestId(`comm-graph-node-${CHAT_ID}`)).toBeDefined();
    });
    fireEvent.click(screen.getByTestId(`comm-graph-node-${CHAT_ID}`));
    fireEvent.click(
      await screen.findByTestId(`comm-graph-detail-${HOST_A}-1-sender`),
    );

    // The tile opens - and that is ALL. The idle agent never wrote this
    // notice, so there is no anchor in its transcript to park a jump on.
    expect(tileNavigationMocks.openTileInEpic).toHaveBeenCalledWith(
      EPIC_ID,
      expect.objectContaining({ id: CHAT_ID, type: "chat", hostId: HOST_A }),
    );
    expect(
      useChatTranscriptJumpStore.getState().requestsByChatId[CHAT_ID],
    ).toBeUndefined();
  });

  it("jumps an anchored notice to the WAITING SENDER's transcript", async () => {
    await renderTile();
    deliverSnapshot([
      message({
        id: 1,
        timestamp: 100,
        kind: "a2a_notice",
        noticeReason: "turn-ended",
        // Sender-side anchor: the notice was delivered into the waiting
        // sender's chat (the host pre-mints this id at the notice tail).
        originKind: "gui_message",
        originChatId: CHAT_ID,
        originRefId: "agent-msg-notice-7",
      }),
    ]);

    // The anchored endpoint is the arrow's receiver - which for a reversed
    // notice is the DB sender's chat.
    await openAgentDetailJump(1);

    expect(tileNavigationMocks.openTileInEpic).toHaveBeenCalledWith(
      EPIC_ID,
      expect.objectContaining({ id: CHAT_ID, type: "chat", hostId: HOST_A }),
    );
    expect(
      useChatTranscriptJumpStore.getState().requestsByChatId[CHAT_ID]?.target,
    ).toEqual({ kind: "message", messageId: "agent-msg-notice-7" });
  });

  it("opens the terminal agent for a tui_session row, with no transcript scroll", async () => {
    await renderTile();
    deliverSnapshot([
      message({
        id: 1,
        timestamp: 100,
        originKind: "tui_session",
        originChatId: TUI_ID,
        originRefId: "harness-session-1",
      }),
    ]);

    await openAgentDetailJump(1);

    expect(tileNavigationMocks.openTileInEpic).toHaveBeenCalledWith(
      EPIC_ID,
      expect.objectContaining({ id: TUI_ID, type: "terminal-agent" }),
    );
    expect(useChatTranscriptJumpStore.getState().requestsByChatId).toEqual({});
  });

  it("opens the owning agent with no scroll and no error when origin is null", async () => {
    await renderTile();
    deliverSnapshot([
      // A row the capture path could not anchor: legitimately origin-less.
      message({
        id: 1,
        timestamp: 100,
        originKind: null,
      }),
    ]);

    await openAgentDetailJump(1);

    // No anchor to scroll to, so the jump degrades to the row's owning agent -
    // the RECEIVER, which is where the origin ref would have pointed.
    expect(tileNavigationMocks.openTileInEpic).toHaveBeenCalledWith(
      EPIC_ID,
      expect.objectContaining({ id: TUI_ID, type: "terminal-agent" }),
    );
    expect(useChatTranscriptJumpStore.getState().requestsByChatId).toEqual({});
  });

  it("offers no jump for a row whose agent this epic does not project", async () => {
    await renderTile();
    deliverSnapshot([
      message({
        id: 1,
        timestamp: 100,
        senderAgentId: "outside-a",
        receiverAgentId: "outside-b",
      }),
    ]);

    expect(await screen.findByTestId(markerTestId(1))).toBeDefined();
    expect(
      screen.queryByTestId(`comm-graph-timeline-jump-${HOST_A}-1`),
    ).toBeNull();
  });
});

/**
 * The panel and the tile are independently mounted surfaces over ONE cursor and
 * ONE subscription. These are the tests that hold that seam.
 */
describe("comm-graph subscription sharing", () => {
  it("opens exactly one subscription per host the epic reaches", async () => {
    await renderTile();

    // One claim, one manager, one dial per host.
    expect(__commGraphSubscriptionRefCountForTests(EPIC_ID)).toBe(1);
    expect(
      openRequests.filter((request) => request.hostId === HOST_A),
    ).toHaveLength(1);
    expect(
      openRequests.filter((request) => request.hostId === HOST_B),
    ).toHaveLength(1);
  });

  it("holds the cursor across a surface unmounting and coming back", async () => {
    await renderTile();
    deliverSnapshot([
      message({ id: 1, timestamp: 100 }),
      message({ id: 2, timestamp: 200 }),
    ]);
    // Scrub back one row, so there is a held cursor to lose.
    await waitFor(() => {
      expect(screen.getByTestId("comm-graph-transport-track")).toBeDefined();
    });
    fireEvent.keyDown(screen.getByTestId("comm-graph-transport-track"), {
      key: "ArrowLeft",
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("comm-graph-transport-track").dataset.following,
      ).toBe("false");
    });

    // The surface goes away: the refcount drops to zero and the manager
    // DETACHES (keeping events, cursors and per-host boundaries) rather than
    // being disposed.
    cleanup();
    expect(__commGraphSubscriptionRefCountForTests(EPIC_ID)).toBe(0);

    await renderTile();

    // Still detached at the same place - neither the store nor the log started
    // over just because the tile was closed.
    await waitFor(() => {
      expect(
        screen.getByTestId("comm-graph-transport-track").dataset.following,
      ).toBe("false");
    });
  });
});

/**
 * The canvas has ONE detail surface, reachable two ways: clicking a pair edge,
 * and clicking an agent node. Edges do not mount in jsdom (see the file header),
 * so the pair route is covered where it lives - `comm-graph-thread-panel.test`.
 */
describe("comm-graph agent detail", () => {
  it("opens an agent's activity when its node is clicked", async () => {
    await renderTile();
    deliverSnapshot([
      message({ id: 1, timestamp: 100 }),
      message({ id: 2, timestamp: 200 }),
      // Someone else's exchange - must not appear in this agent's activity.
      message({
        id: 3,
        timestamp: 300,
        senderAgentId: TUI_B_ID,
        receiverAgentId: TUI_ID,
      }),
    ]);
    await waitFor(() => {
      expect(screen.getByTestId(`comm-graph-node-${CHAT_ID}`)).toBeDefined();
    });

    fireEvent.click(screen.getByTestId(`comm-graph-node-${CHAT_ID}`));

    // Everything captured that this agent took part in - its write and the
    // message it sent - and nothing that it did not.
    expect(await screen.findByTestId("comm-graph-agent-panel")).toBeDefined();
    expect(
      screen.getByTestId(`comm-graph-detail-row-${HOST_A}-1`),
    ).toBeDefined();
    expect(
      screen.getByTestId(`comm-graph-detail-row-${HOST_A}-2`),
    ).toBeDefined();
    expect(
      screen.queryByTestId(`comm-graph-detail-row-${HOST_A}-3`),
    ).toBeNull();
  });

  it("keeps one detail surface: opening an agent replaces the previous one", async () => {
    await renderTile();
    deliverSnapshot([message({ id: 1, timestamp: 100 })]);
    await waitFor(() => {
      expect(screen.getByTestId(`comm-graph-node-${CHAT_ID}`)).toBeDefined();
    });

    fireEvent.click(screen.getByTestId(`comm-graph-node-${CHAT_ID}`));
    await screen.findByTestId("comm-graph-agent-panel");
    fireEvent.click(screen.getByTestId(`comm-graph-node-${TUI_ID}`));

    // Still exactly one panel, now showing the other agent.
    expect(screen.getAllByTestId("comm-graph-agent-panel")).toHaveLength(1);
    expect(screen.queryByTestId("comm-graph-thread-panel")).toBeNull();
  });

  it("opens the agent's own tile from the detail header", async () => {
    await renderTile();
    deliverSnapshot([message({ id: 1, timestamp: 100 })]);
    await waitFor(() => {
      expect(screen.getByTestId(`comm-graph-node-${TUI_ID}`)).toBeDefined();
    });
    fireEvent.click(screen.getByTestId(`comm-graph-node-${TUI_ID}`));

    fireEvent.click(await screen.findByTestId("comm-graph-agent-panel-open"));

    expect(tileNavigationMocks.openTileInEpic).toHaveBeenCalledWith(
      EPIC_ID,
      expect.objectContaining({ id: TUI_ID, type: "terminal-agent" }),
    );
  });

  it("renders message bodies as markdown in the detail, not raw text", async () => {
    await renderTile();
    deliverSnapshot([
      message({
        id: 1,
        timestamp: 100,
        messageText: "## Heading\n\nsome **bold** text",
      }),
    ]);
    await waitFor(() => {
      expect(screen.getByTestId(`comm-graph-node-${CHAT_ID}`)).toBeDefined();
    });

    fireEvent.click(screen.getByTestId(`comm-graph-node-${CHAT_ID}`));

    // Multi-block, so it starts collapsed - expand before reading the body.
    fireEvent.click(
      await screen.findByTestId(`comm-graph-detail-toggle-${HOST_A}-1`),
    );

    // Through the same renderer the chat's A2A cards use: the `##` becomes a
    // heading element rather than literal text on screen.
    const body = await screen.findByTestId(
      `comm-graph-detail-body-${HOST_A}-1`,
    );
    expect(body.querySelector("h2")).not.toBeNull();
    expect(body.querySelector("strong")).not.toBeNull();
    expect(body.textContent).not.toContain("## Heading");
  });

  /**
   * INVERTED. This previously asserted the snippet was the literal source
   * (`## Heading`) and called it "plain", which codified the bug: a reader
   * scanning the timeline was shown markdown syntax, and the markers ate a
   * budget already only one line wide.
   *
   * "Plain" means PROSE, not source. The timeline still renders no markdown -
   * no element comes out of it - but the text it shows is the projection.
   */
  /**
   * The lexer keeps character references encoded, so before this the snippet
   * read `R&amp;D` while expanding the same row in the detail panel read `R&D`.
   */
  it("shows projected prose in the collapsed detail preview too", async () => {
    await renderTile();
    deliverSnapshot([
      message({
        id: 1,
        timestamp: 100,
        messageText: `## Report\n\n${"detail ".repeat(60)}`,
      }),
    ]);
    await waitFor(() => {
      expect(screen.getByTestId(`comm-graph-node-${CHAT_ID}`)).toBeDefined();
    });
    fireEvent.click(screen.getByTestId(`comm-graph-node-${CHAT_ID}`));

    const preview = await screen.findByTestId(
      `comm-graph-detail-preview-${HOST_A}-1`,
    );
    expect(preview.textContent).toContain("Report");
    expect(preview.textContent).not.toContain("#");

    // Expanding still yields real markdown - the projection is preview-only.
    fireEvent.click(screen.getByTestId(`comm-graph-detail-toggle-${HOST_A}-1`));
    const body = await screen.findByTestId(
      `comm-graph-detail-body-${HOST_A}-1`,
    );
    expect(body.querySelector("h2")).not.toBeNull();
  });

  /**
   * The node's own <button> is NOT the path a real browser takes. React Flow
   * writes `pointerEvents: 'none'` onto `.react-flow__node` unless the node is
   * selectable, draggable, or the canvas passes `onNodeClick` - and this canvas
   * deliberately turns the first two off. jsdom ignores CSS pointer-events, so
   * clicking the inner button passes either way and proved nothing.
   *
   * So this clicks React Flow's OWN node wrapper (`rf__node-<id>`, its testid).
   * A click dispatched at the wrapper does not reach the descendant button, so
   * the only handler that can run is React Flow's, which is exactly the path the
   * browser uses.
   */
  it("opens the agent detail through React Flow's onNodeClick, not the inner button", async () => {
    await renderTile();
    deliverSnapshot([message({ id: 1, timestamp: 100 })]);
    await waitFor(() => {
      expect(screen.getByTestId(`rf__node-${CHAT_ID}`)).toBeDefined();
    });

    const wrapper = screen.getByTestId(`rf__node-${CHAT_ID}`);
    // Guard the mechanism itself: if this ever renders pointer-inert again, the
    // click below would be dead in a browser even though jsdom still dispatches
    // it. React Flow only sets an inline `pointer-events` when it wants none.
    expect(wrapper.style.pointerEvents).not.toBe("none");

    fireEvent.click(wrapper);

    expect(await screen.findByTestId("comm-graph-agent-panel")).toBeDefined();
  });

  /**
   * The wrapper must be pointer-live but NOT focusable. React Flow gives it
   * `tabIndex=0` whenever `nodesFocusable` is on, and its keydown handler only
   * drives React Flow's own selection - which `elementsSelectable={false}` rules
   * out. That is a tab stop that does nothing, in front of the real button, on
   * every agent. The two properties are independent (`hasPointerEvents` keys off
   * `onClick`, focusability off `isFocusable`), so both are asserted here.
   */
  it("leaves no dead tab stop on the node wrapper", async () => {
    await renderTile();
    deliverSnapshot([message({ id: 1, timestamp: 100 })]);
    await waitFor(() => {
      expect(screen.getByTestId(`rf__node-${CHAT_ID}`)).toBeDefined();
    });

    const wrapper = screen.getByTestId(`rf__node-${CHAT_ID}`);
    expect(wrapper.getAttribute("tabindex")).toBeNull();
    // Still clickable - turning focus off must not have taken pointers with it.
    expect(wrapper.style.pointerEvents).not.toBe("none");

    // The node's own button remains the one real focus target.
    const button = screen.getByTestId(`comm-graph-node-${CHAT_ID}`);
    expect(button.tagName).toBe("BUTTON");
    expect(wrapper.contains(button)).toBe(true);
  });
});

/**
 * A detail panel lists RAW bodies, and an agent's real message is regularly a
 * full report. Long bodies collapse; short ones must not grow a chevron that
 * reveals nothing.
 */
describe("comm-graph detail row collapsing", () => {
  const LONG_BODY = `# Architecture report\n\n${"detail ".repeat(60)}`;

  async function openAgentDetail(): Promise<void> {
    await waitFor(() => {
      expect(screen.getByTestId(`comm-graph-node-${CHAT_ID}`)).toBeDefined();
    });
    fireEvent.click(screen.getByTestId(`comm-graph-node-${CHAT_ID}`));
    await screen.findByTestId("comm-graph-agent-panel");
  }

  it("collapses a long body to a preview and expands it on demand", async () => {
    await renderTile();
    deliverSnapshot([
      message({ id: 1, timestamp: 100, messageText: LONG_BODY }),
    ]);
    await openAgentDetail();

    // Collapsed: a clamped single-line preview stands in, and the rendered
    // markdown body is not mounted at all.
    const preview = screen.getByTestId(`comm-graph-detail-preview-${HOST_A}-1`);
    expect(preview.textContent).toContain("Architecture report");
    expect(preview.textContent.length).toBeLessThan(200);
    expect(
      screen.queryByTestId(`comm-graph-detail-body-${HOST_A}-1`),
    ).toBeNull();

    fireEvent.click(screen.getByTestId(`comm-graph-detail-toggle-${HOST_A}-1`));

    const body = await screen.findByTestId(
      `comm-graph-detail-body-${HOST_A}-1`,
    );
    expect(body.querySelector("h1")).not.toBeNull();
    expect(
      screen.queryByTestId(`comm-graph-detail-preview-${HOST_A}-1`),
    ).toBeNull();
  });

  /**
   * ONE row species: a short row uses the same preview treatment as a long one,
   * it just has no chevron. Rendering short bodies straight into the framed
   * markdown made a mixed list read as two different kinds of object.
   */
  it("shows a short body in the same preview treatment, with no toggle", async () => {
    await renderTile();
    deliverSnapshot([
      message({ id: 1, timestamp: 100, messageText: "ack, on it" }),
    ]);
    await openAgentDetail();

    const row = screen.getByTestId(`comm-graph-detail-row-${HOST_A}-1`);
    expect(row.dataset.collapsible).toBe("false");
    expect(
      screen.queryByTestId(`comm-graph-detail-toggle-${HOST_A}-1`),
    ).toBeNull();
    // Same preview element a long row shows, and NOT the framed markdown body.
    expect(
      screen.getByTestId(`comm-graph-detail-preview-${HOST_A}-1`).textContent,
    ).toContain("ack, on it");
    expect(
      screen.queryByTestId(`comm-graph-detail-body-${HOST_A}-1`),
    ).toBeNull();
  });

  it("gives a notice the same preview treatment, not a full frame", async () => {
    await renderTile();
    deliverSnapshot([
      message({
        id: 1,
        timestamp: 100,
        kind: "a2a_notice",
        noticeReason: "turn-ended",
        messageText: "receiver went idle",
      }),
    ]);
    await openAgentDetail();

    expect(
      screen.getByTestId(`comm-graph-detail-preview-${HOST_A}-1`),
    ).toBeDefined();
    expect(
      screen.queryByTestId(`comm-graph-detail-body-${HOST_A}-1`),
    ).toBeNull();
    // Identity still travels - via the amber kind chip in the header.
    expect(
      screen.getByTestId(`comm-graph-detail-kind-${HOST_A}-1`).textContent,
    ).toBe("Notice");
  });

  /**
   * The open set is keyed by `hostId:id`, not by list position, precisely so a
   * row that moves as new rows sort in keeps its own expansion.
   *
   * The insertion has to come from the OTHER host to be honest: ids are
   * monotonic per host, so host A can never emit a row that sorts behind one it
   * already sent. Interleaving across hosts is the real way a row lands
   * mid-array.
   */
  it("keeps a row expanded when a row from another host sorts in ahead of it", async () => {
    await renderTile();
    deliverSnapshot([
      message({ id: 2, timestamp: 200, messageText: LONG_BODY }),
    ]);
    await openAgentDetail();

    fireEvent.click(screen.getByTestId(`comm-graph-detail-toggle-${HOST_A}-2`));
    await screen.findByTestId(`comm-graph-detail-body-${HOST_A}-2`);

    // Earlier timestamp, different host: sorts AHEAD of the open row and pushes
    // it down a slot.
    deliverEventFrom(
      HOST_B,
      message({ id: 1, timestamp: 100, messageText: LONG_BODY }),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId(`comm-graph-detail-row-${HOST_B}-1`),
      ).toBeDefined();
    });
    // Still open, and the newcomer is still collapsed - the state followed the
    // row, not the slot.
    expect(
      screen.getByTestId(`comm-graph-detail-body-${HOST_A}-2`),
    ).toBeDefined();
    expect(
      screen.queryByTestId(`comm-graph-detail-body-${HOST_B}-1`),
    ).toBeNull();
  });

  it("pins the heading while the body scrolls", async () => {
    await renderTile();
    deliverSnapshot([
      message({ id: 1, timestamp: 100, messageText: LONG_BODY }),
    ]);
    await openAgentDetail();

    // jsdom cannot lay out `position: sticky`, so assert the contract the CSS
    // rests on: the heading is sticky to the top of the panel's scroller, and
    // it is opaque so the body cannot bleed through it.
    const toggle = screen.getByTestId(`comm-graph-detail-toggle-${HOST_A}-1`);
    const heading = toggle.parentElement;
    expect(heading?.className).toContain("sticky");
    expect(heading?.className).toContain("top-0");
    expect(heading?.className).toContain("bg-background");
  });
});

/**
 * The transport owns the cursor now, so these drive the REAL controls against
 * the real per-epic store. Pointer seeking needs a laid-out track, which jsdom
 * does not provide - the keyboard path is the same seek and is drivable here;
 * the pixel→fraction math is unit-tested in `lib/comm-graph/comm-graph-transport`.
 */
describe("comm-graph transport", () => {
  async function renderWithEvents(count: number): Promise<void> {
    await renderTile();
    deliverSnapshot(
      Array.from({ length: count }, (_unused, index) =>
        message({ id: index + 1, timestamp: (index + 1) * 100 }),
      ),
    );
    await waitFor(() => {
      expect(screen.getByTestId("comm-graph-transport-track")).toBeDefined();
    });
  }

  function following(): string | undefined {
    return screen.getByTestId("comm-graph-transport-track").dataset.following;
  }

  it("renders one marker per captured event", async () => {
    await renderWithEvents(3);
    await waitFor(() => {
      expect(screen.getByTestId(markerTestId(3))).toBeDefined();
    });
    expect(screen.getByTestId(markerTestId(1))).toBeDefined();
    expect(screen.getByTestId(markerTestId(2))).toBeDefined();
  });

  it("starts live with the playhead at the right edge", async () => {
    await renderWithEvents(3);
    expect(following()).toBe("true");
    expect(screen.getByTestId("comm-graph-transport-playhead").style.left).toBe(
      "100%",
    );
  });

  it("detaches when scrubbed back, exactly like the old scroller detach", async () => {
    await renderWithEvents(3);
    fireEvent.keyDown(screen.getByTestId("comm-graph-transport-track"), {
      key: "ArrowLeft",
    });
    await waitFor(() => {
      expect(following()).toBe("false");
    });
  });

  it("re-attaches to live when scrubbed back to the end", async () => {
    await renderWithEvents(3);
    const track = screen.getByTestId("comm-graph-transport-track");
    fireEvent.keyDown(track, { key: "Home" });
    await waitFor(() => {
      expect(following()).toBe("false");
    });

    fireEvent.keyDown(track, { key: "End" });
    await waitFor(() => {
      expect(following()).toBe("true");
    });
  });

  it("narrows the canvas to the as-of prefix when scrubbed back", async () => {
    await renderTile();
    deliverSnapshot([
      message({ id: 1, timestamp: 100 }),
      message({ id: 2, timestamp: LATE_CREATED_AT + 100 }),
    ]);
    await waitFor(() => {
      expect(
        screen.getByTestId(`comm-graph-node-${LATE_CHAT_ID}`),
      ).toBeDefined();
    });

    fireEvent.keyDown(await screen.findByTestId("comm-graph-transport-track"), {
      key: "Home",
    });

    // The graph really is projected as of the playhead, not merely labelled.
    await waitFor(() => {
      expect(
        screen.queryByTestId(`comm-graph-node-${LATE_CHAT_ID}`),
      ).toBeNull();
    });
  });

  it("holds the cursor and flips to pause when playback starts from live", async () => {
    await renderWithEvents(3);
    fireEvent.click(screen.getByTestId("comm-graph-transport-play"));

    // Play from live replays from the beginning, so it detaches immediately.
    await waitFor(() => {
      expect(following()).toBe("false");
    });
    expect(
      screen
        .getByTestId("comm-graph-transport-play")
        .getAttribute("aria-label"),
    ).toBe("Pause playback");
  });

  it("cycles playback speed", async () => {
    await renderWithEvents(2);
    const speed = screen.getByTestId("comm-graph-transport-speed");
    expect(speed.textContent).toBe("1×");
    fireEvent.click(speed);
    await waitFor(() => {
      expect(screen.getByTestId("comm-graph-transport-speed").textContent).toBe(
        "2×",
      );
    });
  });

  it("offers no play control for an epic with nothing captured", async () => {
    await renderTile();
    deliverSnapshot([]);
    deliverSnapshotFrom(HOST_B, []);
    await waitFor(() => {
      expect(screen.getByTestId("comm-graph-transport-track")).toBeDefined();
    });
    // Honest rather than inert-looking: there is nothing to play through.
    expect(
      screen.getByTestId("comm-graph-transport-play").hasAttribute("disabled"),
    ).toBe(true);
  });

  /**
   * An empty epic has no positions to be at, so it must not expose a focusable
   * slider at all - one declaring `min=0 max=0 valuenow=-1` would sit in the tab
   * order announcing a value outside its own range and go nowhere when driven.
   */
  it("exposes no focusable out-of-range slider when nothing is captured", async () => {
    await renderTile();
    deliverSnapshot([]);
    deliverSnapshotFrom(HOST_B, []);
    const element = await screen.findByTestId("comm-graph-transport-track");

    expect(element.dataset.empty).toBe("true");
    expect(element.getAttribute("role")).toBeNull();
    expect(element.getAttribute("tabindex")).toBeNull();
    expect(element.getAttribute("aria-valuenow")).toBeNull();
    expect(element.getAttribute("aria-valuemax")).toBeNull();
    expect(element.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("slider")).toBeNull();
    // No playhead either - there is no position for it to mark.
    expect(screen.queryByTestId("comm-graph-transport-playhead")).toBeNull();
  });

  it("restores the slider once the epic captures something", async () => {
    await renderWithEvents(2);
    const element = screen.getByTestId("comm-graph-transport-track");
    expect(element.dataset.empty).toBe("false");
    expect(element.getAttribute("role")).toBe("slider");
    // In range, both ends inclusive: live sits on the last index.
    expect(element.getAttribute("aria-valuemin")).toBe("0");
    expect(element.getAttribute("aria-valuemax")).toBe("1");
    expect(element.getAttribute("aria-valuenow")).toBe("1");
  });

  it("keeps a detached playhead put when a newer row arrives", async () => {
    await renderWithEvents(3);
    fireEvent.keyDown(screen.getByTestId("comm-graph-transport-track"), {
      key: "Home",
    });
    await waitFor(() => {
      expect(following()).toBe("false");
    });

    deliverEventFrom(HOST_A, message({ id: 4, timestamp: 400 }));

    // A new row extends the track; it must not drag the reader forward.
    await waitFor(() => {
      expect(screen.getByTestId(markerTestId(4))).toBeDefined();
    });
    expect(following()).toBe("false");
  });
});
