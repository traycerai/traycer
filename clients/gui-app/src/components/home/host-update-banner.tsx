import { useMemo, useState } from "react";
import { ArrowDownToLine, X } from "lucide-react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
import type {
  HostInstallResult,
  HostOperationStatus,
  HostRegistryUpdateState,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import {
  HOST_UPDATE_BANNER_SNOOZE_MS,
  isHostUpdateBannerSnoozed,
  useHostUpdateBannerStore,
} from "@/stores/settings/host-update-banner-store";

interface HostUpdateBannerProps {
  readonly className: string | undefined;
}

/**
 * In-app host update banner (Flow 6). Reads the cached host
 * registry state via the same TanStack Query the Settings panel uses,
 * so the launch-time probe (`refreshRegistryUpdateState({ force:
 * false })`) feeds both the banner and Settings without an extra
 * probe. Clicking `Install` runs `traycer host update` through the
 * existing CLI-backed mutation. The banner hides itself when:
 *
 *   - no update is available
 *   - the registry probe failed (banner stays silent; Settings shows
 *     `Last checked: failed`)
 *   - `hostManagement` is null (mobile/web runners that don't
 *     bundle the CLI).
 *   - the user dismissed the banner with "Remind me later" within the
 *     last `HOST_UPDATE_BANNER_SNOOZE_MS` window for the current
 *     `latestVersion` (a newer release re-arms the banner because the
 *     snooze key is bound to the version string).
 */
export function HostUpdateBanner(props: HostUpdateBannerProps) {
  const runnerHost = useRunnerHost();
  const management = runnerHost.hostManagement;
  if (management === null) {
    return null;
  }
  return (
    <HostUpdateBannerInner
      management={management}
      className={props.className}
    />
  );
}

interface HostUpdateBannerInnerProps {
  readonly management: IHostManagement;
  readonly className: string | undefined;
}

function HostUpdateBannerInner(props: HostUpdateBannerInnerProps) {
  const { management, className } = props;
  const queryClient = useQueryClient();
  const snoozeUntilByVersion = useHostUpdateBannerStore(
    (state) => state.snoozeUntilByVersion,
  );
  const snooze = useHostUpdateBannerStore((state) => state.snooze);

  const { data: registryState } = useQuery(
    queryOptions<HostRegistryUpdateState>({
      queryKey: runnerQueryKeys.hostRegistryUpdate(management),
      queryFn: () => management.registryCheck({ force: false }),
      // Same TTL as Settings - both reuse the cached probe.
      staleTime: 60 * 60 * 1000,
    }),
  );

  // Canonical cross-surface "is a host mutation running" status (Ticket:
  // host-update-race-conditions) - shared with Settings → Host and any other
  // open window via the same query key, so the button here disables and
  // shows progress whether THIS banner, Settings, or the background
  // auto-update reconciler is the one actually driving the update.
  // `staleTime: Infinity` because this is entirely event-sourced (pushed by
  // `HostOperationStatusListener`), never polling-appropriate.
  const { data: operationStatus } = useQuery(
    queryOptions<HostOperationStatus | null>({
      queryKey: runnerQueryKeys.hostOperationStatus(management),
      queryFn: () => management.getOperationStatus(),
      staleTime: Infinity,
    }),
  );
  const sharedOperationActive =
    operationStatus !== undefined && operationStatus !== null;
  const sharedPercent =
    operationStatus !== undefined && operationStatus !== null
      ? operationStatus.percent
      : null;

  const updateMutation = useMutation<HostInstallResult>({
    mutationKey: runnerMutationKeys.hostUpdate(),
    // Progress is read from the shared `operationStatus` query above (it
    // reflects the operation regardless of which surface started it), so
    // this mutation doesn't need its own progress callback.
    mutationFn: () => management.updateHost({ onProgress: null }),
    onSuccess: (data) => {
      toast.success(`Updated host to v${data.version}`);
      // Drop any snooze entry recorded against the version the user just
      // installed. We pull `clearSnooze` from the store via `getState()`
      // (rather than subscribing) so this onSuccess is reused for any
      // future variant of the banner without re-triggering renders just
      // to acquire the action.
      useHostUpdateBannerStore.getState().clearSnooze(data.version);
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostRegistryUpdate(management),
      });
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
    },
    onError: (err) => toastFromRunnerError(err, "Couldn't update host"),
  });

  const nowMs = useHostUpdateNowMs();
  const shouldShow = useMemo(() => {
    if (registryState === undefined) return false;
    if (!registryState.reachable) return false;
    if (!registryState.updateAvailable) return false;
    if (registryState.latestVersion === null) return false;
    if (
      isHostUpdateBannerSnoozed(
        snoozeUntilByVersion,
        registryState.latestVersion,
        nowMs,
      )
    ) {
      return false;
    }
    return true;
  }, [snoozeUntilByVersion, registryState, nowMs]);

  if (
    !shouldShow ||
    registryState === undefined ||
    registryState.latestVersion === null
  ) {
    return null;
  }

  const latestVersion = registryState.latestVersion;

  return (
    <output
      aria-label={`Traycer host update available: ${latestVersion}`}
      data-testid="host-update-banner"
      className={cn(
        "flex items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-ui-sm text-sky-950 dark:text-sky-100",
        className,
      )}
    >
      <ArrowDownToLine className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        A new Traycer host is available:{" "}
        <span className="font-mono">{latestVersion}</span>
        {registryState.installedVersion !== null ? (
          <>
            {" "}
            (installed:{" "}
            <span className="font-mono">{registryState.installedVersion}</span>)
          </>
        ) : null}
        .
      </span>
      <Button
        type="button"
        size="sm"
        variant="default"
        disabled={updateMutation.isPending || sharedOperationActive}
        onClick={() => updateMutation.mutate()}
      >
        {updateMutation.isPending || sharedOperationActive ? (
          <>
            <AgentSpinningDots
              className="mr-2 size-3"
              testId={undefined}
              variant={undefined}
            />
            {sharedPercent !== null ? (
              <span
                className="mr-2 font-mono text-code-xs tabular-nums"
                data-testid="host-update-banner-progress-percent"
              >
                {Math.max(0, Math.min(100, Math.round(sharedPercent)))}%
              </span>
            ) : null}
          </>
        ) : null}
        Install
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Remind me later"
        data-testid="host-update-banner-snooze"
        className="text-current hover:bg-sky-500/15 hover:text-current"
        onClick={() => {
          snooze(latestVersion, getHostUpdateSnoozeUntilMs());
        }}
      >
        <X className="size-3" aria-hidden />
      </Button>
    </output>
  );
}

function useHostUpdateNowMs(): number {
  const [nowMs] = useState(() => Date.now());
  return nowMs;
}

function getHostUpdateSnoozeUntilMs(): number {
  return Date.now() + HOST_UPDATE_BANNER_SNOOZE_MS;
}
