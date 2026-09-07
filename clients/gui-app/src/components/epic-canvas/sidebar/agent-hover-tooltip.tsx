/**
 * Extracted rather than copied so the two cannot drift: an agent hovered in the navigator and the same agent hovered on the canvas must say the same things about it.
 * An UNREACHABLE owner host falls to outcome 2/3, and that is a data fact rather than a policy: outcome 1's content is a live RPC chain against the row's own binding host (`worktree.listAllForHost` + `listByWorkspacePaths`), and branch and worktree path are FILESYSTEM facts of that machine.
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
  /** Narrower than the resource-owner wire kind on purpose: only these two have owner metadata to read. */
  readonly ownerKind: WorktreeBindingOwnerKind | null;
  readonly roleClaims: readonly RoleClaim[];
  /**
   * The sidebar row already resolves this verdict for its own offline lock, on the same host id - so passing it makes the lock and the hover provably read the SAME answer instead of two subscriptions that could momentarily disagree, and spares a long tree one extra directory subscription per row.
   * It is also the one input that is a fact about a MACHINE rather than about the record, which is what the "read it here" rule was written for.
   */
  readonly ownerHostUnreachable: boolean;
  /**
   * Which side the tooltip opens on.
   * The sidebar opens right (the tree is a left rail); the canvas opens up, because a node can sit anywhere and the space below it is where the transport bar is.
   */
  readonly side: "top" | "right" | "bottom" | "left";
  /**
   * Appended rather than substituted: everything ABOVE it is still the one shared description, so a surface can add to what an agent says about itself without being able to contradict it.
   */
  readonly extraContent: ReactElement | null;
}

/** `null` when there are no claims - an empty roles card is worse than none. */
function agentRoleHoverContent(
  agentName: string,
  roleClaims: readonly RoleClaim[],
): ReactNode | null {
  if (roleClaims.length === 0) return null;
  return <AgentRoleHoverContent agentName={agentName} claims={roleClaims} />;
}

/**
 * The name must survive whatever else is shown: the office's line under it is "Working · large model", which names nothing, and the floor's own tag is truncated - so a card that dropped the title for the posture line would take away the only place the full name was readable.
 * The role content already carries the name, so it is only added when nothing else does.
 */
function fallbackTooltipLabel(
  nodeName: string,
  roleContent: ReactNode | null,
  extraContent: ReactElement | null,
): ReactNode {
  if (roleContent !== null) {
    return (
      <>
        {roleContent}
        {extraContent}
      </>
    );
  }
  if (extraContent !== null) {
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="break-words">{nodeName}</span>
        {extraContent}
      </div>
    );
  }
  return nodeName;
}

export function AgentHoverTooltip(props: AgentHoverTooltipProps): ReactNode {
  const {
    epicId,
    hostId,
    nodeId,
    nodeName,
    ownerHostUnreachable,
    extraContent,
    ownerKind,
    roleClaims,
    side,
  } = props;
  const roleContent = agentRoleHoverContent(nodeName, roleClaims);
  // `null` is the ONLY way to say "nothing to add", which is why the prop is an element and not a `ReactNode`.
  // The type makes them unrepresentable instead of guarding for them.
  const supplemental =
    roleContent === null && extraContent === null ? null : (
      <>
        {roleContent}
        {extraContent}
      </>
    );

  if (hostId !== null && ownerKind !== null && !ownerHostUnreachable) {
    return (
      <WorktreeOwnerMetadataTooltip
        trigger={props.trigger}
        title={nodeName}
        hostId={hostId}
        epicId={epicId}
        ownerId={nodeId}
        ownerKind={ownerKind}
        supplementalContent={supplemental}
        side={side}
      />
    );
  }
  // Never a bare trigger: a row without roles or owner metadata still exposes its FULL name on hover - sidebar rows and graph nodes truncate, and the tooltip is the only place the complete title is readable (upstream pinned this for selection mode; the shared component gives it everywhere).
  return (
    <TooltipWrapper
      label={fallbackTooltipLabel(nodeName, roleContent, extraContent)}
      side={side}
      sideOffset={6}
      align="start"
    >
      {props.trigger}
    </TooltipWrapper>
  );
}
