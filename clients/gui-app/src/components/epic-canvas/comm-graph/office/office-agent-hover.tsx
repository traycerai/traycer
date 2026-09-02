/**
 * The office floor's agent hover: THE shared agent card, not a lookalike.
 *
 * The floor is one `<canvas>`, so there is no per-agent element for a tooltip
 * to attach to. This renders exactly one transparent trigger over the hovered
 * character's screen rect and hands it to `AgentHoverTooltip` - the same
 * component the sidebar rows and the graph nodes use, reading the same
 * selectors. An agent therefore cannot describe itself one way in the
 * navigator and another on the floor, which is the whole point: the office
 * previously showed a name and a status word where the sidebar showed the
 * harness, model, worktree, branch and PR.
 *
 * The trigger also carries the CLICK, so a pointer that lands on a character
 * selects it whether or not the tooltip is open - the canvas below never sees
 * that press, because this element is over it.
 */
import type { ReactNode } from "react";
import { AgentHoverTooltip } from "@/components/epic-canvas/sidebar/agent-hover-tooltip";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import {
  useEpicAgentRoleClaims,
  useEpicNodeHostId,
  useEpicNodeOwnerKind,
} from "@/lib/epic-selectors";
import type { OfficeRect } from "@/lib/comm-graph/office/office-types";

export interface OfficeAgentHoverProps {
  readonly epicId: string;
  readonly agentId: string;
  readonly name: string;
  /** The character's box in CONTAINER screen pixels, already camera-mapped. */
  readonly screenRect: OfficeRect;
  /** The floor's own reading of the agent, appended under the shared card. */
  readonly extraContent: ReactNode;
  readonly onSelect: (agentId: string) => void;
  readonly onLeave: () => void;
}

export function OfficeAgentHover(props: OfficeAgentHoverProps) {
  const { agentId, epicId, extraContent, name, onLeave, onSelect, screenRect } =
    props;
  // Resolved exactly as the graph node resolves them, from the node id alone -
  // see `comm-graph-agent-node.tsx`. Nothing about the hover is passed in from
  // the canvas, so the office cannot feed the card a different truth.
  const hoverHostId = useEpicNodeHostId(agentId);
  const hoverHostReachability = useHostReachability(
    hoverHostId ?? UNKNOWN_HOST_PLACEHOLDER,
  );
  const hoverOwnerKind = useEpicNodeOwnerKind(agentId);
  const roleClaims = useEpicAgentRoleClaims(agentId);

  const trigger = (
    <button
      type="button"
      aria-label={`Open ${name}`}
      data-testid={`comm-graph-office-hover-trigger-${agentId}`}
      // Transparent and exactly the character's size: it is a hit target, not
      // a decoration, and anything visible here would double-draw the sprite.
      className="absolute cursor-pointer bg-transparent p-0"
      style={{
        left: screenRect.x,
        top: screenRect.y,
        width: screenRect.width,
        height: screenRect.height,
      }}
      onClick={() => onSelect(agentId)}
      onPointerLeave={onLeave}
    />
  );

  return (
    <AgentHoverTooltip
      trigger={trigger}
      epicId={epicId}
      nodeId={agentId}
      nodeName={name}
      hostId={hoverHostId}
      // `unreachable` alone, for the reason the graph node gives: `checking`
      // and `host-starting` are pending states the card renders through.
      ownerHostUnreachable={hoverHostReachability.status === "unreachable"}
      ownerKind={hoverOwnerKind}
      roleClaims={roleClaims}
      extraContent={extraContent}
      // Upward: the space below a character is the rest of the floor, and the
      // transport bar is docked under the tile.
      side="top"
    />
  );
}
