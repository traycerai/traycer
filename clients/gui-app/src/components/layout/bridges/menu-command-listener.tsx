import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  HostInstallResult,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import type { AuthService } from "@/lib/auth/auth-service";
import { useCloseTabFlow } from "@/components/layout/dialogs/use-close-tab-flow";
import { useAuthService } from "@/lib/host";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { resolveDesktopMenuBridge } from "@/lib/windows/desktop-capabilities";
import type {
  DesktopMenuCommandId,
  DesktopMenuCommandPayload,
} from "@/lib/windows/types";
import {
  advanceActiveTileFind,
  openActiveTileFind,
} from "@/lib/commands/tile-find";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { RestartHostConfirmDialog } from "@/components/host/restart-host-confirm-dialog";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
} from "@/lib/analytics";

interface HostWithRequestClose extends IRunnerHost {
  readonly windows: {
    requestClose(windowId: string): Promise<void>;
  };
}

interface HostWithRequestNew extends IRunnerHost {
  readonly windows: {
    requestNew(initialRoute: string | null): Promise<void>;
  };
}

function hostHasRequestClose(host: IRunnerHost): host is HostWithRequestClose {
  if (!("windows" in host)) return false;
  const windows: unknown = host.windows;
  return (
    windows !== null &&
    typeof windows === "object" &&
    "requestClose" in windows &&
    typeof (windows as Record<string, unknown>).requestClose === "function"
  );
}

function hostHasRequestNew(host: IRunnerHost): host is HostWithRequestNew {
  if (!("windows" in host)) return false;
  const windows: unknown = host.windows;
  return (
    windows !== null &&
    typeof windows === "object" &&
    "requestNew" in windows &&
    typeof (windows as Record<string, unknown>).requestNew === "function"
  );
}

/**
 * Routes native menu commands to renderer-owned actions. Mounted at the router
 * root (`RootComponent`), OUTSIDE the page's `HostReadyGate`, so menu commands
 * keep working while the host is still being set up (the gate replaces only the
 * page, not the root-route bridges).
 */
export function MenuCommandListener() {
  const runnerHost = useRunnerHost();
  const authService = useAuthService();
  const navigate = useNavigate();
  const closeTabFlow = useCloseTabFlow();
  const queryClient = useQueryClient();
  const openAboutDetails = useDesktopDialogStore(
    (state) => state.openAboutDetails,
  );
  const openLogs = useDesktopDialogStore((state) => state.openLogs);
  const openEpicInNewWindow = useDesktopDialogStore(
    (state) => state.openEpicInNewWindow,
  );
  const management = runnerHost.hostManagement;
  const service = runnerHost.service;
  const traycerCli = runnerHost.traycerCli;
  const [pendingHostRestart, setPendingHostRestart] = useState<boolean>(false);

  const restartHostMutation = useMutation<void>({
    mutationKey: runnerMutationKeys.requestHostRespawn(),
    mutationFn: () => runnerHost.requestHostRespawn(),
    onSuccess: () => {
      toast.success("Host restart requested");
      // Belt-and-braces: the dialog already closed optimistically at
      // confirm time, but this guarantees the open flag can never survive
      // settlement even if something else set it in between.
      setPendingHostRestart(false);
      if (traycerCli !== null) {
        void queryClient.invalidateQueries({
          queryKey: runnerQueryKeys.traycerHostStatus(traycerCli),
        });
      }
    },
    onError: (err) => {
      setPendingHostRestart(false);
      toastFromRunnerError(err, "Couldn't restart host");
    },
  });

  const installUpdateMutation = useMutation<HostInstallResult>({
    mutationKey: runnerMutationKeys.hostUpdate(),
    mutationFn: () => {
      if (management === null) {
        return Promise.reject(new Error("Host management unavailable"));
      }
      return management.updateHost({ onProgress: null });
    },
    onMutate: () => {
      Analytics.getInstance().track(AnalyticsEvent.HostUpdateStarted, {
        source: "native_menu",
      });
    },
    onSuccess: (data) => {
      Analytics.getInstance().track(AnalyticsEvent.HostUpdateSucceeded, null);
      toast.success(`Updated host to v${data.version}`);
      if (management !== null) {
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
      }
    },
    onError: (err) => {
      Analytics.getInstance().track(AnalyticsEvent.HostUpdateFailed, {
        blocker: analyticsBlockerFromError(err),
      });
      toastFromRunnerError(err, "Couldn't install host update");
    },
  });

  const { mutate: mutateInstallUpdate } = installUpdateMutation;
  useEffect(() => {
    const menu = resolveDesktopMenuBridge(runnerHost);
    if (menu === null) {
      return;
    }
    const subscription = menu.onCommand((payload) => {
      handleMenuCommand(payload, {
        authService,
        navigateSettings: () => {
          void navigate({ to: "/settings/general" });
        },
        openAboutDetails,
        closeActiveTab: closeTabFlow.closeActiveTab,
        openEpicInNewWindow,
        openLogs,
        requestCloseWindow: (windowId) => {
          if (hostHasRequestClose(runnerHost)) {
            void runnerHost.windows.requestClose(windowId);
          }
        },
        requestNewWindow: () => {
          if (hostHasRequestNew(runnerHost)) {
            void runnerHost.windows.requestNew(null);
          }
        },
        openFindBar: () => {
          openActiveTileFind();
        },
        advanceFind: (forward) => {
          advanceActiveTileFind(forward ? 1 : -1);
        },
        installHostUpdate: () => {
          mutateInstallUpdate();
        },
        requestHostRestart: () => {
          // A restart already in flight (from this or an earlier confirm)
          // must not reopen the dialog - it would mount with
          // `isPending=true`, which locks Cancel/Esc for the rest of that
          // mutation's lifetime (the exact lockout this fix removed). Read
          // the mutation cache directly (not a ref synced from
          // `restartHostMutation.isPending`) - `isMutating` reflects
          // `mutate()` the instant it's called, synchronously, with no
          // render/effect delay for a queued native command to slip through.
          if (
            queryClient.isMutating({
              mutationKey: runnerMutationKeys.requestHostRespawn(),
            }) > 0
          ) {
            return;
          }
          setPendingHostRestart(true);
        },
        reportIssue: () => {
          const state = useDesktopDialogStore.getState();
          if (!state.reportIssueAvailable) return;
          state.openReportIssue();
        },
      });
    });
    return () => {
      subscription.dispose();
    };
  }, [
    authService,
    navigate,
    openAboutDetails,
    closeTabFlow.closeActiveTab,
    openEpicInNewWindow,
    openLogs,
    runnerHost,
    mutateInstallUpdate,
    queryClient,
  ]);

  return (
    <>
      {closeTabFlow.unsyncedDialog}
      <RestartHostConfirmDialog
        open={pendingHostRestart}
        onOpenChange={(open) => {
          if (!open) setPendingHostRestart(false);
        }}
        isPending={restartHostMutation.isPending}
        onConfirm={() => {
          // Close optimistically - see host-settings-panel.tsx for why. This
          // surface's mutation can legitimately run up to ~180s with zero
          // progress feedback, which is what made the un-dismissable dialog
          // read as "stuck forever" in the field.
          setPendingHostRestart(false);
          restartHostMutation.mutate();
        }}
      />
    </>
  );
}

interface MenuCommandHandlers {
  readonly authService: AuthService;
  readonly closeActiveTab: () => void;
  readonly navigateSettings: () => void;
  readonly openAboutDetails: () => void;
  readonly openEpicInNewWindow: () => void;
  readonly openLogs: () => void;
  readonly requestCloseWindow: (windowId: string) => void;
  readonly requestNewWindow: () => void;
  readonly openFindBar: () => void;
  readonly advanceFind: (forward: boolean) => void;
  readonly installHostUpdate: () => void;
  readonly requestHostRestart: () => void;
  readonly reportIssue: () => void;
}

const ADVANCE_FIND_DIRECTIONS: Partial<Record<DesktopMenuCommandId, boolean>> =
  {
    "view.findNext": true,
    "view.findPrevious": false,
  };

function handleMenuCommand(
  payload: DesktopMenuCommandPayload,
  handlers: MenuCommandHandlers,
): void {
  if (payload.command === "app.openSettings") {
    Analytics.getInstance().track(AnalyticsEvent.SettingsOpened, {
      source: "native_menu",
      section: "general",
    });
    handlers.navigateSettings();
    return;
  }
  if (payload.command === "app.signIn") {
    Analytics.getInstance().track(AnalyticsEvent.SignInStarted, {
      source: "native_menu",
    });
    void handlers.authService.signIn();
    return;
  }
  if (payload.command === "app.signOut") {
    Analytics.getInstance().track(AnalyticsEvent.SignOutRequested, {
      source: "native_menu",
    });
    void handlers.authService.signOut();
    return;
  }
  if (payload.command === "app.openLogs") {
    Analytics.getInstance().track(AnalyticsEvent.CommandExecuted, {
      source: "native_menu",
      command: "open_logs",
    });
    handlers.openLogs();
    return;
  }
  if (payload.command === "epic.openInNewWindow") {
    handlers.openEpicInNewWindow();
    return;
  }
  if (payload.command === "epic.closeTab") {
    handlers.closeActiveTab();
    return;
  }
  if (payload.command === "app.aboutDetails") {
    handlers.openAboutDetails();
    return;
  }
  if (payload.command === "app.reportIssue") {
    Analytics.getInstance().track(AnalyticsEvent.ReportIssueOpened, {
      source: "native_menu",
    });
    handlers.reportIssue();
    return;
  }
  if (payload.command === "host.installUpdate") {
    Analytics.getInstance().track(AnalyticsEvent.CommandExecuted, {
      source: "native_menu",
      command: "install_host_update",
    });
    handlers.installHostUpdate();
    return;
  }
  if (payload.command === "host.restart") {
    Analytics.getInstance().track(AnalyticsEvent.CommandExecuted, {
      source: "native_menu",
      command: "restart_host",
    });
    handlers.requestHostRestart();
    return;
  }
  if (payload.command === "window.closeWindow") {
    handlers.requestCloseWindow(payload.windowId);
    return;
  }
  if (payload.command === "epic.newWindow") {
    handlers.requestNewWindow();
    return;
  }
  if (payload.command === "view.findInPage") {
    handlers.openFindBar();
    return;
  }
  const forward = ADVANCE_FIND_DIRECTIONS[payload.command];
  if (forward !== undefined) {
    handlers.advanceFind(forward);
  }
}
