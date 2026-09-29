import { useState, type MouseEvent, type ReactNode } from "react";
import { useLayoutRegion } from "@/components/layout-editor/use-layout-region";
import { useLayoutSurface } from "@/components/layout-editor/use-layout-surface";
import { LAYOUT_CLUSTER_ATTRIBUTE } from "@/components/layout-editor/canvas/canvas-attributes";
import { ChatProgressIcon } from "@/components/chat/chat-progress-icon";
import { CommentSidebar } from "@/components/comments/comment-sidebar";
import { PrPanelBodyContent } from "@/components/epic-canvas/pr/pr-panel-body";
import { ResourceUsageChip } from "@/components/resources/resource-usage-chip";
import { useNavigatorResourceMetrics } from "@/hooks/resources/use-navigator-resource-metrics";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  Sidebar,
  SidebarGroup,
  SidebarGroupContent,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { TreeChevronSpacer } from "@/components/ui/tree-chevron";
import { ArtifactRowView } from "@/components/epic-canvas/sidebar/artifact-row-view";
import { ChatRowView } from "@/components/epic-canvas/sidebar/chat-row-view";
import { ChatRowIdleTime } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import {
  LeftPanelBody,
  type LeftPanelDefinition,
} from "@/components/epic-canvas/sidebar/epic-sidebar";
import { RailButton } from "@/components/epic-canvas/sidebar/epic-sidebar-rail";
import {
  artifactRowClassName,
  chatRowClassName,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import { PanelTaskHeaderBody } from "@/components/epic-canvas/sidebar/panel-task-header-body";
import { RailContextMenuContent } from "@/components/epic-canvas/sidebar/rail-context-menu-content";
import { LeftPanelRailDivider } from "@/components/epic-canvas/sidebar/left-panel-rail-divider";
import { LeftPanelRailStack } from "@/components/epic-canvas/sidebar/left-panel-rail-stack";
import { railGroupLabel } from "@/components/epic-canvas/sidebar/left-panel-rail-tile";
import {
  getLeftPanelDefinition,
  isLeftPanelVisible,
  type LeftPanelAvailabilityContext,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { SidebarReparentRowDropWrapper } from "@/components/epic-canvas/sidebar/sidebar-reparent-row-drop-wrapper";
import { useRailDividersEditing } from "@/components/epic-canvas/sidebar/use-rail-dividers-editing";
import { MonogramChip } from "@/components/layout/tabs/monogram-chip";
import {
  sideTabTileOf,
  tabAutoTint,
} from "@/components/layout/tabs/tab-identity";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import { useArrangementValue } from "@/lib/layout-overrides";
import {
  leftPanelIdForRailRegion,
  railDisplayEntries,
  railStackMembersFor,
  RAIL_REGION_IDS,
  type RailDisplayEntry,
} from "@/lib/layout/rail";
import {
  useLayoutRail,
  usePanelVisibilityOverrides,
} from "@/lib/layout/rail-view";
import type { RailRegionId } from "@/lib/layout/region-id";
import type { LeftPanelId } from "@/lib/left-panel-ids";
import { cn } from "@/lib/utils";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useSidebarWidthPx } from "@/stores/epics/left-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  SAMPLE_COMMENT_THREADS,
  SAMPLE_EPIC_ID,
  SAMPLE_HOST_ID,
  SAMPLE_OPEN_ARTIFACT_ID,
  SAMPLE_PULL_REQUESTS,
  SAMPLE_RAIL_PRESENCE,
  SAMPLE_SIDEBAR_AGENTS,
  SAMPLE_SIDEBAR_ARTIFACTS,
  SAMPLE_TASK_TITLE,
  SAMPLE_VIEW_TAB_ID,
  sampleNoop,
} from "./sample-workspace-scene";

const MINUTE_MS = 60_000;

/**
 * The sample scene's sidebar, expanded, drawn from the real sidebar's own
 * components (F3): the rail's tiles, stacks and dividers, the task header, the
 * sidebar body with its sections and split, and the agent and artifact rows.
 * What is the sample's own is only the data: the sample task's rows, and a
 * `Body` per panel that feeds them in.
 *
 * The body shows the panel the user is customizing: the selected Sidebar
 * setting when it is a panel, otherwise the rail's first. A hidden panel is
 * absent at rest and materialises, ghosted, only while its setting is hovered
 * or selected (C3).
 *
 * The `<aside>` is the sidebar surface: its empty space selects it, a drag
 * moves it, and its rail is the cluster a rail drag resolves against. A
 * right-click answers with the REAL rail's menu (L-144).
 */
export function SampleWorkspaceSidebar(): ReactNode {
  const rail = useLayoutRail();
  const sidebarSide = useArrangementValue("sidebarSide");
  const dividersEditing = useRailDividersEditing();
  const surfaceRef = useLayoutSurface("sidebar");
  const widthPx = useSidebarWidthPx();
  const visibilityOverrideById = usePanelVisibilityOverrides();
  const hovered = useLayoutEditorStore((state) => state.hovered);
  const selected = useLayoutEditorStore((state) => state.selected);
  const [contextPanelId, setContextPanelId] = useState<LeftPanelId | null>(
    null,
  );
  const context: LeftPanelAvailabilityContext = {
    ...SAMPLE_RAIL_PRESENCE,
    visibilityOverrideById,
  };
  const panelShown = (regionId: RailRegionId): boolean =>
    isLeftPanelVisible(
      getLeftPanelDefinition(leftPanelIdForRailRegion(regionId)),
      context,
    );
  const drawn = (regionId: RailRegionId): boolean =>
    panelShown(regionId) || regionId === hovered || regionId === selected;
  const entries = railDisplayEntries(rail, drawn);
  const displayedRegion =
    RAIL_REGION_IDS.find((id) => id === selected && drawn(id)) ??
    firstPanel(entries);
  const displayedPanels =
    displayedRegion === null
      ? []
      : railStackMembersFor(rail, displayedRegion, drawn).map((regionId) =>
          samplePanelDefinition(leftPanelIdForRailRegion(regionId)),
        );
  const isActive = (regionId: RailRegionId): boolean =>
    displayedPanels.some(
      (panel) => panel.id === leftPanelIdForRailRegion(regionId),
    );
  return (
    <aside
      ref={surfaceRef}
      aria-label="Sample sidebar"
      className={cn(
        "hidden min-h-0 max-w-[50vw] shrink-0 flex-col overflow-hidden bg-background md:flex",
        sidebarSide === "left" ? "border-r" : "border-l",
      )}
      style={{ width: widthPx }}
    >
      <SidebarProvider defaultOpen className="h-full min-h-0 w-full flex-col">
        <ContextMenu>
          <ContextMenuTrigger
            onContextMenu={(event: MouseEvent<HTMLElement>) => {
              setContextPanelId(pointedPanelId(event.target));
            }}
            render={
              <div
                role="toolbar"
                aria-label="Sample sidebar panels"
                aria-orientation="horizontal"
                {...{ [LAYOUT_CLUSTER_ATTRIBUTE]: "" }}
                className="relative flex h-10 w-full min-w-0 shrink-0 flex-row items-center justify-center-safe gap-1 overflow-x-auto bg-background px-2"
              >
                {entries.map((entry) => {
                  if (entry.kind === "panel")
                    return (
                      <SampleRailTile
                        key={entry.id}
                        regionId={entry.id}
                        label={panelTitle(entry.id)}
                        active={isActive(entry.id)}
                      />
                    );
                  if (entry.kind === "stack")
                    return (
                      <LeftPanelRailStack
                        key={entry.id}
                        stackId={entry.id}
                        memberCount={entry.members.length}
                        showCount={dividersEditing}
                      >
                        <SampleRailTile
                          regionId={entry.members[0]}
                          label={railGroupLabel(entry.members.map(panelTitle))}
                          active={isActive(entry.members[0])}
                        />
                      </LeftPanelRailStack>
                    );
                  return (
                    <LeftPanelRailDivider
                      key={entry.id}
                      dividerId={entry.id}
                      orientation="horizontal"
                      editing={dividersEditing}
                    />
                  );
                })}
              </div>
            }
          />
          <RailContextMenuContent
            context={context}
            contextPanelId={contextPanelId}
          />
        </ContextMenu>
        <PanelTaskHeaderBody
          testId={null}
          chip={
            <MonogramChip
              tile={sideTabTileOf({
                appearance: null,
                title: SAMPLE_TASK_TITLE,
                titleGenerating: false,
                fallback: null,
              })}
              tint={tabAutoTint(SAMPLE_EPIC_ID)}
              tinted
            />
          }
          title={SAMPLE_TASK_TITLE}
          titleEditor={null}
          titleAction={null}
        />
        <div className="min-h-0 flex-1">
          {displayedPanels.length === 0 ? null : (
            <Sidebar
              collapsible="none"
              className="w-full"
              data-layout-passive
              data-sample-sidebar-body
            >
              <LeftPanelBody
                epicId={SAMPLE_EPIC_ID}
                tabId={SAMPLE_VIEW_TAB_ID}
                panels={displayedPanels}
              />
            </Sidebar>
          )}
        </div>
      </SidebarProvider>
    </aside>
  );
}

function firstPanel(
  entries: ReadonlyArray<RailDisplayEntry>,
): RailRegionId | null {
  for (const entry of entries) {
    if (entry.kind === "panel") return entry.id;
    if (entry.kind === "stack") return entry.members[0];
  }
  return null;
}

/** The rail panel under the pointer, read off the region the tile names. */
function pointedPanelId(target: EventTarget): LeftPanelId | null {
  if (!(target instanceof Element)) return null;
  const named = target
    .closest("[data-layout-region]")
    ?.getAttribute("data-layout-region");
  const regionId = RAIL_REGION_IDS.find((id) => id === named) ?? null;
  return regionId === null ? null : leftPanelIdForRailRegion(regionId);
}

function panelTitle(regionId: RailRegionId): string {
  return getLeftPanelDefinition(leftPanelIdForRailRegion(regionId)).title;
}

function SampleRailTile(props: {
  readonly regionId: RailRegionId;
  readonly label: string;
  readonly active: boolean;
}): ReactNode {
  const { ref } = useLayoutRegion({
    regionId: props.regionId,
    instanceId: null,
  });
  return (
    <RailButton
      buttonRef={ref}
      handleListeners={undefined}
      panelId={leftPanelIdForRailRegion(props.regionId)}
      label={props.label}
      orientation="horizontal"
      active={props.active}
      isDragSource={false}
      dropCue={null}
      testId={`sample-rail-${leftPanelIdForRailRegion(props.regionId)}`}
      onClick={sampleNoop}
      onContextMenu={sampleNoop}
    />
  );
}

/** A panel as the real sidebar body takes it, with the sample's own Body. */
function samplePanelDefinition(panelId: LeftPanelId): LeftPanelDefinition {
  return {
    ...getLeftPanelDefinition(panelId),
    Body: SAMPLE_PANEL_BODIES[panelId],
    Actions: null,
    Subtitle: null,
  };
}

/**
 * Each panel's sample Body. The sample task has agents, artifacts, pull
 * requests and comments; every other panel draws the sidebar's own empty
 * state for it.
 */
const SAMPLE_PANEL_BODIES: Readonly<Record<LeftPanelId, () => ReactNode>> = {
  chats: SampleAgentsBody,
  artifacts: SampleArtifactsBody,
  terminals: sampleEmptyBody("terminals"),
  browsers: sampleEmptyBody("browsers"),
  "git-diff": sampleEmptyBody("git-diff"),
  "pull-requests": SamplePullRequestsBody,
  "file-tree": sampleEmptyBody("file-tree"),
  sharing: sampleEmptyBody("sharing"),
  comments: SampleCommentsBody,
};

function SampleAgentsBody(): ReactNode {
  const [now] = useState(() => Date.now());
  // The real rows' own selector, so "Readings on agent rows" and the Resource
  // monitor's Metrics drive these exactly as they drive the user's.
  const resourceMetrics = useNavigatorResourceMetrics();
  return (
    <SamplePanelList label="Sample agents">
      {SAMPLE_SIDEBAR_AGENTS.map((agent) => (
        <SampleTreeItem key={agent.id} nodeId={agent.id} panelId="chats">
          <div
            className={chatRowClassName({
              isDragging: false,
              showRowControls: false,
              reserveArchiveSlot: false,
              selectionMode: false,
              isArchived: false,
              isActive: false,
              revealRowControls: false,
            })}
          >
            <ChatRowView
              chevron={<TreeChevronSpacer />}
              selection={null}
              leadingIcon={
                <ChatProgressIcon
                  epicId={SAMPLE_EPIC_ID}
                  chatId={agent.id}
                  hostId={SAMPLE_HOST_ID}
                  className={undefined}
                  mutedClassName="text-muted-foreground/70"
                  testId="sample-sidebar-agent-icon"
                  defaultIcon={undefined}
                />
              }
              nodeName={agent.title}
              isArchived={false}
              badges={
                <>
                  <ResourceUsageChip
                    {...agent.resources}
                    pssBytes={null}
                    metrics={resourceMetrics}
                    label="Resource usage"
                    className={undefined}
                  />
                  <ChatRowIdleTime
                    updatedAt={now - agent.idleMinutes * MINUTE_MS}
                  />
                </>
              }
            />
          </div>
        </SampleTreeItem>
      ))}
    </SamplePanelList>
  );
}

function SampleArtifactsBody(): ReactNode {
  const artifactIconColorMode = useSettingsStore(
    (state) => state.artifactIconColorMode,
  );
  const iconColor = useSettingsStore((state) => state.artifactIconColors.spec);
  return (
    <SamplePanelList label="Sample artifacts">
      {SAMPLE_SIDEBAR_ARTIFACTS.map((artifact, index) => (
        <SampleTreeItem
          key={artifact.id}
          nodeId={artifact.id}
          panelId="artifacts"
        >
          <div
            className={artifactRowClassName({
              isDragging: false,
              padRightClass: "pr-2",
              selectionMode: false,
              // The first is the artifact open in the sample task.
              isActive: index === 0,
            })}
          >
            <ArtifactRowView
              nodeId={artifact.id}
              nodeName={artifact.name}
              hasChildren={false}
              expanded={false}
              onToggle={sampleNoop}
              selection={null}
              Icon={EPIC_NODE_ICONS.spec}
              artifactIconColorMode={artifactIconColorMode}
              iconStyle={
                artifactIconColorMode === "byType"
                  ? { color: iconColor }
                  : undefined
              }
              statusValue={null}
              showStatusDot={false}
              unreadMarkerVariant={null}
            />
          </div>
        </SampleTreeItem>
      ))}
    </SamplePanelList>
  );
}

function SamplePullRequestsBody(): ReactNode {
  return (
    <PrPanelBodyContent
      epicId={SAMPLE_EPIC_ID}
      tabId={SAMPLE_VIEW_TAB_ID}
      // No host: the rows open no tile.
      hostId={null}
      items={SAMPLE_PULL_REQUESTS}
      sourceStatus="ok"
      error={null}
      isPending={false}
      hasCachedData
    />
  );
}

/** Every sample thread has its anchor in the open artifact. */
const SAMPLE_ANCHOR_POSITIONS = {
  positions: new Map(
    SAMPLE_COMMENT_THREADS.map((thread, index) => [thread.threadId, index]),
  ),
};

function SampleCommentsBody(): ReactNode {
  return (
    <CommentSidebar
      epicId={SAMPLE_EPIC_ID}
      hostClient={null}
      artifactType="spec"
      artifactId={SAMPLE_OPEN_ARTIFACT_ID}
      laneThreads={SAMPLE_COMMENT_THREADS}
      laneDroppedAt={null}
      commentRoomAvailability={{ kind: "available" }}
      anchorPositions={SAMPLE_ANCHOR_POSITIONS}
      currentUserId={null}
      canModerate={false}
      onActivateThread={sampleNoop}
    />
  );
}

function SamplePanelList(props: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
        <ul role="tree" aria-label={props.label} className="space-y-0.5">
          {props.children}
        </ul>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function SampleTreeItem(props: {
  readonly nodeId: string;
  readonly panelId: "chats" | "artifacts";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <li role="treeitem" aria-selected={false}>
      <SidebarReparentRowDropWrapper
        epicId={SAMPLE_EPIC_ID}
        viewTabId={SAMPLE_VIEW_TAB_ID}
        nodeId={props.nodeId}
        panelId={props.panelId}
        contextMenu={null}
      >
        {props.children}
      </SidebarReparentRowDropWrapper>
    </li>
  );
}

/** A Body for a panel the sample task has no rows for. */
function sampleEmptyBody(panelId: LeftPanelId): () => ReactNode {
  const definition = getLeftPanelDefinition(panelId);
  return function SamplePanelEmptyBody(): ReactNode {
    return (
      <SidebarPanelEmptyState
        icon={definition.icon}
        title={definition.title}
        description={`The sample task has no ${definition.title.toLowerCase()}.`}
        testId={undefined}
      />
    );
  };
}
