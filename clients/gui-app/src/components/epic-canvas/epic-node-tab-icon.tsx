import { cn } from "@/lib/utils";
import { ChatProgressIcon } from "@/components/chat/chat-progress-icon";
import {
  EPIC_NODE_ICONS,
  type EpicNodeKind,
} from "@/lib/artifacts/node-display";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  WORKSPACE_FILE_TAB_KIND,
  type EpicNodeRef,
} from "@/stores/epics/canvas/types";
import { WorkspaceFileIcon } from "@/components/epic-canvas/workspace-file/workspace-file-icons";

/**
 * Single source of truth for rendering the icon of a tab/node anywhere in
 * the epic canvas surface (tab strip, DnD drag preview, etc). Dispatches on
 * the `EpicNodeRef` discriminator so consumers never re-implement the
 * chat / workspace-file / static-artifact split.
 *
 * - `variant="live"` (default): chat tabs render the progress spinner that
 *   tracks live chat state. Use inside the mounted tab strip.
 * - `variant="static"`: chat tabs render their static lucide icon. Use for
 *   drag previews and any place where live state isn't appropriate.
 */
export function EpicNodeTabIcon(props: {
  readonly node: EpicNodeRef;
  readonly epicId: string;
  readonly variant: "live" | "static";
  readonly className: string;
}) {
  if (props.node.type === "chat" && props.variant === "live") {
    return (
      <ChatProgressIcon
        epicId={props.epicId}
        chatId={props.node.id}
        className={props.className}
        mutedClassName="text-muted-foreground"
        testId="chat-tab-spinner"
      />
    );
  }
  if (props.node.type === WORKSPACE_FILE_TAB_KIND) {
    return (
      <WorkspaceFileIcon
        fileName={props.node.name}
        className={props.className}
      />
    );
  }
  return (
    <StaticEpicNodeIcon type={props.node.type} className={props.className} />
  );
}

export function StaticEpicNodeIcon(props: {
  readonly type: EpicNodeKind;
  readonly className: string;
}) {
  const Icon = EPIC_NODE_ICONS[props.type];
  const colorMode = useSettingsStore((s) => s.artifactIconColorMode);
  const color = useSettingsStore((s) => s.artifactIconColors[props.type]);
  const style = colorMode === "byType" ? { color } : undefined;
  return (
    <Icon
      className={cn(
        props.className,
        colorMode === "none" && "text-muted-foreground",
      )}
      style={style}
    />
  );
}
