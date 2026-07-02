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
    onSuccess: (data) => {
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
          void navigate({ to: "/settings/host" });
          return;
        case "restartHost":
          // Destructive: restart kills PTYs and in-flight RPC sessions.
          // Surface the confirmation modal before executing.
          setPendingRestart(true);
          return;
        case "openLogs":
          // Logs surface lives inside Settings → Host; navigate there and
          // also open the legacy logs dialog so the user gets the fastest
          // path to the tail regardless of which surface they prefer.
          void navigate({ to: "/settings/host" });
          openLogs();
          return;
        case "installUpdate":
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
