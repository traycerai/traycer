import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ConvergeReadyOk,
  HostControllerStatus,
  IRunnerHost,
  LocalHostSnapshot,
  MutationOutcome,
  MutationProgress,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useRunnerConvergeReady } from "@/hooks/runner/use-runner-converge-ready-mutation";
import { useRunnerHostControllerStatusQuery } from "@/hooks/runner/use-runner-host-controller-status-query";
import { useRunnerHostRemovalStateQuery } from "@/hooks/runner/use-runner-host-removal-state-query";
import { runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
} from "@/lib/analytics";

/** Hanging this lifecycle off a surface that comes and goes would silently lose the busy verdict and the "where
 * the install died" stage (traycer#862) exactly when a wait resolves. */

type HostSetupReason = "launch" | "recovery" | "reinstall" | "update";

// Emitted from mutation events, never renders.
function hostSetupAnalyticsCallbacks(
  reason: HostSetupReason,
  onSuccess: (result: MutationOutcome<ConvergeReadyOk>) => void,
  onFailure: () => void,
): {
  readonly onSuccess: (result: MutationOutcome<ConvergeReadyOk>) => void;
  readonly onError: (error: unknown) => void;
} {
  Analytics.getInstance().track(AnalyticsEvent.HostSetupStarted, { reason });
  return {
    onSuccess: (result) => {
      onSuccess(result);
      if (result.kind === "ok" && result.value.running) {
        Analytics.getInstance().track(AnalyticsEvent.HostSetupSucceeded, {
          reason,
        });
      }
    },
    onError: (error) => {
      onFailure();
      Analytics.getInstance().track(AnalyticsEvent.HostSetupFailed, {
        source: "direct_ui",
        blocker: analyticsBlockerFromError(error),
      });
    },
  };
}

type LocalHostState =
  | { readonly kind: "ready"; readonly snapshot: LocalHostSnapshot }
  | { readonly kind: "unavailable" };

type LocalHostStartupStage = "loading" | "slow";

/** It measures time without progress, not time since the wait began - see laneProgressAdvanceKey. */
export const LOCAL_HOST_SLOW_START_THRESHOLD_MS = 10_000;

/** Keyed ON advancement, not ON arrival, and the difference is a real failure mode rather than a nicety. */
// Its behaviour is reached through the controller in `host-provisioning-controller.test.tsx`; if it ever needs
// a direct unit test, move it to its own module rather than re-exporting it from here.
function laneProgressAdvanceKey(
  progress: MutationProgress | null,
): string | null {
  if (progress === null) return null;
  const { stage, percent, bytes, workUnits } = progress;
  // `totalBytes` is excluded on purpose: it is the size of the work, not the position in it, so a total arriving
  // late would read as advancement while nothing had moved.
  if (
    stage === null &&
    percent === null &&
    bytes === null &&
    workUnits === null
  ) {
    return null;
  }
  return `${stage ?? ""}|${percent ?? ""}|${bytes ?? ""}|${workUnits ?? ""}`;
}

export interface HostProvisioning {
  readonly isProvisioning: boolean;
  readonly error: Error | null;
  readonly progress: MutationProgress | null;
  // Only report surfaces read it - a settled install failure must still say where it died (traycer#862) - live
  // surfaces keep rendering `progress`, and an attempt that succeeds leaves nothing behind.
  readonly lastProgress: MutationProgress | null;
  // True once `convergeReady` returned a `"busy"` outcome: the CLI kept a running host that has work in
  // progress, and the desktop surfaced it for the renderer's compat probe.
  readonly hostBusy: boolean;
  // The removed surface is shown instead of spinning.
  readonly removed: boolean;
  readonly canManageHost: boolean;
  readonly retry: () => void;
  // Forced update: re-run convergeReady with `force`, skipping the busy
  // check, to reinstall + restart onto this build (can end in-progress work).
  readonly force: () => void;
  // Reinstall escape hatch from the removed surface: clear the removal
  // sentinel, then re-run convergeReady to provision the host again.
  readonly reinstall: () => void;
}

export interface HostProvisioningLifecycle {
  readonly localHostState: "unknown" | "ready" | "unavailable";
  readonly slowStartStage: LocalHostStartupStage;
  readonly provisioning: HostProvisioning;
}

// Exposes manual `retry` / `force` over `convergeReady`, plus the settled facts (busy-keep, removed, failure)
// the surfaces read.
function useHostProvisioning(args: {
  readonly enabled: boolean;
  readonly isReady: boolean;
}): HostProvisioning {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const convergeReady = useRunnerConvergeReady();
  // Live boot-time progress is sourced from the shared two-lane status push (`HostControllerStatusListener`),
  // not a per-call callback.
  const statusQuery = useRunnerHostControllerStatusQuery();
  const attemptedRef = useRef(false);
  const [inBusyKeepFlow, setInBusyKeepFlow] = useState(false);
  const [removed, setRemoved] = useState(false);
  const canProvision = args.enabled && runnerHost.hostManagement !== null;
  const hasManagement = runnerHost.hostManagement !== null;
  const { mutate, reset } = convergeReady;

  // Kept in sync so the stable `markBusyKeep` callback below can read the latest management instance without
  // widening its dependency array (see that callback's comment on why it must stay stable).
  const hostManagementRef = useRef(runnerHost.hostManagement);
  useEffect(() => {
    hostManagementRef.current = runnerHost.hostManagement;
  }, [runnerHost.hostManagement]);

  // The failed attempt's last progress event, captured once at failure settlement (see `captureFailedProgress`).
  const [failedProgress, setFailedProgress] = useState<MutationProgress | null>(
    null,
  );
  // `startedAt` of whatever mutation lane was visible when the current attempt began: a lane still carrying that
  // identity at failure time is leftover from a previous attempt and must not be reported.
  const attemptBaselineRef = useRef<string | null>(null);

  // The baseline guard drops a lane a previous attempt left behind, so a retry that fails before its first event
  // reports nothing rather than the old stage.
  const captureFailedProgress = useCallback((): void => {
    const management = hostManagementRef.current;
    if (management === null) return;
    const status = queryClient.getQueryData<HostControllerStatus>(
      runnerQueryKeys.hostControllerStatus(management),
    );
    const lane = status?.mutation ?? null;
    if (lane === null || lane.kind !== "ensure" || lane.progress === null) {
      return;
    }
    if (lane.startedAt === attemptBaselineRef.current) return;
    setFailedProgress(lane.progress);
  }, [queryClient]);

  // An error deliberately leaves the latch untouched: a failed Retry/forced update must keep us in the busy flow
  // (so we never fall through to serving an app against the still-unprobed busy host).
  const markBusyKeep = useCallback(
    (result: MutationOutcome<ConvergeReadyOk>): void => {
      setInBusyKeepFlow(result.kind === "busy");
      // Any non-error settle means the attempt did not fail: nothing to
      // report, and nothing to leak into a later unrelated failure's report.
      setFailedProgress(null);
      // Any other settled result (an `"ok"` outcome with `running: true`, after a reinstall) clears it.
      const isRemovedOutcome = result.kind === "ok" && !result.value.running;
      setRemoved(isRemovedOutcome);
      const management = hostManagementRef.current;
      if (management !== null) {
        queryClient.setQueryData(runnerQueryKeys.hostRemovalState(management), {
          removedByUser: isRemovedOutcome,
        });
      }
    },
    [queryClient],
  );

  // Only `onSuccess` transitions the busy-keep latch; an error leaves it untouched (see markBusyKeep).
  const run = useCallback(
    (force: boolean, reason: HostSetupReason): void => {
      // New attempt: drop the previous attempt's failure snapshot, and record which lane identity belongs to the
      // past so this attempt's failure can only ever report progress the new attempt actually produced.
      const management = hostManagementRef.current;
      attemptBaselineRef.current =
        management === null
          ? null
          : (queryClient.getQueryData<HostControllerStatus>(
              runnerQueryKeys.hostControllerStatus(management),
            )?.mutation?.startedAt ?? null);
      setFailedProgress(null);
      reset();
      mutate(
        { force },
        hostSetupAnalyticsCallbacks(
          reason,
          markBusyKeep,
          captureFailedProgress,
        ),
      );
    },
    [captureFailedProgress, markBusyKeep, mutate, queryClient, reset],
  );

  // Reinstall from the removed surface: clear the persisted removal sentinel (so the desktop's convergeReady
  // stops short-circuiting to the removed outcome), then re-run a normal convergeReady.
  const reinstall = useCallback((): void => {
    const management = runnerHost.hostManagement;
    if (management === null) return;
    // Optimistically drop the removed latch so the surface flips to the provisioning spinner immediately.
    setRemoved(false);
    queryClient.setQueryData(runnerQueryKeys.hostRemovalState(management), {
      removedByUser: false,
    });
    void management.clearRemoval().then(
      () => run(false, "reinstall"),
      (error: unknown) => {
        // Restore the removed surface instead of flashing a spinner through a wasted round-trip; the user can retry
        // Reinstall.
        setRemoved(true);
        queryClient.setQueryData(runnerQueryKeys.hostRemovalState(management), {
          removedByUser: true,
        });
        // The restore alone was the entire feedback, and it is ambiguous: the Reinstall button reappearing looks
        // identical to a click that never registered.
        toastFromRunnerError(error, "Couldn't reinstall the host. Try again.");
      },
    );
  }, [queryClient, run, runnerHost.hostManagement]);

  // The authority asks through `LocalHostEnsurePort` keyed on a hostId it reads from the fleet, and the fleet
  // reads the local id from the enrollment / pid-metadata files.
  void attemptedRef;

  // That effect never re-fired once `attemptedRef` was set - typically right after the very first sign-in, long
  // before the user ever visits Settings -> Danger Zone.
  const removalState = useRunnerHostRemovalStateQuery({
    enabled: canProvision && !args.isReady,
  });
  const isRemoved = removed || removalState.data?.removedByUser === true;

  const mutationLane = statusQuery.data?.mutation ?? null;
  const progress =
    convergeReady.isPending && mutationLane?.kind === "ensure"
      ? mutationLane.progress
      : null;

  const retry = useCallback(() => run(false, "recovery"), [run]);
  const force = useCallback(() => run(true, "update"), [run]);

  // Stable identity: this object is threaded through `HostProvisioningLifecycle` into the readiness controller's
  // memos.
  return useMemo(
    () => ({
      // Report provisioning/error whenever this shell manages the host - not gated on `canProvision`, which
      // collapses to false the instant a busy host is surfaced (its snapshot flips `isReady` true).
      isProvisioning: hasManagement && convergeReady.isPending,
      error: hasManagement ? convergeReady.error : null,
      progress,
      lastProgress: hasManagement ? failedProgress : null,
      hostBusy: hasManagement && inBusyKeepFlow,
      removed: hasManagement && isRemoved,
      canManageHost: hasManagement,
      retry,
      force,
      reinstall,
    }),
    [
      convergeReady.error,
      convergeReady.isPending,
      failedProgress,
      force,
      hasManagement,
      inBusyKeepFlow,
      isRemoved,
      progress,
      reinstall,
      retry,
    ],
  );
}

/** A render-prop rather than a context on purpose. */
export function HostProvisioningController(props: {
  readonly enabled: boolean;
  readonly isReady: boolean;
  readonly children: (lifecycle: HostProvisioningLifecycle) => ReactNode;
}): ReactNode {
  const runnerHost = useRunnerHost();
  // Keying the staged wait on that would have left the only population that hits this defect exactly as broken
  // as before.
  const laneStatus = useRunnerHostControllerStatusQuery();
  const advanceKey = laneProgressAdvanceKey(
    laneStatus.data?.mutation?.progress ?? null,
  );
  const { state, stage } = useLocalHostStartupState(runnerHost, advanceKey);
  const provisioning = useHostProvisioning({
    enabled: props.enabled && state?.kind === "unavailable",
    isReady: props.isReady,
  });
  const localHostState = localHostLifecycleState(state);
  // Memoized for the same reason as `provisioning` above: the readiness controller memoizes on this object, so a
  // fresh literal per render made that memo - and the context value built from it - recompute every time.
  const lifecycle = useMemo<HostProvisioningLifecycle>(
    () => ({ localHostState, slowStartStage: stage, provisioning }),
    [localHostState, provisioning, stage],
  );
  return props.children(lifecycle);
}

function localHostLifecycleState(
  state: LocalHostState | null,
): HostProvisioningLifecycle["localHostState"] {
  if (state === null) return "unknown";
  return state.kind === "ready" ? "ready" : "unavailable";
}

interface LocalHostStartupState {
  readonly state: LocalHostState | null;
  readonly stage: LocalHostStartupStage;
}

/** The runner contract requires the handler to fire synchronously on subscribe; on a runner that never emits (a
 * future custom host that breaks the contract) this stays in `loading` rather than invent a snapshot. */
function useLocalHostStartupState(
  runnerHost: IRunnerHost,
  /** Passed IN rather than read here because the lane read has to happen where `HostProvisioningController`
   * already reads it - this hook runs before `useHostProvisioning`. */
  advanceKey: string | null,
): LocalHostStartupState {
  const [state, setState] = useState<LocalHostState | null>(null);
  const [stage, setStage] = useState<LocalHostStartupStage>("loading");
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
  // Not the raw key: that changes on transitions to `null` too, and a wait restarted by absence-of-evidence is
  // the wrong direction entirely.
  const [lastAdvance, setLastAdvance] = useState<string | null>(null);
  // In an effect it would land one commit late, which is a frame in which the timer is still running against the
  // previous position.
  if (advanceKey !== null && advanceKey !== lastAdvance) {
    setLastAdvance(advanceKey);
    // It is the same fact the wait already trusts in the other direction - `lastAdvance` changing is what restarts
    // the timer.
    setStage((current) => (current === "slow" ? "loading" : current));
  }

  // `lastAdvance` is a dependency, and that is the entire mechanism: React tears down and re-runs this effect
  // whenever the lane reaches a new position, which restarts the timer from zero.
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
  }, [isReady, stage, lastAdvance]);

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
