import type { KeyboardEvent, ReactNode } from "react";
import { House } from "lucide-react";
import { useLayoutRegion } from "@/components/layout-editor/use-layout-region";
import { HomeTabContextMenu } from "../tab-strip-context-menu";
import {
  SideTabRow,
  type SideRowFrame,
  type SideTabRowVariant,
} from "./side-tab-row";
import { NO_LIVE_AGENTS } from "./side-tab-live-agents";

const HOME_LABEL = "Home";

interface SideHomeRowProps {
  readonly variant: SideTabRowVariant;
  readonly isActive: boolean;
  readonly onActivate: () => void;
}

/**
 * Home in the vertical strip, inside Home's own menu (L-19, S-32): the same
 * pairing as the top strip's `HomeStripSlot`. It is not a strip tab, so it
 * has no drag, no close and no Alt-digit.
 */
export function SideHomeRow(props: SideHomeRowProps): ReactNode {
  return (
    <HomeTabContextMenu>
      <SideHomeRowBody {...props} />
    </HomeTabContextMenu>
  );
}

function SideHomeRowBody(props: SideHomeRowProps): ReactNode {
  const { variant, isActive, onActivate } = props;
  const { ref } = useLayoutRegion({ regionId: "homeTab", instanceId: null });
  const icon = <House className="size-4" />;
  const frame: SideRowFrame = {
    ref,
    role: "tab",
    tabIndex: 0,
    "aria-selected": isActive,
    "aria-label": HOME_LABEL,
    "data-testid": "tab-home",
    "data-tab-kind": "home",
    onClick: onActivate,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onActivate();
    },
    className: "cursor-pointer [-webkit-app-region:no-drag]",
  };
  return (
    <SideTabRow
      frame={frame}
      variant={variant}
      active={isActive}
      session={null}
      tint={null}
      groupLine={null}
      leading={icon}
      tile={{ kind: "icon", icon }}
      badge={null}
      agents={NO_LIVE_AGENTS}
      disclosure={null}
      title={HOME_LABEL}
      hoverCardBody={HOME_LABEL}
      hoverCardOnOverflow={false}
      leaderBadge={null}
      close={null}
      waitingLabel={null}
      dropIndicator={null}
      pairPreview={null}
      dragSource={false}
    />
  );
}
