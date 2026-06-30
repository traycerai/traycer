import { cn } from "@/lib/utils";
import { ChatProgressIcon } from "@/components/chat/chat-progress-icon";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  EPIC_NODE_ICONS,
  type EpicNodeKind,
} from "@/lib/artifacts/node-display";
import { useMaybeEpicTuiAgentHarnessId } from "@/lib/epic-selectors";
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
  if (props.node.type === "terminal-agent") {
    return (
      <TuiAgentTabIcon nodeId={props.node.id} className={props.className} />
    );
  }
  return (
    <StaticEpicNodeIcon type={props.node.type} className={props.className} />
  );
}

/**
 * TUI-agent tab/node icon: the underlying harness's brand mark (Claude, Codex,
 * …) so a terminal agent reads as the tool driving it rather than a generic
 * bot. Falls back to the static bot glyph when the harness can't be resolved -
 * a legacy record, or the provider-less drag overlay (see
 * {@link useMaybeEpicTuiAgentHarnessId}). Brand marks render in their own
 * colors; they intentionally don't follow the per-type icon-color customization.
 */
function TuiAgentTabIcon(props: {
  readonly nodeId: string;
  readonly className: string;
}) {
  const harnessId = useMaybeEpicTuiAgentHarnessId(props.nodeId);
  if (harnessId === null) {
    return (
      <StaticEpicNodeIcon type="terminal-agent" className={props.className} />
    );
  }
  return <HarnessIcon harnessId={harnessId} className={props.className} />;
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
