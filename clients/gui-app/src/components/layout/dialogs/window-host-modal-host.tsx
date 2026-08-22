import { useEffect, type ReactNode } from "react";
import {
  WindowHostModal,
  WindowHostStartupCard,
  type WindowHostModalProps,
} from "@/components/layout/dialogs/window-host-modal";
import {
  gateBlocksApp,
  gateCardReadiness,
  presentsLocalHostLifecycle,
  useHostReadinessController,
  type DefaultHostReadinessPresentation,
} from "@/components/layout/host-readiness-controller-context";
import { LocalBootstrapAttempts } from "@/components/host/local-bootstrap-attempts";
import {
  BootstrapLogDisclosure,
  LocalHostBodyShell,
  LocalHostLoadingContent,
} from "@/components/local-host-loading";
import { BootOpenSettingsButton } from "@/components/host/host-boot-surface";
import { useHostProvisioningProgress } from "@/hooks/host/use-host-provisioning-progress";
import { useWindowNarration } from "@/hooks/host/use-window-narration";
import { useAuthStore } from "@/stores/auth/auth-store";
import { getClientAppVersion } from "@/lib/app-version";
import { isMobileApp } from "@/lib/mobile-app";
import { appLogger } from "@/lib/logger";
import type { HostProgressView } from "@/lib/host/host-progress-copy";
import {
  hostUpdateActionApplies,
  type WindowNarrationCause,
  type WindowNarrationState,
  type WindowNarrationVariant,
} from "@/lib/host/window-narration";

/**
 * The window narrator's HOME: the one place that decides whether the modal is
 * on screen, and the mount point the local-host lifecycle re-parents into.
 *
 * Mounted once per window, OUTSIDE the readiness gate (the gate replaces its
 * children during cold start, so a modal mounted inside it could never narrate
 * the cold start it exists for) and inside the router, which is what lets the
 * `/settings` bypass below be a route question.
 *
 * WHY THE LIFECYCLE IS NOT MOUNTED HERE (P3.4, ruled after measuring). An
 * earlier draft of this comment promised the opposite - that P3.4 would wrap
 * this component's body in `HostProvisioningController` and read its lifecycle
 * in place of `presentation`, "since the fields are already exactly the shape
 * it hands back". That was wrong three ways, and the note survives so nobody
 * re-derives it:
 *
 *  1. Of the fields read below, only `retryProvisioning`/`forceProvisioning`/
 *     `provisioning` come from that controller. `configureShell`,
 *     `refreshDirectory` and `openSettings` are the readiness provider's own
 *     props; `canManageHost` and `presentsLocalHostLifecycle` need
 *     `targetKind` + `localBootIntent`, derived up there from the binding, the
 *     directory and the authority's effective host.
 *  2. The readiness projection CONSUMES that lifecycle while the controller's
 *     own `enabled`/`isReady` come from the projection's inputs. Mounting it
 *     below closes the loop.
 *  3. This component is CONDITIONAL - silent is its normal state. The
 *     busy-keep and removed latches live in that hook, and its per-`mutate`
 *     callbacks are dropped when their component unmounts, so hanging the
 *     lifecycle off a surface that comes and goes would lose the busy verdict
 *     and the "where the install died" stage precisely when a wait resolves.
 *
 * So the lifecycle stays mounted above the router and this stays its reader.
 * Progress does not come through the presentation at all: see
 * `useHostProvisioningProgress`, which reads the mutation lane so a first
 * launch driven by the desktop's own reconciler still narrates here.
 */
export function WindowHostModalHost(props: {
  /**
   * The caller's routing-aware answer to "is this a host-independent route".
   *
   * Injected rather than read from the router here, following the same rule
   * the readiness gate's `bypass` prop states: ONE routing-aware computation
   * drives the narrators instead of each layer re-deriving it. It also keeps
   * this component mountable in the trees that exercise host lifecycle
   * without a router.
   *
   * Settings is the escape hatch for a host that cannot start - its Shell page
   * edits the launch config through the CLI, with no running host involved -
   * so the narrator steps aside there. The modal's own "Open settings" action
   * is what sends a user there in the first place.
   */
  readonly bypassed: boolean;
}): ReactNode {
  const narration = useWindowNarration();

  if (narration.kind === "silent") return null;
  if (props.bypassed) return null;
  return <NarratingWindowHostModal narration={narration} />;
}

/**
 * Records that this modal stood down, and for which card.
 *
 * A suppression is invisible by construction - the surface renders nothing, so
 * the only evidence a user can give is a screenshot of the card that WON, which
 * looks identical whether the suppression fired or was never needed. Without
 * this, "the modal is missing" and "the modal correctly deferred" are the same
 * report, and the first triage step is unanswerable from logs.
 *
 * Both halves are needed and they answer different questions. `by` is the gate
 * kind now on screen; `suppressedCause`/`suppressedVariant` is what this surface
 * would have said instead - which is how a WRONG suppression shows up at all,
 * since a stand-down for a cause the gate's card does not describe is a
 * user-visible loss of narration, not a tidy-up.
 *
 * Edge-triggered on the (gate kind x narration) pair rather than logged per
 * render: this is a render path under a lane that ticks, and a per-render line
 * would bury the transition it exists to record in its own repetitions.
 */
function useSuppressionLog(
  gateKind: string | null,
  narration: Extract<WindowNarrationState, { readonly kind: "narrating" }>,
): void {
  const cause = narration.cause;
  const variant = narration.variant.kind;
  useEffect(() => {
    if (gateKind === null) return;
    appLogger.info("[window-narration] modal stood down for the gate's card", {
      by: gateKind,
      suppressedCause: cause,
      suppressedVariant: variant,
    });
  }, [gateKind, cause, variant]);
}

/**
 * Everything the modal needs to DRAW, read only once it is actually drawing.
 *
 * Split from the component above so that a silent narrator - which is every
 * window, almost all of the time - reads nothing but the authority projection.
 * That is not a micro-optimization: this mounts at the app root, and reading
 * the host controller's lane unconditionally there made the ROOT depend on
 * `RunnerHostProvider`, so two root-route suites that had never needed one
 * lost their whole tree to a throw. Narrowing the dependency to the narrating
 * case is the honest contract - the lane is only interesting when there is
 * something to say about it.
 */
function NarratingWindowHostModal(props: {
  readonly narration: Extract<
    WindowNarrationState,
    { readonly kind: "narrating" }
  >;
}): ReactNode {
  const { narration } = props;
  const progress = useHostProvisioningProgress();
  const controller = useHostReadinessController();
  const authStatus = useAuthStore((state) => state.status);
  const presentation = controller.defaultHostPresentation;
  const localLifecycle = presentsLocalHostLifecycle(presentation);
  const settled = hasSettledFailure(narration.cause, presentation);
  const retry = resolveRetry(
    narration.variant,
    presentation,
    localLifecycle,
    settled,
  );
  // ONE NARRATOR PER SCOPE, enforced from this side too.
  //
  // The gate draws its own full-screen card for the kinds the narrator does not
  // own - `provisioning-error` and `removed-host`, local lifecycle terminals
  // P3.4 deliberately left with the machinery that owns them. This modal derives
  // from the authority's LEASES rather than from readiness, so on a single-host
  // account whose local provision threw, both conditions held at once and the
  // user got this modal at `z-[60]` behind its blur, floating over that card,
  // each with its own copy and its own recovery actions.
  //
  // The GATE CARD wins, and not arbitrarily: its Retry is unconditionally
  // `retryProvisioning`, where `resolveRetry` above degrades to
  // `refreshDirectory` when the shell cannot manage the host - refreshing a host
  // directory is not a recovery for a local install that just failed. It also
  // names the actual error, where this surface says "No host is available".
  //
  // GATED ON THE LATCH, NOT ON THE KIND. After the gate latches it stops
  // replacing the app and draws no card at all, and this modal is then the only
  // thing that can narrate. Standing down on the kind alone would go silent there
  // too - a failure nobody reports, which is strictly worse than two cards.
  // `gateCardReadiness` is the gate's own predicate, shared rather than restated:
  // a second copy of it here would be the very defect this suppression fixes,
  // planted by hand.
  //
  // Read HERE rather than in `WindowHostModalHost`, deliberately. That component
  // mounts at the app root and reading the controller there made the ROOT depend
  // on `RunnerHostProvider`, costing two root-route suites their whole tree. By
  // this point the narrator has already decided it is speaking.
  const predicateInput = {
    readiness: controller.readinessFor("default-host", null),
    hasBeenReady: controller.hasBeenDefaultHostReady,
    signedIn: authStatus === "signed-in",
    // The `/settings` bypass is already handled: `WindowHostModalHost` returns
    // null on it before this component mounts, so the gate is not drawing
    // there either and there is nothing to stand down from.
    bypassed: false,
  };
  const gateDrawn = gateCardReadiness(predicateInput);
  // WHICH PRESENTATION: the same predicate the gate itself renders from, so
  // the two can never disagree about whether an app exists behind this
  // surface. While the gate blocks (cold start - the frame is empty), the
  // narration is the released-style full-screen CARD in that frame: no
  // overlay, no pointer trap, toasts alive. Once the gate has latched, a
  // narration can only be the ∅ verdict over a mounted app, and only THAT
  // renders the blocking dialog.
  const blocking = gateBlocksApp(predicateInput);
  // `gateCardReadiness` rather than the boolean wrapper: the log's whole value
  // is naming WHICH card won, and re-deriving that from the readiness here
  // would be the second copy this suppression exists to avoid.
  useSuppressionLog(gateDrawn?.kind ?? null, narration);
  if (gateDrawn !== null) {
    return null;
  }
  const updateHost = resolveUpdateHost(narration.variant, presentation);
  // WHETHER `Open settings` IS THE ONLY ACTION. Computed once, read twice - by
  // the body (which hosts it inline on the footer row) and by the card (which
  // then draws no action row of its own). Two derivations of this would let a
  // card render the settings link in both places or in neither.
  //
  // It is true exactly on the healthy blocking start - `offline`, nothing to
  // retry, nothing to update, nothing failed - and that is also exactly when
  // `buildBootBody` draws the boot body, so the link always has its footer row
  // to sit on. This gate used to ask a fourth question, "is the target this
  // machine", because the body was withheld for any other target; the answer
  // was a card that drew nothing but the `Open settings` link. The body no
  // longer depends on the target (see `buildBootBody`), so neither does this.
  const settingsOnly =
    blocking &&
    narration.variant.kind === "offline" &&
    retry.onRetry === null &&
    updateHost === null &&
    !settled.failed;
  const narrationProps: WindowHostModalProps = {
    cause: narration.cause,
    variant: narration.variant,
    progress,
    settingsOnly,
    bootBody: buildBootBody({
      variant: narration.variant,
      presentation,
      localLifecycle,
      progress,
      settingsOnly,
      // The same `settled.failed` the action row reads, deliberately: the body
      // and the actions must agree about whether this attempt is over. Two
      // derivations of that is how the modal ended up offering Retry beside a
      // spinner claiming a start.
      settledFailure: settled.failed,
    }),
    onRetry: retry.onRetry,
    retryPending: retry.pending,
    onUpdateHost: updateHost,
    onOpenSettings: presentation.openSettings,
    // Report issue is offered only once something has actually failed. It is
    // the affordance that converts a false impression of breakage into
    // support load, and on a healthy first launch there is no failure for a
    // report to be about. Not folded into `onRetry`'s gate: Retry is also
    // right on the slow arm, where nothing has failed yet but the wait has
    // outrun the healthy band, and a report there would still describe a
    // start that is merely taking its time.
    showReportIssue: settled.failed,
    // With no Retry and no Report issue on a healthy start, `Open settings`
    // is the only control on screen - and as an equal-weight button it still
    // reads as "something is wrong, pick one". Quiet link while nothing has
    // failed, button once something has. It is never REMOVED from the dialog:
    // it is the measured escape hatch for a host that cannot start, and
    // gating it behind the failure it exists to fix is the lockout this
    // surface exists to prevent. (The startup card additionally drops its
    // whole action row while nothing is actionable - Settings stays reachable
    // there through the gate frame's own header and "Configure shell…".)
    settingsEmphasis: settled.failed || settled.slow ? "button" : "link",
  };
  if (blocking) {
    return <WindowHostStartupCard {...narrationProps} />;
  }
  if (narration.cause === "cold-start") {
    // Post-latch cold start: the app is mounted and interactive, and its own
    // surfaces (tiles' bounded loading, the chip) tell the connecting story.
    // A dialog here was a modal FLASH at the tail of every warm launch -
    // gate open, first session still a beat away - blocking an app that was
    // about to answer.
    return null;
  }
  if (isMobileApp()) {
    // THE MOBILE APP NEVER GETS THE DIALOG OVER A MOUNTED SHELL, whatever the
    // cause, and this is a navigation rule rather than a styling one.
    //
    // The dialog is a modal layer, so the primitive raises the document pointer
    // barrier for as long as it is rendered. On this shell the barrier does not
    // merely dim the app: the edge-swipe recognizer reads it
    // (`modalLayerCoversApp`) and stands its touch RESERVATION down, so the web
    // view hands the edge drag to whatever scroller is underneath and the
    // gesture cannot come back for the rest of that contact. Back and forward
    // are the phone's only history affordance - there are no title-bar arrows
    // to fall back on - so a narration that flickers here (∅ is one frame away
    // on every resume, where the authority re-attaches with no effective host
    // while a remote host is still perfectly able to serve) costs the whole app
    // its navigation, with no modal left on screen to explain why.
    //
    // The same words are drawn as the startup card instead: a
    // `pointer-events-none` layer with only the card itself live, so the
    // narration is kept - a phone with no reachable host still gets Retry and
    // `Open settings` - while the shell underneath stays the user's to drive.
    // Standing down to `null` would be the cheaper fix and the wrong one: this
    // is the surface that says a fleet is unreachable.
    //
    // The PRODUCT gate, deliberately, and the same one the recognizer itself is
    // gated on: a narrow desktop browser renders the mobile layout without the
    // swipes, and its narration is the desktop's.
    return <WindowHostStartupCard {...narrationProps} />;
  }
  return <WindowHostModal {...narrationProps} />;
}

/**
 * Whether this wait has produced anything a recovery action could be about.
 *
 * `failed` is a settled failure of the attempt being narrated; `slow` is the
 * 10-second promotion `LOCAL_HOST_SLOW_START_THRESHOLD_MS` already computes and
 * whose own doc promises a healthy bundled-host boot "never flashes the Retry
 * UI" - a promise that had no reader left on this surface.
 *
 * Only the cold-start cause gets the healthy grace period. `no-usable-host`
 * means nothing can serve this window right now, which IS the settled failure -
 * there is no in-progress start to protect there, and withholding recovery on
 * that arm would be the mirror defect.
 */
interface SettledFailure {
  readonly failed: boolean;
  readonly slow: boolean;
}

function hasSettledFailure(
  cause: WindowNarrationCause,
  presentation: DefaultHostReadinessPresentation,
): SettledFailure {
  if (cause === "no-usable-host") return { failed: true, slow: false };
  return {
    // `provisioningError` is read ONLY under this cause. Its own contract warns
    // it outlives the attempt that produced it - a host that failed to install
    // and then came up by another route leaves it set - so it may not be
    // treated as ambient host state. Under `cold-start` the modal is on screen
    // precisely because nothing has served this window yet, which is the scope
    // that error still explains.
    failed: presentation.provisioningError !== null,
    slow: presentation.stage === "slow",
  };
}

interface ResolvedRetry {
  readonly onRetry: (() => void) | null;
  readonly pending: boolean;
}

/**
 * Which recovery this state actually has, and whether it has one at all.
 *
 * `plan-restricted` gets NO retry, deliberately: the hosts are healthy and
 * running on their own machines, and a Retry there is a button that can only
 * ever fail while implying the failure is transient. The upgrade action is the
 * whole answer. `update-host` likewise - retrying a version disagreement just
 * re-reads the same versions.
 *
 * For `offline` the answer depends on whose machine this is. When the app
 * manages this machine's host, re-running the install/start is a real recovery
 * (the user-initiated half of provisioning that survived the automatic
 * converge's retirement). When it does not - a fleet of remote machines this
 * app cannot start - the only honest retry is re-reading the registry.
 */
function resolveRetry(
  variant: WindowNarrationVariant,
  presentation: DefaultHostReadinessPresentation,
  localLifecycle: boolean,
  settled: SettledFailure,
): ResolvedRetry {
  if (variant.kind !== "offline") return { onRetry: null, pending: false };
  // A healthy start in progress has nothing to retry. `cause === "cold-start"`
  // always resolves to `offline` by design, so before this gate every local
  // boot rendered Retry from its first frame, with no failure of any kind - the
  // reported defect. Retry is live there too, so the impression of breakage
  // produced a real second converge.
  if (!settled.failed && !settled.slow) {
    return { onRetry: null, pending: false };
  }
  if (localLifecycle && presentation.canManageHost) {
    return {
      onRetry: presentation.retryProvisioning,
      pending: presentation.provisioning,
    };
  }
  return { onRetry: presentation.refreshDirectory, pending: false };
}

function resolveUpdateHost(
  variant: WindowNarrationVariant,
  presentation: DefaultHostReadinessPresentation,
): (() => void) | null {
  if (variant.kind !== "update-host") return null;
  // `canManageHost` asks "is the TARGET this machine"; the card asks "which
  // host is incompatible". Arm 1 of `deriveNoHostVariant` makes those the same
  // host, arm 3 does not - so `canManageHost` alone is a guard argued against
  // only the population it can see. Without this line the button offers to
  // update the host the card names and re-provisions THIS machine instead.
  //
  // Fail closed rather than re-point: `forceProvisioning` is the local
  // lifecycle's own action and there is no host-scoped equivalent to aim
  // elsewhere. A wrong action is worse than no action, and the copy says why
  // it is missing rather than leaving an unexplained gap.
  if (!variant.isTargetHost) return null;
  if (!presentation.canManageHost) return null;
  if (!hostUpdateActionApplies(variant.detail, getClientAppVersion())) {
    return null;
  }
  return presentation.forceProvisioning;
}

/**
 * The boot body, or null when this state has none.
 *
 * Only the `offline` variant gets one: a plan gate and a version mismatch are
 * both about a host that is up and answering, so a bootstrap log and a
 * "Configure shell…" button would be diagnostics for a failure that did not
 * happen.
 *
 * TWO ARMS, gated on different things, and the difference is the point:
 *
 *  - A start that has NOT settled gets the loading body WHATEVER the target's
 *    kind. It is the shared boot headline (the lane's F19 heading when this
 *    machine's controller is doing something, the idle "Starting Traycer…"
 *    when it is not), the current stage's bar, and the Show details / Open
 *    settings footer - the same card the two boot surfaces before it drew.
 *    This arm used to be withheld unless the target was this machine, on the
 *    argument that the bootstrap log describes this computer. It does - and
 *    that is TRUE information under a remote-target start too: on a desktop
 *    the main process starts this machine's host whichever host is effective
 *    (`armLocalHostBootOnSignIn` and `runLaunchHostConvergeReconcile` in
 *    `clients/desktop/src/electron-main/startup/host-launch-converge.ts`
 *    consult sign-in and removal, never the selection), so the tail behind
 *    `Show details` is the log of a start that is happening right now on
 *    this computer, not a stale one. The two surfaces before this card offer
 *    that same disclosure without knowing the target at all - they mount
 *    before it is known - and gating only this phase on it re-creates the
 *    mid-launch shape change this family exists to remove. The disclosure's
 *    one gate is the one every phase can see: the shell has a CLI
 *    (`BootstrapLogDisclosure` self-hides on `traycerCli === null`). What
 *    the target DOES gate is what it should: no local action ARMS for a
 *    remote target (`local-boot-intent.test.tsx` pins `convergeReady` /
 *    `removalState` at zero with this body drawn), and the settled
 *    diagnostics below stay target-gated. What withholding the body actually
 *    produced was the reported launch: a fresh install on an account with
 *    remote hosts derives a remote as effective until the local host
 *    registers, and for that whole window the card was either empty but for
 *    the `Open settings` link or the boxed lane line - a third shape, in a
 *    launch that must have one.
 *
 *  - A start that HAS settled in failure gets this machine's diagnostics
 *    (the attempt panel and the log disclosure) only when the failure is this
 *    machine's. On a fleet this machine is not part of, the title and the
 *    description are the whole story; a crash report about a local install
 *    under "No host is available" blames the wrong computer.
 *
 * `LocalHostLoadingContent` has ONE face, and this is why. It used to take a
 * `stage` and grow a second one on `"slow"`: its own Retry, and the
 * failed-attempt diagnostics. The Retry was a second place for this modal to
 * state an action it already states in one row, and the diagnostics belong on
 * the settled arm where they are TRUE, not under a healthy spinner. That the
 * bootstrap.log path survives all of this is the whole point - it is the one
 * thing that lets a user take a stuck startup somewhere else, and it has been
 * orphaned by a surface move once already.
 */
function buildBootBody(args: {
  readonly variant: WindowNarrationVariant;
  readonly presentation: DefaultHostReadinessPresentation;
  readonly localLifecycle: boolean;
  readonly progress: HostProgressView | null;
  /**
   * Whether the attempt being narrated has settled in failure - the SAME bit the
   * action row gates Retry and Report issue on, not a second derivation of it.
   *
   * This used to be the `cause`, and that was the bug. See below.
   */
  readonly settledFailure: boolean;
  /** Whether `Open settings` is the only action, so the body hosts it inline. */
  readonly settingsOnly: boolean;
}): ReactNode | null {
  if (args.variant.kind !== "offline") return null;
  // NOTHING IS STARTING, so nothing may claim to be. The spinner and the stage
  // line are gated on the settled FAILURE rather than placed beside it:
  // `LocalHostLoadingContent`'s stage line falls back to
  // `HOST_PROGRESS_IDLE_HEADING` exactly when no lane is running, which is
  // precisely this state. A live spinner over a crash report tells a user to
  // wait for a start that is not happening, and they report a hang instead of
  // a crash.
  //
  // GATED ON THE FAILURE, NOT THE CAUSE - and it was the cause until a review
  // caught it. `cause === "no-usable-host"` covers only the arm where nothing can
  // serve the window at all. A cold start whose install has ALREADY FAILED
  // (`provisioningError` set, so the action row is offering Retry and Report
  // issue) still reached the loading body and drew a live spinner claiming a
  // start. That is the user's original complaint inverted: they objected to
  // recovery actions on a start with no error, and this was a modal that HAD
  // errored still insisting it was starting.
  //
  // One rule, two arms: ∅ is settled-by-definition (nothing can serve this
  // window IS the failure), and cold-start settles when the install reports one.
  if (args.settledFailure) {
    if (!args.localLifecycle) return null;
    // The attempt panel comes first because it is what explains the state; the
    // toggle is a footnote to it. Wrapped in the same shell as the loading
    // body, not a fragment: a body returned as a fragment hands its children
    // straight to the dialog's own column, where each one carries its own
    // alignment or none. One contract, both arms.
    return (
      <LocalHostBodyShell>
        <LocalBootstrapAttempts />
        {/* No trailing peer: this arm HAS a real action row (Retry, Report
            issue, Open settings), so the toggle keeps its own line rather
            than borrowing a control that already appears below it. */}
        <BootstrapLogDisclosure
          onConfigureShell={args.presentation.configureShell}
          trailing={null}
        />
      </LocalHostBodyShell>
    );
  }
  return (
    <LocalHostLoadingContent
      progress={args.progress}
      // THE HEALTHY START's whole footer, inline with the toggle: this is the
      // one arm where `Open settings` is the only action, and giving it a row
      // of its own is what made the card a four-line column of stray links.
      // It also makes this phase identical to the two boot surfaces before it,
      // which compose exactly the same pair (`HostBootSurface`).
      footerTrailing={
        args.settingsOnly ? (
          <BootOpenSettingsButton
            onOpenSettings={args.presentation.openSettings}
          />
        ) : null
      }
      onConfigureShell={args.presentation.configureShell}
    />
  );
}
