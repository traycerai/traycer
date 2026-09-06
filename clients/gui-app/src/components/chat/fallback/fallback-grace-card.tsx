import { useCallback, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { PendingFallback } from "@traycer/protocol/host/agent/gui/subscribe";
import { Button } from "@/components/ui/button";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { useGraceCountdown } from "@/lib/relative-time";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";
import {
  DONT_SWITCH_LABEL,
  FALLBACK_SETTINGS_LABEL,
  FRESH_SESSION_HELPER,
  KEEPS_THE_ERROR_HELPER,
  SIGN_IN_INSTEAD_LABEL,
  fallbackReasonLabelFor,
  queuedMessagesMovingText,
  siblingSwitchingText,
} from "./fallback-copy";
import {
  fallbackTupleIdentity,
  useFallbackProfileLabels,
} from "./fallback-identity";
import { useOpenFallbackSettings } from "./open-fallback-settings";
import { useFallbackCancel } from "./use-fallback-actions";

/**
 * The moment-of-failure card: what is about to happen, and how to stop it.
 *
 * Leads with the FAILED profile's identity, following the rate-limit banner's
 * `ProfileRateLimitIdentity` precedent - with two profiles configured the user's
 * first question is which one hit the wall, and a card that opened with the
 * destination would answer the wrong one.
 *
 * Every consequence is stated before the countdown spends it: the fresh session,
 * how many queued messages move, and what each button keeps. The countdown
 * itself is presentational - it ticks against the host's deadline and degrades
 * to "any moment now" rather than holding at "0s" while the two clocks disagree.
 */
export function FallbackGraceCard({
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
   * The destination menu, trigger and all - `<FallbackGraceMenu>` in the
   * composer, `null` where there is no menu to open.
   *
   * A SLOT rather than an `onChooseDifferently` callback. The menu takes a
   * grace-hold LEASE, and the lease's whole lifecycle - the frame, the ack that
   * mints the token, the release on close, the refusal when the host declines -
   * belongs to whatever owns the popover. Handing this card a callback would
   * have made it the co-owner of a lease it has no way to reason about.
   *
   * `null` hides the affordance rather than rendering a button that does
   * nothing: the honest shape for the one case that produces it, a host whose
   * `chat.fallback.listTargets` this build cannot use.
   */
  readonly menu: ReactNode | null;
}) {
  const labelFor = useFallbackProfileLabels(client, true);
  const cancel = useFallbackCancel(client, chatId);
  const openFallbackSettings = useOpenFallbackSettings(hostId);
  const { openSettings } = useSystemTabModalActions();

  const failed = fallbackTupleIdentity(pending.failedTuple, labelFor);
  const target =
    pending.targetTuple === null
      ? null
      : fallbackTupleIdentity(pending.targetTuple, labelFor);
  const reasonLabel = fallbackReasonLabelFor(pending.reason);
  // "Sign in instead" belongs only to a signed-out traversal: for any other
  // reason it would send the user to fix an account that is working.
  const signedOut = pending.reason === "auth";

  const onCancel = useCallback(() => {
    cancel.mutate({
      epicId,
      chatId,
      traversalId: pending.traversalId,
      revision: pending.revision,
    });
  }, [cancel, chatId, epicId, pending.revision, pending.traversalId]);

  const onSignInInstead = useCallback(() => {
    // Cancel FIRST, then open sign-in. Signing in is a multi-second trip
    // through Settings, and without the cancel the countdown would expire and
    // switch the chat while the user was in the middle of fixing the account
    // they had just chosen to keep.
    onCancel();
    // The gate is on the PROVIDER id, the focus is written with the HARNESS id.
    // `providerId === null` means this harness has no provider-CLI account to
    // sign into, so there is nothing for Settings to open; everywhere else the
    // tuple's own harness is the right key, and re-deriving it from the
    // provider would be a round trip that can only lose.
    if (failed.providerId === null) return;
    const focus = useProvidersFocusStore.getState();
    const profileId = pending.failedTuple.profileId;
    if (profileId !== null) {
      focus.setProfileFocus({
        harnessId: failed.harnessId,
        hostId,
        profileId,
        startSignIn: true,
      });
    } else {
      focus.setFocusHarnessId(failed.harnessId);
    }
    openSettings({ section: "providers", resetToGeneral: false });
  }, [
    failed.harnessId,
    failed.providerId,
    hostId,
    onCancel,
    openSettings,
    pending.failedTuple.profileId,
  ]);

  const queuedText = queuedMessagesMovingText(pending.queuedItemsMoving);
  const siblingText = siblingSwitchingText(pending.siblingSwitching);
  const busy = cancel.isPending || !canAct;

  return (
    <div
      data-testid="fallback-grace-card"
      className="flex w-full flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-ui-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <AlertTriangle
            className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden
          />
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-border/60 bg-background/60 px-1.5 py-0.5 text-ui-xs font-medium text-foreground">
            <HarnessIcon harnessId={failed.harnessId} className="size-3" />
            <span className="min-w-0 truncate">
              {failed.providerLabel} · {failed.profileLabel}
            </span>
          </span>
          {reasonLabel !== null ? (
            <span className="text-ui-xs font-medium text-amber-700 dark:text-amber-300">
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

      <FallbackGraceHeadline
        state={pending.state}
        targetLabel={target?.profileLabel ?? null}
        deadline={pending.deadline}
      />

      <div className="text-ui-xs text-muted-foreground">
        {FRESH_SESSION_HELPER}
        {queuedText === null ? null : ` ${queuedText}`}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          {DONT_SWITCH_LABEL}
        </Button>
        {signedOut ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={onSignInInstead}
          >
            {SIGN_IN_INSTEAD_LABEL}
          </Button>
        ) : null}
        {menu}
      </div>

      <div className="text-ui-xs text-muted-foreground/80">
        {signedOut
          ? `${SIGN_IN_INSTEAD_LABEL} stops the switch and ${KEEPS_THE_ERROR_HELPER} once you're signed in.`
          : `${DONT_SWITCH_LABEL} ${KEEPS_THE_ERROR_HELPER}.`}
        {menu !== null && pending.state === "hold"
          ? " Opening the menu pauses the countdown."
          : ""}
        {siblingText === null ? null : ` ${siblingText}`}
      </div>
    </div>
  );
}

/**
 * The one line that says what is about to happen.
 *
 * Its own component so the once-a-second countdown tick repaints this line
 * rather than the whole card - the buttons, the helper text and the identity
 * chip do not change between ticks, and re-rendering them sixty times a minute
 * is the cost the seconds clock's own docs warn about.
 */
function FallbackGraceHeadline({
  state,
  targetLabel,
  deadline,
}: {
  readonly state: PendingFallback["state"];
  readonly targetLabel: string | null;
  readonly deadline: number | null;
}) {
  // Subscribed HERE and not in the card: this component is the only thing on
  // screen that changes between ticks, so the once-a-second wake repaints one
  // line instead of the buttons, the helper text and the identity chip.
  const countdown = useGraceCountdown(deadline);
  // `switching` has committed: there is nothing left to count down to, and a
  // timer here would imply the user still had a window they no longer have.
  if (state === "switching") {
    return (
      <div className="text-ui-sm">
        {targetLabel === null
          ? "Switching now…"
          : `Switching to ${targetLabel}…`}
      </div>
    );
  }
  // `choosing`: the menu froze the window under a lease. Said only once the HOST
  // has granted the state - never optimistically on the click - so the card can
  // never claim a pause the engine did not take.
  if (state === "choosing") {
    return (
      <div className={cn("text-ui-sm", "text-muted-foreground")}>
        {targetLabel === null
          ? "Countdown paused while you choose."
          : `Switching to ${targetLabel} — countdown paused while you choose.`}
      </div>
    );
  }
  if (targetLabel === null) {
    // A hold with no target yet: `notify` is a rung like any other, and the
    // user still gets the window and the menu. Saying "switching to" here would
    // name a destination that does not exist.
    return (
      <div className="text-ui-sm">
        This turn failed.
        {countdown === null ? "" : ` Deciding what to do in ${countdown}.`}
      </div>
    );
  }
  return (
    <div className="text-ui-sm">
      Switching to <span className="font-medium">{targetLabel}</span>
      {countdown === null ? "" : ` in ${countdown}`}
    </div>
  );
}
