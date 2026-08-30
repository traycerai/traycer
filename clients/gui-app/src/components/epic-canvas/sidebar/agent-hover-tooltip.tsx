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
 * An UNREACHABLE owner host falls to outcome 2/3, and that is a data fact
 * rather than a policy: outcome 1's content is a live RPC chain against the
 * row's own binding host (`worktree.listAllForHost` + `listByWorkspacePaths`),
 * and branch and worktree path are FILESYSTEM facts of that machine. There is
 * nothing to replicate that would fix this - a cloud copy of a folder list
 * would be a stale claim about a disk this client cannot see - so the honest
 * degrade is to show what is still true: the agent's name, and its roles.
 *
 * The TUI roster's phase 2 is what makes the case ordinary. Every terminal
 * agent on every other machine the user owns is now in the tree, and hovering
 * one whose laptop is shut would otherwise open a card that spins on a host
 * nothing can reach.
 *
 * DATA COMES FROM THE EPIC SELECTORS, not from the caller. Both call sites pass
 * only the node's identity; everything SHOWN is read here, so neither surface
 * can hand it a different truth. `ownerHostUnreachable` is the one exception,
 * and it is not shown - it only chooses between the outcomes. See its own doc.
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
   * Whether the owner host can be reached right now.
   *
   * A PROP where everything else here is read internally, and the exception is
   * deliberate. The sidebar row already resolves this verdict for its own
   * offline lock, on the same host id - so passing it makes the lock and the
   * hover provably read the SAME answer instead of two subscriptions that
   * could momentarily disagree, and spares a long tree one extra directory
   * subscription per row. It is also the one input that is a fact about a
   * MACHINE rather than about the record, which is what the "read it here"
   * rule was written for.
   */
  readonly ownerHostUnreachable: boolean;
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
  const {
    epicId,
    hostId,
    nodeId,
    nodeName,
    ownerHostUnreachable,
    ownerKind,
    roleClaims,
    side,
  } = props;
  const roleContent = agentRoleHoverContent(nodeName, roleClaims);

  if (hostId !== null && ownerKind !== null && !ownerHostUnreachable) {
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
