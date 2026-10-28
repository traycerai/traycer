import { useCallback, useLayoutEffect, useRef } from "react";
import { RotateCcw, Smartphone, TriangleAlert, X } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import { SimulatorAgentBadge } from "@/components/simulator-tile/simulator-agent-badge";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import {
  revealSidebarNode,
  SIDEBAR_REVEAL_HIGHLIGHT_CLASS,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useSimulatorCatalogActions } from "@/hooks/simulator/use-simulator-catalog-actions";
import { useSimulatorInstanceOpen } from "@/hooks/simulator/use-simulator-instance-open";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import {
  simulatorIdleCountdownLabel,
  simulatorSessionEndedLabel,
  simulatorVersionLabel,
} from "@/lib/simulator-view/simulator-labels";
import { useIsActiveTile } from "@/stores/epics/canvas/store";
import type { SimulatorTileRef } from "@/stores/epics/canvas/types";
import {
  clearSidebarNodeRevealRequest,
  useSidebarNodeRevealRequest,
} from "@/stores/epics/sidebar-node-reveal-store";
import { cn } from "@/lib/utils";
import { SimulatorCreatePicker } from "./simulator-create-picker";
import {
  useSimulatorListModel,
  type SimulatorDeviceGroupModel,
  type SimulatorEndedRow,
  type SimulatorListModel,
  type SimulatorLiveRow,
  type SimulatorPendingRow,
} from "./use-simulator-list-model";

export function SimulatorsPanelActions(props: LeftPanelSlotProps) {
  return (
    <SimulatorCreatePicker
      epicId={props.epicId}
      tabId={props.tabId}
      onOpened={null}
      testId="epic-simulators-panel-add"
    />
  );
}

/**
 * The task's Mobile simulators panel: one row per instance the task holds on
 * any machine, from the cloud catalog, grouped by machine like browser tabs.
 * A row places its tile, which attaches to (or opens) the person's own
 * session; Close ends every session in the row. A session that ended without
 * the person asking stays as a closed row with its reason until dismissed.
 */
export function SimulatorsPanelBody(props: LeftPanelSlotProps) {
  const { epicId, tabId } = props;
  const model = useSimulatorListModel(epicId);
  const listRef = useRef<HTMLDivElement>(null);
  const revealRequest = useSidebarNodeRevealRequest(tabId);
  useLayoutEffect(() => {
    if (revealRequest === null || listRef.current === null) return;
    if (
      revealSidebarNode(
        listRef.current,
        revealRequest.nodeId,
        revealRequest.nonce,
      )
    )
      clearSidebarNodeRevealRequest(tabId, revealRequest.nonce);
  }, [model.groups, revealRequest, tabId]);
  return (
    <SidebarContent className="min-h-0">
      <SidebarGroup className="min-h-0 flex-1">
        <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
          <SimulatorListFeedback model={model} epicId={epicId} tabId={tabId} />
          <div
            ref={listRef}
            className="min-w-0 space-y-1"
            data-testid="epic-simulators-panel-list"
          >
            {model.groups.map((group) => (
              <SimulatorDeviceGroup
                key={group.hostId}
                group={group}
                epicId={epicId}
                tabId={tabId}
                nowMs={model.nowMs}
              />
            ))}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}

/** Loading, not-ready, unreadable and empty: what the panel says instead of rows. */
export function SimulatorListFeedback(props: {
  readonly model: SimulatorListModel;
  readonly epicId: string;
  readonly tabId: string;
}) {
  const { model } = props;
  if (model.notReady)
    return (
      <p
        role="status"
        className="px-2 py-2 text-ui-xs text-muted-foreground"
        data-testid="simulator-list-not-ready"
      >
        Mobile simulators in tasks aren't available yet.
      </p>
    );
  if (model.loading)
    return (
      <div
        role="status"
        className="flex items-center gap-2 px-2 py-1.5 text-ui-sm text-muted-foreground"
      >
        <AgentSpinningDots
          className="shrink-0"
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
        <span>Loading simulators…</span>
      </div>
    );
  if (model.status === "error")
    return (
      <div
        role="status"
        className="flex items-center gap-2 px-2 py-2 text-ui-xs text-muted-foreground"
        data-testid="simulator-list-error"
      >
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">Couldn't load simulators.</span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={model.refresh}
        >
          <RotateCcw className="size-3.5" aria-hidden />
          Retry
        </Button>
      </div>
    );
  if (model.rowCount > 0) return null;
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center text-muted-foreground"
      data-testid="simulator-list-empty-state"
    >
      <Smartphone className="size-8 text-muted-foreground/45" aria-hidden />
      <p className="text-ui-sm">No simulators open in this task.</p>
      <SimulatorCreatePicker
        epicId={props.epicId}
        tabId={props.tabId}
        onOpened={null}
        testId="simulator-empty-add"
      />
    </div>
  );
}

function SimulatorDeviceGroup(props: {
  readonly group: SimulatorDeviceGroupModel;
  readonly epicId: string;
  readonly tabId: string;
  readonly nowMs: number;
}) {
  const { group } = props;
  return (
    <section
      className="min-w-0"
      aria-label={`Simulators on ${group.name}`}
      data-testid={`simulator-device-group-${group.hostId}`}
    >
      <div className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-ui-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-medium">
          {group.name}
        </span>
        {group.isLocal ? <span className="shrink-0">Local</span> : null}
        {group.offline ? <span className="shrink-0">Offline</span> : null}
        <span className="shrink-0 tabular-nums">{group.rows.length}</span>
      </div>
      <ul aria-label={`Simulators on ${group.name}`} className="space-y-0.5">
        {group.rows.map((row) => {
          switch (row.kind) {
            case "live":
              return (
                <SimulatorLiveRowItem
                  key={row.key}
                  row={row}
                  epicId={props.epicId}
                  tabId={props.tabId}
                  offline={group.offline}
                  nowMs={props.nowMs}
                />
              );
            case "ended":
              return (
                <SimulatorEndedRowItem
                  key={row.key}
                  row={row}
                  epicId={props.epicId}
                />
              );
            case "pending":
              return <SimulatorPendingRowItem key={row.key} row={row} />;
          }
        })}
      </ul>
    </section>
  );
}

const ROW_CLASS =
  "group/simulator-row relative grid min-h-8 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center rounded-md transition-colors duration-100 motion-reduce:transition-none";

const ROW_ACTION_CLASS = cn(
  "size-6 cursor-pointer justify-self-center opacity-0 transition-opacity duration-100 pointer-events-none motion-reduce:transition-none",
  "group-focus-within/simulator-row:pointer-events-auto group-focus-within/simulator-row:opacity-100",
  "group-hover/simulator-row:pointer-events-auto group-hover/simulator-row:opacity-100",
  "group-data-[active=true]/simulator-row:pointer-events-auto group-data-[active=true]/simulator-row:opacity-100",
  "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
);

function SimulatorLiveRowItem(props: {
  readonly row: SimulatorLiveRow;
  readonly epicId: string;
  readonly tabId: string;
  readonly offline: boolean;
  readonly nowMs: number;
}) {
  const { row, epicId, tabId } = props;
  const isActive = useIsActiveTile(tabId, row.tileId, row.hostId);
  const { openTile } = useEpicTileNavigation();
  const { closeRecords, closing } = useSimulatorCatalogActions(epicId);
  const { open } = useSimulatorInstanceOpen(epicId);
  const place = useCallback(
    (ref: SimulatorTileRef) => {
      openTile(tileIntent(ref, { tabId }, "explicit", "direct_ui"));
    },
    [openTile, tabId],
  );
  // A watch is a session of the person's own, so the row sends the open and
  // the tile lands on its answer - the picker's and the switcher's path. A
  // tile placed on its own would dedupe onto the existing one, which stopped
  // attaching the moment the person's session ended elsewhere.
  const openRow = useCallback(() => {
    open({
      hostId: row.hostId,
      target: {
        simulatorId: row.simulatorId,
        platform: row.platform,
        name: row.name,
        version: row.version,
      },
      instance: row.instanceKey,
      place,
    });
  }, [
    open,
    place,
    row.hostId,
    row.instanceKey,
    row.name,
    row.platform,
    row.simulatorId,
    row.version,
  ]);
  const versionLabel = simulatorVersionLabel(row);
  const countdown = simulatorIdleCountdownLabel(row.idleUntil, props.nowMs);
  const rowClosing = row.records.some((record) => closing(record.sessionId));
  return (
    <li>
      <div
        data-active={isActive}
        data-sidebar-node-id={row.tileId}
        className={cn(
          ROW_CLASS,
          isActive
            ? "bg-accent text-accent-foreground"
            : "text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground",
          SIDEBAR_REVEAL_HIGHLIGHT_CLASS,
        )}
      >
        <button
          type="button"
          data-testid={`epic-simulator-row-${row.instanceKey}`}
          aria-label={[
            row.name,
            versionLabel,
            row.drivenByAgent ? "driven by an agent" : null,
            countdown,
          ]
            .filter((part) => part !== null)
            .join(", ")}
          disabled={props.offline}
          className="flex min-h-8 min-w-0 cursor-pointer flex-col justify-center rounded-md px-2 py-1 text-left text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
          onClick={openRow}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Smartphone className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            {row.drivenByAgent ? <SimulatorAgentBadge /> : null}
            <span className="shrink-0 text-ui-xs text-muted-foreground">
              {versionLabel}
            </span>
          </span>
          {countdown === null ? null : (
            <span
              className="truncate pl-6 text-ui-xs text-muted-foreground"
              data-testid={`epic-simulator-row-countdown-${row.instanceKey}`}
            >
              {countdown}
            </span>
          )}
        </button>
        <Button
          type="button"
          variant="muted-destructive"
          size="icon-xs"
          disabled={rowClosing}
          aria-label={`Close ${row.name} in this task`}
          data-testid={`epic-simulator-row-close-${row.instanceKey}`}
          className={cn(
            ROW_ACTION_CLASS,
            rowClosing && "pointer-events-auto opacity-100",
          )}
          onClick={() => closeRecords(row.hostId, row.records)}
        >
          {rowClosing ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : (
            <X className="size-3.5" aria-hidden />
          )}
        </Button>
      </div>
    </li>
  );
}

function SimulatorEndedRowItem(props: {
  readonly row: SimulatorEndedRow;
  readonly epicId: string;
}) {
  const { row, epicId } = props;
  const { closeRecords, closing } = useSimulatorCatalogActions(epicId);
  const dismissing = closing(row.record.sessionId);
  const notice = simulatorSessionEndedLabel(row.reason);
  return (
    <li>
      <div
        data-sidebar-node-id={row.tileId}
        data-testid={`epic-simulator-ended-row-${row.record.sessionId}`}
        className={cn(ROW_CLASS, "text-muted-foreground")}
      >
        <div className="flex min-h-8 min-w-0 flex-col justify-center px-2 py-1 text-ui-sm">
          <span className="flex min-w-0 items-center gap-2">
            <Smartphone className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            <span className="shrink-0 text-ui-xs">
              {simulatorVersionLabel(row)}
            </span>
          </span>
          <span className="truncate pl-6 text-ui-xs">{notice}</span>
        </div>
        <Button
          type="button"
          variant="muted"
          size="icon-xs"
          disabled={dismissing}
          aria-label={`Dismiss ${row.name}: ${notice}`}
          data-testid={`epic-simulator-row-dismiss-${row.record.sessionId}`}
          className="size-6 cursor-pointer justify-self-center"
          onClick={() => closeRecords(row.hostId, [row.record])}
        >
          {dismissing ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : (
            <X className="size-3.5" aria-hidden />
          )}
        </Button>
      </div>
    </li>
  );
}

function SimulatorPendingRowItem(props: { readonly row: SimulatorPendingRow }) {
  const { row } = props;
  return (
    <li>
      <div
        role="status"
        data-testid={`epic-simulator-pending-row-${row.requestId}`}
        className={cn(ROW_CLASS, "text-foreground/75")}
      >
        <span className="flex min-h-8 min-w-0 items-center gap-2 px-2 text-ui-sm">
          <Smartphone className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          <span className="shrink-0 text-ui-xs text-muted-foreground">
            {row.attaching ? "Opening" : "Booting"}
          </span>
          <AgentSpinningDots
            className="shrink-0"
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
        </span>
      </div>
    </li>
  );
}
