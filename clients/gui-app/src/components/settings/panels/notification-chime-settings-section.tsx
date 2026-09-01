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
import { useSettingsStore } from "@/stores/settings/settings-store";

const EVENT_ROWS: ReadonlyArray<{
  readonly description: string;
  readonly eventType: NotificationChimeEventType;
  readonly label: string;
}> = [
  {
    eventType: "needs_action",
    label: "Needs action",
    description: "Approvals and interviews.",
  },
  {
    eventType: "failure",
    label: "Failure",
    description: "Errored turns, stalls, crashes, and rate limits.",
  },
  {
    eventType: "done",
    label: "Done",
    description: "Completed or intentionally stopped turns.",
  },
  {
    eventType: "info",
    label: "Info",
    description:
      "Sharing, comments, access changes, and other informational notifications.",
  },
];

export function NotificationChimeSettingsSection() {
  const sounds = useSettingsStore((state) => state.notificationChimeSounds);
  const setSoundForEvent = useSettingsStore(
    (state) => state.setNotificationChimeSoundForEvent,
  );

  return (
    <SettingsGroup
      title="Sound"
      tone="default"
      dataTestId="notification-chime-section"
      fill={false}
    >
      {EVENT_ROWS.map((row) => (
        <SettingsRow
          key={row.eventType}
          label={row.label}
          description={row.description}
          control={
            <NotificationChimeSelect
              label={row.label}
              eventType={row.eventType}
              sound={sounds[row.eventType]}
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
