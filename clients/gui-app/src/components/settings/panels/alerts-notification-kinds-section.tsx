import type { ReactNode } from "react";
import { ALERTS } from "@/components/settings/panels/alerts-settings.definitions";
import { NotificationChimeSelect } from "@/components/settings/panels/notification-chime-select";
import { SettingsGroup } from "@/components/settings/settings-group";
import { Switch } from "@/components/ui/switch";
import { usePushSeveritySwitches } from "@/hooks/runner/use-push-severity-switches";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import type { NotificationChimeEventType } from "@/lib/notifications/notification-chime";
import { isPushPermissionRowAvailable } from "@/lib/settings/settings-availability";
import type { SettingsRowDefinition } from "@/lib/settings-search/settings-definitions";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { useSettingsStore } from "@/stores/settings/settings-store";

interface KindRow {
  readonly kind: NotificationChimeEventType;
  readonly row: SettingsRowDefinition;
}

const KIND_ROWS: ReadonlyArray<KindRow> = [
  { kind: "needs_action", row: ALERTS.definitions.needsAction },
  { kind: "failure", row: ALERTS.definitions.failure },
  { kind: "done", row: ALERTS.definitions.done },
  { kind: "info", row: ALERTS.definitions.info },
];

/**
 * One row per kind of notification: whether it interrupts on this device, and
 * its chime.
 *
 * The switch column belongs to the device. On a computer it is Notify, kept by
 * this app. In the phone app it is Push, the mute the phone keeps for the
 * account, and there is no second switch: Push also decides the toast while
 * the app is in front (`useNotificationNotifies`). The push hooks reach the
 * runner host, so only the phone's own child calls them.
 */
export function AlertsNotificationKindsSection(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  return isPushPermissionRowAvailable(availability) ? (
    <PushKinds />
  ) : (
    <NotifyKinds />
  );
}

function NotifyKinds(): ReactNode {
  const notify = useSettingsStore((state) => state.notificationNotify);
  const setNotify = useSettingsStore(
    (state) => state.setNotificationNotifyForEvent,
  );
  return (
    <KindsTable
      switchHeader="Notify"
      renderSwitch={(entry) => (
        <Switch
          checked={notify[entry.kind]}
          aria-label={`${entry.row.label} notifications`}
          onCheckedChange={(checked) => {
            setNotify(entry.kind, checked);
          }}
        />
      )}
    />
  );
}

function PushKinds(): ReactNode {
  const push = usePushSeveritySwitches();
  return (
    <KindsTable
      switchHeader="Push"
      renderSwitch={(entry) => (
        <Switch
          checked={push.delivers(entry.kind)}
          disabled={!push.editable}
          aria-label={`${entry.row.label} push notifications`}
          onCheckedChange={(delivered) => {
            push.setDelivered(entry.kind, delivered);
          }}
        />
      )}
    />
  );
}

/**
 * Every row is a subgrid of one grid, so the switch and chime columns line up
 * under their headings whatever the labels' lengths. The description sits
 * under the label from `md` up and spans the row below it, where the label
 * column alone would be a few words wide.
 */
const ROW = "col-span-full grid grid-cols-subgrid";

function KindsTable(props: {
  readonly switchHeader: string;
  readonly renderSwitch: (entry: KindRow) => ReactNode;
}): ReactNode {
  const compact = useSettingsDensity() === "compact";
  const sounds = useSettingsStore((state) => state.notificationChimeSounds);
  const setSoundForEvent = useSettingsStore(
    (state) => state.setNotificationChimeSoundForEvent,
  );
  const padding = compact ? "px-4" : "px-5";
  return (
    <SettingsGroup
      group={ALERTS.definitions.notifications}
      // The column headings name the card's contents; a title over them would
      // be a second name for the same table.
      showTitle={false}
      tone="default"
      dataTestId="alerts-notification-kinds"
      fill={false}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 md:gap-x-6">
        {/* For the eye only: each control already names its kind and column. */}
        <div
          aria-hidden
          className={cn(
            ROW,
            "border-b border-border/40 py-2 text-ui-xs font-medium text-muted-foreground",
            padding,
          )}
        >
          <span>Kind</span>
          <span className="text-center">{props.switchHeader}</span>
          <span>Chime</span>
        </div>
        {KIND_ROWS.map((entry) => (
          <div
            key={entry.kind}
            data-settings-anchor={entry.row.anchor ?? undefined}
            className={cn(
              ROW,
              "items-center gap-y-1 border-b border-border/40 last:border-b-0",
              padding,
              compact ? "py-2.5" : "py-4",
            )}
          >
            <div className="col-start-1 row-start-1 font-medium text-foreground">
              {entry.row.label}
            </div>
            <p className="col-span-full row-start-2 break-words text-pretty text-ui-sm text-muted-foreground md:col-span-1">
              {entry.row.description}
            </p>
            <div className="col-start-2 row-start-1 flex justify-center md:row-span-2">
              {props.renderSwitch(entry)}
            </div>
            <div className="col-start-3 row-start-1 md:row-span-2">
              <NotificationChimeSelect
                label={entry.row.label}
                eventType={entry.kind}
                sound={sounds[entry.kind]}
                setSoundForEvent={setSoundForEvent}
              />
            </div>
          </div>
        ))}
      </div>
    </SettingsGroup>
  );
}
