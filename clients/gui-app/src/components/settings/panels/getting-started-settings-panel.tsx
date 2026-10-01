import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { GettingStartedCards } from "@/components/onboarding/getting-started-cards";
import {
  isPermanentlyUnavailable,
  UNAVAILABLE_ON_THIS_SHELL_NOTE,
  useGettingStartedChecklist,
} from "@/components/onboarding/getting-started-checklist";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { GETTING_STARTED } from "./getting-started-settings.definitions";

export function GettingStartedSettingsPanel() {
  const phone = useIsMobileViewport();
  const { entries, complete, guideCount } = useGettingStartedChecklist();
  // A guide the shell can never offer keeps its disabled card on a desktop
  // pane, which has room to say so. On a phone a full disabled card is the
  // largest thing on the screen saying the least, so it collapses to a
  // footnote; a reason the user can leave ("Connect a host") keeps its card.
  const footnoted = phone ? entries.filter(isPermanentlyUnavailable) : [];
  const visible = entries.filter((entry) => !footnoted.includes(entry));
  return (
    <SettingsPanelShell
      title={GETTING_STARTED.page.label}
      description={GETTING_STARTED.page.description}
      bodyClassName="overflow-visible rounded-none border-0 bg-transparent"
      headerAction={
        <span
          className="text-ui-xs tabular-nums text-muted-foreground"
          role="status"
        >
          {complete} of {guideCount} complete
        </span>
      }
    >
      <GettingStartedCards entries={visible} surface="settings" />
      {/* One line, not a card each: these guides cannot run on this shell at
          all, and a phone has room for the guides it CAN offer. Named rather
          than counted, so the user can tell which one they are missing, and
          plain text rather than a disabled control, because there is nothing
          here to press. */}
      {footnoted.length > 0 ? (
        <p
          data-testid="getting-started-unavailable-note"
          className="mt-4 text-ui-xs text-muted-foreground"
        >
          {footnoted.map(({ card }) => card.row.label).join(", ")}:{" "}
          {UNAVAILABLE_ON_THIS_SHELL_NOTE}.
        </p>
      ) : null}
    </SettingsPanelShell>
  );
}
