import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { ProviderJudgeSwitch } from "@/components/settings/panels/permissions/provider-judge-switch";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/**
 * The body of a provider's Permissions tab: who reviews this provider's
 * commands in Auto mode, through `ProviderJudgeSwitch`, whose only home this
 * is, followed by one link to the Permissions page's Judge tab.
 *
 * The switch is the only per-provider fact here. Which model Traycer's judge
 * runs on and the rules it follows are one machine's and one account's, not a
 * provider's, so they live on the Permissions page and this links there.
 */
export function ProviderAutoJudgeSection({
  state,
}: {
  readonly state: ProviderCliState;
}) {
  const { openSettings } = useSystemTabModalActions();
  const providerName = PROVIDER_DISPLAY_NAMES[state.providerId];
  return (
    <div className="mt-3 flex flex-col items-start gap-2 rounded-lg border border-border/60 p-3">
      <p className="text-ui-sm font-medium text-foreground">
        Who reviews {providerName}&apos;s commands
      </p>
      <div className="w-full">
        <ProviderJudgeSwitch state={state} />
      </div>
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        data-testid="provider-auto-judge-all-settings"
        onClick={() =>
          openSettings({
            section: "permissions",
            resetToGeneral: false,
            tab: "judge",
            draft: null,
            // Settings is already scoped to the machine this tab shows.
            hostId: null,
          })
        }
      >
        All permission settings
      </Button>
    </div>
  );
}
