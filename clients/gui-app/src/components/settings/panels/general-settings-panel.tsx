import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { VoiceSettingsSection } from "@/components/settings/voice-settings-section";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Switch } from "@/components/ui/switch";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useRunnerUninstallTraycer } from "@/hooks/runner/use-runner-uninstall-traycer-mutation";
import { requestAppQuit } from "@/lib/desktop-app-lifecycle";
import { useHostQuery, useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  hostQueryKeys,
  runnerMutationKeys,
  snapshotsMutationKeys,
} from "@/lib/query-keys";
import { clearAllPersistedStores } from "@/lib/persist";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import type {
  DesktopJsonValue,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import { toastFromHostError } from "@/lib/host-error-toast";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import {
  epicsSeen,
  taskChainsSeen,
  useMigrationRunStore,
  type MigrationRunState,
} from "@/stores/migration/migration-run-store";
import { startMigrationRun } from "@/components/migration/migration-run-handle";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLocalSnapshotClearStore } from "@/stores/settings/local-snapshot-clear-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";

const MIGRATION_PROGRESS_LABEL = "Migrating tasks";
const SNAPSHOTS_LOCAL_STORAGE_PARAMS = {};

interface ClearLocalSnapshotsMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

function formatMigrationProgress(state: MigrationRunState): string | null {
  if (state.status !== "running") return null;
  if (state.totals === null) return MIGRATION_PROGRESS_LABEL;
  const { totalTaskChains, totalLocalEpics } = state.totals;
  const tasks = `${taskChainsSeen(state.counts)}/${totalTaskChains}`;
  const epics = `${epicsSeen(state.counts)}/${totalLocalEpics}`;
  return `${MIGRATION_PROGRESS_LABEL} - tasks ${tasks}, epics ${epics}`;
}

export function GeneralSettingsPanel() {
  const navigate = useNavigate();
  const restartOnboarding = useOnboardingStore((s) => s.restart);
  const migrationState = useMigrationRunStore(
    useShallow((s) => ({
      status: s.status,
      totals: s.totals,
      counts: s.counts,
      finalSuccess: s.finalSuccess,
      remoteRunning: s.remoteRunning,
    })),
  );
  const migrationProgressLabel = formatMigrationProgress(migrationState);
  const migrationIsRunning =
    migrationState.status === "running" || migrationState.remoteRunning;
  const preventSleepWhileRunning = useSettingsStore(
    (s) => s.preventSleepWhileRunning,
  );
  const setPreventSleepWhileRunning = useSettingsStore(
    (s) => s.setPreventSleepWhileRunning,
  );
  const notifyOnChatTurnComplete = useSettingsStore(
    (s) => s.notifyOnChatTurnComplete,
  );
  const setNotifyOnChatTurnComplete = useSettingsStore(
    (s) => s.setNotifyOnChatTurnComplete,
  );
  const showGlobalResourceMonitor = useSettingsStore(
    (s) => s.showGlobalResourceMonitor,
  );
  const setShowGlobalResourceMonitor = useSettingsStore(
    (s) => s.setShowGlobalResourceMonitor,
  );
  const showNavigatorResourceStats = useSettingsStore(
    (s) => s.showNavigatorResourceStats,
  );
  const setShowNavigatorResourceStats = useSettingsStore(
    (s) => s.setShowNavigatorResourceStats,
  );
  const pinContextUsageBreakdown = useSettingsStore(
    (s) => s.pinContextUsageBreakdown,
  );
  const setPinContextUsageBreakdown = useSettingsStore(
    (s) => s.setPinContextUsageBreakdown,
  );
  const quoteReplyEnabled = useSettingsStore((s) => s.quoteReplyEnabled);
  const setQuoteReplyEnabled = useSettingsStore((s) => s.setQuoteReplyEnabled);

  return (
    <SettingsPanelShell title="General">
      <SettingsRow
        label="Notify on chat turn completion"
        description="Show a system notification when an agent finishes responding and Traycer isn't focused."
        control={
          <Switch
            checked={notifyOnChatTurnComplete}
            onCheckedChange={setNotifyOnChatTurnComplete}
            aria-label="Notify on chat turn completion"
          />
        }
      />
      <SettingsRow
        label="Prevent sleep while running"
        description="Keep the computer awake while a chat or terminal agent is running, so work continues when you step away."
        control={
          <Switch
            checked={preventSleepWhileRunning}
            onCheckedChange={setPreventSleepWhileRunning}
            aria-label="Prevent sleep while running"
          />
        }
      />
      <SettingsRow
        label="Show global resources button"
        description="Show the app-wide resource monitor in the header."
        control={
          <Switch
            checked={showGlobalResourceMonitor}
            onCheckedChange={setShowGlobalResourceMonitor}
            aria-label="Show global resources button"
          />
        }
      />
      <SettingsRow
        label="Show navigator resource stats"
        description="Show compact live CPU and memory chips in task navigator rows."
        control={
          <Switch
            checked={showNavigatorResourceStats}
            onCheckedChange={setShowNavigatorResourceStats}
            aria-label="Show navigator resource stats"
          />
        }
      />
      <SettingsRow
        label="Pin context usage breakdown"
        description="Keep the context window breakdown visible near the chat composer when usage data is available."
        control={
          <Switch
            checked={pinContextUsageBreakdown}
            onCheckedChange={setPinContextUsageBreakdown}
            aria-label="Pin context usage breakdown"
          />
        }
      />
      <SettingsRow
        label="Quote reply on text selection"
        description="Selecting assistant text shows a quote button that inserts the selection into the composer."
        control={
          <Switch
            checked={quoteReplyEnabled}
            onCheckedChange={setQuoteReplyEnabled}
            aria-label="Quote reply on text selection"
          />
        }
      />
      <VoiceSettingsSection />
      <SettingsRow
        label="Data migration"
        description={
          migrationProgressLabel ??
          "Retry moving local SQLite tasks and epics to cloud."
        }
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={migrationIsRunning}
            data-testid="settings-reattempt-migration"
            onClick={() => {
              startMigrationRun();
            }}
          >
            {migrationIsRunning ? (
              <AgentSpinningDots
                className="text-muted-foreground"
                testId="settings-reattempt-migration-spinner"
                variant={undefined}
              />
            ) : null}
            Re-attempt migration
          </Button>
        }
      />
      <SettingsRow
        label="Product tour"
        description="Replay the first-launch onboarding tour."
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="settings-replay-onboarding"
            onClick={() => {
              restartOnboarding();
              void navigate({
                to: "/onboarding",
                search: { replay: true },
              });
            }}
          >
            Replay tour
          </Button>
        }
      />
      <DangerZoneSection />
    </SettingsPanelShell>
  );
}

// Destructive local actions live inline so the settings panel keeps one
// rounded outer border while each action still reads as its own row.
function DangerZoneSection() {
  const { hostManagement } = useRunnerHost();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const uninstall = useRunnerUninstallTraycer();

  return (
    <>
      <section className="bg-destructive/5" data-testid="settings-danger-zone">
        <div className="border-b border-border/40 px-5 py-4">
          <h2 className="text-ui font-semibold text-foreground">Danger Zone</h2>
        </div>
        <SettingsFileEditSnapshotsSection />
        <SettingsLocalAppStateSection />
        {hostManagement === null ? null : (
          <RemoveTraycerDangerRow
            isPending={uninstall.isPending}
            isSuccess={uninstall.isSuccess}
            onRemove={() => {
              setConfirmOpen(true);
            }}
          />
        )}
      </section>
      {hostManagement === null ? null : (
        <ConfirmDestructiveDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Remove Traycer from this device?"
          description="This stops and removes Traycer's background host and services and won't reinstall them automatically. Your chats, history, and credentials stay on this device - you can reinstall anytime from Settings."
          cascadeSummary={null}
          actionLabel="Remove Traycer"
          isPending={uninstall.isPending}
          onConfirm={() => {
            uninstall.mutate(undefined, {
              onSuccess: () => {
                setConfirmOpen(false);
              },
            });
          }}
        />
      )}
    </>
  );
}

function RemoveTraycerDangerRow(props: {
  readonly isPending: boolean;
  readonly isSuccess: boolean;
  readonly onRemove: () => void;
}) {
  const { isPending, isSuccess, onRemove } = props;

  if (isSuccess) {
    return (
      <SettingsRow
        label="Traycer removed"
        description="Background components were removed. Your chats, history, and credentials are preserved on this device. To finish, quit Traycer and drag it from Applications to the Trash."
        control={
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="settings-quit-after-uninstall"
            onClick={() => {
              requestAppQuit();
            }}
          >
            Quit Traycer
          </Button>
        }
      />
    );
  }

  return (
    <SettingsRow
      label="Remove Traycer"
      description="Stops the background host and services and removes the installed components from this device. Your chats and history are preserved, and the host won't reinstall itself."
      control={
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={isPending}
          data-testid="settings-remove-traycer"
          onClick={onRemove}
        >
          {isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId="settings-remove-traycer-spinner"
              variant={undefined}
            />
          ) : null}
          Remove Traycer
        </Button>
      }
    />
  );
}

function SettingsFileEditSnapshotsSection() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const client = useHostClient();
  const queryClient = useQueryClient();
  const currentUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? state.profile?.userId ?? null,
  );
  const storageSizeQuery = useHostQuery<
    HostRpcRegistry,
    "snapshots.getLocalStorageSize"
  >({
    client,
    method: "snapshots.getLocalStorageSize",
    params: SNAPSHOTS_LOCAL_STORAGE_PARAMS,
    options: null,
  });
  const clearSnapshotsMutation = useHostMutation<
    HostRpcRegistry,
    "snapshots.clearLocalSnapshots",
    ClearLocalSnapshotsMutationContext
  >({
    client,
    method: "snapshots.clearLocalSnapshots",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: snapshotsMutationKeys.clearLocalSnapshots(),
      onMutate: () => ({
        hostId: client.getActiveHostId(),
        userId: currentUserId,
      }),
      onSuccess: (result, _variables, context) => {
        if (context.hostId !== null) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.method<
              HostRpcRegistry,
              "snapshots.getLocalStorageSize"
            >(
              context.hostId,
              "snapshots.getLocalStorageSize",
              SNAPSHOTS_LOCAL_STORAGE_PARAMS,
            ),
          });
        }
        if (context.hostId !== null && context.userId !== null) {
          useLocalSnapshotClearStore
            .getState()
            .markCleared(context.userId, context.hostId, Date.now());
        }
        setConfirmOpen(false);
        toast.success("Cleared file edit snapshots", {
          description: `${formatSnapshotBytes(result.clearedBytes)} removed.`,
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't clear file edit snapshots."),
    },
  });

  return (
    <>
      <SettingsRow
        label="File Edit Snapshots"
        description="Pre-edit file snapshots for Undo and cached long plan content on this device. This data stays local and is not synced."
        control={
          <div className="flex flex-col items-end gap-2">
            <div
              className="font-mono text-code-xs text-muted-foreground"
              data-testid="settings-local-snapshots-size"
            >
              <SnapshotsSize query={storageSizeQuery} />
            </div>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={clearSnapshotsMutation.isPending}
              data-testid="settings-clear-file-edit-snapshots"
              onClick={() => {
                setConfirmOpen(true);
              }}
            >
              {clearSnapshotsMutation.isPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId="settings-clear-file-edit-snapshots-spinner"
                  variant={undefined}
                />
              ) : null}
              Clear file edit snapshots
            </Button>
          </div>
        }
      />
      <ConfirmDestructiveDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Clear file edit snapshots?"
        description="Cleared snapshots cannot be restored. Existing chat history and checkpoint records remain visible, but Undo will be disabled for your past turns on this device."
        cascadeSummary={null}
        actionLabel="Clear file edit snapshots"
        isPending={clearSnapshotsMutation.isPending}
        onConfirm={() => {
          clearSnapshotsMutation.mutate(SNAPSHOTS_LOCAL_STORAGE_PARAMS);
        }}
      />
    </>
  );
}

// Resolve the host-side per-window clear for "Clear local app state":
//   - desktop bridge with the `clear` RPC: use it directly (authoritative).
//   - desktop bridge WITHOUT `clear` (older preload): degrade through the
//     always-present `get` + `update` RPCs. Wiping browser storage alone leaves
//     the host-owned per-window snapshot intact, so the tab strip / canvases /
//     drafts would come back after reload. The fallback empties tabs + drafts
//     and deletes every existing canvas entry by sending `null` for each key
//     (the host `update` merge treats `canvasByTabId[key] = null` as deletion).
//   - no bridge (true web mode): null, so the util stays storage-only.
function resolvePerWindowHostClear(
  bridge: DesktopWindowsBridge | null,
): (() => Promise<void>) | null {
  const perWindowState = bridge?.perWindowState ?? null;
  if (perWindowState === null) return null;
  if (typeof perWindowState.clear === "function") {
    return perWindowState.clear.bind(perWindowState);
  }
  return async () => {
    const snapshot = await perWindowState.get();
    const canvasByTabId: Record<string, DesktopJsonValue> = Object.fromEntries(
      Object.keys(snapshot.canvasByTabId).map(
        (key): [string, DesktopJsonValue] => [key, null],
      ),
    );
    await perWindowState.update({
      epicTabs: [],
      activeTabId: null,
      canvasByTabId,
      landingDrafts: [],
      activeLandingDraftId: null,
    });
  };
}

function SettingsLocalAppStateSection() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const bridge = useWindowsBridge();

  // Routed through `useMutation` (mirrors the sibling `clearSnapshotsMutation`):
  // `isPending` drives the UI and `onError` resets the dialog + toasts, so a
  // failed host `clear` RPC can't leave the dialog stuck. The windows bridge is
  // `IRunnerHost`, so this uses a bare mutation + `toastFromRunnerError`.
  const clearLocalAppStateMutation = useMutation({
    mutationKey: runnerMutationKeys.clearAllLocalData(),
    mutationFn: () =>
      clearAllPersistedStores({ hostClear: resolvePerWindowHostClear(bridge) }),
    // On success the util reloads the page (its last step), so there is no
    // onSuccess work to do. On failure, close the dialog and surface the error
    // so the user isn't stuck on a spinning confirm.
    onError: (error) => {
      setConfirmOpen(false);
      toastFromRunnerError(error, "Couldn't clear local app state.");
    },
  });

  return (
    <>
      <SettingsRow
        label="Local app state"
        description="Reset this device's app state - open tabs, layout, drafts, settings, and view preferences - then reload. You stay signed in. File edit snapshots are cleared separately above."
        control={
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={clearLocalAppStateMutation.isPending}
            data-testid="settings-clear-local-app-state"
            onClick={() => {
              setConfirmOpen(true);
            }}
          >
            {clearLocalAppStateMutation.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId="settings-clear-local-app-state-spinner"
                variant={undefined}
              />
            ) : null}
            Clear local app state
          </Button>
        }
      />
      <ConfirmDestructiveDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Clear local app state?"
        description="This resets app state on this device - open tabs, layout, drafts, settings, and view preferences - then reloads. It can't be undone. You'll stay signed in."
        cascadeSummary={null}
        actionLabel="Clear local app state"
        isPending={clearLocalAppStateMutation.isPending}
        onConfirm={() => {
          clearLocalAppStateMutation.mutate();
        }}
      />
    </>
  );
}

function SnapshotsSize(props: {
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data: { readonly bytes: number } | undefined;
  };
}) {
  const { query } = props;
  if (query.isPending) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <AgentSpinningDots
          className="text-muted-foreground"
          testId="settings-local-snapshots-size-spinner"
          variant={undefined}
        />
        Calculating
      </span>
    );
  }
  if (query.isError) return "Unavailable";
  return formatSnapshotBytes(query.data?.bytes ?? 0);
}

function formatSnapshotBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  const precision =
    exponent === 0 || value >= 10 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(precision)} ${units[exponent] ?? "TB"}`;
}
