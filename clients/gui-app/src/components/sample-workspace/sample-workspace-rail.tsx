import { useLayoutHotspot } from "@/components/customize/use-layout-hotspot";
import { LeftPanelRailIcon } from "@/components/epic-canvas/sidebar/left-panel-rail-icon";
import { LEFT_PANEL_RAIL_TILE_CLASS } from "@/components/epic-canvas/sidebar/left-panel-rail-tile";
import {
  getLeftPanelDefinition,
  isLeftPanelVisible,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import {
  useLeftPanelGroups,
  usePanelVisibilityOverrides,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";
import { SAMPLE_RAIL_PRESENCE } from "./sample-workspace-scene";
import { cn } from "@/lib/utils";

export function SampleWorkspaceRail() {
  const groups = useLeftPanelGroups();
  return (
    <aside
      aria-label="Sample sidebar"
      className="hidden shrink-0 flex-col gap-2 border-r p-2 md:flex"
    >
      {groups.map((group) => (
        <div
          key={group.panelIds[0]}
          className={cn(
            "flex flex-col gap-1 rounded-md",
            group.panelIds.length > 1 && "bg-foreground/6",
          )}
        >
          {group.panelIds.map((panelId) => (
            <SampleRailTile key={panelId} panelId={panelId} />
          ))}
        </div>
      ))}
    </aside>
  );
}
function SampleRailTile({ panelId }: { readonly panelId: LeftPanelId }) {
  const visibilityOverrideById = usePanelVisibilityOverrides();
  const definition = getLeftPanelDefinition(panelId);
  const hidden = !isLeftPanelVisible(definition, {
    ...SAMPLE_RAIL_PRESENCE,
    visibilityOverrideById,
  });
  const { ref } = useLayoutHotspot({
    settingId: "sidebar.panel",
    tileId: panelId,
    ghost: hidden,
    condition: hidden
      ? (definition.forcedOnHint ?? "Hidden from the sidebar")
      : null,
  });
  return (
    <div
      ref={ref}
      aria-label={definition.title}
      className={cn(
        LEFT_PANEL_RAIL_TILE_CLASS,
        "flex items-center justify-center",
        hidden && "border border-dashed border-border/60",
      )}
    >
      <LeftPanelRailIcon panelId={panelId} hidden={hidden} />
    </div>
  );
}
