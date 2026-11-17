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

/** The chime one kind of notification plays; picking a sound plays it. */
export function NotificationChimeSelect(props: {
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
        className="w-[min(32vw,9rem)]"
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
