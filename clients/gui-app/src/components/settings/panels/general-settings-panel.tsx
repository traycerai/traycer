import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsGroup } from "@/components/settings/settings-group";
import { VoiceSettingsSection } from "@/components/settings/voice-settings-section";
import { PreventSleepSettingsSection } from "@/components/settings/prevent-sleep-settings-section";
import { WorktreeBranchPrefixSection } from "@/components/settings/worktree-branch-prefix-section";
import { PermissionsPicker } from "@/components/home/pickers/permissions-picker";
import { BrowserSettingsSection } from "@/components/settings/browser-settings-section";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { cn } from "@/lib/utils";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Switch } from "@/components/ui/switch";
import { runnerMutationKeys } from "@/lib/query-keys";
import { clearAllPersistedStores } from "@/lib/persist";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import type {
  DesktopJsonValue,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { trackSettingChanged, type AnalyticsSetting } from "@/lib/analytics";
import {
  GENERAL,
  MOD_ENTER_LABEL,
} from "@/components/settings/panels/general-settings.definitions";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { useRunnerFeatureSettingsQuery } from "@/hooks/runner/use-runner-feature-settings-query";
import { useRunnerAgentRolesSet } from "@/hooks/runner/use-runner-agent-roles-set-mutation";

function trackGeneralSetting(setting: AnalyticsSetting): void {
  trackSettingChanged("general", setting);
}

export function GeneralSettingsPanel() {
  const navigate = useNavigate();
  const restartOnboarding = useOnboardingStore((s) => s.restart);
  const defaultPermission = useSettingsStore((s) => s.defaultPermission);
  const setDefaultPermission = useSettingsStore((s) => s.setDefaultPermission);
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
  const steerOnModEnterEnabled = useSettingsStore(
    (s) => s.steerOnModEnterEnabled,
  );
  const setSteerOnModEnterEnabled = useSettingsStore(
    (s) => s.setSteerOnModEnterEnabled,
  );
  const compact = useSettingsDensity() === "compact";
  const featureSettings = useRunnerFeatureSettingsQuery();
  const setAgentRoles = useRunnerAgentRolesSet();
  const availability = useSettingsAvailabilityContext();
  const featureSettingsAvailable =
    GENERAL.definitions.experimental.availableWhen(availability);

  return (
    <SettingsPanelShell
      title="General"
      description="App behavior, agent activity, and local data controls."
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
        <SettingsGroup
          group={GENERAL.definitions.chatComposer}
          showTitle
          tone="default"
          dataTestId={undefined}
          fill={false}
        >
          <SettingsRow
            row={GENERAL.definitions.defaultPermission}
            control={
              <PermissionsPicker
                value={defaultPermission}
                disabled={false}
                onChange={(next) => {
                  trackGeneralSetting("defaultPermission");
                  setDefaultPermission(next);
                }}
                // No harness scope: the default is install-wide and every
                // option stays enabled. A provider that does not honour the
                // chosen mode narrows it in the composer, where a harness is
                // actually selected.
                supportedPermissionModes={null}
                harnessLabel={null}
                // Install-wide and harness-agnostic, so there is no catalog to
                // union, no turn to be mid-way through, and no one host whose
                // judge this row could name: all three stay at the values that
                // render exactly what this row rendered before them.
                catalogSupportedModes={null}
                turnActive={false}
                judgeBilling={null}
                closeFocus="trigger"
              />
            }
          />
          <VoiceSettingsSection />
          <SettingsRow
            row={GENERAL.definitions.quoteReply}
            control={
              <Switch
                checked={quoteReplyEnabled}
                onCheckedChange={(value) => {
                  trackGeneralSetting("quoteReplyEnabled");
                  setQuoteReplyEnabled(value);
                }}
                aria-label="Quote reply on text selection"
              />
            }
          />
          <SettingsRow
            row={GENERAL.definitions.steerOnModEnter}
            control={
              <Switch
                checked={steerOnModEnterEnabled}
                onCheckedChange={(value) => {
                  trackGeneralSetting("steerOnModEnterEnabled");
                  setSteerOnModEnterEnabled(value);
                }}
                aria-label={`Steer with ${MOD_ENTER_LABEL}`}
              />
            }
          />
          <SettingsRow
            row={GENERAL.definitions.pinContextUsage}
            control={
              <Switch
                checked={pinContextUsageBreakdown}
                onCheckedChange={(value) => {
                  trackGeneralSetting("pinContextUsageBreakdown");
                  setPinContextUsageBreakdown(value);
                }}
                aria-label="Pin context usage breakdown"
              />
            }
          />
        </SettingsGroup>

        <BrowserSettingsSection />

        <SettingsGroup
          group={GENERAL.definitions.runningAgents}
          showTitle
          tone="default"
          dataTestId={undefined}
          fill={false}
        >
          <PreventSleepSettingsSection />
          <SettingsRow
            row={GENERAL.definitions.globalResourcesButton}
            control={
              <Switch
                checked={showGlobalResourceMonitor}
                onCheckedChange={(value) => {
                  trackGeneralSetting("showGlobalResourceMonitor");
                  setShowGlobalResourceMonitor(value);
                }}
                aria-label="Show global resources button"
              />
            }
          />
          <SettingsRow
            row={GENERAL.definitions.navigatorResourceStats}
            control={
              <Switch
                checked={showNavigatorResourceStats}
                onCheckedChange={(value) => {
                  trackGeneralSetting("showNavigatorResourceStats");
                  setShowNavigatorResourceStats(value);
                }}
                aria-label="Show navigator resource stats"
              />
            }
          />
        </SettingsGroup>

        <SettingsGroup
          group={GENERAL.definitions.worktrees}
          showTitle
          tone="default"
          dataTestId={undefined}
          fill={false}
        >
          <WorktreeBranchPrefixSection />
        </SettingsGroup>

        {featureSettingsAvailable ? (
          <SettingsGroup
            group={GENERAL.definitions.experimental}
            showTitle
            tone="default"
            dataTestId={undefined}
            fill={false}
          >
            <SettingsRow
              row={GENERAL.definitions.agentRoles}
              status={
                featureSettings.isError
                  ? "Couldn't read feature settings. Repair ~/.traycer/cli/config.json, or back it up before resetting it, then reopen Settings."
                  : undefined
              }
              control={
                <Switch
                  checked={featureSettings.data?.agentRoles === true}
                  disabled={
                    featureSettings.data === undefined ||
                    setAgentRoles.isPending
                  }
                  onCheckedChange={(enabled) => {
                    setAgentRoles.mutate(enabled);
                  }}
                  aria-label="Agent roles"
                />
              }
            />
          </SettingsGroup>
        ) : null}

        {/* One row, and named for the SUBJECT rather than for itself: the
            tour is a window-level replay of onboarding, so it belongs on the
            app-wide page. Import and Data migration used to sit beside it and
            do not - each moves one machine's local data, and neither could
            name the machine from here. Both are now on that host's own
            Overview, under the sidebar's host picker. */}
        <SettingsGroup
          group={GENERAL.definitions.onboarding}
          showTitle
          tone="default"
          dataTestId={undefined}
          fill={false}
        >
          <SettingsRow
            row={GENERAL.definitions.productTour}
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
        </SettingsGroup>

        <DangerZoneSection />
      </div>
    </SettingsPanelShell>
  );
}

/**
 * App-global destruction only.
 *
 * This box used to hold three rows at three different scopes: "File Edit
 * Snapshots" (ONE MACHINE's data - and it carried its own host dropdown, so a
 * red button took its target from a control shaped like a form field),
 * "Remove Traycer" (THIS DEVICE's installation) and "Local app state" (THIS
 * APP). Only the last is app-global, so only it stays. The other two moved to
 * the machine's own page, where the page title already names the target.
 */
function DangerZoneSection() {
  return (
    <SettingsGroup
      group={GENERAL.definitions.dangerZone}
      showTitle
      tone="danger"
      dataTestId="settings-danger-zone"
      fill={false}
    >
      <SettingsLocalAppStateSection />
    </SettingsGroup>
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
        row={GENERAL.definitions.localAppState}
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
        blockedReason={null}
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
