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

/** Mounted once per window, outside the readiness gate (the gate replaces its children during cold start, so a
 * modal mounted inside it could never narrate the cold start it exists for) and inside the router. */
export function WindowHostModalHost(props: {
  /** Injected rather than read from the router here, following the same rule the readiness gate's `bypass` prop
   * states: one routing-aware computation drives the narrators instead of each layer re-deriving it. */
  readonly bypassed: boolean;
}): ReactNode {
  const narration = useWindowNarration();

  if (narration.kind === "silent") return null;
  if (props.bypassed) return null;
  return <NarratingWindowHostModal narration={narration} />;
}

/** A suppression is invisible by construction - the surface renders nothing, so the only evidence a user can
 * give is a screenshot of the card that won. */
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

/** That is not a micro-optimization: this mounts at the app root, and reading the host controller's lane
 * unconditionally there made the root depend on `RunnerHostProvider`. */
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
  // The gate card wins, and not arbitrarily: its Retry is unconditionally `retryProvisioning`, where
  // `resolveRetry` above degrades to `refreshDirectory` when the shell cannot manage the host.
  const predicateInput = {
    readiness: controller.readinessFor("default-host", null),
    hasBeenReady: controller.hasBeenDefaultHostReady,
    signedIn: authStatus === "signed-in",
    bypassed: false,
  };
  const gateDrawn = gateCardReadiness(predicateInput);
  // Which presentation: the same predicate the gate itself renders from, so the two can never disagree about
  // whether an app exists behind this surface.
  const blocking = gateBlocksApp(predicateInput);
  // `gateCardReadiness` rather than the boolean wrapper: the log's whole value is naming which card won, and
  // re-deriving that from the readiness here would be the second copy this suppression exists to avoid.
  useSuppressionLog(gateDrawn?.kind ?? null, narration);
  if (gateDrawn !== null) {
    return null;
  }
  const updateHost = resolveUpdateHost(narration.variant, presentation);
  // Whether `open settings` is the only action. Two derivations of this would let a card render the settings
  // link in both places or in neither.
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
      // The same `settled.failed` the action row reads, deliberately: the body and the actions must agree about
      // whether this attempt is over.
      settledFailure: settled.failed,
    }),
    onRetry: retry.onRetry,
    retryPending: retry.pending,
    onUpdateHost: updateHost,
    onOpenSettings: presentation.openSettings,
    // Not folded into `onRetry`'s gate: Retry is also right on the slow arm, where nothing has failed yet but the
    // wait has outrun the healthy band.
    showReportIssue: settled.failed,
    // It is never removed from the dialog: it is the measured escape hatch for a host that cannot start, and
    // gating it behind the failure it exists to fix is the lockout this surface exists to prevent.
    settingsEmphasis: settled.failed || settled.slow ? "button" : "link",
  };
  if (blocking) {
    return <WindowHostStartupCard {...narrationProps} />;
  }
  if (narration.cause === "cold-start") {
    // A dialog here was a modal flash at the tail of every warm launch - gate open, first session still a beat
    // away - blocking an app that was about to answer.
    return null;
  }
  if (isMobileApp()) {
    // The mobile app never gets the dialog over A mounted shell, whatever the cause, and this is a navigation rule
    // rather than a styling one.
    return <WindowHostStartupCard {...narrationProps} />;
  }
  return <WindowHostModal {...narrationProps} />;
}

/** Only the cold-start cause gets the healthy grace period. */
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
    // `provisioningError` is read only under this cause. Under `cold-start` the modal is on screen precisely
    // because nothing has served this window yet, which is the scope that error still explains.
    failed: presentation.provisioningError !== null,
    slow: presentation.stage === "slow",
  };
}

interface ResolvedRetry {
  readonly onRetry: (() => void) | null;
  readonly pending: boolean;
}

/** When it does not - a fleet of remote machines this app cannot start - the only honest retry is re-reading
 * the registry. */
function resolveRetry(
  variant: WindowNarrationVariant,
  presentation: DefaultHostReadinessPresentation,
  localLifecycle: boolean,
  settled: SettledFailure,
): ResolvedRetry {
  if (variant.kind !== "offline") return { onRetry: null, pending: false };
  // A healthy start in progress has nothing to retry.
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
  // Fail closed rather than re-point: `forceProvisioning` is the local lifecycle's own action and there is no
  // host-scoped equivalent to aim elsewhere.
  if (!variant.isTargetHost) return null;
  if (!presentation.canManageHost) return null;
  if (!hostUpdateActionApplies(variant.detail, getClientAppVersion())) {
    return null;
  }
  return presentation.forceProvisioning;
}

/** It does - and that is true information under a remote-target start too. */
function buildBootBody(args: {
  readonly variant: WindowNarrationVariant;
  readonly presentation: DefaultHostReadinessPresentation;
  readonly localLifecycle: boolean;
  readonly progress: HostProgressView | null;
  /** Whether the attempt being narrated has settled in failure - the same bit the action row gates Retry and
   * Report issue on, not a second derivation of it. */
  readonly settledFailure: boolean;
  /** Whether `Open settings` is the only action, so the body hosts it inline. */
  readonly settingsOnly: boolean;
}): ReactNode | null {
  if (args.variant.kind !== "offline") return null;
  // Nothing IS starting, so nothing may claim to be. A live spinner over a crash report tells a user to wait for
  // a start that is not happening, and they report a hang instead of a crash.
  if (args.settledFailure) {
    if (!args.localLifecycle) return null;
    // Wrapped in the same shell as the loading body, not a fragment: a body returned as a fragment hands its
    // children straight to the dialog's own column, where each one carries its own alignment or none.
    return (
      <LocalHostBodyShell>
        <LocalBootstrapAttempts />
        {/* No trailing peer: this arm has a real action row (Retry, Report issue, Open settings), so the toggle keeps
           its own line rather than borrowing a control that already appears below it. */}
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
      // The healthy start's whole footer, inline with the toggle: this is the one arm where `Open settings` is the
      // only action, and giving it a row of its own is what made the card a four-line column of stray links.
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
