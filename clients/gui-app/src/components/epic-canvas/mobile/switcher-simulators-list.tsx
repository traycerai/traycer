import { useCallback } from "react";
import { Smartphone, X } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { SimulatorAgentBadge } from "@/components/simulator-tile/simulator-agent-badge";
import { SimulatorCreatePicker } from "@/components/epic-canvas/sidebar/simulator-create-picker";
import { SimulatorListFeedback } from "@/components/epic-canvas/sidebar/epic-simulators-panel";
import {
  useSimulatorListModel,
  type SimulatorEndedRow,
  type SimulatorListRow,
  type SimulatorLiveRow,
} from "@/components/epic-canvas/sidebar/use-simulator-list-model";
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
import { SwitcherListHeader, SwitcherListRow } from "./switcher-list-row";

interface SwitcherListProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * The Mobile simulators category: the desktop panel's rows in the switcher's
 * touch chrome, grouped by machine. A tap watches the row's instance the way
 * the palette does - the open is sent with the instance and a `requestId`,
 * and the tile lands once it answers - and closes the sheet at once, so a
 * slow boot never holds it.
 */
export function SwitcherSimulatorsList(props: SwitcherListProps) {
  const { epicId, tabId, onClose } = props;
  const model = useSimulatorListModel(epicId);
  const { open } = useSimulatorInstanceOpen(epicId);
  const { openTile } = useEpicTileNavigation();
  const place = useCallback(
    (ref: SimulatorTileRef) => {
      openTile(tileIntent(ref, { tabId }, "single", "direct_ui"));
    },
    [openTile, tabId],
  );
  const watch = useCallback(
    (row: SimulatorLiveRow) => {
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
      onClose();
    },
    [onClose, open, place],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SwitcherListHeader
        search={null}
        action={
          <SimulatorCreatePicker
            epicId={epicId}
            tabId={tabId}
            onOpened={onClose}
            testId="switcher-new-simulator"
          />
        }
        viewMenu={null}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain p-1 pb-safe-bottom">
        <SimulatorListFeedback model={model} epicId={epicId} tabId={tabId} />
        <div className="min-w-0 space-y-1">
          {model.groups.map((group) => (
            <section
              key={group.hostId}
              aria-label={`Simulators on ${group.name}`}
              className="min-w-0"
            >
              <h3 className="flex min-h-11 items-center gap-1.5 px-3 text-ui-xs text-muted-foreground">
                <span className="min-w-0 flex-1 truncate font-medium">
                  {group.name}
                </span>
                {group.isLocal ? <span>Local</span> : null}
                {group.offline ? <span>Offline</span> : null}
              </h3>
              <div className="flex flex-col gap-0.5">
                {group.rows.map((row) => (
                  <SwitcherSimulatorRow
                    key={row.key}
                    row={row}
                    epicId={epicId}
                    tabId={tabId}
                    offline={group.offline}
                    nowMs={model.nowMs}
                    onWatch={watch}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function SwitcherSimulatorRow(props: {
  readonly row: SimulatorListRow;
  readonly epicId: string;
  readonly tabId: string;
  readonly offline: boolean;
  readonly nowMs: number;
  readonly onWatch: (row: SimulatorLiveRow) => void;
}) {
  const { row } = props;
  const isActive = useIsActiveTile(
    props.tabId,
    row.kind === "pending" ? "" : row.tileId,
    row.hostId,
  );
  const { onWatch, offline } = props;
  // The row has no disabled state, so a tap on an offline machine's row, a
  // closed row or a pending one is simply not acted on.
  const onSelect = useCallback(() => {
    if (row.kind !== "live" || offline) return;
    onWatch(row);
  }, [offline, onWatch, row]);
  const icon = <Smartphone className="size-4" aria-hidden />;
  if (row.kind === "pending")
    return (
      <SwitcherListRow
        disabled={false}
        icon={icon}
        label={row.name}
        secondaryLabel="Booting"
        badge={
          <AgentSpinningDots
            className="shrink-0"
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
        }
        active={false}
        onSelect={onSelect}
        actions={null}
        selectTestId={`switcher-simulator-pending-${row.requestId}`}
      />
    );
  if (row.kind === "ended")
    return (
      <SwitcherListRow
        disabled={false}
        icon={icon}
        label={row.name}
        secondaryLabel={simulatorSessionEndedLabel(row.reason)}
        badge={null}
        active={false}
        onSelect={onSelect}
        actions={<SwitcherDismissAction row={row} epicId={props.epicId} />}
        selectTestId={`switcher-simulator-ended-${row.record.sessionId}`}
      />
    );
  const countdown = simulatorIdleCountdownLabel(row.idleUntil, props.nowMs);
  return (
    <SwitcherListRow
      disabled={false}
      icon={icon}
      label={row.name}
      secondaryLabel={
        countdown === null
          ? simulatorVersionLabel(row)
          : `${simulatorVersionLabel(row)} · ${countdown}`
      }
      badge={row.drivenByAgent ? <SimulatorAgentBadge /> : null}
      active={isActive}
      onSelect={onSelect}
      actions={<SwitcherCloseAction row={row} epicId={props.epicId} />}
      selectTestId={`switcher-simulator-row-${row.instanceKey}`}
    />
  );
}

/** Ends every session in the row; the desktop row's X. */
function SwitcherCloseAction(props: {
  readonly row: SimulatorLiveRow;
  readonly epicId: string;
}) {
  const { row } = props;
  const { closeRecords, closing } = useSimulatorCatalogActions(props.epicId);
  const pending = row.records.some((record) => closing(record.sessionId));
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={pending}
      aria-label={`Close ${row.name} in this task`}
      data-testid={`switcher-simulator-close-${row.instanceKey}`}
      className="shrink-0"
      onClick={() => closeRecords(row.hostId, row.records)}
    >
      {pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      ) : (
        <X className="size-4" aria-hidden />
      )}
    </Button>
  );
}

function SwitcherDismissAction(props: {
  readonly row: SimulatorEndedRow;
  readonly epicId: string;
}) {
  const { row } = props;
  const { closeRecords, closing } = useSimulatorCatalogActions(props.epicId);
  const pending = closing(row.record.sessionId);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={pending}
      aria-label={`Dismiss ${row.name}`}
      data-testid={`switcher-simulator-dismiss-${row.record.sessionId}`}
      className="shrink-0"
      onClick={() => closeRecords(row.hostId, [row.record])}
    >
      {pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      ) : (
        <X className="size-4" aria-hidden />
      )}
    </Button>
  );
}
