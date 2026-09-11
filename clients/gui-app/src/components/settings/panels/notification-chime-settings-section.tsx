import { APP_NOTIFICATIONS } from "@/components/settings/panels/app-notifications-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  isNotificationChimeSound,
  type NotificationChimeEventType,
  NOTIFICATION_CHIME_LABELS,
  NOTIFICATION_CHIME_SOUNDS,
  type NotificationChimeSound,
  playNotificationChimeSound,
} from "@/lib/notifications/notification-chime";
import type { SettingsRowDefinition } from "@/lib/settings-search/settings-definitions";
import { useSettingsStore } from "@/stores/settings/settings-store";

const EVENT_ROWS: ReadonlyArray<{
  readonly eventType: NotificationChimeEventType;
  readonly row: SettingsRowDefinition;
}> = [
  {
    eventType: "needs_action",
    row: APP_NOTIFICATIONS.definitions.chimeNeedsAction,
  },
  { eventType: "failure", row: APP_NOTIFICATIONS.definitions.chimeFailure },
  { eventType: "done", row: APP_NOTIFICATIONS.definitions.chimeDone },
  { eventType: "info", row: APP_NOTIFICATIONS.definitions.chimeInfo },
];

export function NotificationChimeSettingsSection() {
  const sounds = useSettingsStore((state) => state.notificationChimeSounds);
  const setSoundForEvent = useSettingsStore(
    (state) => state.setNotificationChimeSoundForEvent,
  );

  return (
    <SettingsGroup
      // The page is already titled Sounds; a group heading (Sound, Chimes)
      // would be a second name for the same four dropdowns. System / Events
      // below keep titles because they are different destinations.
      group={APP_NOTIFICATIONS.definitions.chimes}
      showTitle={false}
      tone="default"
      dataTestId="notification-chime-section"
      fill={false}
    >
      {EVENT_ROWS.map((event) => (
        <SettingsRow
          key={event.eventType}
          row={event.row}
          status={undefined}
          control={
            <NotificationChimeSelect
              label={event.row.label}
              eventType={event.eventType}
              sound={sounds[event.eventType]}
              setSoundForEvent={setSoundForEvent}
            />
          }
        />
      ))}
    </SettingsGroup>
  );
}

function NotificationChimeSelect(props: {
  readonly label: string;
  readonly eventType: NotificationChimeEventType;
  readonly sound: NotificationChimeSound;
  readonly setSoundForEvent: (
    eventType: NotificationChimeEventType,
    sound: NotificationChimeSound,
  ) => void;
}) {
  return (
    <Select
      value={props.sound}
      onValueChange={(next) => {
        if (!isNotificationChimeSound(next)) return;
        props.setSoundForEvent(props.eventType, next);
      }}
    >
      <SelectTrigger
        className="w-[min(40vw,9rem)]"
        aria-label={`${props.label} sound`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {NOTIFICATION_CHIME_SOUNDS.map((option) => (
          <ChimeOption key={option} sound={option} />
        ))}
      </SelectContent>
    </Select>
  );
}

function ChimeOption(props: { readonly sound: NotificationChimeSound }) {
  const preview = (): void => playNotificationChimeSound(props.sound);

  return (
    <SelectItem
      value={props.sound}
      onPointerUp={preview}
      onClick={(event) => {
        // Pointer activations already preview on pointer-up, before Radix
        // persists and closes the menu. A zero-detail click is synthesized
        // (for example by a screen reader or HTMLElement.click()) and has no
        // pointer event to provide that preview.
        if (event.detail === 0) preview();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") preview();
      }}
    >
      {NOTIFICATION_CHIME_LABELS[props.sound]}
    </SelectItem>
  );
}
