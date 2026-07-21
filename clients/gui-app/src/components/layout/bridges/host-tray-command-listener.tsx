import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  BusyContinuation,
  HostTrayCommand,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { RestartHostConfirmDialog } from "@/components/host/restart-host-confirm-dialog";
import { HostBusyForceDeferDialog } from "@/components/host/host-busy-force-defer-dialog";
import { useRunnerHostControllerStatusQuery } from "@/hooks/runner/use-runner-host-controller-status-query";
import { useRunnerApplyStaged } from "@/hooks/runner/use-runner-apply-staged-mutation";
import { useRunnerActivateInstalled } from "@/hooks/runner/use-runner-activate-installed-mutation";
import {
  Analytics,
  AnalyticsEvent,
  hostUpdateAnalyticsCallbacks,
} from "@/lib/analytics";

type TrayUpdateIntent = "apply" | "activate";

interface TrayBusyState {
  readonly intent: TrayUpdateIntent;
  readonly continuation: BusyContinuation;
  readonly message: string;
}

/**
 * NP-6: listens for host-scoped tray commands forwarded from the
 * Electron main process and dispatches them against the renderer:
 *   - openSettingsHost → navigate to /settings/host.
 *   - restartHost      → confirm with the user, then invoke
 *                          hostManagement.restartHost() and surface
 *                          success/error via toast.
 *   - openLogs           → navigate to /settings/host (logs surface lives
 *                          inside the host panel) and open the legacy logs
 *                          dialog as a redundant entry point.
 *   - installUpdate      → confirm with the user (preview the version that
 *                          will be installed), then submit `applyStaged` (a
 *                          ready update) or `activateInstalled` (activation
 *                          debt only) - whichever the canonical two-lane
 *                          status is currently offering (update-over-debt
 *                          priority) - with toast feedback. A busy outcome
 *                          opens the shared Force/Defer dialog; any other
 *                          non-`"ok"` outcome (incl. exhausted lock-retry) is
 *                          this surface's own deferred-lock notification.
 *
 * Shells without a tray expose `hostTray: null` and this listener
 * is a no-op.
 */
export function HostTrayCommandListener() {
  const runnerHost = useRunnerHost();
  const navigate = useNavigate();
  const openLogs = useDesktopDialogStore((state) => state.openLogs);
  const queryClient = useQueryClient();
  const management = runnerHost.hostManagement;
  const { data: status, refetch: refetchStatus } =
    useRunnerHostControllerStatusQuery();
  const [pendingRestart, setPendingRestart] = useState<boolean>(false);
  const [pendingInstallVersion, setPendingInstallVersion] = useState<
    string | null
  >(null);
  const [busy, setBusy] = useState<TrayBusyState | null>(null);
  const hostUpdateAnalytics = hostUpdateAnalyticsCallbacks("system_tray");

  const invalidate = (): void => {
    if (management === null) return;
    void queryClient.invalidateQueries({
      queryKey: runnerQueryKeys.hostAvailableVersionsScope(management),
    });
    void queryClient.invalidateQueries({
      queryKey: runnerQueryKeys.hostRegistryUpdate(management),
    });
    void queryClient.invalidateQueries({
      queryKey: runnerQueryKeys.hostInstalledRecord(management),
    });
  };

  const applyStagedMutation = useRunnerApplyStaged();
  const activateInstalledMutation = useRunnerActivateInstalled();

  const handleApplyOutcome = (
    outcome: MutationOutcome<ApplyStagedOk>,
  ): void => {
    setPendingInstallVersion(null);
    if (outcome.kind === "ok") {
      hostUpdateAnalytics.onSucceeded();
      toast.success(`Updated host to v${outcome.value.appliedVersion}`);
      setBusy(null);
      invalidate();
      return;
    }
    if (outcome.kind === "busy") {
      setBusy({
        intent: "apply",
        continuation: outcome.continuation,
        message: outcome.message,
      });
      return;
    }
    hostUpdateAnalytics.onFailed(new Error(outcome.message));
    setBusy(null);
    toast.error(outcome.message);
  };

  const handleActivateOutcome = (
    outcome: MutationOutcome<ActivateInstalledOk>,
  ): void => {
    setPendingInstallVersion(null);
    if (outcome.kind === "ok") {
      hostUpdateAnalytics.onSucceeded();
      toast.success("Host activated");
      setBusy(null);
      invalidate();
      return;
    }
    if (outcome.kind === "busy") {
      setBusy({
        intent: "activate",
        continuation: outcome.continuation,
        message: outcome.message,
      });
      return;
    }
    hostUpdateAnalytics.onFailed(new Error(outcome.message));
    setBusy(null);
    toast.error(outcome.message);
  };

  const runApply = (force: boolean): void => {
    hostUpdateAnalytics.onStarted();
    applyStagedMutation.mutate(
      { trigger: "manual", force },
      { onSuccess: handleApplyOutcome },
    );
  };

  const runActivate = (force: boolean): void => {
    hostUpdateAnalytics.onStarted();
    activateInstalledMutation.mutate(
      { force },
      { onSuccess: handleActivateOutcome },
    );
  };

  const restartMutation = useMutation<void>({
    mutationKey: runnerMutationKeys.hostRestart(),
    mutationFn: () => {
      if (management === null) {
        return Promise.reject(new Error("Host management unavailable"));
      }
      return management.restartHost();
    },
    onSuccess: () => {
      toast.success("Host restart requested");
      setPendingRestart(false);
      if (management !== null) {
        void queryClient.invalidateQueries({
          queryKey: runnerQueryKeys.hostInstalledRecord(management),
        });
      }
      invalidate();
    },
    onError: (err) => {
      setPendingRestart(false);
      toastFromRunnerError(err, "Couldn't restart host");
    },
  });

  useEffect(() => {
    const tray = runnerHost.hostTray;
    if (tray === null) {
      return;
    }
    const subscription = tray.onCommand((command: HostTrayCommand) => {
      switch (command.kind) {
        case "openSettingsHost":
          Analytics.getInstance().track(AnalyticsEvent.CommandExecuted, {
            source: "system_tray",
            command: "open_settings",
          });
          void navigate({ to: "/settings/host" });
          return;
        case "restartHost":
          Analytics.getInstance().track(AnalyticsEvent.CommandExecuted, {
            source: "system_tray",
            command: "restart_host",
          });
          // Destructive: restart kills PTYs and in-flight RPC sessions.
          // Surface the confirmation modal before executing.
          setPendingRestart(true);
          return;
        case "openLogs":
          Analytics.getInstance().track(AnalyticsEvent.CommandExecuted, {
            source: "system_tray",
            command: "open_logs",
          });
          // Logs surface lives inside Settings → Host; navigate there and
          // also open the legacy logs dialog so the user gets the fastest
          // path to the tail regardless of which surface they prefer.
          void navigate({ to: "/settings/host" });
          openLogs();
          return;
        case "installUpdate":
          Analytics.getInstance().track(AnalyticsEvent.CommandExecuted, {
            source: "system_tray",
            command: "install_host_update",
          });
          // Destructive: installing an update restarts the host and kills
          // PTYs / in-flight RPC sessions. Preview the version that will be
          // installed before executing.
          setPendingInstallVersion(command.version);
          return;
      }
    });
    return () => {
      subscription.dispose();
    };
  }, [navigate, openLogs, runnerHost]);

  return (
    <>
      <RestartHostConfirmDialog
        open={pendingRestart}
        onOpenChange={(open) => {
          if (!open) setPendingRestart(false);
        }}
        isPending={restartMutation.isPending}
        onConfirm={() => restartMutation.mutate()}
      />
      <ConfirmDestructiveDialog
        open={pendingInstallVersion !== null}
        onOpenChange={(open) => {
          if (!open) setPendingInstallVersion(null);
        }}
        title="Install host update?"
        description={
          pendingInstallVersion === null
            ? "Installing will restart the host, ending any running terminal sessions and cancelling in-flight requests."
            : `Installing host v${pendingInstallVersion} will restart the host, ending any running terminal sessions and cancelling in-flight requests.`
        }
        cascadeSummary={null}
        actionLabel="Install update"
        isPending={
          applyStagedMutation.isPending || activateInstalledMutation.isPending
        }
        onConfirm={() => {
          // Update-over-debt priority: the same live status the banner/menu
          // derive their "Update to X" affordance from decides which intent
          // this confirm submits.
          if (status?.updateReady === true) {
            runApply(false);
          } else if (
            status?.activation === "pendingActivation" ||
            status?.activation === "activationUnknown"
          ) {
            runActivate(false);
          } else {
            setPendingInstallVersion(null);
            void refetchStatus({ cancelRefetch: true });
          }
        }}
      />
      <HostBusyForceDeferDialog
        open={busy !== null}
        message={busy?.message ?? ""}
        isForcing={
          applyStagedMutation.isPending || activateInstalledMutation.isPending
        }
        forceLabel={
          busy?.continuation === "activate" ? "Force restart" : "Force update"
        }
        onForce={() => {
          if (busy === null) return;
          if (busy.continuation === "activate") {
            runActivate(true);
            return;
          }
          if (busy.intent === "apply") {
            runApply(true);
          } else {
            runActivate(true);
          }
        }}
        onDefer={() => {
          setBusy(null);
        }}
      />
    </>
  );
}
