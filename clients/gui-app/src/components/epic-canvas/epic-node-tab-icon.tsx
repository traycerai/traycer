import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ChatProgressIcon } from "@/components/chat/chat-progress-icon";
import {
  NotificationIndicatorIcon,
  type IndicatorRunningKind,
} from "@/components/notifications/notification-indicator-icon";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  EPIC_NODE_ICONS,
  type EpicNodeKind,
} from "@/lib/artifacts/node-display";
import {
  useMaybeEpicTuiAgentHarnessId,
  useRegisteredEpicActiveAgentIds,
  useRegisteredEpicNodeArchived,
} from "@/lib/epic-selectors";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  WORKSPACE_FILE_TAB_KIND,
  type EpicArtifactRef,
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
  /**
   * Idle-slot override for live chat icons (e.g. title-generation spinner).
   * Ignored for non-chat / static paths. Semantic chat status still wins.
   */
  readonly defaultIcon: ReactNode | undefined;
}) {
  if (
    props.variant === "live" &&
    (props.node.type === "chat" || props.node.type === "terminal-agent")
  ) {
    return <ArchiveAwareEpicNodeTabIcon {...props} />;
  }
  return <EpicNodeTabIconContent {...props} />;
}

/**
 * Live chat/TUI tab icon decoration. Kept in a leaf so non-archivable node
 * kinds do not subscribe to the epic projection, and provider-less drag
 * previews keep rendering through the registry-backed selector.
 */
function ArchiveAwareEpicNodeTabIcon(props: {
  readonly node: EpicNodeRef;
  readonly epicId: string;
  readonly variant: "live" | "static";
  readonly className: string;
  readonly defaultIcon: ReactNode | undefined;
}) {
  const isArchived = useRegisteredEpicNodeArchived(props.epicId, props.node.id);
  const icon = <EpicNodeTabIconContent {...props} />;
  if (!isArchived) return icon;
  return (
    <span
      className="inline-flex size-3.5 shrink-0 opacity-50"
      data-testid="archived-tab-icon"
    >
      {icon}
    </span>
  );
}

function EpicNodeTabIconContent(props: {
  readonly node: EpicNodeRef;
  readonly epicId: string;
  readonly variant: "live" | "static";
  readonly className: string;
  readonly defaultIcon: ReactNode | undefined;
}) {
  if (props.node.type === "chat" && props.variant === "live") {
    return (
      <ChatProgressIcon
        epicId={props.epicId}
        chatId={props.node.id}
        className={props.className}
        mutedClassName="text-muted-foreground"
        testId="chat-tab-spinner"
        defaultIcon={props.defaultIcon}
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
  if (props.variant === "live" && props.node.type === "terminal") {
    return (
      <TerminalNodeTabIcon
        nodeId={props.node.id}
        epicId={props.epicId}
        running={false}
        runningTitle=""
        defaultIcon={
          <StaticEpicNodeIcon type="terminal" className={props.className} />
        }
      />
    );
  }
  if (props.variant === "live" && props.node.type === "terminal-agent") {
    return (
      <TuiAgentLiveTabIcon
        nodeId={props.node.id}
        epicId={props.epicId}
        pendingTuiHarnessId={props.node.pendingTuiHarnessId}
        className={props.className}
      />
    );
  }
  if (props.node.type === "terminal-agent") {
    return (
      <TuiAgentTabIcon
        nodeId={props.node.id}
        pendingTuiHarnessId={props.node.pendingTuiHarnessId}
        className={props.className}
      />
    );
  }
  return (
    <StaticEpicNodeIcon type={props.node.type} className={props.className} />
  );
}

function TerminalNodeTabIcon(props: {
  readonly nodeId: string;
  readonly epicId: string;
  readonly running: IndicatorRunningKind;
  readonly runningTitle: string;
  readonly defaultIcon: ReactNode;
}) {
  const indicatorState = useSurfaceNotificationIndicatorState({
    epicId: props.epicId,
    chatId: props.nodeId,
  });
  return (
    <NotificationIndicatorIcon
      state={indicatorState}
      running={props.running}
      subjectId={props.nodeId}
      testIdPrefix="terminal-tab"
      className={undefined}
      style={undefined}
      runningTitle={props.runningTitle}
      defaultIcon={props.defaultIcon}
      statusPresentation="spinner"
    />
  );
}

/**
 * Live TUI-agent tab icon: swaps the harness brand mark for the running
 * spinner while the agent is working, mirroring the sidebar's terminal-agent
 * row so both surfaces read the same. Epic-wide active-agent awareness is the
 * sole authority - a TUI agent's PTY runs host-side, so there is no renderer
 * run-status to smooth against and no background tier to distinguish.
 * Notification tones still outrank the spinner (see NotificationIndicatorIcon).
 *
 * Reads awareness through the registry rather than `useOpenEpicHandle`, so this
 * icon stays renderable outside an `<EpicSessionProvider>` (drag previews,
 * mount-lifecycle tests) - an unregistered Epic degrades to "not working"
 * instead of throwing. The plain-terminal path stays hook-free entirely: a
 * shell tab has no agent to be active.
 */
function TuiAgentLiveTabIcon(props: {
  readonly nodeId: string;
  readonly epicId: string;
  readonly pendingTuiHarnessId: EpicArtifactRef["pendingTuiHarnessId"];
  readonly className: string;
}) {
  const isActive = useRegisteredEpicActiveAgentIds(props.epicId).has(
    props.nodeId,
  );
  return (
    <TerminalNodeTabIcon
      nodeId={props.nodeId}
      epicId={props.epicId}
      running={isActive ? "turn" : false}
      runningTitle="Agent in progress"
      defaultIcon={
        <TuiAgentTabIcon
          nodeId={props.nodeId}
          pendingTuiHarnessId={props.pendingTuiHarnessId}
          className={props.className}
        />
      }
    />
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
  readonly pendingTuiHarnessId: EpicArtifactRef["pendingTuiHarnessId"];
  readonly className: string;
}) {
  const projectedHarnessId = useMaybeEpicTuiAgentHarnessId(props.nodeId);
  const harnessId = projectedHarnessId ?? props.pendingTuiHarnessId ?? null;
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
