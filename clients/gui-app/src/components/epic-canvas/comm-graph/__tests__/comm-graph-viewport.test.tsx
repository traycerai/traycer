const reactFlowMock = vi.hoisted(() => vi.fn((_props: unknown) => null));

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

vi.mock("@/lib/epic-selectors", () => ({
  useEpicAgentActivityTiers: () => new Map(),
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  ReactFlowInstance,
  ReactFlowProps,
  Viewport,
} from "@xyflow/react";
import { CommGraphCanvas } from "@/components/epic-canvas/comm-graph/comm-graph-canvas";
import type { CommGraphAgentFlowNode } from "@/components/epic-canvas/comm-graph/comm-graph-agent-node";
import type { CommGraphFlowEdge } from "@/components/epic-canvas/comm-graph/comm-graph-edge";
import {
  COMM_GRAPH_NODE_HEIGHT,
  COMM_GRAPH_NODE_WIDTH,
} from "@/lib/comm-graph/comm-graph-layout";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import type { CommGraphPulse } from "@/lib/comm-graph/comm-graph-timeline";
import { DEFAULT_COMM_GRAPH_VIEW } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";

const AGENT: CommGraphAgentNode = {
  id: "agent-1",
  kind: "chat",
  name: "Agent",
  hostId: "host-1",
  parentId: null,
  harnessId: null,
  archived: false,
  createdAt: 1,
};

interface RenderCanvasOptions {
  readonly playing: boolean;
  readonly pulse: CommGraphPulse | null;
}

const STATIC_CANVAS: RenderCanvasOptions = { playing: false, pulse: null };

function canvas(view: CommGraphTileViewState, options: RenderCanvasOptions) {
  return (
    <CommGraphCanvas
      epicId="epic-1"
      agents={[AGENT]}
      agentIds={new Set([AGENT.id])}
      events={[]}
      hosts={[]}
      initialHistoryCaughtUp={false}
      playing={options.playing}
      pulse={options.pulse}
      view={view}
      onViewChange={vi.fn()}
      canOpenAgentForEvent={() => true}
      canJump={() => false}
      onJump={vi.fn()}
      canJumpToSender={() => false}
      onJumpToSender={vi.fn()}
      canJumpToCreated={() => false}
      onJumpToCreated={vi.fn()}
      onOpenAgent={vi.fn()}
    />
  );
}

function renderCanvas(
  view: CommGraphTileViewState,
  options: RenderCanvasOptions,
) {
  return render(canvas(view, options));
}

function latestReactFlowProps(): ReactFlowProps<
  CommGraphAgentFlowNode,
  CommGraphFlowEdge
> {
  const props = reactFlowMock.mock.lastCall?.[0];
  if (typeof props !== "object" || props === null) {
    throw new Error("ReactFlow was not rendered");
  }
  return props;
}

function firstFlowNode(): CommGraphAgentFlowNode {
  const nodes = latestReactFlowProps().nodes;
  if (nodes === undefined || nodes.length === 0) {
    throw new Error("Expected at least one comm-graph node");
  }
  return nodes[0];
}

type FlowSetCenter = ReactFlowInstance<
  CommGraphAgentFlowNode,
  CommGraphFlowEdge
>["setCenter"];

function createFlowInstanceStub(
  viewport: Viewport,
  setCenter: Mock<FlowSetCenter>,
): ReactFlowInstance<CommGraphAgentFlowNode, CommGraphFlowEdge> {
  const noop = vi.fn();
  const noopArray = vi.fn((): CommGraphAgentFlowNode[] => []);
  const noopEdges = vi.fn((): CommGraphFlowEdge[] => []);
  return {
    getViewport: vi.fn(() => viewport),
    setCenter,
    getNodes: noopArray,
    setNodes: noop,
    addNodes: noop,
    getNode: vi.fn(() => undefined),
    getInternalNode: vi.fn(() => undefined),
    getEdges: noopEdges,
    setEdges: noop,
    addEdges: noop,
    getEdge: vi.fn(() => undefined),
    toObject: vi.fn(() => ({ nodes: [], edges: [], viewport })),
    deleteElements: vi.fn(() =>
      Promise.resolve({ deletedNodes: [], deletedEdges: [] }),
    ),
    getIntersectingNodes: noopArray,
    isNodeIntersecting: vi.fn(() => false),
    updateNode: noop,
    updateNodeData: noop,
    updateEdge: noop,
    updateEdgeData: noop,
    getNodesBounds: vi.fn(() => ({ x: 0, y: 0, width: 0, height: 0 })),
    getHandleConnections: vi.fn(() => []),
    getNodeConnections: vi.fn(() => []),
    fitView: vi.fn(() => Promise.resolve(false)),
    zoomIn: vi.fn(() => Promise.resolve(true)),
    zoomOut: vi.fn(() => Promise.resolve(true)),
    zoomTo: vi.fn(() => Promise.resolve(true)),
    getZoom: vi.fn(() => viewport.zoom),
    setViewport: vi.fn(() => Promise.resolve(true)),
    fitBounds: vi.fn(() => Promise.resolve(true)),
    screenToFlowPosition: vi.fn(() => ({ x: 0, y: 0 })),
    flowToScreenPosition: vi.fn(() => ({ x: 0, y: 0 })),
    viewportInitialized: true,
  };
}

function installFlowInstance(viewport: Viewport): {
  readonly setCenter: Mock<FlowSetCenter>;
} {
  const setCenter = vi.fn<FlowSetCenter>(() => Promise.resolve(true));
  const instance = createFlowInstanceStub(viewport, setCenter);
  act(() => {
    latestReactFlowProps().onInit?.(instance);
  });
  return { setCenter };
}

function setCanvasSize(element: HTMLElement): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ width: 600, height: 400 }),
  );
}

function playbackPulse(): CommGraphPulse {
  return { kind: "agent", agentId: AGENT.id, senderAgentId: AGENT.id };
}

function receiverOnlyPulse(senderAgentId: string): CommGraphPulse {
  return { kind: "agent", agentId: AGENT.id, senderAgentId };
}

afterEach(() => {
  cleanup();
  reactFlowMock.mockClear();
  vi.restoreAllMocks();
});

describe("CommGraphCanvas viewport", () => {
  it("fits every node on first open and permits a full-graph overview", () => {
    renderCanvas(DEFAULT_COMM_GRAPH_VIEW, STATIC_CANVAS);

    expect(reactFlowMock.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        defaultViewport: DEFAULT_COMM_GRAPH_VIEW,
        fitView: true,
        minZoom: 0.1,
      }),
    );
  });

  it("restores a user-positioned viewport instead of fitting it again", () => {
    const persistedView = { x: 120, y: -80, zoom: 0.75 };
    renderCanvas(persistedView, STATIC_CANVAS);

    expect(reactFlowMock.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        defaultViewport: persistedView,
        fitView: false,
        minZoom: 0.1,
      }),
    );
  });

  it("centers an offscreen playback sender without changing zoom", async () => {
    const result = renderCanvas(DEFAULT_COMM_GRAPH_VIEW, {
      playing: true,
      pulse: playbackPulse(),
    });
    setCanvasSize(result.getByTestId("comm-graph-canvas"));
    const sender = firstFlowNode();
    const { setCenter } = installFlowInstance({
      x: -10_000,
      y: -10_000,
      zoom: 0.75,
    });

    await waitFor(() => {
      expect(setCenter).toHaveBeenCalledWith(
        sender.position.x + COMM_GRAPH_NODE_WIDTH / 2,
        sender.position.y + COMM_GRAPH_NODE_HEIGHT / 2,
        { zoom: 0.75, duration: 250 },
      );
    });
  });

  it("does not pan to the receiver when the sender is not rendered", () => {
    const result = renderCanvas(DEFAULT_COMM_GRAPH_VIEW, {
      playing: true,
      pulse: receiverOnlyPulse("offscreen-sender"),
    });
    setCanvasSize(result.getByTestId("comm-graph-canvas"));
    const { setCenter } = installFlowInstance({
      x: -10_000,
      y: -10_000,
      zoom: 0.5,
    });

    expect(setCenter).not.toHaveBeenCalled();
  });

  it("does not move when the playback sender already intersects the viewport", () => {
    const result = renderCanvas(DEFAULT_COMM_GRAPH_VIEW, {
      playing: true,
      pulse: playbackPulse(),
    });
    setCanvasSize(result.getByTestId("comm-graph-canvas"));
    const sender = firstFlowNode();
    const { setCenter } = installFlowInstance({
      x: 100 - sender.position.x,
      y: 100 - sender.position.y,
      zoom: 1,
    });

    expect(setCenter).not.toHaveBeenCalled();
  });

  it("stops following after manual interaction and re-arms on the next Play", async () => {
    const firstPulse = playbackPulse();
    const result = renderCanvas(DEFAULT_COMM_GRAPH_VIEW, {
      playing: true,
      pulse: firstPulse,
    });
    const canvasElement = result.getByTestId("comm-graph-canvas");
    setCanvasSize(canvasElement);
    const { setCenter } = installFlowInstance({
      x: -10_000,
      y: -10_000,
      zoom: 0.5,
    });
    await waitFor(() => {
      expect(setCenter).toHaveBeenCalledTimes(1);
    });
    setCenter.mockClear();

    fireEvent.pointerDown(canvasElement);
    result.rerender(
      canvas(DEFAULT_COMM_GRAPH_VIEW, {
        playing: true,
        pulse: playbackPulse(),
      }),
    );
    expect(setCenter).not.toHaveBeenCalled();

    result.rerender(
      canvas(DEFAULT_COMM_GRAPH_VIEW, { playing: false, pulse: null }),
    );
    result.rerender(
      canvas(DEFAULT_COMM_GRAPH_VIEW, {
        playing: true,
        pulse: playbackPulse(),
      }),
    );
    await waitFor(() => {
      expect(setCenter).toHaveBeenCalledTimes(1);
    });
  });
});
