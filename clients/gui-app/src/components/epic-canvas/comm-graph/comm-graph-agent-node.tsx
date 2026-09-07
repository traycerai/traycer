/**
 * HOVER IS THE SIDEBAR'S HOVER, not a lookalike: `AgentHoverTooltip` is the component the Agents tree rows use, reading the same epic selectors, so an agent cannot describe itself one way in the navigator and another on the canvas.
 * `TooltipContent` renders inside `TooltipPrimitive.Portal`, so the card escapes `.react-flow__viewport` - which carries a CSS `transform: scale()` for zoom, and would otherwise scale and clip it. - It does not eat the click.
 */
import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { cn } from "@/lib/utils";
import { EpicNodeTabIcon } from "@/components/epic-canvas/epic-node-tab-icon";
import { AgentHoverTooltip } from "@/components/epic-canvas/sidebar/agent-hover-tooltip";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import {
  useEpicAgentRoleClaims,
  useEpicNodeHostId,
  useEpicNodeOwnerKind,
} from "@/lib/epic-selectors";
import type { CommGraphAgentKind } from "@/lib/comm-graph/comm-graph-model";
import type { CommGraphHostStatus } from "@/lib/comm-graph/comm-graph-events";
import type { AgentActivityTier } from "@/lib/epic-selectors";

export const COMM_GRAPH_AGENT_NODE_TYPE = "commGraphAgent";

/**
 * Such an agent is deliberately left unattributed rather than guessed at from the app's active host, so it has no subscription at all - a distinct situation from a host that exists but cannot be reached.
 */
export type CommGraphNodeHostStatus = CommGraphHostStatus | "host-unknown";

export interface CommGraphAgentNodeData extends Record<string, unknown> {
  readonly epicId: string;
  readonly agentId: string;
  readonly kind: CommGraphAgentKind;
  readonly name: string;
  readonly archived: boolean;
  readonly hostStatus: CommGraphNodeHostStatus;
  readonly activityTier: AgentActivityTier | null;
  /** This agent's name matches the tile's current find query. */
  readonly searchMatched: boolean;
  /** Changes for each search so the finite blink restarts on repeat searches. */
  readonly searchHighlightNonce: number;
  /**
   * The cursor sits on a message whose OTHER endpoint is not on this canvas, so there is no edge for it to travel along.
   * Every drawable exchange pulses its edge instead.
   */
  readonly pulsing: boolean;
  /** Opens this agent's activity detail beside the canvas. */
  readonly onSelect: (agentId: string) => void;
}

export type CommGraphAgentFlowNode = Node<
  CommGraphAgentNodeData,
  typeof COMM_GRAPH_AGENT_NODE_TYPE
>;

export const CommGraphAgentNodeView = memo(function CommGraphAgentNodeView(
  props: NodeProps<CommGraphAgentFlowNode>,
) {
  const { data } = props;
  // They now roll up to the Epic header's status dot (`useCommGraphFeedHealth`) and survive here only as `data-host-status` for tests and tooling.
  // It is deliberately unattributed rather than guessed at, so it has no host to dial and therefore CANNOT appear in either manager's `snapshot.hosts` - the header has no way to learn about it.
  const unattributedHost = data.hostStatus === "host-unknown";
  // Read from the epic selectors, exactly as the sidebar row does - the node's own `data` carries only what the CANVAS needs, and duplicating hover facts into it is how the two surfaces would drift apart.
  const hoverHostId = useEpicNodeHostId(data.agentId);
  // The hover's owner-metadata outcome is a live RPC chain against this host, so an unreachable one has to fall back rather than spin.
  // The sidebar reads the same verdict for its offline lock; here there is no lock, so this is the only consumer and the hook is resolved at the call site.
  const hoverHostReachability = useHostReachability(
    hoverHostId ?? UNKNOWN_HOST_PLACEHOLDER,
  );
  const hoverOwnerKind = useEpicNodeOwnerKind(data.agentId);
  const roleClaims = useEpicAgentRoleClaims(data.agentId);
  const button = (
    <button
      key={data.searchHighlightNonce}
      type="button"
      // This is the KEYBOARD path, and only incidentally a mouse one.
      // React Flow's `onNodeClick` (wired on the canvas) is what handles the mouse: its keydown handler only ever drives React Flow's own selection and never calls the user callback, so without a real <button> here the node would be unreachable without a pointer.
      onClick={() => data.onSelect(data.agentId)}
      data-testid={`comm-graph-node-${data.agentId}`}
      data-archived={data.archived ? "true" : "false"}
      data-host-status={data.hostStatus}
      data-pulsing={data.pulsing ? "true" : "false"}
      data-search-match={data.searchMatched ? "true" : "false"}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-left text-ui-xs shadow-sm hover:border-primary/50",
        data.archived && "border-dashed opacity-50",
        unattributedHost && "opacity-60",
        data.activityTier === "turn" && "border-primary ring-2 ring-primary/30",
        data.activityTier === "background" && "border-primary/50",
        data.pulsing && "animate-pulse border-primary ring-2 ring-primary/60",
        data.searchMatched &&
          "comm-graph-search-match border-primary ring-2 ring-primary/60",
      )}
    >
      {/* Invisible so the default port dots never read as interactive affordances, and so nothing appears anchored to a fixed side of the node. */}
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="pointer-events-none opacity-0"
      />
      <div className="flex min-w-0 items-center gap-2">
        <EpicNodeTabIcon
          node={{
            id: data.agentId,
            instanceId: data.agentId,
            type: data.kind,
            name: data.name,
            hostId: "",
          }}
          epicId={data.epicId}
          variant="live"
          className="size-3.5 shrink-0"
          defaultIcon={undefined}
        />
        <span className="min-w-0 flex-1 truncate font-medium">{data.name}</span>
      </div>
      {data.archived || unattributedHost ? (
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          {data.archived ? <span>Archived</span> : null}
          {unattributedHost ? (
            <span
              className="truncate"
              data-testid={`comm-graph-node-notice-${data.agentId}`}
            >
              Host unknown
            </span>
          ) : null}
        </div>
      ) : null}
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="pointer-events-none opacity-0"
      />
    </button>
  );
  return (
    <AgentHoverTooltip
      trigger={button}
      epicId={data.epicId}
      nodeId={data.agentId}
      nodeName={data.name}
      hostId={hoverHostId}
      // `unreachable` ALONE, not `!== "reachable"`: `checking` and `host-starting` are pending states the metadata card renders through, and collapsing on them would flicker the richer card away and back while a local host finishes booting.
      ownerHostUnreachable={hoverHostReachability.status === "unreachable"}
      ownerKind={hoverOwnerKind}
      roleClaims={roleClaims}
      // The graph node adds nothing of its own: everything it knows about an
      // agent is already in the shared card.
      extraContent={null}
      // Upward: a node can sit anywhere on the canvas, and the space below it
      // is where the transport bar is docked.
      side="top"
    />
  );
});
