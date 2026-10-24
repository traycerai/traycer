import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { GettingStartedCards } from "@/components/onboarding/getting-started-cards";
import { useGettingStartedChecklist } from "@/components/onboarding/getting-started-checklist";
import { GETTING_STARTED } from "./getting-started-settings.definitions";

export function GettingStartedSettingsPanel() {
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
