import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  HostInstallResult,
  HostTrayCommand,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { RestartHostConfirmDialog } from "@/components/host/restart-host-confirm-dialog";
import {
  Analytics,
  AnalyticsEvent,
  hostUpdateAnalyticsCallbacks,
} from "@/lib/analytics";

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
 *                          will be installed), then invoke
 *                          hostManagement.installHost() against the
 *                          registry-known version with toast feedback.
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
  const service = runnerHost.service;
  const [pendingRestart, setPendingRestart] = useState<boolean>(false);
  const [pendingInstallVersion, setPendingInstallVersion] = useState<
    string | null
  >(null);
  const hostUpdateAnalytics = hostUpdateAnalyticsCallbacks("system_tray");

  const invalidate = (): void => {
    if (management === null) return;
    if (service !== null) {
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.serviceStatus(service),
      });
    }
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
      // Belt-and-braces: the dialog already closed optimistically at
      // confirm time, but this guarantees the open flag can never survive
      // settlement even if something else set it in between.
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

  const installMutation = useMutation<HostInstallResult, Error, string>({
    mutationKey: runnerMutationKeys.hostInstall(),
    mutationFn: (version) => {
      if (management === null) {
        return Promise.reject(new Error("Host management unavailable"));
      }
      return management.installHost({ version, onProgress: null });
    },
    onMutate: () => {
      hostUpdateAnalytics.onStarted();
    },
    onSuccess: (data) => {
      hostUpdateAnalytics.onSucceeded();
      toast.success(`Installed host v${data.version}`);
      setPendingInstallVersion(null);
      if (management !== null) {
        void queryClient.invalidateQueries({
          queryKey: runnerQueryKeys.hostInstalledRecord(management),
        });
      }
      invalidate();
    },
    onError: (err) => {
      hostUpdateAnalytics.onFailed(err);
      setPendingInstallVersion(null);
      toastFromRunnerError(err, "Couldn't install host update");
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
          // A restart already in flight (from this or an earlier confirm)
          // must not reopen the dialog - it would mount with
          // `isPending=true`, which locks Cancel/Esc for the rest of that
          // mutation's lifetime (the exact lockout this fix removed).
          // Read the mutation cache directly (not a ref synced from
          // `restartMutation.isPending`) - `isMutating` reflects `mutate()`
          // the instant it's called, synchronously, with no render/effect
          // delay for a queued native command to slip through.
          if (
            queryClient.isMutating({
              mutationKey: runnerMutationKeys.hostRestart(),
            }) > 0
          ) {
            return;
          }
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
  }, [navigate, openLogs, runnerHost, queryClient]);

  return (
    <>
      <RestartHostConfirmDialog
        open={pendingRestart}
        onOpenChange={(open) => {
          if (!open) setPendingRestart(false);
        }}
        isPending={restartMutation.isPending}
        onConfirm={() => {
          // Close optimistically - see host-settings-panel.tsx for why. This
          // listener also lives inside HostReadyGate and can unmount
          // mid-restart (the gate swaps to "Setting up Traycer Host…" once
          // the snapshot goes null), which would otherwise discard this
          // mutation's onSuccess/onError toasts - closing eagerly means the
          // dialog never depends on those callbacks firing.
          setPendingRestart(false);
          restartMutation.mutate();
        }}
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
        isPending={installMutation.isPending}
        onConfirm={() => {
          if (pendingInstallVersion !== null) {
            installMutation.mutate(pendingInstallVersion);
          }
        }}
      />
    </>
  );
}
