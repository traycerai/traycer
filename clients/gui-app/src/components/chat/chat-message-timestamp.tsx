import {
  useLayoutRegion,
  useRegionGhost,
} from "@/components/layout-editor/use-layout-region";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRegionShown } from "@/lib/layout-overrides";
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
 *
 * It is also the Timestamps region (audit R3): Layout > Chat > Timestamps
 * takes it out, together with the ` · ` that joins it to a sender label when
 * `separated`, so a hidden stamp never leaves a dangling separator.
 */
export function ChatMessageTimestamp(props: {
  readonly timestamp: number;
  readonly separated: boolean;
  /** Names this stamp for the editor's canvas; a message or card id. */
  readonly instanceId: string;
}) {
  // Drawn while the editor points at a hidden stamp too, as a ghost (L-14).
  const shown = useRegionShown("timestamps");
  const ghost = useRegionGhost("timestamps");
  if (!(shown || ghost) || !hasRenderableMessageTime(props.timestamp)) {
    return null;
  }
  return <ShownTimestamp {...props} />;
}

/**
 * A transcript row's sender label and, unless the row has not been sent, the
 * time it was. Shared with the layout editor's sample conversation, which is a
 * picture of this row and so draws it rather than a copy.
 */
export function ChatSenderOverline(props: {
  readonly label: string;
  readonly sentAt: number;
  readonly stamped: boolean;
  readonly instanceId: string;
}) {
  return (
    <span className="text-overline font-medium text-muted-foreground/60">
      {/* Passive under the layout editor: the stamp beside it is a region
          and stays lit, the sender label is content. */}
      <span data-layout-passive className="uppercase">
        {props.label}
      </span>
      {props.stamped ? (
        <ChatMessageTimestamp
          timestamp={props.sentAt}
          separated
          instanceId={props.instanceId}
        />
      ) : null}
    </span>
  );
}

function ShownTimestamp({
  timestamp,
  separated,
  instanceId,
}: {
  readonly timestamp: number;
  readonly separated: boolean;
  readonly instanceId: string;
}) {
  const label = useMessageTime(timestamp);
  const { ref } = useLayoutRegion({ regionId: "timestamps", instanceId });
  // `toISOString()` is the one call in this feature that THROWS on a bad
  // instant rather than rendering "Invalid Date", and it would take the whole
  // message row down with it. The test has to be the Date's own validity, not
  // `Number.isFinite` on the input: 8.64e15 + 1 is a perfectly finite number
  // and still out of range for a Date. Nothing to print is the honest answer
  // for a stamp that names no time. The outer component guards through the
  // exported predicate, so past it `toISOString()` cannot throw.
  const iso = new Date(timestamp).toISOString();
  const stamp = (
    <TooltipWrapper
      label={formatFullTimestamp(timestamp)}
      side="top"
      align="center"
      sideOffset={undefined}
    >
      <time
        ref={ref}
        dateTime={iso}
        data-testid="chat-message-timestamp"
        className="shrink-0 font-normal tabular-nums text-muted-foreground/50"
      >
        {label}
      </time>
    </TooltipWrapper>
  );
  if (!separated) return stamp;
  return (
    <>
      <span aria-hidden> · </span>
      {stamp}
    </>
  );
}
