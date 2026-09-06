import { useCallback, type ReactNode } from "react";
import { Clock } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { PendingFallback } from "@traycer/protocol/host/agent/gui/subscribe";
import { Button } from "@/components/ui/button";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  formatClockTime,
  formatResetCountdown,
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
import { useFallbackCancel } from "./use-fallback-actions";

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
 * The time is the SHARED 12-hour format (`formatClockTime`), never the Claude
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
  const cancel = useFallbackCancel(client, chatId);
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
 * A `role="status"` live region, and the only part of the card that is one: a
 * wait is the state a user leaves the window on, so the moment it turns over is
 * worth announcing - while the buttons and the identity chip beside it would be
 * re-announced with it if the whole card were the region.
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
 * for the same reason.
 */
function FallbackWaitHeadline({
  deadline,
}: {
  readonly deadline: number | null;
}) {
  const now = useSampledNow();
  const label =
    deadline === null || deadline <= now
      ? "Resuming shortly…"
      : `Resuming at ${formatClockTime(deadline)} (in about ${formatResetCountdown(deadline, now)})`;
  return (
    <div role="status" className="text-ui-sm">
      {label}
    </div>
  );
}
