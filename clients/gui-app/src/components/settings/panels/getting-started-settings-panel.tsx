import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { GettingStartedCards } from "@/components/onboarding/getting-started-cards";
import { useGettingStartedChecklist } from "@/components/onboarding/getting-started-checklist";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";
import { GettingStartedGuidesSettingsPanel } from "./getting-started-guides-settings-panel";
import { GETTING_STARTED } from "./getting-started-settings.definitions";

/**
 * The Getting started page: the first steps, or in a build without
 * environments (`unreleased-features.ts`) the 1.5.1 guides.
 */
export function GettingStartedSettingsPanel() {
  return UNRELEASED_FEATURES_ENABLED ? (
    <FirstStepsSettingsPanel />
  ) : (
    <GettingStartedGuidesSettingsPanel />
  );
}

function FirstStepsSettingsPanel() {
  const { entries, complete, guideCount, allDone } =
    useGettingStartedChecklist();
  return (
    <SettingsPanelShell
      title={GETTING_STARTED.page.label}
      description={GETTING_STARTED.page.description}
      bodyClassName="overflow-visible rounded-none border-0 bg-transparent"
      headerAction={
        allDone ? null : (
          <span
            className="text-ui-xs tabular-nums text-muted-foreground"
            role="status"
          >
            {complete} of {guideCount} complete
          </span>
        )
      }
    >
      {allDone ? null : (
        <GettingStartedCards entries={entries} surface="settings" />
      )}
    </SettingsPanelShell>
  );
}
