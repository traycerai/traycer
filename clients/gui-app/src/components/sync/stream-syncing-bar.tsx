import { type ReactNode } from "react";
import { SyncingSweepBar } from "@/components/sync/syncing-sweep-bar";
import {
  streamSyncingLabel,
  type StreamSyncingSpell,
} from "@/lib/sync/stream-syncing-state";

interface StreamSyncingBarProps {
  /**
   * The surface's resync, from `useStreamSyncingSpell`. The clock lives in the
   * hook rather than here on purpose: this component is unmounted whenever the
   * strip is suppressed, and a clock unmounted with it would re-time an outage
   * that never stopped.
   */
  readonly spell: StreamSyncingSpell;
  /**
   * Names what is re-syncing, for a screen reader that hears the strip with no
   * surrounding context ("Task", "Chat"). The visible word stays the short one.
   */
  readonly surfaceLabel: string;
  readonly testId: string;
}

/**
 * The thin strip a surface shows while its own stream comes back with content
 * already on screen: the word, and an accent bar travelling on a faint track
 * beneath it.
 *
 * ONE indicator per surface, and it is deliberately not a spinner. A spinner
 * next to a transcript reads as "the agent is working"; this is about the
 * connection, and it has to be distinguishable from the agent's own activity at
 * a glance on a phone.
 *
 * The strip takes its own row rather than overlaying the content, so nothing it
 * says is painted on top of the possibly-stale text it is describing. It is
 * `shrink-0` because it lives inside the surface's header stack, where the
 * scroller below is what absorbs the height.
 */
export function StreamSyncingBar(props: StreamSyncingBarProps): ReactNode {
  const { spell } = props;
  if (!spell.syncing) return null;
  return (
    <div
      data-testid={props.testId}
      data-sync-state={spell.escalated ? "stalled" : "syncing"}
      // A polite live region, and deliberately NOT `aria-busy`. Busy asks a
      // reader to HOLD this element's updates until it clears, and this element
      // never clears it - it is removed instead - so the escalation to "Still
      // syncing…" could sit undelivered for the whole outage, which is the one
      // update here worth hearing. Busy on this node would not describe the
      // stale transcript beside it either; it would only describe the strip.
      role="status"
      className="shrink-0"
    >
      <span className="block truncate px-3 pb-1 text-ui-xs text-muted-foreground">
        <span className="sr-only">{props.surfaceLabel}: </span>
        {streamSyncingLabel(spell.escalated)}
      </span>
      {/* The bar is decoration for the word above it - it carries no semantics
          of its own, so a reader hears the sentence once. The bound on its
          motion holds per OUTAGE rather than per mount only because the clock
          behind `spell` outlives this component. */}
      <SyncingSweepBar
        settled={spell.escalated}
        testId={`${props.testId}-sweep`}
        className={undefined}
      />
    </div>
  );
}
