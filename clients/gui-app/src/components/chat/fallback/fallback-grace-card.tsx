import { useCallback, useRef, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  FallbackImpendingAction,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { Button } from "@/components/ui/button";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  formatWaitTime,
  GRACE_COUNTDOWN_IMMINENT,
  useGraceCountdown,
  useSampledNow,
} from "@/lib/relative-time";
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
  pendingFallbackResumesFailedTuple,
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
  // Whether that destination is the tuple that failed: the wait rung's resume,
  // which has no "to" at all - see {@link pendingFallbackResumesFailedTuple}.
  const resuming = pendingFallbackResumesFailedTuple(pending);
  const reasonLabel = fallbackReasonLabelFor(pending.reason);
  // "Sign in instead" belongs only to a signed-out traversal: for any other
  // reason it would send the user to fix an account that is working.
  //
  // And only to one that HAS somewhere to sign in. `providerId === null` means
  // this harness has no provider-CLI account behind it - `fallbackTupleIdentity`
  // calls that field the thing "the sign-in affordance routes on", and names
  // "a sign-in that leads nowhere" as the failure it exists to prevent. That
  // check used to live inside the armed closure below and nowhere else, so the
  // button rendered for such a tuple, its press CANCELLED the traversal, and the
  // closure then returned before opening anything: the user gave up the switch
  // and got no sign-in surface in exchange. A gate the render condition does not
  // share is not a gate, it is a dead end one click in.
  //
  // One variable rather than a second condition at the button, so the helper
  // line at the foot of the card follows it too - it promises what
  // "Sign in instead" does, and a card with no such button must not.
  const signedOut = pending.reason === "auth" && failed.providerId !== null;

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
      // The gate is on the PROVIDER id, the focus is written with the HARNESS
      // id. `providerId === null` means this harness has no provider-CLI
      // account to sign into, so there is nothing for Settings to open;
      // everywhere else the tuple's own harness is the right key, and
      // re-deriving it from the provider would be a round trip that can only
      // lose.
      //
      // Unreachable while `signedOut` holds the same check, which is the point:
      // the gate that DECIDES is now the render condition, and this one is what
      // keeps a future change to `signedOut` from quietly restoring the dead end
      // instead of failing here. It runs FIRST for the same reason - everything
      // below it is a side effect of navigating, and nothing below it navigates.
      if (failed.providerId === null) return;
      // The chat's OWN host, on both branches. The managed-profile branch
      // carries it through `setProfileFocus`, but the ambient branch below
      // writes only a harness id - `setFocusHarnessId` explicitly clears the
      // host halves - so a signed-out Terminal account on host B used to open
      // sign-in on whichever host Settings last showed. This is the same carry
      // every other fallback settings link makes.
      //
      // Below the gate, not above it: it rewrites the APP-WIDE Settings scope,
      // so running it on a path that opens no Settings re-points a surface the
      // user never navigated to and will meet later, pointed at this chat's
      // host for no reason they can see.
      carryViewedHostIntoSettingsScope(hostId);
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
        resuming={resuming}
        deadline={pending.deadline}
        impendingAction={pending.impendingAction}
      />

      {/*
       * Only for a plan that MOVES the chat to a named destination - the
       * announcer's rule for the same sentence (`fallbackHoldText`). A wait
       * resumes the session it failed on (`routing=resume`), so on a wait
       * plan's hold card and on the resume itself this line was false, and so
       * was "will run on the new settings too" for a queue that is not moving.
       */}
      {targetLabel !== null && !resuming ? (
        <div className="text-ui-xs text-muted-foreground">
          {FRESH_SESSION_HELPER}
          {queuedText === null ? null : ` ${queuedText}`}
        </div>
      ) : null}

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
  resuming,
  deadline,
  impendingAction,
}: {
  readonly state: PendingFallback["state"];
  readonly targetLabel: string | null;
  /**
   * The destination is the tuple that failed - the wait rung's resume - so
   * there is nowhere to switch TO.
   */
  readonly resuming: boolean;
  readonly deadline: number | null;
  /** The host's plan for when this window ends. `null` when nothing is takeable. */
  readonly impendingAction: FallbackImpendingAction | null;
}) {
  // Subscribed HERE and not in the card: this component is the only thing on
  // screen that changes between ticks, so the once-a-second wake repaints one
  // line instead of the buttons, the helper text and the identity chip.
  const countdown = useGraceCountdown(deadline);
  // The minute clock, for the wait plan's resume time alone: whether it is far
  // enough out to need its weekday (`formatWaitTime`).
  const now = useSampledNow();
  // `switching` has committed: there is nothing left to count down to, and a
  // timer here would imply the user still had a window they no longer have.
  if (state === "switching") {
    // The wait's resume runs these same phases onto the tuple that failed:
    // "Switching to <the model it was already on>…" said the chat had moved
    // when it was only going back to work.
    if (resuming) {
      return <div className="text-ui-sm">Resuming now…</div>;
    }
    // No destination: the host has just entered a rung and resolves its target
    // in the next breath - `enterSwitchRung` publishes this frame with the plan
    // re-pointed at that rung and still resolving, whatever the hold had
    // predicted. That breath either names a target ("Switching to …") or skips
    // the rung for the next one, a wait or a settle, so "Switching now…" here
    // was false every time the rung was skipped: 34 ms of it between "This
    // chat will wait until 12:29 am" and the waiting card, live. The card's
    // own words for a plan the host has not resolved are true either way.
    return (
      <div className="text-ui-sm">
        {targetLabel === null
          ? "Deciding what to do…"
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
        {impendingHeadline(impendingAction, now)}
        {countdown === null
          ? ""
          : ` ${impendingCountdownClause(impendingAction, countdown)}`}
      </div>
    );
  }
  return (
    <div className="text-ui-sm">
      Switching to <span className="font-medium">{targetLabel}</span>
      {countdown === null ? "" : ` ${countdownPhrase(countdown)}`}
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
function impendingHeadline(
  action: FallbackImpendingAction | null,
  now: number,
): string {
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
        : `This turn failed. This chat will wait until ${formatWaitTime(action.resumesAt, now)}.`;
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
  const when = countdownPhrase(countdown);
  if (action === null) return `Stopping ${when}.`;
  if (action.pending !== null) return `Deciding what to do ${when}.`;
  switch (action.rung) {
    case "wait":
      return `Waiting starts ${when}.`;
    case "retry":
      return `Retrying ${when}.`;
    case "notify":
      return `Stopping ${when}.`;
    case "profile":
    case "tier":
      return `Switching ${when}.`;
  }
}

/**
 * "in 12s" - or, at or past the deadline, the imminent phrase on its own.
 *
 * `formatGraceCountdown` answers {@link GRACE_COUNTDOWN_IMMINENT} there, and
 * the card really does sit past its deadline: the host holds an expiry for up
 * to 30 s past it while a profile probe is still out, and every window
 * crosses it for the moment before the host's timer fires. Every clause on
 * this card reads "… in <countdown>", so without this it said "Deciding what
 * to do in any moment now."
 */
function countdownPhrase(countdown: string): string {
  return countdown === GRACE_COUNTDOWN_IMMINENT ? countdown : `in ${countdown}`;
}
