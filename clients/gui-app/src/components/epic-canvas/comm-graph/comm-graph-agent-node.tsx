/**
 * One agent on the communication-graph canvas.
 *
 * Icons come from the SAME renderers the nav surfaces use
 * (`EpicNodeTabIcon` → `StaticEpicNodeIcon` / `HarnessIcon`), so a chat, a
 * Claude terminal agent, and a Codex terminal agent read identically here and
 * in the sidebar, per-kind icon-color settings included. `variant="live"` also
 * gives the node the existing progress/awareness icon for free.
 *
 * HOVER IS THE SIDEBAR'S HOVER, not a lookalike: `AgentHoverTooltip` is the
 * component the Agents tree rows use, reading the same epic selectors, so an
 * agent cannot describe itself one way in the navigator and another on the
 * canvas. Two things make it safe here:
 *
 * - It PORTALS. `TooltipContent` renders inside `TooltipPrimitive.Portal`, so
 *   the card escapes `.react-flow__viewport` - which carries a CSS
 *   `transform: scale()` for zoom, and would otherwise scale and clip it.
 * - It does not eat the click. The trigger attaches to this button, but the
 *   MOUSE path to the detail panel is React Flow's `onNodeClick` on the node
 *   wrapper above it; Radix's trigger adds pointer handlers without stopping
 *   propagation, so the click still reaches the wrapper and the button keeps
 *   its keyboard role.
 */
import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { cn } from "@/lib/utils";
import { EpicNodeTabIcon } from "@/components/epic-canvas/epic-node-tab-icon";
import { AgentHoverTooltip } from "@/components/epic-canvas/sidebar/agent-hover-tooltip";
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
 * A node's edge-data state. Adds one value to the per-host subscription
 * status: `host-unknown`, for a legacy chat whose record predates
 * `Chat.hostId`. Such an agent is deliberately left unattributed rather than
 * guessed at from the app's active host, so it has no subscription at all -
 * a distinct situation from a host that exists but cannot be reached.
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
  /**
   * The cursor sits on a message whose OTHER endpoint is not on this canvas, so
   * there is no edge for it to travel along. Every drawable exchange pulses its
   * edge instead.
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
  // A node reports what is true of THIS AGENT, and nothing about a socket.
  //
  // The transport statuses (`reconnecting`, `unreachable`, `failed`,
  // `unsupported`) are facts about a SUBSCRIPTION, and the cloud relay stamps
  // one relay status onto every origin host - so captioning them here read
  // "Reconnecting…" under every agent at once for a single wobbly socket. They
  // now roll up to the Epic header's status dot (`useCommGraphFeedHealth`) and
  // survive here only as `data-host-status` for tests and tooling.
  //
  // `host-unknown` is the exception, and stays: it is a property of the agent's
  // own record (a legacy chat predating `Chat.hostId`), not of any subscription.
  // It is deliberately unattributed rather than guessed at, so it has no host to
  // dial and therefore CANNOT appear in either manager's `snapshot.hosts` - the
  // header has no way to learn about it. Dropping it here would leave such a
  // node looking healthy while it can never receive an edge.
  const unattributedHost = data.hostStatus === "host-unknown";
  // Read from the epic selectors, exactly as the sidebar row does - the node's
  // own `data` carries only what the CANVAS needs, and duplicating hover facts
  // into it is how the two surfaces would drift apart.
  const hoverHostId = useEpicNodeHostId(data.agentId);
  const hoverOwnerKind = useEpicNodeOwnerKind(data.agentId);
  const roleClaims = useEpicAgentRoleClaims(data.agentId);
  const button = (
    <button
      type="button"
      // This is the KEYBOARD path, and only incidentally a mouse one. React
      // Flow's `onNodeClick` (wired on the canvas) is what handles the mouse:
      // its keydown handler only ever drives React Flow's own selection and
      // never calls the user callback, so without a real <button> here the node
      // would be unreachable without a pointer. Both paths land on the same
      // idempotent setter, so the duplicate call a mouse click makes is a no-op.
      onClick={() => data.onSelect(data.agentId)}
      data-testid={`comm-graph-node-${data.agentId}`}
      data-archived={data.archived ? "true" : "false"}
      data-host-status={data.hostStatus}
      data-pulsing={data.pulsing ? "true" : "false"}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-left text-ui-xs shadow-sm hover:border-primary/50",
        data.archived && "border-dashed opacity-50",
        unattributedHost && "opacity-60",
        data.activityTier === "turn" && "border-primary ring-2 ring-primary/30",
        data.activityTier === "background" && "border-primary/50",
        data.pulsing && "animate-pulse border-primary ring-2 ring-primary/60",
      )}
    >
      {/* React Flow requires handles to exist, but the edges are FLOATING -
          they compute their own endpoints from the two node boxes, so these
          carry no geometry. Invisible so the default port dots never read as
          interactive affordances, and so nothing appears anchored to a fixed
          side of the node. */}
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
      ownerKind={hoverOwnerKind}
      roleClaims={roleClaims}
      // Upward: a node can sit anywhere on the canvas, and the space below it
      // is where the transport bar is docked.
      side="top"
    />
  );
});
