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
 * selects it whether or not the tooltip is open. A PRESS is handed back to
 * the floor through `onPointerDown`: the canvas below never sees it
 * otherwise, because this element is over it, and a drag or a wheel that
 * happens to start on a character must still pan and zoom the floor.
 */
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";
import { AgentHoverTooltip } from "@/components/epic-canvas/sidebar/agent-hover-tooltip";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useEpicNodeHostId, useEpicNodeOwnerKind } from "@/lib/epic-selectors";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import type { OfficeRect } from "@/lib/comm-graph/office/office-types";

export interface OfficeAgentHoverProps {
  readonly epicId: string;
  readonly agentId: string;
  readonly name: string;
  /** The character's box in CONTAINER screen pixels, already camera-mapped. */
  readonly screenRect: OfficeRect;
  /** The floor's own reading of the agent, appended under the shared card. */
  readonly extraContent: ReactElement;
  readonly onSelect: (agentId: string) => void;
  readonly onLeave: () => void;
  /** The floor's own press handler, so a drag that starts here still pans. */
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /**
   * The floor's own double-click, so the zoom works over a person too.
   *
   * This target sits ON the floor rather than inside it, so the gesture has to
   * be handed across explicitly - and the handler anchors on the cursor, which
   * is why it takes the event rather than the agent.
   */
  readonly onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => void;
  /**
   * This agent's claims, taken from the canvas's ONE bulk map rather than from
   * a hook here. The floor already holds every agent's claims for the plates,
   * and a second per-agent subscription opening on hover is a subscription
   * that churns with the pointer.
   */
  readonly roleClaims: readonly RoleClaim[];
}

export function OfficeAgentHover(props: OfficeAgentHoverProps) {
  const {
    agentId,
    epicId,
    extraContent,
    name,
    onLeave,
    onDoubleClick,
    onPointerDown,
    onSelect,
    roleClaims,
    screenRect,
  } = props;
  // Resolved exactly as the graph node resolves them, from the node id alone -
  // see `comm-graph-agent-node.tsx`. Nothing about the hover is passed in from
  // the canvas, so the office cannot feed the card a different truth.
  const hoverHostId = useEpicNodeHostId(agentId);
  const hoverHostReachability = useHostReachability(
    hoverHostId ?? UNKNOWN_HOST_PLACEHOLDER,
  );
  const hoverOwnerKind = useEpicNodeOwnerKind(agentId);

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
      // The zoom gesture belongs to the FLOOR, and this target covers a piece
      // of it. The canvas element is a sibling, not an ancestor, so nothing
      // bubbles there on its own - and asking for a closer look at somebody is
      // exactly when a person double-clicks.
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
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
