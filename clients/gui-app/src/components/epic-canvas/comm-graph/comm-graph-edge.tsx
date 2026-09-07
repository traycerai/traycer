/**
 * Everything second-order lives in the click-through, which lists every row: numbers on the canvas cost legibility on every edge permanently to answer a question that is only asked occasionally, and a label per edge is the thing that makes a busy graph unreadable.
 * NO ARROWHEADS either, and one edge instead of two.
 */
import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
  type Edge,
} from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import {
  commGraphEdgeEndpoints,
  type CommGraphEdgeBox,
} from "@/lib/comm-graph/comm-graph-floating-edge";
import type { CommGraphPulseKind } from "@/lib/comm-graph/comm-graph-timeline";
import { commGraphTravelKeyPoints } from "@/lib/comm-graph/comm-graph-travel";

export const COMM_GRAPH_EDGE_TYPE = "commGraphEdge";

export interface CommGraphEdgeData extends Record<string, unknown> {
  /** Order-independent pair id. */
  readonly edgeId: string;
  readonly hasOpenThread: boolean;
  /**
   * `request` vs `reply` comes from `inReplyTo`; `notice` is the broker giving up rather than an agent speaking.
   */
  readonly pulse: CommGraphPulseKind | null;
  /**
   * Which way that pulse runs along the drawn path.
   * The edge's own endpoints are in canonical (sorted) order and carry no meaning, so the canvas resolves the message's sender/receiver against them and hands down the answer - see `commGraphEdgeTravel`.
   */
  readonly pulseReversed: boolean;
  readonly onSelect: (edgeId: string) => void;
}

/**
 * The traveling dot's fill, one per kind - so an ask, an answer and a broker notice are told apart by the thing that MOVES, never by the line it moves along.
 * Inline rather than Tailwind `fill-*` utilities to match how React Flow paints its own SVG chrome, and because this value is handed to an attribute.
 */
const TRAVEL_FILL: Readonly<Record<CommGraphPulseKind, string>> = {
  request: "var(--color-primary)",
  reply: "var(--color-emerald-500)",
  notice: "var(--color-amber-500)",
  created: "var(--color-sky-500)",
};

export type CommGraphFlowEdge = Edge<
  CommGraphEdgeData,
  typeof COMM_GRAPH_EDGE_TYPE
>;

/**
 * The node's box in flow space, or `null` before React Flow has measured it.
 * Falls back to the declared `width`/`height` the canvas supplies up front, so an edge can route on the first frame instead of waiting for a ResizeObserver.
 */
function boxOf(
  node:
    | {
        readonly internals: {
          readonly positionAbsolute: { x: number; y: number };
        };
        readonly measured: {
          width?: number | undefined;
          height?: number | undefined;
        };
        readonly width?: number | undefined;
        readonly height?: number | undefined;
      }
    | undefined,
): CommGraphEdgeBox | null {
  if (node === undefined) return null;
  const width = node.measured.width ?? node.width ?? null;
  const height = node.measured.height ?? node.height ?? null;
  if (width === null || height === null) return null;
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width,
    height,
  };
}

export const CommGraphEdgeView = memo(function CommGraphEdgeView(
  props: EdgeProps<CommGraphFlowEdge>,
) {
  const { data } = props;
  // `source`/`target` here are just the pair's canonical order - the edge has no direction, so it must not have fixed anchors either.
  const sourceBox = boxOf(useInternalNode(props.source));
  const targetBox = boxOf(useInternalNode(props.target));
  const endpoints =
    sourceBox === null || targetBox === null
      ? {
          sourceX: props.sourceX,
          sourceY: props.sourceY,
          sourcePosition: props.sourcePosition,
          targetX: props.targetX,
          targetY: props.targetY,
          targetPosition: props.targetPosition,
        }
      : commGraphEdgeEndpoints(sourceBox, targetBox);
  const [path, labelX, labelY] = getBezierPath(endpoints);
  if (data === undefined) return <BaseEdge id={props.id} path={path} />;
  // The ONLY thing that ever varies on the base stroke here.
  const style = data.hasOpenThread ? { strokeDasharray: "4 3" } : props.style;
  return (
    <>
      <BaseEdge id={props.id} path={path} style={style} />
      {data.pulse === null ? null : (
        // `<animateMotion>` walks the SAME `path` the edge is drawn with rather than a second computed curve, so the dot cannot drift off the line it is meant to be running along; reversing is just walking that path backwards via `keyPoints`.
        <circle
          r={4}
          fill={TRAVEL_FILL[data.pulse]}
          data-testid={`comm-graph-edge-travel-${data.edgeId}`}
          data-reversed={data.pulseReversed ? "true" : "false"}
        >
          <animateMotion
            dur="1.1s"
            repeatCount="indefinite"
            path={path}
            keyPoints={commGraphTravelKeyPoints(data.pulseReversed)}
            keyTimes="0;1"
            calcMode="linear"
          />
        </circle>
      )}
      {!data.hasOpenThread ? null : (
        <EdgeLabelRenderer>
          <button
            type="button"
            // `pointer-events-auto` re-enables clicks: the label layer disables
            // them wholesale so labels never eat canvas pan gestures.
            className="pointer-events-auto absolute"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            data-testid={`comm-graph-edge-open-thread-${data.edgeId}`}
            onClick={() => data.onSelect(data.edgeId)}
          >
            {/* Same compact badge language as the row kind chips, so "awaiting
                reply" reads as the same class of fact in both places. */}
            <Badge
              variant="outline"
              className="h-4 rounded-sm border-primary/25 bg-card px-1 py-0 text-micro font-medium text-primary shadow-sm"
            >
              awaiting reply
            </Badge>
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
