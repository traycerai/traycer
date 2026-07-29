/**
 * THE agent hover, shared by the sidebar's Agents tree and the communication
 * graph's nodes.
 *
 * It was inline in `epic-sidebar-chat-tree`'s row until the graph needed the
 * same thing. Extracted rather than copied so the two cannot drift: an agent
 * hovered in the navigator and the same agent hovered on the canvas must say
 * the same things about it.
 *
 * THREE OUTCOMES, and the order matters - this is the sidebar's own precedence,
 * preserved exactly:
 *
 *   1. Owner metadata (worktree / resource stats) when the node has BOTH a host
 *      and a resource-tracked owner kind, with any role claims appended to it
 *      as supplemental content. The richest case, and the common one.
 *   2. Role claims alone, in a plain tooltip, when there is no owner metadata to
 *      show but the agent has claimed something.
 *   3. NO HOVER AT ALL. An agent with neither is not given an empty card - a
 *      tooltip that opens onto nothing is worse than no tooltip.
 *
 * DATA COMES FROM THE EPIC SELECTORS, not from the caller. Both call sites pass
 * only the node's identity; everything shown is read here, so neither surface
 * can hand it a different truth.
 */
import type { ReactElement, ReactNode } from "react";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { WorktreeOwnerMetadataTooltip } from "@/components/worktree/worktree-owner-metadata";
import { AgentRoleHoverContent } from "@/components/epic-canvas/sidebar/agent-role-badges";

export interface AgentHoverTooltipProps {
  readonly trigger: ReactElement;
  readonly epicId: string;
  readonly nodeId: string;
  readonly nodeName: string;
  /** `null` for a legacy record with no resolvable host - no metadata to read. */
  readonly hostId: string | null;
  /**
   * `null` for node kinds that own no worktree-bound process tree (specs,
   * tickets, …). Narrower than the resource-owner wire kind on purpose: only
   * these two have owner metadata to read.
   */
  readonly ownerKind: WorktreeBindingOwnerKind | null;
  readonly roleClaims: readonly RoleClaim[];
  /**
   * Which side the tooltip opens on. The sidebar opens right (the tree is a
   * left rail); the canvas opens up, because a node can sit anywhere and the
   * space below it is where the transport bar is.
   */
  readonly side: "top" | "right" | "bottom" | "left";
}

/** `null` when there are no claims - an empty roles card is worse than none. */
function agentRoleHoverContent(
  agentName: string,
  roleClaims: readonly RoleClaim[],
): ReactNode | null {
  if (roleClaims.length === 0) return null;
  return <AgentRoleHoverContent agentName={agentName} claims={roleClaims} />;
}

export function AgentHoverTooltip(props: AgentHoverTooltipProps): ReactNode {
  const { epicId, hostId, nodeId, nodeName, ownerKind, roleClaims, side } =
    props;
  const roleContent = agentRoleHoverContent(nodeName, roleClaims);

  if (hostId !== null && ownerKind !== null) {
    return (
      <WorktreeOwnerMetadataTooltip
        trigger={props.trigger}
        title={nodeName}
        hostId={hostId}
        epicId={epicId}
        ownerId={nodeId}
        ownerKind={ownerKind}
        supplementalContent={roleContent}
        side={side}
      />
    );
  }
  // Never a bare trigger: a row without roles or owner metadata still exposes
  // its FULL name on hover - sidebar rows and graph nodes truncate, and the
  // tooltip is the only place the complete title is readable (upstream pinned
  // this for selection mode; the shared component gives it everywhere).
  return (
    <TooltipWrapper
      label={roleContent ?? nodeName}
      side={side}
      sideOffset={6}
      align="start"
    >
      {props.trigger}
    </TooltipWrapper>
  );
}
