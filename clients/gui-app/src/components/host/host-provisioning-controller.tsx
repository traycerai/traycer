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

/**
 * THE LOCAL HOST'S LIFECYCLE STATE - the one owner of this machine's
 * host-startup facts and its user-initiated recovery gestures.
 *
 * It lived inside `local-host-gate.tsx` until redesign P3.4, wrapped by three
 * components that had been marked NOT RENDERED IN PRODUCTION for two
 * consolidations (F21). Those wrappers are gone; this is what was alive inside
 * them, moved out unchanged.
 *
 * WHAT IT IS NOT: it does not draw anything, and it does not decide when a
 * user sees a surface. The window narrator (`WindowHostModalHost`) draws the
 * bootstrap surface and derives WHETHER to speak from the selection
 * authority's leases; the readiness gate decides whether the app may mount.
 * This projects the facts both of them read.
 *
 * WHERE IT MOUNTS, and why that is not the modal (P3.4 ruling, shape A). The
 * mount stays in `HostReadinessControllerProvider`, above the router:
 *
 *  - the readiness projection CONSUMES this lifecycle (`provisioning` ->
 *    `provisioning-host`, `removed` -> `removed-host`, `provisioningError` ->
 *    `provisioning-error`, `localHostState`+`slowStartStage` -> the slow
 *    promotion), while this controller's own `enabled`/`isReady` inputs are
 *    that provider's derived facts. Mounting it below the projection closes
 *    the loop;
 *  - the modal is CONDITIONALLY rendered - it is silent for a healthy window.
 *    The busy-keep and removed latches are state in `useHostProvisioning`, and
 *    `run()`'s per-`mutate` callbacks (`markBusyKeep`, `captureFailedProgress`,
 *    the setup analytics) are dropped by TanStack when their component
 *    unmounts. Hanging this lifecycle off a surface that comes and goes would
 *    silently lose the busy verdict and the "where the install died" stage
 *    (traycer#862) exactly when a wait resolves.
 */

type HostSetupReason = "launch" | "recovery" | "reinstall" | "update";

// Best-effort setup telemetry around the `convergeReady` mutation. Emitted
// from mutation events, never renders. The mutation hook already rejects
// non-"ok"/"busy" outcomes (see `useRunnerConvergeReady`), so `onSuccess`
// here only ever sees those two kinds - a `"busy"` outcome, or an `"ok"`
// outcome with `running: false` (removed-by-user short-circuit), is neither
// success nor failure; the user resolves it through its own surface.
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

/**
 * Threshold before the staged wait promotes from Stage 1 ("loading", no Retry)
 * to Stage 2 ("slow", the unavailable surface with Retry).
 *
 * It measures TIME WITHOUT PROGRESS, not time since the wait began - see
 * {@link laneProgressAdvanceKey}. That distinction is the whole contract:
 * `slow` means STALLED, not merely long.
 *
 * The number is chosen in the 8-15s band so a healthy bundled-host boot
 * (typically well under a second) never flashes the Retry UI, while a genuinely
 * stalled launch surfaces the escape hatch before the user suspects the app is
 * broken.
 *
 * ⚠ THAT JUSTIFICATION IS ABOUT ONE POPULATION, and for a long time this timer
 * governed several. A bundled-host BOOT is sub-second, so 10s is a 10x margin.
 * The same staged wait also covers the first-run download and install, where ten
 * seconds is entirely routine - so a healthy first launch promoted to `slow` mid
 * download and put Retry in front of a user whose install was working perfectly.
 * That is the recovery-action-on-a-healthy-startup complaint this epic started
 * from, arriving by a different route.
 *
 * The fix was NOT a bigger number. A bigger number moves the same bug later and
 * costs every genuinely stalled user the delay. Resetting on real progress is
 * what makes one threshold correct for every population sharing it.
 */
export const LOCAL_HOST_SLOW_START_THRESHOLD_MS = 10_000;

/**
 * A comparable fingerprint of how far the host controller's lane has got, or
 * `null` when it offers no evidence of having moved.
 *
 * The staged wait restarts whenever this CHANGES, which is what makes the
 * threshold mean "time without progress".
 *
 * KEYED ON ADVANCEMENT, NOT ON ARRIVAL, and the difference is a real failure
 * mode rather than a nicety: a download that is stuck but chatty re-emits the
 * same percent indefinitely, and a timer reset by the arrival of any event would
 * never promote - so the escape hatch would vanish for precisely the user who
 * needs it. An identical event produces an identical key and does not reset
 * anything.
 *
 * ⚠ `workUnits` IS WHAT MAKES THIS WORK ON THE POPULATION THAT MATTERS, and its
 * absence is why an earlier version of this key did not. A bundled first launch
 * never runs `download` - the desktop ships the archive beside the CLI - so the
 * only stages that run are `verify` and `extract`, and both emitted a CONSTANT
 * payload for minutes: a stage name and nothing else. The key therefore had PHASE
 * granularity, two advances in an entire install, and this staged wait promoted a
 * healthy install to its Retry surface about ten seconds in.
 *
 * `verify` now reports hashed `bytes` - a real position, from a stream that
 * already knew it - and `extract` reports `workUnits`, archive entries being the
 * only discrete unit that phase has. An older bundled CLI sends neither, and the
 * NDJSON parser normalises both to `null`, so version skew degrades to the
 * previous behaviour rather than breaking.
 *
 * `null` FOR AN EVENTLESS LANE IS DELIBERATE. `useHostProvisioningProgress` is
 * explicit that a null `progress` on a running lane means "accepted but has not
 * pushed an event", not "no progress yet" - so an install that was accepted and
 * then went quiet for the whole threshold is exactly the stall this stage exists
 * to surface. Same for an event carrying only a message: a line of prose is not
 * evidence of movement. When there is nothing comparable to compare, the wait
 * runs, which fails toward keeping the escape hatch.
 */
// Deliberately NOT exported: nothing outside this file imports it, and a
// non-component export here costs the whole module its fast refresh
// (`react-refresh/only-export-components`, which the package lints at
// `--max-warnings 0`). Its behaviour is reached through the controller in
// `host-provisioning-controller.test.tsx`; if it ever needs a direct unit
// test, move it to its own module rather than re-exporting it from here.
function laneProgressAdvanceKey(
  progress: MutationProgress | null,
): string | null {
  if (progress === null) return null;
  const { stage, percent, bytes, workUnits } = progress;
  // `totalBytes` is excluded on purpose: it is the SIZE of the work, not the
  // position in it, so a total arriving late would read as advancement while
  // nothing had moved. `message` is excluded for the same reason.
  //
  // ⚠ THE SAFETY ARGUMENT, here rather than only in the suite - this is where
  // someone stands when they decide the line is dead weight. Returning a
  // non-null value for an event with no comparable fields makes every repeat of
  // that event restart the staged wait, so an installer that says "working…"
  // forever WITHHOLDS Retry and Report issue indefinitely. Prose is not
  // movement. The wrong direction here is silent: the user gets a screen that
  // never offers a way out.
  //
  // ⚠ AND IT IS UNPROVEN. Mutating this line to report an advance passes the
  // entire suite - three attempts at an arm for it were each vacuous, for three
  // different reasons recorded in
  // `__tests__/host-provisioning-controller.test.tsx`. Read those before
  // trusting a green run on this branch, and prefer an integration-level
  // measurement if you need to change it.
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
  // Last `progress` event observed during the current provisioning attempt,
  // non-null ONLY once that attempt has failed (when live `progress` has
  // already nulled out). Only report surfaces read it - a settled install
  // failure must still say where it died (traycer#862) - live surfaces keep
  // rendering `progress`, and an attempt that succeeds leaves nothing behind.
  readonly lastProgress: MutationProgress | null;
  // True once `convergeReady` returned a `"busy"` outcome: the CLI kept a
  // running host that has work in progress, and the desktop surfaced it for
  // the renderer's compat probe.
  readonly hostBusy: boolean;
  // True once `convergeReady` returned `{kind: "ok", value: {running: false}}`
  // (the removed-by-user short-circuit): the user removed Traycer's
  // background components on this device, so the desktop refused to
  // reinstall. The removed surface is shown instead of spinning.
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

// Exposes manual `retry` / `force` over `convergeReady`, plus the settled
// facts (busy-keep, removed, failure) the surfaces read. A `useRef` guard
// survives from the retired automatic converge; see the retirement note below.
function useHostProvisioning(args: {
  readonly enabled: boolean;
  readonly isReady: boolean;
}): HostProvisioning {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const convergeReady = useRunnerConvergeReady();
  // Live boot-time progress is sourced from the shared two-lane status push
  // (`HostControllerStatusListener`), not a per-call callback - the mutation
  // lane's `kind` tags which intent is in flight, so this stays indifferent
  // to any concurrent download-lane activity by construction (it only ever
  // reads `mutation`, never `download`).
  const statusQuery = useRunnerHostControllerStatusQuery();
  const attemptedRef = useRef(false);
  const [inBusyKeepFlow, setInBusyKeepFlow] = useState(false);
  const [removed, setRemoved] = useState(false);
  const canProvision = args.enabled && runnerHost.hostManagement !== null;
  const hasManagement = runnerHost.hostManagement !== null;
  const { mutate, reset } = convergeReady;

  // Kept in sync so the stable `markBusyKeep` callback below can read the
  // latest management instance without widening its dependency array (see
  // that callback's comment on why it must stay stable).
  const hostManagementRef = useRef(runnerHost.hostManagement);
  useEffect(() => {
    hostManagementRef.current = runnerHost.hostManagement;
  }, [runnerHost.hostManagement]);

  // The failed attempt's last progress event, captured ONCE at failure
  // settlement (see `captureFailedProgress`) - never per progress push, so
  // the per-chunk progress stream drives no extra renders and no ref is read
  // during render. Cleared on every new attempt (`run`) and on a successful
  // settle (`markBusyKeep`), so a report filed later against an unrelated
  // failure can never carry a stale stage from an attempt that succeeded.
  const [failedProgress, setFailedProgress] = useState<MutationProgress | null>(
    null,
  );
  // `startedAt` of whatever mutation lane was visible when the CURRENT
  // attempt began: a lane still carrying that identity at failure time is
  // leftover from a PREVIOUS attempt and must not be reported. Written and
  // read only in event handlers/mutation callbacks, never during render.
  const attemptBaselineRef = useRef<string | null>(null);

  // Failure settlement: snapshot the freshest ensure-lane progress straight
  // from the status query cache. An event-time cache read on purpose - the
  // render-observed value can miss a progress push that coalesces into the
  // same render as the settlement (the desktop broadcast collapses bursts to
  // the latest status), and effect-ordering arguments are exactly what the
  // hooks rules forbid relying on. The baseline guard drops a lane a
  // previous attempt left behind, so a retry that fails before its first
  // event reports nothing rather than the old stage.
  //
  // Known limit: the lane carries no requester identity, so this is
  // best-effort attribution - if ANOTHER window's distinct ensure is already
  // mid-flight on the shared FIFO lane when this attempt's failure settles,
  // its stage can be snapshotted here (same ambiguity the live `progress`
  // display accepts while pending). Positive binding needs the attempt's
  // identity returned with the converge outcome itself - a
  // MutationOutcome/IHostManagement contract change, out of scope for this
  // renderer-only report enrichment. The line is a triage hint beside
  // auto-attached logs, not a source of truth.
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

  // Latch the busy-keep flow from the settled mutation RESULT (a mutation
  // event, not a render effect or a ref read), so it survives the surfaced
  // host flipping `isReady` true and survives Retry/forced update `reset()`
  // (which clears `convergeReady.data`). A `"busy"` outcome enters the flow;
  // any other success exits it. An ERROR deliberately leaves the latch
  // untouched: a failed Retry/forced update must keep us in the busy flow (so
  // we never fall through to serving an app against the still-unprobed
  // busy host), and a failed initial provision leaves the latch at its
  // `false` default (normal error path). Stable handler keeps the provision
  // effect from re-running.
  const markBusyKeep = useCallback(
    (result: MutationOutcome<ConvergeReadyOk>): void => {
      setInBusyKeepFlow(result.kind === "busy");
      // Any non-error settle means the attempt did not fail: nothing to
      // report, and nothing to leak into a later unrelated failure's report.
      setFailedProgress(null);
      // The desktop refused to reinstall a user-removed host; latch the
      // removed surface. Any other settled result (an `"ok"` outcome with
      // `running: true`, after a reinstall) clears it.
      const isRemovedOutcome = result.kind === "ok" && !result.value.running;
      setRemoved(isRemovedOutcome);
      // `convergeReady`'s own removal check is the freshest possible truth,
      // so write it straight into the removal-state query cache too - a
      // response-equals-state cache write (not a guess) that keeps the
      // direct removal-sentinel query (below) from re-asserting a stale
      // `true` it fetched before this settle.
      const management = hostManagementRef.current;
      if (management !== null) {
        queryClient.setQueryData(runnerQueryKeys.hostRemovalState(management), {
          removedByUser: isRemovedOutcome,
        });
      }
    },
    [queryClient],
  );

  // Retry/forced update: clear any prior error, then re-run convergeReady.
  // Only `onSuccess` transitions the busy-keep latch; an error leaves it
  // untouched (see markBusyKeep).
  const run = useCallback(
    (force: boolean, reason: HostSetupReason): void => {
      // New attempt: drop the previous attempt's failure snapshot, and record
      // which lane identity belongs to the past so this attempt's failure can
      // only ever report progress the new attempt actually produced.
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

  // Reinstall from the removed surface: clear the persisted removal sentinel
  // (so the desktop's convergeReady stops short-circuiting to the removed
  // outcome), then re-run a normal convergeReady. Optimistically drop the
  // removed latch so the surface flips to the provisioning spinner
  // immediately.
  const reinstall = useCallback((): void => {
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
      () => run(false, "reinstall"),
      (error: unknown) => {
        // The sentinel couldn't be cleared, so convergeReady would just
        // short-circuit back to the removed outcome. Restore the removed
        // surface instead of flashing a spinner through a wasted round-trip;
        // the user can retry Reinstall.
        setRemoved(true);
        queryClient.setQueryData(runnerQueryKeys.hostRemovalState(management), {
          removedByUser: true,
        });
        // The restore alone was the entire feedback, and it is ambiguous: the
        // Reinstall button reappearing looks identical to a click that never
        // registered. Say the request failed, through the shared runner
        // handler so a typed bridge error keeps its own message.
        toastFromRunnerError(error, "Couldn't reinstall the host. Try again.");
      },
    );
  }, [queryClient, run, runnerHost.hostManagement]);

  // THE AUTOMATIC LAUNCH-TIME `convergeReady` IS RETIRED (D14/C5, registry §5).
  //
  // It used to fire here, once per session, whenever a signed-in local-host
  // shell had no reachable host. That made the renderer a SECOND process actor
  // alongside the selection authority, which requests the same
  // `HostController.convergeReady` through `LocalHostEnsurePort` - and the
  // registry is explicit that the engine gets EXACTLY ONE sanctioned process
  // action and the registry itself never drives processes. Two actors broke
  // that in both directions: whichever won, the other was wrong. Renderer-wins
  // left the engine refraining (it saw provisioning already under way through
  // the mutation lane and declined to ask), so its ∅ derivation and the actual
  // provisioning state described different worlds; engine-wins produced two
  // converge calls for one boot.
  //
  // It is also what made the ∅ definitions two rather than one: registry §5
  // says ∅ is "no usable lease AND the ensure path is unavailable or has
  // failed", which is only decidable if the engine is the one asking.
  //
  // What stays HERE is presentation state and USER-INITIATED recovery: Retry,
  // forced update, the busy-keep flow, the removal surface, and the progress
  // the mutation lane pushes. Those are gestures and facts, not automatic
  // process mutation. P3.1 re-homed the SURFACE they drive into the window
  // modal; P3.4 moved this state out of the dead gate wrapper. Nothing here
  // asks for a process on its own.
  //
  // BOOT-TIME PROVISIONING SPLITS IN TWO, and an earlier draft of this comment
  // said "the authority alone", which was wrong in a way that cost a first
  // launch. The authority asks through `LocalHostEnsurePort` keyed on a hostId
  // it reads from the fleet, and the fleet reads the local id from the
  // enrollment / pid-metadata files - so on a machine that has never had a
  // host the id is null and the authority structurally cannot ask. It owns
  // the STEADY-STATE ensure: the local host exists but is down, whichever host
  // the window is pointed at. The FIRST BOOT belongs to the desktop's launch
  // module (`armLocalHostBootOnSignIn` in
  // `electron-main/startup/host-launch-converge.ts`), which is the launch-time
  // process actor: sign-in and removal-sentinel gated, and retrying on a
  // backoff ladder until a host runs. Retiring this effect without that arm
  // left nobody installing a first-ever host.
  void attemptedRef;

  // Direct removal-sentinel check, independent of the retired one-shot
  // `convergeReady` effect above. That effect never re-fired once
  // `attemptedRef` was set - typically right after the very first sign-in,
  // long before the user ever visits Settings -> Danger Zone - so it could not
  // notice a removal that happens later in the same session. The query
  // re-activates on every not-ready transition (see its `enabled`), and its
  // result is read directly below (derived, not synced into state) so it
  // short-circuits straight to the removed surface per `getRemovalState`'s
  // contract instead of falling through to the generic unavailable/Retry card.
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

  // Stable identity: this object is threaded through `HostProvisioningLifecycle`
  // into the readiness controller's memos. Returning a fresh literal (with
  // fresh `retry`/`force` arrows) invalidated every one of them on each render,
  // so the readiness context value churned and re-ran all its consumers.
  return useMemo(
    () => ({
      // Report provisioning/error whenever this shell manages the host - NOT
      // gated on `canProvision`, which collapses to false the instant a busy
      // host is surfaced (its snapshot flips `isReady` true). Gating on
      // `canProvision` would hide Retry/forced update progress and swallow
      // their errors. `convergeReady.isPending`/`.error` are only meaningful
      // after a mutation that already required management, so `hasManagement`
      // is the correct gate.
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

/**
 * Mounts the local-host provisioning lifecycle and projects it to its readers.
 *
 * A render-prop rather than a context on purpose: it has exactly one mount
 * (the readiness controller, see this module's header) and one reader tree
 * below it, and the projection is already memoized for that reader's memos.
 */
export function HostProvisioningController(props: {
  readonly enabled: boolean;
  readonly isReady: boolean;
  readonly children: (lifecycle: HostProvisioningLifecycle) => ReactNode;
}): ReactNode {
  const runnerHost = useRunnerHost();
  // THE LANE, not this renderer's own mutation state. A first launch is driven by
  // the desktop's launch reconciler, so `provisioning.isProvisioning` is false
  // and `provisioning.progress` is null throughout the very install that trips
  // the staged wait - see `useHostProvisioningProgress`, which exists because a
  // renderer-side observer "can only ever see the episodes it started". Keying
  // the staged wait on that would have left the only population that hits this
  // defect exactly as broken as before.
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
  // Memoized for the same reason as `provisioning` above: the readiness
  // controller memoizes on this object, so a fresh literal per render made
  // that memo - and the context value built from it - recompute every time.
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

/**
 * The local host snapshot plus the staged wait over it. Called
 * `useLocalHostGateState` until P3.4 deleted the gate it was named for; the
 * behaviour is unchanged, so a search for the old name lands here.
 *
 * Staged wait (Flow 5):
 *   1. "loading" - the immediate waiting state, no Retry affordance. The
 *      default on mount and after every Ready -> not-ready transition.
 *   2. "slow" - entered after `LOCAL_HOST_SLOW_START_THRESHOLD_MS` has
 *      elapsed without a usable snapshot; this is what puts a Retry
 *      (respawn) in front of the user.
 *   A usable snapshot arriving at any point returns the surfaces to ready
 *   without requiring the user to click anything.
 *
 * `IRunnerHost.onLocalHostChange(...)` is the only source of truth - there is
 * no `getLocalHost()` accessor. The runner contract requires the handler to
 * fire synchronously on subscribe; on a runner that never emits (a future
 * custom host that breaks the contract) this stays in `loading` rather than
 * invent a snapshot.
 */
function useLocalHostStartupState(
  runnerHost: IRunnerHost,
  /**
   * The host controller lane's advance fingerprint, from
   * {@link laneProgressAdvanceKey}. Passed IN rather than read here because the
   * lane read has to happen where `HostProvisioningController` already reads it -
   * this hook runs before `useHostProvisioning`, whose `enabled` depends on the
   * state this hook produces, so reading the lane here would close that loop.
   */
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
  // The last POSITION the lane was seen at, which is what the staged wait below
  // restarts on. Not the raw key: that changes on transitions to `null` too, and
  // a wait restarted by absence-of-evidence is the wrong direction entirely.
  //
  // Measured: with the raw key as the dependency, the lane momentarily reading
  // `null` - the controller-status query's own priming fetch landing after a
  // pushed event - restarted the wait and a genuinely stuck download stopped
  // promoting. It surfaced as a test failing for a reason unrelated to what it
  // was testing, which is the cheapest way to be told.
  //
  // "Advance" means A DIFFERENT position, not a greater one. A stage change
  // resets `percent` to a lower number (download 90% -> extract 5%), so
  // requiring monotonic increase would read a legitimate transition as a stall.
  const [lastAdvance, setLastAdvance] = useState<string | null>(null);
  // Adjusted DURING RENDER, the same documented pattern the ready latch uses -
  // not in an effect. React re-runs this render immediately, before committing,
  // so the wait below sees the new position in the same pass. In an effect it
  // would land one commit late, which is a frame in which the timer is still
  // running against the previous position.
  //
  // `null` is not a position, so it neither advances nor rewinds the wait: an
  // accepted-but-silent lane keeps whatever timer is already running, which is
  // what lets it promote on schedule.
  if (advanceKey !== null && advanceKey !== lastAdvance) {
    setLastAdvance(advanceKey);
    // AND DEMOTE, because `slow` was otherwise ABSORBING. The effect below
    // returns early on `stage === "slow"`, so once the wait promoted, no later
    // event could re-arm the timer or take the state back down - only reaching
    // `ready`, or a ready -> not-ready transition, ever cleared it. A user
    // whose install went quiet for eleven seconds and then resumed kept Retry
    // and the emphasized recovery controls in front of them for the rest of a
    // healthy install, which is the same false alarm the staged wait exists to
    // avoid, just arrived at from the other side.
    //
    // A NEW POSITION IS THE EVIDENCE. It is the same fact the wait already
    // trusts in the other direction - `lastAdvance` changing is what restarts
    // the timer - so treating it as proof of life here is not a new claim,
    // only the missing half of the existing one. The stall detection is
    // unweakened: the effect re-arms from this position, so an install that
    // advances once and stops promotes again on schedule.
    setStage((current) => (current === "slow" ? "loading" : current));
  }

  // `lastAdvance` is a DEPENDENCY, and that is the entire mechanism: React tears
  // down and re-runs this effect whenever the lane reaches a new position, which
  // restarts the timer from zero. So the threshold measures time since progress
  // last moved rather than time since the wait began. Repeated identical events
  // leave it untouched, so a chatty stall still promotes on schedule.
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
