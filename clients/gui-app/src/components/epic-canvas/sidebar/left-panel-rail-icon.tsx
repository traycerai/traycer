import { getLeftPanelDefinition } from "./left-panel-registry";
import type { LeftPanelId } from "@/lib/left-panel-ids";
import { cn } from "@/lib/utils";
export function LeftPanelRailIcon({
  panelId,
  hidden,
}: {
  readonly panelId: LeftPanelId;
  readonly hidden: boolean;
}) {
  const Icon = getLeftPanelDefinition(panelId).icon;
  return <Icon className={cn("size-4", hidden && "opacity-40")} />;
}
