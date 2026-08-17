import { type ReactNode } from "react";
import { WindowHostModal } from "@/components/layout/dialogs/window-host-modal";
import {
  gateDrawsOwnCard,
  presentsLocalHostLifecycle,
  useHostReadinessController,
  type DefaultHostReadinessPresentation,
} from "@/components/layout/host-readiness-controller-context";
import { BootstrapAttemptDetails } from "@/components/host/bootstrap-attempt-details";
import { summariseBootstrapAttempts } from "@/components/host/bootstrap-attempt-summary";
import {
  BootstrapLogDisclosure,
  LocalHostBodyShell,
  LocalHostLoadingContent,
} from "@/components/local-host-loading";
import { useHostProvisioningProgress } from "@/hooks/host/use-host-provisioning-progress";
import { useRunnerTraycerHostStatusQuery } from "@/hooks/runner/use-runner-traycer-host-status-query";
import { useWindowNarration } from "@/hooks/host/use-window-narration";
import { useAuthStore } from "@/stores/auth/auth-store";
import { getClientAppVersion } from "@/lib/app-version";
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
  // `gateDrawsOwnCard` is the gate's own predicate, shared rather than restated:
  // a second copy of it here would be the very defect this suppression fixes,
  // planted by hand.
  //
  // Read HERE rather than in `WindowHostModalHost`, deliberately. That component
  // mounts at the app root and reading the controller there made the ROOT depend
  // on `RunnerHostProvider`, costing two root-route suites their whole tree. By
  // this point the narrator has already decided it is speaking.
  if (
    gateDrawsOwnCard({
      readiness: controller.readinessFor("default-host", null),
      hasBeenReady: controller.hasBeenDefaultHostReady,
      signedIn: authStatus === "signed-in",
      // The `/settings` bypass is already handled: `WindowHostModalHost` returns
      // null on it before this component mounts, so the gate is not drawing
      // there either and there is nothing to stand down from.
      bypassed: false,
    })
  ) {
    return null;
  }
  return (
    <WindowHostModal
      cause={narration.cause}
      variant={narration.variant}
      progress={progress}
      localBootstrapBody={buildLocalBootstrapBody({
        variant: narration.variant,
        presentation,
        localLifecycle,
        progress,
        // The same `settled.failed` the action row reads, deliberately: the body
        // and the actions must agree about whether this attempt is over. Two
        // derivations of that is how the modal ended up offering Retry beside a
        // spinner claiming a start.
        settledFailure: settled.failed,
      })}
      onRetry={retry.onRetry}
      retryPending={retry.pending}
      onUpdateHost={resolveUpdateHost(narration.variant, presentation)}
      onOpenSettings={presentation.openSettings}
      // Report issue is offered only once something has actually failed. It is
      // the affordance that converts a false impression of breakage into
      // support load, and on a healthy first launch there is no failure for a
      // report to be about. Not folded into `onRetry`'s gate: Retry is also
      // right on the slow arm, where nothing has failed yet but the wait has
      // outrun the healthy band, and a report there would still describe a
      // start that is merely taking its time.
      showReportIssue={settled.failed}
      // With no Retry and no Report issue on a healthy start, `Open settings`
      // is the only control on screen - and as an equal-weight button it still
      // reads as "something is wrong, pick one". Quiet link while nothing has
      // failed, button once something has. It is never REMOVED: it is the
      // measured escape hatch for a host that cannot start, and gating it
      // behind the failure it exists to fix is the lockout this surface exists
      // to prevent.
      settingsEmphasis={settled.failed || settled.slow ? "button" : "link"}
    />
  );
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
  if (!presentation.canManageHost) return null;
  if (!hostUpdateActionApplies(variant.detail, getClientAppVersion())) {
    return null;
  }
  return presentation.forceProvisioning;
}

/**
 * The rich local-bootstrap body, or null when this wait is not about this
 * machine.
 *
 * Only the `offline` variant gets it: a plan gate and a version mismatch are
 * both about a host that is up and answering, so a bootstrap log and a
 * "Configure shell…" button would be diagnostics for a failure that did not
 * happen.
 *
 * `LocalHostLoadingContent` has ONE face now, and this is why. It used to take
 * a `stage` and grow a second one on `"slow"`: its own Retry, and the
 * failed-attempt diagnostics. The Retry was a second place for this modal to
 * state an action it already states in one row, and the diagnostics belong on
 * the arm below where they are TRUE, not under a healthy spinner - so this
 * call site passed `"loading"` unconditionally, and once P3.2 deleted the
 * gate's fallbacks it was the only caller left. P3.4 deleted the branch it
 * had already stopped reaching. That the bootstrap.log path survives all of
 * this is the whole point - it is the one thing that lets a user take a stuck
 * startup somewhere else, and it has been orphaned by a surface move once
 * already.
 */
function buildLocalBootstrapBody(args: {
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
}): ReactNode | null {
  if (args.variant.kind !== "offline") return null;
  if (!args.localLifecycle) return null;
  // NOTHING IS STARTING, so nothing may claim to be. The spinner and the stage
  // line are gated on the settled FAILURE rather than placed beside it:
  // `LocalHostLoadingContent`'s stage line falls back to
  // `HOST_PROGRESS_IDLE_HEADING` - "Starting local Traycer Host…" - exactly when
  // no lane is running, which is precisely this state. A live spinner over a
  // crash report tells a user to wait for a start that is not happening, and
  // they report a hang instead of a crash.
  //
  // GATED ON THE FAILURE, NOT THE CAUSE - and it was the cause until a review
  // caught it. `cause === "no-usable-host"` covers only the arm where nothing can
  // serve the window at all. A cold start whose install has ALREADY FAILED
  // (`provisioningError` set, so the action row is offering Retry and Report
  // issue) still reached the loading body and drew a live spinner claiming a
  // start. That is the user's original complaint inverted: they objected to
  // recovery actions on a start with no error, and this was a modal that HAD
  // errored still insisting it was starting. The reachable route is a registered
  // local host - so `effectiveHostId` is non-null and the cause stays
  // `cold-start` - whose bootstrap failed on first launch.
  //
  // One rule, two arms: ∅ is settled-by-definition (nothing can serve this
  // window IS the failure), and cold-start settles when the install reports one.
  // The ∅ arm is now a case of the rule rather than a special arm beside it.
  //
  // The log disclosure still renders: it is the one affordance that lets
  // someone take a stuck startup somewhere else, and it is TRUE on both.
  // The attempt panel comes first because it is what explains the state; the
  // toggle is a footnote to it.
  //
  // Wrapped in the same shell as the loading body, not a fragment: a body
  // returned as a fragment hands its children straight to the dialog's own
  // column, where each one carries its own alignment or none. One contract, both
  // arms - otherwise the two bodies drift apart the moment either is touched.
  if (args.settledFailure) {
    return (
      <LocalHostBodyShell>
        <LocalBootstrapAttempts />
        <BootstrapLogDisclosure
          onConfigureShell={args.presentation.configureShell}
        />
      </LocalHostBodyShell>
    );
  }
  return (
    <LocalHostLoadingContent
      progress={args.progress}
      onConfigureShell={args.presentation.configureShell}
    />
  );
}

/**
 * What the last bootstrap attempt tried, and where the full log lives.
 *
 * A single read, not a poll: while a user is staring at a failure card there
 * is nothing to gain from re-running the CLI underneath them, and the recovery
 * actions invalidate this query when they fire.
 */
function LocalBootstrapAttempts(): ReactNode {
  const status = useRunnerTraycerHostStatusQuery({ pollIntervalMs: null });
  if (status.data === undefined) return null;
  const summary = summariseBootstrapAttempts(status.data.bootstrapMarkers);
  if (summary === null) return null;
  return (
    <BootstrapAttemptDetails
      summary={summary}
      bootstrapLogPath={status.data.bootstrapLogPath}
    />
  );
}
