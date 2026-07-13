import {
  cloneElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  BootstrapMarkerEntry,
  HostEnsureResult,
  HostProgressEvent,
  IRunnerHost,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { Card, CardContent } from "@/components/ui/card";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { AppHeader } from "@/components/layout/header/app-header";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useRunnerRequestHostRespawn } from "@/hooks/runner/use-runner-request-host-respawn-mutation";
import { useRunnerEnsureHost } from "@/hooks/runner/use-runner-ensure-host-mutation";
import { useRunnerHostRemovalStateQuery } from "@/hooks/runner/use-runner-host-removal-state-query";
import { useRunnerTraycerHostStatusQuery } from "@/hooks/runner/use-runner-traycer-host-status-query";
import {
  describeHostCompatibilityError,
  useHostCompatibility,
} from "@/lib/host";
import { requestAppQuit } from "@/lib/desktop-app-lifecycle";
import { runnerQueryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { createReportIssueContext } from "@/lib/report-issue-context";

/**
 * URL prefix that bypasses the host-readiness gate. Settings work without
 * a running host - the Shell page edits SQLite via the CLI subprocess,
 * the Service page talks to launchd/systemd directly, etc. Exposing this
 * during a wedged bootstrap is the user's escape hatch: edit the shell
 * args, restart the host, watch the bootstrap log refill.
 *
 * Consumed by `TraycerAppRouter` to compute the `bypass` prop fed to
 * every gate in the stack (LocalHostGate, MobileHostGate). A single
 * routing-aware computation drives all gates so they agree on whether
 * the current route is host-independent.
 */
export const GATE_BYPASS_PATH_PREFIX = "/settings";

type LocalHostState =
  | { readonly kind: "ready"; readonly snapshot: LocalHostSnapshot }
  | { readonly kind: "unavailable" };

type GateStage = "loading" | "slow";

/**
 * Threshold before the gate promotes from Stage 1 ("loading", no Retry) to
 * Stage 2 ("slow", full unavailable card with Retry). Chosen in the 8–15s
 * band so a healthy bundled-host boot (typically well under a second)
 * never flashes the Retry UI, while a genuinely stalled launch surfaces the
 * escape hatch before the user suspects the app is broken.
 */
export const LOCAL_HOST_SLOW_START_THRESHOLD_MS = 10_000;

export interface LocalHostGateProps {
  readonly children: ReactNode;
  readonly loading: ReactNode;
  readonly provisioningLoading: ReactElement<ProvisioningLoadingProps> | null;
  readonly unavailable: ReactNode;
  readonly selectedEntry: HostDirectoryEntry | null;
  /**
   * When `true`, the gate always passes children through regardless of
   * host state. The decision lives in the caller (TraycerAppRouter) so
   * one routing-aware computation drives every gate in the stack -
   * `LocalHostGate` and `MobileHostGate` need to agree, otherwise the
   * inner gate blocks settings even after the outer gate bypassed.
   *
   * Used so users can edit shell config / env overrides while the host
   * is still starting or wedged.
   */
  readonly bypass: boolean;
}

/**
 * Gates host-backed routes on the desktop local-host snapshot.
 *
 * Behaviour:
 *   - Unauthenticated users pass through untouched - sign-in screens must
 *     render regardless of host state.
 *   - Shells that do not expose a local-host stream
 *     (`runnerHost.hasLocalHost === false`, e.g. mobile/web) pass through
 *     so the shell-specific UX (`<MobileHostGate />`) can render instead.
 *   - Non-local explicit selections (future remote hosts) pass through
 *     without observing the stream.
 *   - For signed-in users on a local-host-capable shell, the gate also
 *     holds when `selectedEntry === null` so the gap before auto-bind (the
 *     moment the app mounts before the bundled host is ready) renders
 *     the Flow 5 waiting surface rather than an inline placeholder
 *     downstream.
 *
 * Staged wait (Flow 5):
 *   1. "loading" - immediate signed-in waiting state. Renders `props.loading`
 *      ("Starting local Traycer Host…") with no Retry affordance. This is the
 *      default stage on mount and after every Ready → not-ready transition.
 *   2. "slow" - entered after `LOCAL_HOST_SLOW_START_THRESHOLD_MS` has
 *      elapsed without a usable snapshot. Renders `props.unavailable`
 *      (`<LocalHostUnavailable />` with a Retry button wired to
 *      `runnerHost.requestHostRespawn()`).
 *   A usable snapshot arriving at any point auto-transitions the gate to
 *   Ready (children render) without requiring the user to click Retry.
 *
 * The gate observes `IRunnerHost.onLocalHostChange(...)` as its only
 * source of truth - there is no `getLocalHost()` accessor. The runner
 * contract requires the handler to fire synchronously on subscribe; on a
 * runner that never emits (a future custom host that breaks the contract),
 * the gate stays in `loading` rather than invent a snapshot.
 */
export function LocalHostGate(props: LocalHostGateProps) {
  const runnerHost = useRunnerHost();
  const authStatus = useAuthStore((state) => state.status);
  const { state, stage } = useLocalHostGateState(runnerHost);

  const firstSnapshotObserved = state !== null;
  const isReady = state?.kind === "ready";
  const hostUnavailable = firstSnapshotObserved && !isReady;
  // The gate passes children straight through (no host required) for
  // signed-out users, non-local-host shells, non-local selections, and
  // bypass routes (e.g. /settings/shell). Anything else is a signed-in
  // local-host route that must hold until the host is reachable.
  const { passThrough, bypassEligible } = computeGateEligibility({
    authStatus,
    hasLocalHost: runnerHost.hasLocalHost,
    selectedEntry: props.selectedEntry,
    bypass: props.bypass,
  });

  // Post-auth provisioning: when the gate is active and no host is
  // reachable, ask the CLI (via the runner host) to install + register +
  // start it. Skipped on shells without host management
  // (mobile/web/tests), so the legacy loading/slow/respawn path is the only
  // behaviour there.
  const provisioning = useHostProvisioning({
    enabled: !passThrough && hostUnavailable,
    isReady,
  });

  // Reinstall-progress node, reused by the busy-keep forced update branch and
  // the normal provisioning branch.
  const provisioningLoadingNode =
    props.provisioningLoading !== null
      ? cloneElement(props.provisioningLoading, {
          progress: provisioning.progress,
        })
      : props.loading;

  if (passThrough) {
    return renderPassThroughGate({
      bypassEligible,
      children: props.children,
      loading: props.loading,
      canManageHost: provisioning.canManageHost,
      force: provisioning.force,
      restartError: provisioning.error,
    });
  }

  // host-busy keep path: the CLI kept a running host that has work in
  // progress. This state is LATCHED (it survives the surfaced host flipping
  // the snapshot to `ready`, and survives Retry/forced update `reset()`), and it takes
  // precedence over `isReady` so children never connect to an unprobed busy
  // host. `HostCompatibilityGate` is isolated in its own component because the compat
  // probe calls `useHostClient`, valid only below the host runtime
  // provider. A Retry/forced update in flight shows its progress, not the panel.
  if (provisioning.hostBusy) {
    if (provisioning.isProvisioning) {
      return <>{provisioningLoadingNode}</>;
    }
    return (
      <HostCompatibilityGate
        bypass={false}
        source="busy-keep"
        checking={props.loading}
        onRefreshBusy={provisioning.retry}
        onForce={provisioning.canManageHost ? provisioning.force : null}
        restartError={provisioning.error}
      >
        {props.children}
      </HostCompatibilityGate>
    );
  }

  // An ensure in flight holds the gate on the provisioning surface even if a
  // snapshot has transiently flipped `isReady` true. The ensure RESULT arrives
  // on a separate IPC channel from the host snapshot, and it is the result -
  // not readiness alone - that decides whether the surfaced host is
  // trustworthy or must first clear the busy compat probe. Checking this before
  // `isReady` closes the window where children would mount against an unprobed
  // (possibly incompatible) busy host. (Its 60s budget exceeds the slow-start
  // threshold, so this also suppresses the respawn card while the install runs.)
  if (provisioning.isProvisioning) {
    return <>{provisioningLoadingNode}</>;
  }

  // The user removed Traycer's background components on this device. Show the
  // terminal removed surface instead of reinstalling or spinning; Reinstall is
  // the escape hatch.
  if (provisioning.removed) {
    return <HostRemovedSurface onReinstall={provisioning.reinstall} />;
  }

  if (isReady) {
    return (
      <HostCompatibilityGate
        bypass={false}
        source="normal-ready"
        checking={props.loading}
        onRefreshBusy={null}
        onForce={provisioning.canManageHost ? provisioning.force : null}
        restartError={provisioning.error}
      >
        {props.children}
      </HostCompatibilityGate>
    );
  }

  // Provisioning failed - show the error with a Retry that re-runs ensure.
  // (Respawn - the `unavailable` slot - can't recover a host that was
  // never installed, so we take precedence over the slow path here.)
  if (provisioning.error !== null) {
    return (
      <GateProvisioningError
        message={provisioning.error.message}
        onRetry={provisioning.retry}
        isRetrying={provisioning.isProvisioning}
      />
    );
  }

  if (state === null) {
    return <>{props.loading}</>;
  }

  if (stage === "slow") {
    return <>{props.unavailable}</>;
  }

  return <>{props.loading}</>;
}

interface PassThroughGateArgs {
  // `passThrough` is true ONLY because of the `/settings` bypass flag - the
  // same signed-in, local-host-capable population that also reaches
  // `isReady` in `LocalHostGate`. That's the boundary this stabilizes:
  // `bypass` flips on every epic<->settings crossing while the host stays
  // ready, so THIS population renders through the SAME `HostCompatibilityGate`
  // chain as `isReady` (`bypass` forcing it to render children outright) so
  // the two share one element type/tree depth instead of remounting the
  // whole gated subtree on every crossing. `useHostCompatibility()` is safe
  // here: `HostCompatibilityProvider` sits above `RouterProvider` and is
  // always mounted for a signed-in, local-host-capable session by the time
  // any routed page exists.
  //
  // The other `passThrough` reasons (signed-out, no local host, non-local
  // selection) never depend on `bypass` and never need to match `isReady`'s
  // tree shape, so they keep the plain short-circuit - which also keeps them
  // independent of `HostCompatibilityProvider` ever mounting (e.g. a
  // signed-out user renders immediately).
  readonly bypassEligible: boolean;
  readonly children: ReactNode;
  readonly loading: ReactNode;
  readonly canManageHost: boolean;
  readonly force: () => void;
  readonly restartError: Error | null;
}

function renderPassThroughGate(args: PassThroughGateArgs): ReactNode {
  if (!args.bypassEligible) {
    return <>{args.children}</>;
  }
  return (
    <HostCompatibilityGate
      bypass
      source="normal-ready"
      checking={args.loading}
      onRefreshBusy={null}
      onForce={args.canManageHost ? args.force : null}
      restartError={args.restartError}
    >
      {args.children}
    </HostCompatibilityGate>
  );
}

interface GateEligibility {
  // True when the gate should render children without requiring a ready
  // host: signed-out users, shells without a local host (mobile/web),
  // explicit non-local selections, and caller-declared bypass routes.
  readonly passThrough: boolean;
  // True for the signed-in, local-host-capable population that can also
  // reach `isReady` - i.e. `bypass` is the only reason `passThrough` might
  // be true. `false` for the other short-circuits (signed-out, no local
  // host, non-local selection), which never depend on `bypass`.
  readonly bypassEligible: boolean;
}

function computeGateEligibility(args: {
  readonly authStatus: string;
  readonly hasLocalHost: boolean;
  readonly selectedEntry: HostDirectoryEntry | null;
  readonly bypass: boolean;
}): GateEligibility {
  if (args.authStatus !== "signed-in") {
    return { passThrough: true, bypassEligible: false };
  }
  if (!args.hasLocalHost) {
    return { passThrough: true, bypassEligible: false };
  }
  if (args.selectedEntry !== null && args.selectedEntry.kind !== "local") {
    return { passThrough: true, bypassEligible: false };
  }
  return { passThrough: args.bypass, bypassEligible: true };
}

interface ProvisioningLoadingProps {
  readonly progress: HostProgressEvent | null;
}

interface HostProvisioning {
  readonly isProvisioning: boolean;
  readonly error: Error | null;
  readonly progress: HostProgressEvent | null;
  // True once `ensureHost` returned `action: "host-busy"`: the CLI kept a
  // running host that has work in progress, and the desktop surfaced it for
  // the renderer's compat probe.
  readonly hostBusy: boolean;
  // True once `ensureHost` returned `action: "removed"`: the user removed
  // Traycer's background components on this device, so the desktop refused to
  // reinstall. The gate shows the removed surface instead of spinning.
  readonly removed: boolean;
  readonly canManageHost: boolean;
  readonly retry: () => void;
  // Forced update: re-run ensure with `force`, skipping the busy check, to
  // reinstall + restart onto this build (can end in-progress work).
  readonly force: () => void;
  // Reinstall escape hatch from the removed surface: clear the removal
  // sentinel, then re-run ensure to provision the host again.
  readonly reinstall: () => void;
}

// Fires `ensureHost` once per session when a signed-in local-host shell
// has no reachable host, and exposes manual `retry` / `force`. A `useRef`
// guard keeps a transient Ready → not-ready disconnect from re-triggering an
// install (that case routes to the existing slow/respawn path instead).
function useHostProvisioning(args: {
  readonly enabled: boolean;
  readonly isReady: boolean;
}): HostProvisioning {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const ensure = useRunnerEnsureHost();
  const attemptedRef = useRef(false);
  const [progress, setProgress] = useState<HostProgressEvent | null>(null);
  const [inBusyKeepFlow, setInBusyKeepFlow] = useState(false);
  const [removed, setRemoved] = useState(false);
  const canProvision = args.enabled && runnerHost.hostManagement !== null;
  const hasManagement = runnerHost.hostManagement !== null;
  const { mutate, reset } = ensure;

  // Kept in sync so the stable `markBusyKeep` callback below can read the
  // latest management instance without widening its dependency array (see
  // that callback's comment on why it must stay stable).
  const hostManagementRef = useRef(runnerHost.hostManagement);
  useEffect(() => {
    hostManagementRef.current = runnerHost.hostManagement;
  }, [runnerHost.hostManagement]);

  // Latch the busy-keep flow from the settled mutation RESULT (a mutation
  // event, not a render effect or a ref read), so it survives the surfaced
  // host flipping `isReady` true and survives Retry/forced update `reset()` (which
  // clears `ensure.data`). A `host-busy` result enters the flow; any other
  // success exits it. An ERROR deliberately leaves the latch untouched: a
  // failed Retry/forced update must keep us in the busy flow (so we never fall through
  // to rendering children against the still-unprobed busy host), and a failed
  // initial provision leaves the latch at its `false` default (normal error
  // path). Stable handler keeps the provision effect from re-running.
  const markBusyKeep = useCallback(
    (result: HostEnsureResult): void => {
      setInBusyKeepFlow(result.action === "host-busy");
      // The desktop refused to reinstall a user-removed host; latch the removed
      // surface. Any other settled result (provisioned/already-ready after a
      // reinstall) clears it.
      setRemoved(result.action === "removed");
      // `ensureHost`'s own removal check is the freshest possible truth, so
      // write it straight into the removal-state query cache too - a
      // response-equals-state cache write (not a guess) that keeps the
      // direct removal-sentinel query (below) from re-asserting a stale
      // `true` it fetched before this settle.
      const management = hostManagementRef.current;
      if (management !== null) {
        queryClient.setQueryData(runnerQueryKeys.hostRemovalState(management), {
          removedByUser: result.action === "removed",
        });
      }
    },
    [queryClient],
  );

  // Retry/forced update: clear any prior error/progress, then re-run ensure. Only
  // `onSuccess` transitions the busy-keep latch; an error leaves it untouched
  // (see markBusyKeep).
  const run = (force: boolean): void => {
    reset();
    setProgress(null);
    mutate(
      { force, onProgress: (event) => setProgress(event) },
      { onSuccess: markBusyKeep },
    );
  };

  // Reinstall from the removed surface: clear the persisted removal sentinel
  // (so the desktop's ensure stops short-circuiting to `removed`), then re-run
  // a normal ensure. Optimistically drop the removed latch so the surface
  // flips to the provisioning spinner immediately.
  const reinstall = (): void => {
    const management = runnerHost.hostManagement;
    if (management === null) return;
    // Optimistically drop the removed latch so the surface flips to the
    // provisioning spinner immediately. Also mirror it into the removal-state
    // query cache - otherwise a `true` it fetched before this click would
    // still OR back in below and hold the surface on `removed`.
    setRemoved(false);
    queryClient.setQueryData(runnerQueryKeys.hostRemovalState(management), {
      removedByUser: false,
    });
    void management.clearRemoval().then(
      () => run(false),
      () => {
        // The sentinel couldn't be cleared, so ensure would just short-circuit
        // back to `removed`. Restore the removed surface instead of flashing a
        // spinner through a wasted round-trip; the user can retry Reinstall.
        setRemoved(true);
        queryClient.setQueryData(runnerQueryKeys.hostRemovalState(management), {
          removedByUser: true,
        });
      },
    );
  };

  useEffect(() => {
    if (!canProvision || args.isReady || attemptedRef.current) {
      return;
    }
    attemptedRef.current = true;
    mutate(
      { force: false, onProgress: (event) => setProgress(event) },
      { onSuccess: markBusyKeep },
    );
  }, [canProvision, args.isReady, mutate, markBusyKeep]);

  // Direct removal-sentinel check, independent of the one-shot `ensureHost`
  // effect above. That effect never re-fires once `attemptedRef` is set -
  // typically right after the very first sign-in, long before the user ever
  // visits Settings -> Danger Zone - so it cannot notice a removal that
  // happens later in the same session. The query re-activates on every
  // not-ready transition (see its `enabled`), and its result is read directly
  // below (derived, not synced into state) so it short-circuits straight to
  // the removed surface per `getRemovalState`'s contract instead of falling
  // through to the generic unavailable/Retry card until a reload re-mounts
  // this hook and resets `attemptedRef`.
  const removalState = useRunnerHostRemovalStateQuery({
    enabled: canProvision && !args.isReady,
  });
  const isRemoved = removed || removalState.data?.removedByUser === true;

  return {
    // Report provisioning/error whenever this shell manages the host - NOT
    // gated on `canProvision`, which collapses to false the instant a busy
    // host is surfaced (its snapshot flips `isReady` true). Gating on
    // `canProvision` would hide Retry/forced update progress and swallow their
    // errors. `ensure.isPending`/`ensure.error` are only meaningful after a
    // mutation that already required management, so `hasManagement` is the
    // correct gate.
    isProvisioning: hasManagement && ensure.isPending,
    error: hasManagement ? ensure.error : null,
    progress,
    hostBusy: hasManagement && inBusyKeepFlow,
    removed: hasManagement && isRemoved,
    canManageHost: hasManagement,
    retry: () => run(false),
    force: () => run(true),
    reinstall,
  };
}

// Shared compat verdict for host-backed launch. The provider owns the
// `host.status` probe above routed UI and startup warmups; this gate consumes
// the verdict to either continue into host-backed UI or convert the existing
// initializing-host surface into an update-required card.
interface HostBusyGateProps {
  readonly children: ReactNode;
  readonly source: HostCompatibilityGateSource;
  readonly checking: ReactNode;
  readonly onRefreshBusy: (() => void) | null;
  readonly onForce: (() => void) | null;
  readonly restartError: Error | null;
  /**
   * When `true`, renders `children` outright regardless of `compat.status` -
   * used by `LocalHostGate`'s `passThrough` branch so it can share this
   * component's tree shape with the `isReady` branch (see the call site
   * comment) instead of returning a structurally different element. The
   * compat hook is still called unconditionally to keep hook order stable
   * across the bypass flip.
   */
  readonly bypass: boolean;
}

type HostCompatibilityGateSource = "busy-keep" | "normal-ready";

// Rendered once a local host is reachable and the host runtime is mounted.
// Blocks host-backed children until the shared `/rpc` manifest handshake
// succeeds. The same gate handles both normal launch and the older busy-host
// keep flow; only retry copy/wiring differs.
function HostCompatibilityGate(props: HostBusyGateProps) {
  const compat = useHostCompatibility();
  if (props.bypass) {
    return <>{props.children}</>;
  }
  if (compat.status === "incompatible") {
    return (
      <GateIncompatibleHost
        source={props.source}
        reason={describeHostCompatibilityError(compat.error)}
        onRefreshBusy={props.onRefreshBusy}
        onForce={props.onForce}
        restartError={props.restartError}
      />
    );
  }
  if (compat.status === "failed") {
    return (
      <GateProvisioningError
        message={`Could not verify host compatibility. ${compat.error.message}`}
        onRetry={compat.retry}
        isRetrying={compat.retrying}
      />
    );
  }
  if (compat.status === "compatible") {
    return <>{props.children}</>;
  }
  return <>{props.checking}</>;
}

interface GateIncompatibleBusyProps {
  readonly source: HostCompatibilityGateSource;
  readonly reason: string;
  readonly onRefreshBusy: (() => void) | null;
  readonly onForce: (() => void) | null;
  readonly restartError: Error | null;
}

// Shown when the reachable host is incompatible with this build. Compatible
// hosts continue automatically; incompatible hosts have one meaningful action:
// update the local host to the app-compatible version.
function GateIncompatibleHost(props: GateIncompatibleBusyProps) {
  const isBusyKeep = props.source === "busy-keep";
  return (
    <div
      data-testid={
        isBusyKeep ? "local-host-incompatible-busy" : "local-host-incompatible"
      }
      className="flex min-h-svh w-full flex-col bg-background text-foreground"
    >
      <AppHeader variant="host-loading" />
      <div className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-md shadow-sm">
          <CardContent className="flex flex-col items-center gap-4 py-6 text-center text-ui-sm">
            <div className="flex flex-col gap-2">
              <p className="text-ui font-medium text-foreground">
                Host update required
              </p>
              <p className="text-muted-foreground">
                {isBusyKeep
                  ? "The running host has work in progress and is not compatible with this app update. Refresh to check again, or force update the host. Running work may be interrupted."
                  : "This Traycer app update is not compatible with the running host. Update the local host before continuing."}
              </p>
              <p
                className="max-w-full break-words rounded-md bg-muted/50 px-3 py-2 text-left text-ui-xs text-muted-foreground"
                data-testid="local-host-incompatible-reason"
              >
                Reason: {props.reason}
              </p>
              {props.restartError !== null ? (
                <p
                  className="max-w-full break-words text-ui-xs text-destructive"
                  data-testid="local-host-incompatible-restart-error"
                >
                  {props.restartError.message}
                </p>
              ) : null}
            </div>
            <div
              className={cn(
                "grid w-full gap-2",
                isBusyKeep ? "sm:grid-cols-2" : "sm:flex sm:justify-center",
              )}
            >
              {isBusyKeep && props.onRefreshBusy !== null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={props.onRefreshBusy}
                  data-testid="local-host-incompatible-busy-refresh"
                >
                  Refresh
                </Button>
              ) : null}
              {props.onForce !== null ? (
                <Button
                  type="button"
                  size="sm"
                  variant={isBusyKeep ? "destructive" : "default"}
                  className={cn("w-full", !isBusyKeep && "sm:w-auto")}
                  onClick={props.onForce}
                  data-testid={
                    isBusyKeep
                      ? "local-host-incompatible-busy-force-update"
                      : "local-host-incompatible-update"
                  }
                >
                  {isBusyKeep ? "Force update host" : "Update host"}
                </Button>
              ) : null}
              <ReportIssueAction
                context={createReportIssueContext({
                  title: "Host update required",
                  message: "Traycer Host requires an update.",
                  code: null,
                  source: "Host startup",
                })}
                presentation="text"
                className="w-full"
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface GateProvisioningErrorProps {
  readonly message: string;
  readonly onRetry: () => void;
  readonly isRetrying: boolean;
}

function GateProvisioningError(props: GateProvisioningErrorProps) {
  return (
    <div
      data-testid="local-host-provisioning-error"
      className="flex min-h-svh w-full items-center justify-center bg-background p-6 text-foreground"
    >
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col gap-4 py-6 text-ui-sm">
          <p className="text-center">{props.message}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={props.isRetrying}
              onClick={props.onRetry}
              data-testid="local-host-provisioning-retry"
            >
              <span className="inline-flex items-center gap-1.5">
                <span>Retry</span>
                {props.isRetrying ? (
                  <AgentSpinningDots
                    className={undefined}
                    testId="local-host-provisioning-retry-spinner"
                    variant={undefined}
                  />
                ) : null}
              </span>
            </Button>
            <ReportIssueAction
              context={createReportIssueContext({
                title: "Could not start Traycer Host",
                message: "Traycer Host could not start.",
                code: null,
                source: "Host startup",
              })}
              presentation="text"
              className={undefined}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface HostRemovedSurfaceProps {
  readonly onReinstall: () => void;
}

// Terminal surface shown after the user removed Traycer's background
// components (Settings → General → Danger Zone) and then landed on a
// host-backed route or relaunched. The host is intentionally gone; offer Quit
// (the expected next step before dragging the app to the Trash) and a
// Reinstall escape hatch.
function HostRemovedSurface(props: HostRemovedSurfaceProps) {
  return (
    <div
      data-testid="local-host-removed"
      className="flex min-h-svh w-full items-center justify-center bg-background p-6 text-foreground"
    >
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col gap-4 py-6 text-ui-sm">
          <div className="flex flex-col gap-1 text-center">
            <p className="font-medium">Traycer was removed</p>
            <p className="text-muted-foreground">
              You removed Traycer's background components from this device, so
              the host won't start. Your chats and history are preserved. To
              finish, quit Traycer and drag it from Applications to the Trash.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => {
                requestAppQuit();
              }}
              data-testid="local-host-removed-quit"
            >
              Quit Traycer
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={props.onReinstall}
              data-testid="local-host-removed-reinstall"
            >
              Reinstall
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface GateState {
  readonly state: LocalHostState | null;
  readonly stage: GateStage;
}

function useLocalHostGateState(runnerHost: IRunnerHost): GateState {
  const [state, setState] = useState<LocalHostState | null>(null);
  const [stage, setStage] = useState<GateStage>("loading");
  const wasReadyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const subscription = runnerHost.onLocalHostChange((next) => {
      if (cancelled) {
        return;
      }
      const nextState = computeLocalHostState(next);
      setState(nextState);
      if (nextState.kind === "ready") {
        wasReadyRef.current = true;
      } else if (wasReadyRef.current) {
        // Ready → not-ready transition: restart the staged wait so the
        // user sees "Starting local Traycer Host…" again before Retry reappears.
        wasReadyRef.current = false;
        setStage("loading");
      }
    });

    return () => {
      cancelled = true;
      subscription.dispose();
    };
  }, [runnerHost]);

  const isReady = state !== null && state.kind === "ready";
  useEffect(() => {
    if (isReady || stage === "slow") {
      return;
    }
    const timer = setTimeout(() => {
      setStage("slow");
    }, LOCAL_HOST_SLOW_START_THRESHOLD_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isReady, stage]);

  return { state, stage };
}

function computeLocalHostState(
  snapshot: LocalHostSnapshot | null,
): LocalHostState {
  if (snapshot === null) {
    return { kind: "unavailable" };
  }
  if (snapshot.websocketUrl.length === 0) {
    return { kind: "unavailable" };
  }
  return { kind: "ready", snapshot };
}

export interface LocalHostUnavailableProps {
  readonly message: string;
}

interface BootstrapAttemptSummary {
  readonly attempt: BootstrapMarkerEntry;
  readonly outcome: BootstrapMarkerEntry | null;
}

/**
 * Picks the most recent `phase=starting` marker and its terminal follow-up
 * (`exited` / `crashed` / `killed` / `failed-to-spawn`). The marker file is
 * append-only, so the relevant pair is "the last `starting` and the next
 * non-`starting` after it". When no follow-up exists, the host is mid-
 * spawn or never published a terminal marker - surface that as `outcome:
 * null` and let the renderer say so.
 */
function summariseBootstrapAttempts(
  markers: readonly BootstrapMarkerEntry[],
): BootstrapAttemptSummary | null {
  let lastStartIdx = -1;
  for (let i = markers.length - 1; i >= 0; i--) {
    if (markers[i]?.phase === "starting") {
      lastStartIdx = i;
      break;
    }
  }
  if (lastStartIdx === -1) return null;
  const attempt = markers[lastStartIdx];
  for (let i = lastStartIdx + 1; i < markers.length; i++) {
    const m = markers[i];
    if (m.phase !== "starting") {
      return { attempt, outcome: m };
    }
  }
  return { attempt, outcome: null };
}

function describeOutcome(marker: BootstrapMarkerEntry): string {
  const fields = marker.fields;
  switch (marker.phase) {
    case "exited": {
      const code = fields.code ?? "?";
      return `Host exited with code ${code}.`;
    }
    case "crashed": {
      const code = fields.code ?? "?";
      const signal =
        fields.signal !== undefined ? ` (signal ${fields.signal})` : "";
      return `Host crashed with code ${code}${signal}.`;
    }
    case "killed": {
      const signal = fields.signal ?? "unknown";
      return `Host was killed with signal ${signal}.`;
    }
    case "failed-to-spawn": {
      const error = fields.error ?? "spawn failed";
      return `Failed to spawn shell: ${error}`;
    }
    case "starting":
      return "";
  }
}

/**
 * Default UI for the `LocalHostGate` `unavailable` slot.
 *
 * Renders a centered card with a Retry button that asks the shell to spawn
 * its bundled local host again via `runnerHost.requestHostRespawn()`.
 * The gate keeps its background `onLocalHostChange` subscription, so a
 * successful respawn flips the gate to `ready` automatically - Retry just
 * triggers the shell-side spawn and never owns lifecycle state itself.
 *
 * On shells with a `traycerCli` capability, the card additionally pulls
 * `traycer host status` and renders the most recent bootstrap attempt:
 * what shell/args were tried, and what (if anything) followed - so the user
 * sees "we tried `zsh -i -l -c …` and it crashed with code 1" instead of a
 * blank "host unreachable" message.
 */
export function LocalHostUnavailable(props: LocalHostUnavailableProps) {
  const respawn = useRunnerRequestHostRespawn();
  // Single read; while the user is staring at the failure card we don't
  // want to keep hammering the CLI. The Retry button drives a respawn
  // which triggers an explicit invalidate via the gate-level query.
  const status = useRunnerTraycerHostStatusQuery({ pollIntervalMs: null });

  const summary = useMemo(
    () =>
      status.data !== undefined
        ? summariseBootstrapAttempts(status.data.bootstrapMarkers)
        : null,
    [status.data],
  );

  return (
    <div
      data-testid="local-host-unavailable"
      className="flex min-h-svh w-full items-center justify-center bg-background p-6 text-foreground"
    >
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col gap-4 py-6 text-ui-sm">
          <p className="text-center">{props.message}</p>
          {summary !== null ? (
            <BootstrapAttemptDetails
              summary={summary}
              bootstrapLogPath={status.data?.bootstrapLogPath ?? null}
            />
          ) : null}
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={respawn.isPending}
              onClick={() => {
                respawn.mutate();
              }}
              data-testid="local-host-retry"
            >
              <span className="inline-flex items-center gap-1.5">
                <span>Retry</span>
                {respawn.isPending ? (
                  <AgentSpinningDots
                    className={undefined}
                    testId="local-host-unavailable-retry-spinner"
                    variant={undefined}
                  />
                ) : null}
              </span>
            </Button>
            <ReportIssueAction
              context={createReportIssueContext({
                title: "Traycer Host is unavailable",
                message: "Traycer Host was unavailable.",
                code: null,
                source: "Host startup",
              })}
              presentation="text"
              className={undefined}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface BootstrapAttemptDetailsProps {
  readonly summary: BootstrapAttemptSummary;
  readonly bootstrapLogPath: string | null;
}

function BootstrapAttemptDetails(props: BootstrapAttemptDetailsProps) {
  const { attempt, outcome } = props.summary;
  const shell = attempt.fields.shell ?? null;
  const argsField = attempt.fields.args ?? null;
  const outcomeText = outcome !== null ? describeOutcome(outcome) : null;

  return (
    <div
      data-testid="local-host-bootstrap-details"
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3 text-ui-xs text-muted-foreground"
    >
      {shell !== null ? (
        <div className="flex flex-col">
          <span className="text-foreground/70">Last attempt</span>
          <code className="break-all font-mono text-ui-xs">
            {shell}
            {argsField !== null ? ` ${argsField}` : ""}
          </code>
        </div>
      ) : null}
      {outcomeText !== null ? (
        <div
          className={cn(
            "flex flex-col",
            outcome?.phase === "failed-to-spawn" || outcome?.phase === "crashed"
              ? "text-destructive"
              : null,
          )}
        >
          <span>{outcomeText}</span>
          {outcome?.fields.error !== undefined &&
          outcome.phase !== "failed-to-spawn" ? (
            <code className="mt-1 break-all font-mono text-ui-xs">
              {outcome.fields.error}
            </code>
          ) : null}
        </div>
      ) : (
        <span>Host never reported a terminal status.</span>
      )}
      {props.bootstrapLogPath !== null ? (
        <div className="flex flex-col">
          <span className="text-foreground/70">Full log</span>
          <code className="break-all font-mono text-ui-xs">
            {props.bootstrapLogPath}
          </code>
        </div>
      ) : null}
    </div>
  );
}
