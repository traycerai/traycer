import type { ReactNode } from "react";
import { TabIcon } from "@/components/epic-canvas/canvas/tab-strip";
import { SwitcherListRow } from "@/components/epic-canvas/mobile/switcher-list-row";
import { useMobileTileReading } from "@/components/epic-canvas/mobile/use-mobile-tile-level2-form";
import type { MobileTileSelection } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { useEpicTabDisplayTitle } from "@/lib/epic-selectors";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

/**
 * The second tile, while the width has no room for it, at the head of the list
 * whatever its category: the lists enumerate content, and a tile with no row
 * there (a diff, a file) would otherwise be out of reach after a rotation.
 * Choosing it trades places with the current tile, so the same two come back
 * side by side when the width does.
 */
export function SwitcherLastTileRow(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}): ReactNode {
  const { epicId, tabId, onClose } = props;
  const { primary, secondary, tiles } = useMobileTileReading(tabId);
  if (secondary === null || tiles === 2) return null;
  return (
    <SwitcherLastTileRowBody
      epicId={epicId}
      tabId={tabId}
      current={primary}
      last={secondary}
      onClose={onClose}
    />
  );
}

function SwitcherLastTileRowBody(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly current: MobileTileSelection | null;
  readonly last: MobileTileSelection;
  readonly onClose: () => void;
}): ReactNode {
  const { epicId, tabId, current, last, onClose } = props;
  const { openTile } = useEpicTileNavigation();
  const setSecondary = useEpicCanvasStore((s) => s.setMobileSecondaryTile);
  const title = useEpicTabDisplayTitle(
    {
      id: last.ref.id,
      name: last.ref.name,
      type: last.ref.type,
      hostId: last.ref.hostId,
    },
    epicId,
    null,
  );
  return (
    <div
      className="shrink-0 border-b border-canvas-border/70 p-1"
      data-testid="switcher-last-tile"
    >
      <SwitcherListRow
        icon={
          <TabIcon
            epicId={epicId}
            tab={last.ref}
            titleGenerationPending={false}
            browserPresentation={null}
          />
        }
        label={title}
        secondaryLabel="Last open"
        badge={null}
        active={false}
        actions={null}
        disabled={false}
        selectTestId="switcher-last-tile-select"
        onSelect={() => {
          openTile(tileIntent(last.ref, { tabId }, "explicit", "direct_ui"));
          setSecondary(
            tabId,
            current === null
              ? null
              : { instanceId: current.ref.instanceId, transient: false },
          );
          onClose();
        }}
      />
    </div>
  );
}
