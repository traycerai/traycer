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
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  BootstrapMarkerEntry,
  HostEnsureResult,
  HostProgressEvent,
  IRunnerHost,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useRunnerRequestHostRespawn } from "@/hooks/runner/use-runner-request-host-respawn-mutation";
import { useRunnerEnsureHost } from "@/hooks/runner/use-runner-ensure-host-mutation";
import { useRunnerTraycerHostStatusQuery } from "@/hooks/runner/use-runner-traycer-host-status-query";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { cn } from "@/lib/utils";

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
  const passThrough = shouldPassThroughGate({
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

  // Reinstall-progress node, reused by the busy-keep restart branch and the
  // normal provisioning branch.
  const provisioningLoadingNode =
    props.provisioningLoading !== null
      ? cloneElement(props.provisioningLoading, {
          progress: provisioning.progress,
        })
      : props.loading;

  if (passThrough) {
    return <>{props.children}</>;
  }

  // host-busy keep path: the CLI kept a running host that has work in
  // progress. This state is LATCHED (it survives the surfaced host flipping
  // the snapshot to `ready`, and survives Retry/Force `reset()`), and it takes
  // precedence over `isReady` so children never connect to an unprobed busy
  // host. `HostBusyGate` is isolated in its own component because the compat
  // probe calls `useHostClient`, valid only below the host runtime
  // provider. A Retry/Force restart in flight shows its progress, not the panel.
  if (provisioning.hostBusy) {
    if (provisioning.isProvisioning) {
      return <>{provisioningLoadingNode}</>;
    }
    return (
      <HostBusyGate onRetry={provisioning.retry} onForce={provisioning.force}>
        {props.children}
      </HostBusyGate>
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

  if (isReady) {
    return <>{props.children}</>;
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

// True when the gate should render children without requiring a ready
// host: signed-out users, shells without a local host (mobile/web),
// explicit non-local selections, and caller-declared bypass routes.
function shouldPassThroughGate(args: {
  readonly authStatus: string;
  readonly hasLocalHost: boolean;
  readonly selectedEntry: HostDirectoryEntry | null;
  readonly bypass: boolean;
}): boolean {
  if (args.authStatus !== "signed-in") return true;
  if (!args.hasLocalHost) return true;
  if (args.selectedEntry !== null && args.selectedEntry.kind !== "local") {
    return true;
  }
  return args.bypass;
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
  readonly retry: () => void;
  // Force restart: re-run ensure with `force`, skipping the busy check, to
  // reinstall + restart onto this build (ends the in-progress work).
  readonly force: () => void;
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
  const ensure = useRunnerEnsureHost();
  const attemptedRef = useRef(false);
  const [progress, setProgress] = useState<HostProgressEvent | null>(null);
  const [inBusyKeepFlow, setInBusyKeepFlow] = useState(false);
  const canProvision = args.enabled && runnerHost.hostManagement !== null;
  const hasManagement = runnerHost.hostManagement !== null;
  const { mutate, reset } = ensure;

  // Latch the busy-keep flow from the settled mutation RESULT (a mutation
  // event, not a render effect or a ref read), so it survives the surfaced
  // host flipping `isReady` true and survives Retry/Force `reset()` (which
  // clears `ensure.data`). A `host-busy` result enters the flow; any other
  // success exits it. An ERROR deliberately leaves the latch untouched: a
  // failed Retry/Force must keep us in the busy flow (so we never fall through
  // to rendering children against the still-unprobed busy host), and a failed
  // initial provision leaves the latch at its `false` default (normal error
  // path). Stable handler keeps the provision effect from re-running.
  const markBusyKeep = useCallback((result: HostEnsureResult): void => {
    setInBusyKeepFlow(result.action === "host-busy");
  }, []);

  // Retry/Force: clear any prior error/progress, then re-run ensure. Only
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

  return {
    // Report provisioning/error whenever this shell manages the host - NOT
    // gated on `canProvision`, which collapses to false the instant a busy
    // host is surfaced (its snapshot flips `isReady` true). Gating on
    // `canProvision` would hide Retry/Force restart progress and swallow their
    // errors. `ensure.isPending`/`ensure.error` are only meaningful after a
    // mutation that already required management, so `hasManagement` is the
    // correct gate.
    isProvisioning: hasManagement && ensure.isPending,
    error: hasManagement ? ensure.error : null,
    progress,
    hostBusy: hasManagement && inBusyKeepFlow,
    retry: () => run(false),
    force: () => run(true),
  };
}

type CompatProbeStatus = "checking" | "compatible" | "incompatible";

const HOST_STATUS_PROBE = {};

// After this long stuck on "checking" (the surfaced host never bound, or the
// probe kept failing transiently), the checking surface reveals a manual
// Retry/Force escape so the user is never trapped on the spinner with no way
// out. Sits above the typical sub-second probe so a healthy keep never flashes
// the buttons.
const COMPAT_CHECK_ESCAPE_THRESHOLD_MS = 12_000;

// Terminal handshake verdicts: the host's manifest is genuinely incompatible
// with this build, so retrying the probe cannot change the answer. Every other
// error (a transient RPC/connection blip) is non-terminal and is retried.
function isTerminalCompatError(error: HostRpcError): boolean {
  return (
    error.code === "INCOMPATIBLE" || error.code === "DOWNGRADE_UNSUPPORTED"
  );
}

// Compat probe for the host-busy keep path (D4). Reuses the existing manifest
// handshake: calling `host.status` (a pure-local RPC - no cloud I/O) against
// the surfaced default host either succeeds (compatible) or throws
// `HostRpcError{INCOMPATIBLE | DOWNGRADE_UNSUPPORTED}` from the openAck
// negotiation. `host.status` is deliberate (not a cloud-backed method) so a
// compatible-but-cloud-degraded host still reads "compatible". Until the
// host binds the underlying query stays disabled and we report "checking"; a
// transient error is retried (so a network blip never reads as incompatible),
// and the checking surface reveals a manual Retry/Force escape if it stays
// stuck, so a never-binding or repeatedly-failing probe is not a dead-end.
interface HostBusyGateProps {
  readonly children: ReactNode;
  readonly onRetry: () => void;
  readonly onForce: () => void;
}

// Rendered only while the CLI kept a busy host (D4 keep path). Probes the
// surfaced host's compatibility and renders the keep / checking / prompt
// outcome. Isolated so `useHostClient` (valid only below the host runtime
// provider) is never reached from the gate's other states.
function HostBusyGate(props: HostBusyGateProps) {
  const compat = useHostCompatProbe();
  if (compat === "incompatible") {
    return (
      <GateIncompatibleBusy onRetry={props.onRetry} onForce={props.onForce} />
    );
  }
  if (compat === "compatible") {
    return <>{props.children}</>;
  }
  return <GateCompatChecking onRetry={props.onRetry} onForce={props.onForce} />;
}

function useHostCompatProbe(): CompatProbeStatus {
  const client = useHostClient();
  const probe = useHostQuery<HostRpcRegistry, "host.status">({
    client,
    method: "host.status",
    params: HOST_STATUS_PROBE,
    options: {
      // Retry a transient failure a couple of times so a momentary blip never
      // reads as incompatible, but fail fast on a terminal compat verdict
      // (retrying an INCOMPATIBLE handshake cannot change the answer).
      retry: (failureCount, error) =>
        !isTerminalCompatError(error) && failureCount < 2,
      // A compatible verdict must not bounce back to "checking": Infinity keeps
      // the success cached with no background refetch, so children stay mounted
      // even if the host connection later churns. The query key is host-id
      // scoped, so a genuine host swap still re-probes.
      staleTime: Infinity,
    },
  });
  if (probe.isSuccess) {
    return "compatible";
  }
  if (probe.error !== null && isTerminalCompatError(probe.error)) {
    return "incompatible";
  }
  return "checking";
}

interface GateCompatCheckingProps {
  readonly onRetry: () => void;
  readonly onForce: () => void;
}

// "Host is busy — checking compatibility…" surface, shown while the compat
// probe is in flight or the surfaced host has not yet bound. If it stays
// stuck past COMPAT_CHECK_ESCAPE_THRESHOLD_MS (the host never bound, or the
// probe kept failing transiently), it reveals a manual Retry/Force escape so
// the user is never trapped on the spinner with no way out.
function GateCompatChecking(props: GateCompatCheckingProps) {
  const [showEscape, setShowEscape] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowEscape(true);
    }, COMPAT_CHECK_ESCAPE_THRESHOLD_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return (
    <div
      data-testid="local-host-compat-checking"
      className="flex min-h-svh w-full items-center justify-center bg-background p-6 text-foreground"
    >
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-6 text-ui-sm">
          <AgentSpinningDots
            className={undefined}
            testId="local-host-compat-checking-spinner"
            variant={undefined}
          />
          <p className="text-center">
            Your host is busy — checking whether this update can keep using it…
          </p>
          {showEscape ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={props.onRetry}
                data-testid="local-host-compat-checking-retry"
              >
                Retry
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={props.onForce}
                data-testid="local-host-compat-checking-force"
              >
                Force restart (ends running work)
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

interface GateIncompatibleBusyProps {
  readonly onRetry: () => void;
  readonly onForce: () => void;
}

// Shown when the kept busy host is incompatible with this build: Retry
// re-checks busy, Force reinstalls + restarts (ending the running work).
function GateIncompatibleBusy(props: GateIncompatibleBusyProps) {
  return (
    <div
      data-testid="local-host-incompatible-busy"
      className="flex min-h-svh w-full items-center justify-center bg-background p-6 text-foreground"
    >
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col gap-4 py-6 text-ui-sm">
          <div className="flex flex-col gap-1 text-center">
            <p className="font-medium">Update paused</p>
            <p className="text-muted-foreground">
              Your host has work in progress and is not compatible with this
              update. Retry the restart, or force a restart now — Force ends the
              running work.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={props.onRetry}
              data-testid="local-host-incompatible-busy-retry"
            >
              Retry restart
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={props.onForce}
              data-testid="local-host-incompatible-busy-force"
            >
              Force restart (ends running work)
            </Button>
          </div>
        </CardContent>
      </Card>
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
          <div className="flex justify-center">
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
          <div className="flex justify-center">
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
