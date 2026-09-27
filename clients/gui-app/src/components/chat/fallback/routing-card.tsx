import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { FallbackActionOutcome } from "@traycer/protocol/host/chat-fallback";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import {
  formatResetCountdown,
  formatWaitTime,
  GRACE_COUNTDOWN_IMMINENT,
  useGraceCountdownState,
  useSampledNow,
} from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import {
  CHOOSE_ANOTHER_MODEL_LABEL,
  DECIDING_LABEL,
  RECONNECTING_LABEL,
  ROUTING_SETTINGS_LABEL,
  STOP_WAITING_LABEL,
  SWITCH_BACK_LABEL,
  SWITCH_NOW_LABEL,
  fallbackLowUsageClause,
  fallbackReasonLabelFor,
  joinCostClauses,
  queuedReturningClause,
  queuedWaitingClause,
} from "./fallback-copy";
import {
  TERMINAL_ACCOUNT_LABEL,
  fallbackTupleIdentity,
  pendingFallbackHarnessSubjects,
  pendingFallbackOffersSignIn,
  useFallbackModelLabels,
  useFallbackProfileLabels,
  type FallbackIdentityResolvers,
  type FallbackTupleIdentity,
} from "./fallback-identity";
import type { FallbackReturnLowUsage } from "./fallback-return-low-usage";
import {
  countdownRefusalLabel,
  routingCountdownCountClauses,
  routingCountdownPlan,
  type RoutingCountdownPlan,
} from "./fallback-state";
import { useOpenFallbackSettings } from "./open-fallback-settings";
import {
  RouteArrow,
  RouteLine,
  RouteTupleChip,
  RouteTupleTriggerContent,
} from "./route-line";
import { routeTupleOf, routeTupleText } from "./route-tuple";
import { RoutingDestinationPicker } from "./routing-destination-picker";
import {
  IGNORE_FALLBACK_OUTCOME,
  useFallbackCancel,
  useFallbackProceed,
  useFallbackReturnToPreferred,
} from "./use-fallback-actions";

/**
 * The composer's routing card, in whichever state the chat is in.
 *
 * ONE family (spec principle 1): every routing surface above the composer is
 * this card with the same anatomy - a status line, a headline, a route line, an
 * optional cost line and one action row - and the state changes the words,
 * never the layout. It replaces the three cards that used to occupy this slot
 * (the countdown card, the waiting card and the return banner), which between
 * them had three frames and eight button styles.
 *
 * - `countdown`: a turn failed and routing is about to act (`hold`,
 *   `choosing`, `switching`).
 * - `waiting`: routing is parked until a limit resets.
 * - `return`: the preferred account's limit reset and routing offers to go
 *   back.
 *
 * Every state's action row is exactly two `Button`s - the productive action
 * filled, the refusal outlined - and no text links. On a countdown that names
 * a destination the picker opens from that destination's chip on the route
 * line (options Q1 B); where nothing is named (a wait, and the waiting card)
 * the picker IS the filled button, "Choose another model…".
 *
 * There is no hide control (clutter cuts, 2026-09-27): the card leaves when
 * the countdown ends, the user answers, or routing settles.
 */
export type RoutingCardState =
  | { readonly kind: "countdown"; readonly pending: PendingFallback }
  | { readonly kind: "waiting"; readonly pending: PendingFallback }
  | {
      readonly kind: "return";
      readonly offer: PendingReturn;
      /**
       * The absorbed rate-limit advisory for the account the chat is on now,
       * or `null` - see `returnBannerLowUsage`.
       */
      readonly lowUsage: FallbackReturnLowUsage | null;
    };

/**
 * The host method behind the "now" buttons. Registered off the released floor
 * with `degrade: unsupported`, so its negotiated presence is the capability:
 * against a host without it the card draws no primary and keeps its old shape.
 */
const PROCEED_METHOD = "chat.fallback.proceed";

export function RoutingCard({
  state,
  client,
  chatId,
  epicId,
  hostId,
  canAct,
}: {
  readonly state: RoutingCardState;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly chatId: string;
  readonly epicId: string;
  /** The TAB's host - the chat's own machine, for settings and capabilities. */
  readonly hostId: string;
  /**
   * Whether this reader may steer the chat right now. `false` disables every
   * action and says "Reconnecting…" beside them; the settings gear stays.
   */
  readonly canAct: boolean;
}) {
  switch (state.kind) {
    case "countdown":
      return (
        <CountdownRoutingCard
          pending={state.pending}
          client={client}
          chatId={chatId}
          epicId={epicId}
          hostId={hostId}
          canAct={canAct}
        />
      );
    case "waiting":
      return (
        <WaitingRoutingCard
          pending={state.pending}
          client={client}
          chatId={chatId}
          epicId={epicId}
          hostId={hostId}
          canAct={canAct}
        />
      );
    case "return":
      return (
        <ReturnRoutingCard
          offer={state.offer}
          lowUsage={state.lowUsage}
          client={client}
          chatId={chatId}
          epicId={epicId}
          canAct={canAct}
        />
      );
  }
}

/* ------------------------------------------------------------------------- */
/* Countdown                                                                 */
/* ------------------------------------------------------------------------- */

function CountdownRoutingCard({
  pending,
  client,
  chatId,
  epicId,
  hostId,
  canAct,
}: {
  readonly pending: PendingFallback;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly chatId: string;
  readonly epicId: string;
  readonly hostId: string;
  readonly canAct: boolean;
}) {
  const labelFor = useFallbackProfileLabels(client, true);
  // Every tuple this card can name - the failed one, the committed target and
  // the PLANNED one, which is the only destination there is during the window
  // the user can act in.
  const modelLabelFor = useFallbackModelLabels(
    client,
    pendingFallbackHarnessSubjects(pending),
    true,
  );
  const resolvers: FallbackIdentityResolvers = { labelFor, modelLabelFor };
  const plan = routingCountdownPlan(pending);
  // Which countdown this is: the host's plan id changes exactly when the
  // planned step does, and `"none"` is its own window.
  const windowKey = `${pending.traversalId}:${pending.impendingAction?.planId ?? "none"}`;
  const failed = fallbackTupleIdentity(
    pending.failedTuple,
    labelFor,
    modelLabelFor,
  );
  // "Sign in instead" belongs only to a signed-out traversal with somewhere to
  // sign in - the predicate the announcer names the button by, too.
  const signedOut = pendingFallbackOffersSignIn(pending);
  const signIn = useSignInInstead({
    pending,
    failed,
    client,
    chatId,
    epicId,
    hostId,
  });
  const proceed = useFallbackProceed(client, chatId);
  const proceedSupported = useHostSupportsMethod(hostId, PROCEED_METHOD);
  const openSettings = useOpenFallbackSettings(hostId);

  const onProceed = useCallback(() => {
    proceed.mutate({
      epicId,
      chatId,
      traversalId: pending.traversalId,
      revision: pending.revision,
    });
  }, [chatId, epicId, pending.revision, pending.traversalId, proceed]);

  // `switching` has committed: no window is left to act in. A plan the host is
  // still resolving disables the row too (spec Flow 1, "Still deciding"), and
  // says so beside it.
  const committed = pending.state === "switching";
  const busy = signIn.cancelPending || proceed.isPending;
  const disabled = busy || !canAct || committed || plan.kind === "deciding";
  const primaryLabel = countdownPrimaryLabel(plan);
  const note = countdownActionNote({ canAct, committed, plan });
  let primary: ReactNode = null;
  if (plan.kind === "wait") {
    // A wait names no destination, so the one productive thing to do is
    // choose one: the picker is the filled button, as on the waiting card,
    // and the countdown flows into the wait on its own.
    primary = (
      <RoutingDestinationPicker
        entry={{ kind: "countdown", pending }}
        triggerLabel={CHOOSE_ANOTHER_MODEL_LABEL}
        triggerAriaLabel={null}
        triggerVariant="default"
        triggerDisabled={committed || busy}
        canAct={canAct}
        epicId={epicId}
        chatId={chatId}
        hostId={hostId}
      />
    );
  } else if (primaryLabel !== null && proceedSupported) {
    primary = (
      <Button size="sm" disabled={disabled} onClick={onProceed}>
        {primaryLabel}
        {proceed.isPending ? <PendingDots /> : null}
      </Button>
    );
  }

  return (
    <RoutingCardFrame state="countdown">
      <RoutingStatusLine
        tone="warning"
        cause={fallbackReasonLabelFor(pending.reason)}
        subject={`${failed.providerLabel} · ${failed.profileLabel}`}
        onOpenSettings={openSettings}
      />
      <CountdownHeadline
        // One mount per window; see `CountdownHeadline`.
        key={windowKey}
        state={pending.state}
        plan={plan}
        deadline={pending.deadline}
        graceRemainingMs={pending.graceRemainingMs}
        windowKey={windowKey}
      />
      <CountdownRouteLine
        pending={pending}
        plan={plan}
        resolvers={resolvers}
        committed={committed}
        canAct={canAct}
        chatId={chatId}
        epicId={epicId}
        hostId={hostId}
      />
      <RoutingCostLine text={countdownCostLine(pending, plan)} />
      <RoutingActionRow note={note}>
        {primary}
        {signedOut ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={signIn.onSignInInstead}
          >
            {countdownRefusalLabel(pending, plan)}
            {signIn.signInPending ? <PendingDots /> : null}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={signIn.onCancel}
          >
            {countdownRefusalLabel(pending, plan)}
            {signIn.cancelPending && !signIn.signInPending ? (
              <PendingDots />
            ) : null}
          </Button>
        )}
      </RoutingActionRow>
    </RoutingCardFrame>
  );
}

/**
 * The "now" button per plan, or `null` where there is none to press: a wait's
 * productive action is the picker instead (the countdown flows into the wait
 * on its own, so starting it early is not worth a button), a resume is the
 * wait finishing, and a plan the host has not resolved has no step to run
 * early.
 *
 * "Switch now" ends the window, not the probe behind it: the host may spend up
 * to 30 seconds confirming the account before it commits, so the card keeps
 * the countdown's words until a frame says `switching` - it never claims the
 * switch on the click.
 */
function countdownPrimaryLabel(plan: RoutingCountdownPlan): string | null {
  switch (plan.kind) {
    case "switch":
      return SWITCH_NOW_LABEL;
    case "wait":
    case "resume":
    case "deciding":
    case "nothing":
      return null;
  }
}

/**
 * Why the row is disabled, said beside it - or `null` when it is not, or when
 * the reason is on the card already (`switching` says "Switching…").
 */
function countdownActionNote(input: {
  readonly canAct: boolean;
  readonly committed: boolean;
  readonly plan: RoutingCountdownPlan;
}): string | null {
  if (!input.canAct) return RECONNECTING_LABEL;
  if (!input.committed && input.plan.kind === "deciding") {
    return DECIDING_LABEL;
  }
  return null;
}

/**
 * The cost line: COUNT clauses only, and only when true - "2 queued messages
 * move with it", "1 other chat in this task is also switching". What a switch
 * does to the session is the picker footer's sentence, and that the
 * destination can be changed is the chip's own affordance, so neither is
 * repeated here (clutter cuts, 2026-09-27). With no count to state the line is
 * not drawn at all. The clauses are the announcer's too
 * (`routingCountdownCountClauses`).
 */
function countdownCostLine(
  pending: PendingFallback,
  plan: RoutingCountdownPlan,
): string | null {
  return joinCostClauses(routingCountdownCountClauses(pending, plan));
}

/**
 * From → to. The "to" end is the picker's trigger. Where the plan names no
 * destination - a wait, or a plan the host is still deciding - the failed
 * tuple stands alone and nothing on the line is clickable: a wait's picker is
 * the action row's filled button, and its time is in the headline.
 */
function CountdownRouteLine({
  pending,
  plan,
  resolvers,
  committed,
  canAct,
  chatId,
  epicId,
  hostId,
}: {
  readonly pending: PendingFallback;
  readonly plan: RoutingCountdownPlan;
  readonly resolvers: FallbackIdentityResolvers;
  readonly committed: boolean;
  readonly canAct: boolean;
  readonly chatId: string;
  readonly epicId: string;
  readonly hostId: string;
}) {
  const from = routeTupleOf(pending.failedTuple, resolvers);
  if (plan.kind === "switch") {
    const to = routeTupleOf(plan.destination, resolvers);
    return (
      <RouteLine>
        <RouteTupleChip tuple={from} peer={to} end="from" />
        <RouteArrow />
        <RoutingDestinationPicker
          entry={{ kind: "countdown", pending }}
          triggerLabel={<RouteTupleTriggerContent tuple={to} peer={from} />}
          triggerAriaLabel={`Change destination: ${routeTupleText(to, from)}`}
          triggerVariant="route-chip"
          triggerDisabled={committed}
          canAct={canAct}
          epicId={epicId}
          chatId={chatId}
          hostId={hostId}
        />
      </RouteLine>
    );
  }
  return (
    <RouteLine>
      <RouteTupleChip tuple={from} peer={null} end="single" />
    </RouteLine>
  );
}

/**
 * The headline, and the drain bar along the card's top edge.
 *
 * Its own component so the once-a-second tick repaints this line and the bar
 * rather than the whole card. Both come from ONE `useSyncExternalStore`
 * snapshot (`useGraceCountdownState`): a render-time clock read is memoized on
 * the deadline under the React Compiler, and the bar would freeze at its first
 * width while the label kept ticking - the failure the countdown's compiler
 * pin exists to catch.
 *
 * Mounted once per WINDOW: the card keys it by `windowKey`, so a new plan is a
 * new mount and its identity is the window's. That is what keeps the drain's
 * latch from outliving its window. The second clock can be paused - it does
 * not fire while the window is off screen - and the host mints a new plan
 * without re-arming the deadline, so a plan landing during a hide would be
 * rendered against the sample from before it and latch that stale remainder
 * as the new window's length. A new mount's first render is floored at the
 * moment it mounts (`useGraceCountdownState`), which for a new plan is the
 * moment the plan arrived. The one visible cost: a new plan's bar appears
 * full at once instead of sweeping up from the old plan's leftover.
 */
function CountdownHeadline({
  state,
  plan,
  deadline,
  graceRemainingMs,
  windowKey,
}: {
  readonly state: PendingFallback["state"];
  readonly plan: RoutingCountdownPlan;
  readonly deadline: number | null;
  /** The frozen remainder while `choosing`, drawn as a still bar. */
  readonly graceRemainingMs: number | null;
  /** Which countdown this is: a new plan is a new window to drain. */
  readonly windowKey: string;
}) {
  const countdown = useGraceCountdownState(state === "hold" ? deadline : null);
  const remainingMs = drainRemainingMs(state, countdown, graceRemainingMs);
  const fraction = useDrainFraction(remainingMs, windowKey);
  // The shared minute clock, for one decision: whether the wait's end is far
  // enough out to need its weekday (`formatWaitTime`).
  const now = useSampledNow();
  const waitUntil =
    plan.kind === "wait" && plan.resumesAt !== null
      ? formatWaitTime(plan.resumesAt, now)
      : null;
  return (
    <>
      {fraction === null ? null : <DrainBar fraction={fraction} />}
      <div
        data-testid="routing-card-headline"
        className="text-ui-md font-semibold text-foreground"
      >
        {countdownHeadlineText({
          state,
          plan,
          countdownLabel: countdown === null ? null : countdown.label,
          waitUntil,
        })}
      </div>
    </>
  );
}

/**
 * How much of the window is left to draw: the live remainder on a `hold`, the
 * host's frozen remainder while `choosing`, and nothing once `switching` has
 * committed.
 */
function drainRemainingMs(
  state: PendingFallback["state"],
  countdown: { readonly remainingMs: number } | null,
  graceRemainingMs: number | null,
): number | null {
  if (state === "hold")
    return countdown === null ? null : countdown.remainingMs;
  if (state === "choosing") return graceRemainingMs;
  return null;
}

/**
 * The bar's fill, `remaining / total`.
 *
 * The frame carries the deadline but not the window's length, so the total is
 * the most this card has seen remaining for THIS window (keyed by traversal and
 * plan): the first sample, or more if a resume granted more. A card that
 * mounts mid-window therefore drains from full over what is left, which is
 * true about what is left. State rather than a ref, and adjusted during render
 * (React's "storing information from previous renders"), so the compiled
 * component reads it like any other input.
 */
function useDrainFraction(
  remainingMs: number | null,
  windowKey: string,
): number | null {
  const [span, setSpan] = useState<{
    readonly key: string;
    readonly totalMs: number;
  } | null>(null);
  const known = span !== null && span.key === windowKey ? span.totalMs : null;
  if (
    remainingMs !== null &&
    remainingMs > 0 &&
    (known === null || remainingMs > known)
  ) {
    setSpan({ key: windowKey, totalMs: remainingMs });
  }
  if (remainingMs === null) return null;
  const total = Math.max(known ?? 0, remainingMs);
  if (total <= 0) return 0;
  return Math.min(1, remainingMs / total);
}

/** The 3px drain along the card's top edge. The only thing on it that moves. */
function DrainBar({ fraction }: { readonly fraction: number }) {
  return (
    <div
      aria-hidden
      data-testid="routing-drain-bar"
      className="absolute inset-x-0 top-0 h-0.75 bg-warning/15"
    >
      <div
        data-testid="routing-drain-fill"
        className="h-full bg-warning transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
        style={{ width: `${(fraction * 100).toFixed(2)}%` }}
      />
    </div>
  );
}

/**
 * One short sentence: what happens and when - for a wait, until when too
 * ("Waiting until 3:21 am starts in 14s"), which is where the wait's clock
 * badge used to sit.
 *
 * `choosing` says "paused" only because the HOST granted it - the frame says
 * `choosing` - never on the click.
 */
function countdownHeadlineText(input: {
  readonly state: PendingFallback["state"];
  readonly plan: RoutingCountdownPlan;
  readonly countdownLabel: string | null;
  /** The wait's end, formatted, or `null` with no wait or no known end. */
  readonly waitUntil: string | null;
}): string {
  const { state, plan, countdownLabel, waitUntil } = input;
  if (state === "switching") return committedHeadline(plan);
  if (state === "choosing") return "Paused while you choose";
  const when = countdownPhrase(countdownLabel ?? GRACE_COUNTDOWN_IMMINENT);
  switch (plan.kind) {
    case "switch":
      return `Switching ${when}`;
    case "wait":
      return waitUntil === null
        ? `Waiting starts ${when}`
        : `Waiting until ${waitUntil} starts ${when}`;
    case "resume":
      return `Resuming ${when}`;
    case "deciding":
      return "Deciding what to do…";
    case "nothing":
      return "Nothing else to try";
  }
}

/** The one frame after the window: the step is under way. */
function committedHeadline(plan: RoutingCountdownPlan): string {
  switch (plan.kind) {
    case "switch":
      return "Switching…";
    case "resume":
      return "Resuming now…";
    case "wait":
      return "Starting the wait…";
    // The host has entered a step and resolves its target in the next breath
    // - which may skip it for a wait or a settle - so "Switching…" here would
    // be false every time the step was skipped.
    case "deciding":
    case "nothing":
      return "Deciding what to do…";
  }
}

/**
 * "in 12s" - or, at or past the deadline, the imminent phrase on its own, so
 * the headline never reads "Switching in any moment now".
 */
function countdownPhrase(countdown: string): string {
  return countdown === GRACE_COUNTDOWN_IMMINENT ? countdown : `in ${countdown}`;
}

/**
 * Cancel, and "Sign in instead" - which is cancel first and navigate only once
 * the host APPLIED it.
 *
 * Signing in is a multi-second trip through Settings, so an uncancelled
 * countdown would expire and switch the chat while the user fixed the account
 * they had just chosen to keep. The navigation is armed by the click and run
 * by the host's answer, through the mutation-level callback, because an
 * applied cancel settles the traversal and unmounts this card before the
 * answer can reach anything the card owns. A ref and not state: nothing
 * renders from it, and it must survive the unmount.
 */
function useSignInInstead(input: {
  readonly pending: PendingFallback;
  readonly failed: FallbackTupleIdentity;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly chatId: string;
  readonly epicId: string;
  readonly hostId: string;
}): {
  readonly onCancel: () => void;
  readonly onSignInInstead: () => void;
  readonly cancelPending: boolean;
  readonly signInPending: boolean;
} {
  const { pending, failed, client, chatId, epicId, hostId } = input;
  const pendingSignInRef = useRef<(() => void) | null>(null);
  const [signInSent, setSignInSent] = useState(false);
  const onCancelOutcome = useCallback((outcome: FallbackActionOutcome) => {
    const navigate = pendingSignInRef.current;
    // Disarmed on EVERY outcome: a refusal that left it armed would open
    // Settings on the next plain refusal the user made.
    pendingSignInRef.current = null;
    if (outcome !== "applied" || navigate === null) return;
    navigate();
  }, []);
  const cancel = useFallbackCancel(client, chatId, onCancelOutcome);
  const { openSettings } = useSystemTabModalActions();
  const onCancel = useCallback(() => {
    // Disarm first: a sign-in whose cancel died in transport never reaches
    // `onCancelOutcome`, and a plain refusal must not inherit it.
    pendingSignInRef.current = null;
    setSignInSent(false);
    cancel.mutate({
      epicId,
      chatId,
      traversalId: pending.traversalId,
      revision: pending.revision,
    });
  }, [cancel, chatId, epicId, pending.revision, pending.traversalId]);
  const profileId = pending.failedTuple.profileId;
  const onSignInInstead = useCallback(() => {
    pendingSignInRef.current = () => {
      // Unreachable while the card's `signedOut` holds the same check - which
      // is the point: this keeps a future change to that gate from quietly
      // restoring a cancel that opens nothing.
      if (failed.providerId === null) return;
      // The chat's OWN host on both branches: the ambient branch writes only a
      // harness id, and Settings would otherwise open sign-in on whichever
      // host it last showed.
      carryViewedHostIntoSettingsScope(hostId);
      const focus = useProvidersFocusStore.getState();
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
      openSettings({
        section: "providers",
        resetToGeneral: false,
        tab: null,
        draft: null,
        hostId: null,
      });
    };
    setSignInSent(true);
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
    pending.revision,
    pending.traversalId,
    profileId,
  ]);
  return {
    onCancel,
    onSignInInstead,
    cancelPending: cancel.isPending,
    signInPending: cancel.isPending && signInSent,
  };
}

/* ------------------------------------------------------------------------- */
/* Waiting                                                                   */
/* ------------------------------------------------------------------------- */

function WaitingRoutingCard({
  pending,
  client,
  chatId,
  epicId,
  hostId,
  canAct,
}: {
  readonly pending: PendingFallback;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly chatId: string;
  readonly epicId: string;
  readonly hostId: string;
  readonly canAct: boolean;
}) {
  const labelFor = useFallbackProfileLabels(client, true);
  // One tuple: a wait parks on the account that failed and resumes there.
  const modelLabelFor = useFallbackModelLabels(
    client,
    [pending.failedTuple.harnessId],
    true,
  );
  // Nothing to do with the outcome: "Stop waiting" has no follow-on
  // navigation, and the shared toast already reports a refusal.
  const cancel = useFallbackCancel(client, chatId, IGNORE_FALLBACK_OUTCOME);
  const openSettings = useOpenFallbackSettings(hostId);
  const waiting = fallbackTupleIdentity(
    pending.failedTuple,
    labelFor,
    modelLabelFor,
  );
  const tuple = routeTupleOf(pending.failedTuple, { labelFor, modelLabelFor });
  const onStopWaiting = useCallback(() => {
    cancel.mutate({
      epicId,
      chatId,
      traversalId: pending.traversalId,
      revision: pending.revision,
    });
  }, [cancel, chatId, epicId, pending.revision, pending.traversalId]);
  const disabled = cancel.isPending || !canAct;

  return (
    <RoutingCardFrame state="waiting">
      <RoutingStatusLine
        tone="neutral"
        cause={fallbackReasonLabelFor(pending.reason)}
        subject={`${waiting.providerLabel} · ${waiting.profileLabel}`}
        onOpenSettings={openSettings}
      />
      <WaitingHeadline deadline={pending.deadline} />
      {/* The tuple alone says what resumes. */}
      <RouteLine>
        <RouteTupleChip tuple={tuple} peer={null} end="single" />
      </RouteLine>
      <RoutingCostLine
        text={joinCostClauses([queuedWaitingClause(pending.queuedItemsMoving)])}
      />
      <RoutingActionRow note={canAct ? null : RECONNECTING_LABEL}>
        {/*
         * The filled button is the picker here, and this is the one card where
         * the picker has a button: waiting is passive, so the only productive
         * thing to do is leave, and there is no destination chip to click.
         */}
        <RoutingDestinationPicker
          entry={{ kind: "waiting", pending }}
          triggerLabel={CHOOSE_ANOTHER_MODEL_LABEL}
          triggerAriaLabel={null}
          triggerVariant="default"
          triggerDisabled={cancel.isPending}
          canAct={canAct}
          epicId={epicId}
          chatId={chatId}
          hostId={hostId}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={onStopWaiting}
        >
          {STOP_WAITING_LABEL}
          {cancel.isPending ? <PendingDots /> : null}
        </Button>
      </RoutingActionRow>
    </RoutingCardFrame>
  );
}

/**
 * "Resuming at 1:02 am · in about 1h 27m", or "Resuming shortly…".
 *
 * TWO elements on one line, and the split is the point. The `role="status"`
 * region carries the deadline alone - a fact for the life of the wait, so its
 * text changes once, when the deadline passes - and the countdown is a
 * SIBLING of it, readable on demand but not re-announced every minute of a
 * six-hour wait. Both returns render the same element at the same position,
 * so React keeps the live region across the deadline rather than swapping in
 * a new one that assistive tech was not observing. Entering the wait is
 * spoken by the chat's announcer, not here.
 *
 * Minute resolution: a wait runs to a provider's reset boundary and is
 * measured in hours.
 */
function WaitingHeadline({ deadline }: { readonly deadline: number | null }) {
  const now = useSampledNow();
  if (deadline === null || deadline <= now) {
    return (
      <div
        data-testid="routing-card-headline"
        className="text-ui-md font-semibold text-foreground"
      >
        <span role="status">Resuming shortly…</span>
      </div>
    );
  }
  return (
    <div
      data-testid="routing-card-headline"
      className="text-ui-md font-semibold text-foreground"
    >
      <span role="status">Resuming at {formatWaitTime(deadline, now)}</span>
      <span className="font-normal text-muted-foreground">
        {" "}
        · in about {formatResetCountdown(deadline, now)}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Return                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * The offer to move this chat back to the account it started on. Unchanged in
 * behaviour: surfaced only once the host says so, and every answer ends the
 * traversal, so it carries no settings gear - it describes a chat that is
 * working. The route runs the other way, from where the chat is now back to
 * where it started, and switching back moves the queued messages too, which
 * the cost line counts when there are any.
 *
 * Two answers (clutter cuts, 2026-09-27): "Switch back", and "Stay on …",
 * which dismisses this offer. The per-chat "Don't ask for this chat" is gone
 * from this card; its host action stays for older clients.
 */
function ReturnRoutingCard({
  offer,
  lowUsage,
  client,
  chatId,
  epicId,
  canAct,
}: {
  readonly offer: PendingReturn;
  readonly lowUsage: FallbackReturnLowUsage | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly chatId: string;
  readonly epicId: string;
  readonly canAct: boolean;
}) {
  const labelFor = useFallbackProfileLabels(client, true);
  const modelLabelFor = useFallbackModelLabels(
    client,
    [offer.preferredTuple.harnessId, offer.fallbackTuple.harnessId],
    true,
  );
  const returnToPreferred = useFallbackReturnToPreferred(client, chatId);
  const preferred = fallbackTupleIdentity(
    offer.preferredTuple,
    labelFor,
    modelLabelFor,
  );
  const current = fallbackTupleIdentity(
    offer.fallbackTuple,
    labelFor,
    modelLabelFor,
  );
  const resolvers: FallbackIdentityResolvers = { labelFor, modelLabelFor };
  const from = routeTupleOf(offer.fallbackTuple, resolvers);
  const to = routeTupleOf(offer.preferredTuple, resolvers);
  const answer = useCallback(
    (action: "switch_back" | "stay") => {
      returnToPreferred.mutate({
        epicId,
        chatId,
        traversalId: offer.traversalId,
        revision: offer.revision,
        action,
      });
    },
    [chatId, epicId, offer.revision, offer.traversalId, returnToPreferred],
  );
  const disabled = returnToPreferred.isPending || !canAct;
  const currentName = accountName(current, preferred);

  return (
    <RoutingCardFrame state="return">
      <RoutingStatusLine
        tone="success"
        cause={null}
        subject={combinedHeadline(
          resetHeadline(preferred),
          currentName,
          lowUsage,
        )}
        onOpenSettings={null}
      />
      <div
        data-testid="routing-card-headline"
        className="text-ui-md font-semibold text-foreground"
      >
        Switch back to {accountName(preferred, current)}?
      </div>
      <RouteLine>
        <RouteTupleChip tuple={from} peer={to} end="from" />
        <RouteArrow />
        <RouteTupleChip tuple={to} peer={from} end="to" />
      </RouteLine>
      <RoutingCostLine
        text={joinCostClauses([queuedReturningClause(offer.queuedItemsMoving)])}
      />
      <RoutingActionRow note={canAct ? null : RECONNECTING_LABEL}>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => {
            answer("switch_back");
          }}
        >
          {SWITCH_BACK_LABEL}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            answer("stay");
          }}
        >
          Stay on {currentName}
        </Button>
      </RoutingActionRow>
    </RoutingCardFrame>
  );
}

/**
 * "Personal 3's limit has reset and Surya is running low on Fable usage".
 *
 * One clause joined to the reset rather than a second line: the account that
 * failed is back and the one carrying the chat is running out, which is one
 * situation. `null` low usage leaves the reset clause alone.
 */
function combinedHeadline(
  reset: string,
  currentAccountName: string,
  lowUsage: FallbackReturnLowUsage | null,
): string {
  if (lowUsage === null) return reset;
  return `${reset} · ${fallbackLowUsageClause({
    accountName: currentAccountName,
    severity: lowUsage.severity,
    limitedFamilies: lowUsage.limitedFamilies,
  })}`;
}

/**
 * "Personal 3's limit has reset", or the Terminal-account form, which names
 * the provider because the ambient account has no name of its own.
 */
function resetHeadline(preferred: FallbackTupleIdentity): string {
  if (preferred.profileLabel === TERMINAL_ACCOUNT_LABEL) {
    return `${preferred.providerLabel}'s ${TERMINAL_ACCOUNT_LABEL} limit has reset`;
  }
  return `${preferred.profileLabel}'s limit has reset`;
}

/**
 * What to call one end of the return. Within one provider the account label is
 * the whole difference; across providers - or for the nameless Terminal
 * account - the provider and model are its identity.
 */
function accountName(
  subject: FallbackTupleIdentity,
  other: FallbackTupleIdentity,
): string {
  const crossProvider = subject.providerId !== other.providerId;
  if (crossProvider || subject.profileLabel === TERMINAL_ACCOUNT_LABEL) {
    return `${subject.providerLabel} · ${subject.model}`;
  }
  return subject.profileLabel;
}

/* ------------------------------------------------------------------------- */
/* Shared anatomy                                                            */
/* ------------------------------------------------------------------------- */

/**
 * The card's one frame. Tone is carried by the status line's icon and colour,
 * never by the frame, so the three states cannot drift into three looks again.
 * `relative` and `overflow-hidden` hold the countdown's drain bar to the top
 * edge.
 */
function RoutingCardFrame({
  state,
  children,
}: {
  readonly state: RoutingCardState["kind"];
  readonly children: ReactNode;
}) {
  return (
    <div
      data-testid="routing-card"
      data-routing-card-state={state}
      className="relative flex w-full flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card px-3 pt-3 pb-2.5 text-ui-sm"
    >
      {children}
    </div>
  );
}

type RoutingTone = "warning" | "neutral" | "success";

const TONE_ICON: Readonly<Record<RoutingTone, LucideIcon>> = {
  warning: AlertTriangle,
  neutral: Clock,
  success: CheckCircle2,
};

const TONE_TEXT: Readonly<Record<RoutingTone, string>> = {
  warning: "text-warning-foreground",
  neutral: "text-muted-foreground",
  success: "text-success-foreground",
};

/**
 * Cause · the account that failed · gear. Nothing else lives up here.
 *
 * The gear opens this chat's host's routing settings, once, where the card
 * used to carry a "Model routing" link twice. It is never disabled, not even
 * for a reader who cannot steer the chat: reading the settings steers nothing.
 */
function RoutingStatusLine({
  tone,
  cause,
  subject,
  onOpenSettings,
}: {
  readonly tone: RoutingTone;
  /** The failure's label, or `null` for a reason this build does not know. */
  readonly cause: string | null;
  readonly subject: string;
  readonly onOpenSettings: (() => void) | null;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      data-testid="routing-status-line"
      className="flex min-w-0 items-start gap-2 text-ui-xs text-muted-foreground"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 pt-1">
        <Icon
          aria-hidden
          className={cn("size-3.5 shrink-0", TONE_TEXT[tone])}
        />
        {cause === null ? null : (
          <>
            <span className={cn("font-medium", TONE_TEXT[tone])}>{cause}</span>
            <span aria-hidden className="text-muted-foreground/70">
              ·
            </span>
          </>
        )}
        <span
          className={cn(
            "min-w-0 wrap-anywhere",
            tone === "success" && cn("font-medium", TONE_TEXT.success),
          )}
        >
          {subject}
        </span>
      </div>
      {onOpenSettings === null ? null : (
        <TooltipWrapper
          label={ROUTING_SETTINGS_LABEL}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            size="icon-xs"
            variant="muted"
            aria-label={ROUTING_SETTINGS_LABEL}
            onClick={onOpenSettings}
          >
            <Settings aria-hidden />
          </Button>
        </TooltipWrapper>
      )}
    </div>
  );
}

/** Only when something is true; hidden otherwise. */
function RoutingCostLine({ text }: { readonly text: string | null }) {
  if (text === null) return null;
  return (
    <div
      data-testid="routing-cost-line"
      className="text-ui-xs text-muted-foreground"
    >
      {text}
    </div>
  );
}

/**
 * The action row, and why it is disabled when it is. The note sits beside the
 * buttons - "Reconnecting…", "Deciding…" - so a greyed row never reads as a
 * broken one.
 */
function RoutingActionRow({
  note,
  children,
}: {
  readonly note: string | null;
  readonly children: ReactNode;
}) {
  return (
    <div
      data-testid="routing-action-row"
      className="mt-1 flex flex-wrap items-center gap-2"
    >
      {children}
      {note === null ? null : (
        <span
          data-testid="routing-action-note"
          className="text-ui-xs text-muted-foreground"
        >
          {note}
        </span>
      )}
    </div>
  );
}

function PendingDots() {
  return (
    <AgentSpinningDots
      className={undefined}
      testId={undefined}
      variant={undefined}
    />
  );
}
