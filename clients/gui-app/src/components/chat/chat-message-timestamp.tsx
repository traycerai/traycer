import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  formatFullTimestamp,
  hasRenderableMessageTime,
  useMessageTime,
} from "@/lib/relative-time";

/**
 * The clock time a transcript row was sent, rendered beside its sender label.
 *
 * Its own leaf component so the shared 60s tick repaints this one element
 * rather than the message row around it - `useMessageTime` subscribes, and a
 * transcript re-rendering every row once a minute is exactly what that hook's
 * leaf guidance exists to prevent.
 *
 * `<time>` rather than a span: the visible label is day-scoped and locale-
 * shaped, so the machine-readable instant is the only form that stays
 * unambiguous for assistive tech and for anything reading the DOM. The hover
 * label is what lets the visible one abbreviate - it restores the weekday,
 * the date, the year and the seconds the row drops.
 *
 * Deliberately NOT focusable. Radix does not make a `<time>` trigger a tab
 * stop on its own, and adding one here would put an extra stop in front of
 * every message in the transcript to reach a label whose content the
 * `dateTime` attribute already exposes to assistive tech.
 *
 * `shrink-0` is baked in rather than passed per call site. In the sender
 * overline the stamp is inline and the property is inert; in the agent-sender
 * card header it is a flex item beside a name that IS allowed to shrink, and
 * the stamp must not be the thing that collapses.
 */
export function ChatMessageTimestamp({
  timestamp,
}: {
  readonly timestamp: number;
}) {
  const label = useMessageTime(timestamp);
  // `toISOString()` is the one call in this feature that THROWS on a bad
  // instant rather than rendering "Invalid Date", and it would take the whole
  // message row down with it. The test has to be the Date's own validity, not
  // `Number.isFinite` on the input: 8.64e15 + 1 is a perfectly finite number
  // and still out of range for a Date. Nothing to print is the honest answer
  // for a stamp that names no time. Guarding through the exported predicate
  // keeps this decision and the caller's separator on one rule; past it,
  // `toISOString()` cannot throw.
  if (!hasRenderableMessageTime(timestamp)) return null;
  const iso = new Date(timestamp).toISOString();
  return (
    <TooltipWrapper
      label={formatFullTimestamp(timestamp)}
      side="top"
      align="center"
      sideOffset={undefined}
    >
      <time
        dateTime={iso}
        data-testid="chat-message-timestamp"
        className="shrink-0 font-normal tabular-nums text-muted-foreground/50"
      >
        {label}
      </time>
    </TooltipWrapper>
  );
}
