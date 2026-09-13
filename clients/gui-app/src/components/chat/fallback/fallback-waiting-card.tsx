import { useCallback, type ReactNode } from "react";
import { Clock } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { PendingFallback } from "@traycer/protocol/host/agent/gui/subscribe";
import { Button } from "@/components/ui/button";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  formatResetCountdown,
  formatWaitTime,
  useSampledNow,
} from "@/lib/relative-time";
import type { HostRpcRegistry } from "@/lib/host";
import {
  FALLBACK_SETTINGS_LABEL,
  KEEPS_THE_ERROR_HELPER,
  STOP_WAITING_LABEL,
  fallbackReasonLabelFor,
  queuedMessagesWaitingText,
} from "./fallback-copy";
import {
  fallbackTupleIdentity,
  useFallbackProfileLabels,
} from "./fallback-identity";
import { useOpenFallbackSettings } from "./open-fallback-settings";
import {
  IGNORE_FALLBACK_OUTCOME,
  useFallbackCancel,
} from "./use-fallback-actions";

/**
 * The wait card: this chat is paused until an account's limit resets.
 *
 * A different card from the grace card rather than a fifth state on it, because
 * the two answer opposite questions. The grace card is spending a budget the
 * user can still refuse - everything on it is about the switch that is ABOUT to
 * happen. A wait has already been decided: nothing is counting down to an
 * action, the chat is simply parked until a time the provider fixed, and the
 * user's two questions are "when" and "can I not wait". Folding them together
 * would put "Starts a fresh session from this transcript" on a card whose whole
 * point is that no session changes.
 *
 * The time is the SHARED 12-hour format (`formatWaitTime`), never the Claude
 * wake row's zero-padded 24-hour form: a fallback wait and a scheduled wake are
 * different things, and rendering one in the other's shape is how a user reads a
 * paused chat as a wake they scheduled.
 */
export function FallbackWaitingCard({
  pending,
  client,
  chatId,
  epicId,
  hostId,
  canAct,
  menu,
}: {
  readonly pending: PendingFallback;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly chatId: string;
  readonly epicId: string;
  readonly hostId: string;
  readonly canAct: boolean;
  /**
   * The destination menu, trigger and all - `<FallbackWaitingMenu>` in the
   * composer, `null` where there is no menu to open.
   *
   * A SLOT rather than an `onSwitchInstead` callback, because the menu owns
   * state this card has no business holding: its open flag, its lease (none,
   * here), its in-flight pick and the refusal line it renders before closing.
   * Passing a callback would have put all of that back on the card and made two
   * surfaces responsible for one popover.
   *
   * `null` hides the affordance rather than rendering a dead button, for the
   * one case that produces it: a host whose `chat.fallback.listTargets` this
   * build cannot use.
   */
  readonly menu: ReactNode | null;
}) {
  const labelFor = useFallbackProfileLabels(client, true);
  // Nothing to do with the outcome: "Stop waiting" has no follow-on
  // navigation, and the shared toast already reports a refusal. The grace
  // card's "Sign in instead" is the one caller that needs the answer.
  const cancel = useFallbackCancel(client, chatId, IGNORE_FALLBACK_OUTCOME);
  const openFallbackSettings = useOpenFallbackSettings(hostId);

  const waiting = fallbackTupleIdentity(pending.failedTuple, labelFor);
  const reasonLabel = fallbackReasonLabelFor(pending.reason);
  const queuedText = queuedMessagesWaitingText(pending.queuedItemsMoving);

  const onStopWaiting = useCallback(() => {
    cancel.mutate({
      epicId,
      chatId,
      traversalId: pending.traversalId,
      revision: pending.revision,
    });
  }, [cancel, chatId, epicId, pending.revision, pending.traversalId]);

  const busy = cancel.isPending || !canAct;

  return (
    <div
      data-testid="fallback-waiting-card"
      className="flex w-full flex-col gap-2 rounded-md border border-border bg-foreground/3 px-3 py-2 text-ui-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Clock
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-border/60 bg-background/60 px-1.5 py-0.5 text-ui-xs font-medium text-foreground">
            <HarnessIcon harnessId={waiting.harnessId} className="size-3" />
            <span className="min-w-0 truncate">
              {waiting.providerLabel} · {waiting.profileLabel}
            </span>
          </span>
          {reasonLabel !== null ? (
            <span className="text-ui-xs font-medium text-muted-foreground">
              {reasonLabel}
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-auto px-1 py-0 text-ui-xs text-muted-foreground"
          onClick={openFallbackSettings}
        >
          {FALLBACK_SETTINGS_LABEL}
        </Button>
      </div>

      <FallbackWaitHeadline deadline={pending.deadline} />

      {queuedText === null ? null : (
        <div className="text-ui-xs text-muted-foreground">{queuedText}</div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onStopWaiting}
        >
          {STOP_WAITING_LABEL}
        </Button>
        {menu}
      </div>

      <div className="text-ui-xs text-muted-foreground/80">
        {STOP_WAITING_LABEL} {KEEPS_THE_ERROR_HELPER}.
      </div>
    </div>
  );
}

/**
 * "Resuming at 3:00 PM (in about 2h 14m)", or "Resuming shortly…".
 *
 * TWO elements on one line, and the split is the whole point (AX9).
 *
 * The `role="status"` live region carries the SEMANTIC status only - the
 * deadline, which is a fixed fact for the life of the wait. A wait is the state
 * a user leaves the window on, so entering it and passing it are worth
 * announcing; the buttons and the identity chip beside it would be re-announced
 * with them if the whole card were the region, so it stays narrow.
 *
 * The countdown is a SIBLING of that region, never inside it. It is the only
 * part that changes routinely: a six-hour wait ticks ~360 times, and while the
 * whole sentence lived in the region every one of those ticks was a fresh
 * polite announcement - hundreds of them, multiplied by every visible chat.
 * Outside the region it is still in the accessibility tree and still readable
 * on demand, which is what the finding asks for; it is simply not news. An
 * `aria-hidden` countdown would have "fixed" the noise by deleting the number
 * for exactly the users the region exists for.
 *
 * So the region's text changes exactly ONCE over an entire wait - when the
 * deadline passes - and no minute tick can move it. Anything added here that
 * varies with `now` belongs on the countdown side of that boundary.
 *
 * Entering the wait is NOT announced from here, and this region could not do it
 * anyway: it mounts already carrying the deadline, and a live region that
 * arrives with its text announces nothing - the same rule
 * `fallback-destination-menu.tsx` states for its own regions, and the reason
 * `FallbackWaitHeadline`'s two returns keep one element at one position rather
 * than swapping the region out. Entry is spoken by the chat's announcer, from
 * the `waiting` sentence in `stores/chats/chat-announcements.ts`. What this
 * region is for is the CHANGE: the wait ending is news, and it is news at a
 * moment no other surface is speaking.
 *
 * Its own component so the minute tick repaints this line rather than the card.
 * MINUTE resolution deliberately, unlike the grace card's seconds: a wait runs
 * to a provider's reset boundary and is measured in hours, so a second hand
 * here would wake the renderer 3,600 times to move a number that changes 60
 * times.
 *
 * Past the deadline the card stops counting rather than showing "0s". The
 * deadline is the HOST's, and the frame that ends the wait takes a moment to
 * arrive; "Resuming shortly…" is true across the whole of that gap, and a
 * `null` deadline - an effect phase that is due now - lands on the same words
 * for the same reason. Neither state has a countdown to show.
 */
function FallbackWaitHeadline({
  deadline,
}: {
  readonly deadline: number | null;
}) {
  const now = useSampledNow();
  // Two returns rather than one with ternaries inside it, and the shape is
  // load-bearing: both render the SAME element at the SAME position, so React
  // reuses the live region across the deadline instead of replacing it. A
  // region that is torn down and rebuilt is a region assistive tech was not
  // observing when its text arrived - the mount-with-content case that
  // announces nothing.
  if (deadline === null || deadline <= now) {
    return (
      <div className="text-ui-sm">
        <span role="status">Resuming shortly…</span>
      </div>
    );
  }
  return (
    <div className="text-ui-sm">
      <span role="status">Resuming at {formatWaitTime(deadline, now)}</span>
      <span className="text-muted-foreground">
        {" "}
        (in about {formatResetCountdown(deadline, now)})
      </span>
    </div>
  );
}
