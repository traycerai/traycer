import { useCallback, useRef, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  FallbackImpendingAction,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { Button } from "@/components/ui/button";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { formatClockTime, useGraceCountdown } from "@/lib/relative-time";
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
  fallbackResolvedIdentitySentence,
  fallbackTupleIdentity,
  useFallbackProfileLabels,
} from "./fallback-identity";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import { useOpenFallbackSettings } from "./open-fallback-settings";
import type { FallbackActionOutcome } from "@traycer/protocol/host/chat-fallback";
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
  // The sign-in navigation, armed by the click and run by the host's answer -
  // or `null` when the cancel in flight is a plain "Don't switch".
  //
  // A ref and not state, because nothing renders from it, and because the
  // thing that reads it may run after this component is gone: an APPLIED
  // cancel settles the traversal, the settled frame clears `pendingFallback`,
  // and that unmounts this card. The closure survives; the component does not.
  const pendingSignInRef = useRef<(() => void) | null>(null);
  const onCancelOutcome = useCallback((outcome: FallbackActionOutcome) => {
    const navigate = pendingSignInRef.current;
    // Disarmed on EVERY outcome, not just the applied one. A refusal that left
    // it armed would send the user to Settings on the NEXT cancel they made -
    // one they never asked to navigate from.
    pendingSignInRef.current = null;
    if (outcome !== "applied" || navigate === null) return;
    navigate();
  }, []);
  const cancel = useFallbackCancel(client, chatId, onCancelOutcome);
  const openFallbackSettings = useOpenFallbackSettings(hostId);
  const { openSettings } = useSystemTabModalActions();

  const failed = fallbackTupleIdentity(pending.failedTuple, labelFor);
  // The whole destination, not just its account. "Switching to Terminal
  // account" named the one field that is identical on both sides of a
  // cross-provider hop and omitted the provider, the model and the effort -
  // every part that actually changes. The shared helper is what keeps this
  // sentence and the menu row the user clicked from describing one place two
  // ways, and it is the same string the transcript announcer speaks.
  const targetLabel = fallbackResolvedIdentitySentence(
    { kind: "fallback", pending },
    labelFor,
  );
  const reasonLabel = fallbackReasonLabelFor(pending.reason);
  // "Sign in instead" belongs only to a signed-out traversal: for any other
  // reason it would send the user to fix an account that is working.
  const signedOut = pending.reason === "auth";

  const onCancel = useCallback(() => {
    // Disarm first. A sign-in click whose cancel died in transport never
    // reaches `onCancelOutcome`, so without this a plain "Don't switch"
    // afterwards would inherit its navigation.
    pendingSignInRef.current = null;
    cancel.mutate({
      epicId,
      chatId,
      traversalId: pending.traversalId,
      revision: pending.revision,
    });
  }, [cancel, chatId, epicId, pending.revision, pending.traversalId]);

  const onSignInInstead = useCallback(() => {
    // Cancel FIRST and navigate only once the host has APPLIED it. Signing in
    // is a multi-second trip through Settings, so an uncancelled countdown
    // would expire and switch the chat while the user was fixing the account
    // they had just chosen to keep - which is exactly what calling the
    // mutation and opening Settings in the same breath allowed: the host
    // legitimately refuses a stale cancel, and the refusal arrived to a card
    // the user could no longer see, behind Settings, with the traversal still
    // running.
    //
    // No second message here on the refusal path. `useFallbackCancel` already
    // reports every non-`applied` outcome through the shared toast and a
    // transport failure through its `errorMessage`, and TanStack runs the
    // hook's `onSuccess` in ADDITION to this one - so saying anything would
    // report one refusal twice.
    pendingSignInRef.current = () => {
      // The chat's OWN host, on both branches. The managed-profile branch
      // carries it through `setProfileFocus`, but the ambient branch below
      // writes only a harness id - `setFocusHarnessId` explicitly clears the
      // host halves - so a signed-out Terminal account on host B used to open
      // sign-in on whichever host Settings last showed. This is the same carry
      // every other fallback settings link makes.
      carryViewedHostIntoSettingsScope(hostId);
      // The gate is on the PROVIDER id, the focus is written with the HARNESS
      // id. `providerId === null` means this harness has no provider-CLI
      // account to sign into, so there is nothing for Settings to open;
      // everywhere else the tuple's own harness is the right key, and
      // re-deriving it from the provider would be a round trip that can only
      // lose.
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
    };
    cancel.mutate({
      epicId,
      chatId,
      traversalId: pending.traversalId,
      revision: pending.revision,
    });
  }, [
    cancel,
    chatId,
    epicId,
    failed.harnessId,
    failed.providerId,
    hostId,
    openSettings,
    pending.failedTuple.profileId,
    pending.revision,
    pending.traversalId,
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
        targetLabel={targetLabel}
        deadline={pending.deadline}
        impendingAction={pending.impendingAction}
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
  impendingAction,
}: {
  readonly state: PendingFallback["state"];
  readonly targetLabel: string | null;
  readonly deadline: number | null;
  /** The host's plan for when this window ends. `null` when nothing is takeable. */
  readonly impendingAction: FallbackImpendingAction | null;
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
    // No destination named - but that is now three different situations, and
    // the host says which. Before `impendingAction` the frame carried
    // `targetTuple: null` for the WHOLE hold (the engine resolved and
    // committed only after expiry), so this generic line was all the card
    // could ever say: a cancel window that would not say what it was
    // cancelling. It is still the right line for a plan the host has not
    // finished resolving, and the wrong one for a plan it has.
    return (
      <div className="text-ui-sm">
        {impendingHeadline(impendingAction)}
        {countdown === null
          ? ""
          : ` ${impendingCountdownClause(impendingAction, countdown)}`}
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

/**
 * What the host will do when this window ends, in words.
 *
 * Reached only when there is no destination to name, so every arm here is a
 * rung that HAS no destination (`wait`, `notify`, `retry`) or a plan still
 * being resolved. A rung with a target renders the destination sentence
 * instead, which is the branch above.
 */
function impendingHeadline(action: FallbackImpendingAction | null): string {
  // `null` is the host saying nothing is takeable - a traversal about to
  // settle as exhausted. Saying "deciding" would promise a decision that is
  // not coming.
  if (action === null) return "This turn failed. Nothing else to try.";
  // A plan still being resolved. The honest line is the one the card always
  // used to show, and it is honest HERE and nowhere else: the host really has
  // not decided yet.
  if (action.pending !== null) return "This turn failed.";
  switch (action.rung) {
    case "wait":
      return action.resumesAt === null
        ? "This turn failed. This chat will wait for the limit to reset."
        : `This turn failed. This chat will wait until ${formatClockTime(action.resumesAt)}.`;
    case "notify":
      return "This turn failed. Nothing else to try.";
    case "retry":
      return "This turn failed. Trying the same account again.";
    // Both destination rungs reach here only with no resolved target - the
    // headline above has it otherwise - so there is nothing more specific to
    // say than that a move is coming.
    case "profile":
    case "tier":
      return "This turn failed. Switching to another account.";
  }
}

/**
 * The countdown clause, in the VERB of the thing that is about to happen.
 *
 * Separate from the headline because the two say different things, and the
 * distinction is the point of the cancel window: a plan the host has not
 * resolved is still being DECIDED, and one it has is simply due. "Deciding
 * what to do in 12s" over a named plan would suggest the window buys a
 * decision that has already been made - which is the opposite of what the
 * user needs to know, since what the window actually buys is the chance to
 * stop it.
 */
function impendingCountdownClause(
  action: FallbackImpendingAction | null,
  countdown: string,
): string {
  if (action === null) return `Stopping in ${countdown}.`;
  if (action.pending !== null) return `Deciding what to do in ${countdown}.`;
  switch (action.rung) {
    case "wait":
      return `Waiting starts in ${countdown}.`;
    case "retry":
      return `Retrying in ${countdown}.`;
    case "notify":
      return `Stopping in ${countdown}.`;
    case "profile":
    case "tier":
      return `Switching in ${countdown}.`;
  }
}
