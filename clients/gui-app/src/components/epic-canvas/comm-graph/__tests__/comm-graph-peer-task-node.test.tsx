/**
 * The peer-task stand-in node: drawn on the canvas for a cross-task message's
 * foreign endpoint (see `commGraphPeerTaskStubs`), and its own rendering as a
 * `CommGraphAgentNodeView` variant.
 *
 * Split from `comm-graph-viewport.test.tsx` because the node-level cases need
 * a different mock set (`@tanstack/react-router`, `@/lib/epic-selectors`,
 * `@/lib/tab-navigation`) than the canvas-level ones need.
 */
const reactFlowMock = vi.hoisted(() => vi.fn((_props: unknown) => null));
const registerFindAdapterMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const navigateToTabIntentMock = vi.hoisted(() => vi.fn());
const openOrFocusEpicIntentMock = vi.hoisted(() =>
  vi.fn((input: { readonly epicId: string; readonly focus: undefined }) => ({
    kind: "open-epic" as const,
    ...input,
  })),
);
const useRegisteredEpicTitleMock = vi.hoisted(() =>
  vi.fn((): string | null => null),
);

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, ReactFlow: reactFlowMock };
});

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: "light" as const,
    themePreset: "default",
  }),
}));

vi.mock("@/components/epic-canvas/tile-find/tile-find-adapter-context", () => ({
  useRegisterTileFindAdapter: registerFindAdapterMock,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicAgentActivityTiers: () => new Map(),
  useRegisteredEpicTitle: useRegisteredEpicTitleMock,
  useEpicAgentRoleClaims: () => [],
  useEpicNodeHostId: () => null,
  useEpicNodeOwnerKind: () => null,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: navigateToTabIntentMock,
  openOrFocusEpicIntent: openOrFocusEpicIntentMock,
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { CommGraphCanvas } from "@/components/epic-canvas/comm-graph/comm-graph-canvas";
import {
  COMM_GRAPH_AGENT_NODE_TYPE,
  CommGraphAgentNodeView,
  type CommGraphAgentFlowNode,
  type CommGraphPeerTaskNodeData,
} from "@/components/epic-canvas/comm-graph/comm-graph-agent-node";
import type { CommGraphFlowEdge } from "@/components/epic-canvas/comm-graph/comm-graph-edge";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { DEFAULT_COMM_GRAPH_VIEW } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";

const AGENT: CommGraphAgentNode = {
  id: "agent-1",
  kind: "chat",
  name: "Agent",
  hostId: "host-1",
  parentId: null,
  harnessId: null,
  model: null,
  archived: false,
  archivedAt: null,
  createdAt: 1,
};

const PEER_EPIC_ID = "epic-peer-123456789";
const FOREIGN_SENDER_ID = "foreign-agent-1";

function event(overrides: Partial<CommGraphEvent>): CommGraphEvent {
  return {
    id: 1,
    timestamp: 10,
    hostId: "host-1",
    kind: "a2a_message",
    senderAgentId: AGENT.id,
    receiverAgentId: AGENT.id,
    responseId: null,
    inReplyTo: null,
    expectReply: false,
    messageText: "hi",
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    peerEpicId: null,
    ...overrides,
  };
}

const CROSS_TASK_EVENT = event({
  id: 1,
  timestamp: 10,
  senderAgentId: FOREIGN_SENDER_ID,
  receiverAgentId: AGENT.id,
  peerEpicId: PEER_EPIC_ID,
});

const SAME_TASK_EVENT = event({
  id: 2,
  timestamp: 20,
  senderAgentId: AGENT.id,
  receiverAgentId: AGENT.id,
  peerEpicId: null,
});

function latestReactFlowProps(): {
  readonly nodes: ReadonlyArray<CommGraphAgentFlowNode>;
  readonly edges: ReadonlyArray<CommGraphFlowEdge>;
} {
  const props = reactFlowMock.mock.lastCall?.[0];
  if (typeof props !== "object" || props === null) {
    throw new Error("ReactFlow was not rendered");
  }
  return props as {
    readonly nodes: ReadonlyArray<CommGraphAgentFlowNode>;
    readonly edges: ReadonlyArray<CommGraphFlowEdge>;
  };
}

afterEach(() => {
  cleanup();
  reactFlowMock.mockClear();
  registerFindAdapterMock.mockClear();
  useRegisteredEpicTitleMock.mockReset();
  useRegisteredEpicTitleMock.mockReturnValue(null);
  navigateToTabIntentMock.mockClear();
  openOrFocusEpicIntentMock.mockClear();
  vi.restoreAllMocks();
});

describe("CommGraphCanvas peer-task stand-in", () => {
  it("draws a stand-in node and an edge for a cross-task row's foreign endpoint", () => {
    render(
      <CommGraphCanvas
        epicId="epic-1"
        tileInstanceId="comm-graph-instance-1"
        agents={[AGENT]}
        agentIds={new Set([AGENT.id])}
        events={[CROSS_TASK_EVENT, SAME_TASK_EVENT]}
        hosts={[]}
        initialHistoryCaughtUp={false}
        playing={false}
        pulse={null}
        pulseKey={null}
        modeToggle={null}
        view={DEFAULT_COMM_GRAPH_VIEW}
        onCameraChange={vi.fn()}
        canOpenAgentForEvent={() => true}
        canJump={() => false}
        onJump={vi.fn()}
        canJumpToSender={() => false}
        onJumpToSender={vi.fn()}
        canJumpToCreated={() => false}
        onJumpToCreated={vi.fn()}
        onOpenAgent={vi.fn()}
      />,
    );

    const { nodes, edges } = latestReactFlowProps();
    const stub = nodes.find((node) => node.id === FOREIGN_SENDER_ID);
    if (stub === undefined) {
      throw new Error("Expected a peer-task stand-in node");
    }
    expect(stub.data).toEqual(
      expect.objectContaining({
        variant: "peer-task",
        peerEpicId: PEER_EPIC_ID,
        name: "Task epic-pee",
      }),
    );

    const stubEdge = edges.find(
      (edge) =>
        new Set([edge.source, edge.target]).size === 2 &&
        [edge.source, edge.target].includes(FOREIGN_SENDER_ID) &&
        [edge.source, edge.target].includes(AGENT.id),
    );
    expect(stubEdge).toBeDefined();
  });
});

function peerTaskNodeProps(
  data: CommGraphPeerTaskNodeData,
): NodeProps<CommGraphAgentFlowNode> {
  return {
    id: data.agentId,
    data,
    type: COMM_GRAPH_AGENT_NODE_TYPE,
    dragging: false,
    zIndex: 0,
    selectable: false,
    deletable: false,
    selected: false,
    draggable: false,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
}

const PEER_TASK_DATA: CommGraphPeerTaskNodeData = {
  variant: "peer-task",
  agentId: FOREIGN_SENDER_ID,
  peerEpicId: PEER_EPIC_ID,
  name: "Task epic-pee",
  searchMatched: false,
  searchHighlightNonce: 0,
  pulsing: false,
};

function renderPeerTaskNode() {
  return render(
    <ReactFlowProvider>
      <CommGraphAgentNodeView {...peerTaskNodeProps(PEER_TASK_DATA)} />
    </ReactFlowProvider>,
  );
}

describe("CommGraphAgentNodeView peer-task variant", () => {
  it("shows the registered task's title when this client knows it", () => {
    useRegisteredEpicTitleMock.mockReturnValue("Reviewer Task");
    renderPeerTaskNode();

    expect(screen.getByText("Reviewer Task")).toBeDefined();
    expect(screen.queryByText("Task epic-pee")).toBeNull();
  });

  it("falls back to the id-prefix label when the task title is not known here", () => {
    useRegisteredEpicTitleMock.mockReturnValue(null);
    renderPeerTaskNode();

    expect(screen.getByText("Task epic-pee")).toBeDefined();
  });

  it("opens the peer task on click", () => {
    useRegisteredEpicTitleMock.mockReturnValue(null);
    renderPeerTaskNode();

    fireEvent.click(
      screen.getByTestId(`comm-graph-peer-task-node-${FOREIGN_SENDER_ID}`),
    );

    expect(openOrFocusEpicIntentMock).toHaveBeenCalledWith({
      epicId: PEER_EPIC_ID,
      focus: undefined,
    });
    expect(navigateToTabIntentMock).toHaveBeenCalledWith(
      navigateMock,
      openOrFocusEpicIntentMock.mock.results[0]?.value,
      undefined,
    );
  });
});
