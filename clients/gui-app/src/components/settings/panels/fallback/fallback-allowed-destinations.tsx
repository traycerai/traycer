import { type ReactNode } from "react";
import type { FallbackPolicy } from "@traycer/protocol/host/fallback-policy";
import { harnessLabel } from "@/components/settings/panels/fallback/fallback-harness-label";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup } from "@/components/settings/settings-group";
import { FALLBACK } from "@/components/settings/panels/fallback-settings.definitions";

/** Destination preferences never edit equivalence groups or source membership. */
export function FallbackAllowedDestinations(props: {
  readonly policy: FallbackPolicy;
  readonly onChange: (next: FallbackPolicy) => void;
  readonly status: ReactNode;
}): ReactNode {
  const { policy, onChange, status } = props;
  const members = [
    ...new Set(
      policy.tierGroups.flatMap((group) =>
        group.candidates.map((candidate) => candidate.harnessId),
      ),
    ),
  ];
  const exclusions = new Set(policy.destinationExclusions);
  // Retain controls for excluded providers even after their final model row is
  // removed, so the preference can still be cleared before adding a row again.
  const providers = [...new Set([...members, ...policy.destinationExclusions])];
  const allowed = members.filter((harnessId) => !exclusions.has(harnessId));
  return (
    <SettingsGroup
      group={FALLBACK.definitions.allowedDestinations}
      // The Destinations tab already names this; a title here would be a second
      // name for one checklist.
      showTitle={false}
      tone="default"
      fill={false}
      dataTestId="settings-fallback-destinations"
    >
      <fieldset className="min-w-0 space-y-3 px-5 py-4">
        <legend className="sr-only">Allowed destinations</legend>
        <p className="text-ui-sm">
          Can switch to:{" "}
          {allowed.length === 0 ? "none" : allowed.map(harnessLabel).join(", ")}
        </p>
        <p className="text-ui-sm text-muted-foreground">
          Destinations come from your model groups. Availability is checked when
          switching. Turning one off only stops Traycer switching to it - it
          stays a valid source, and its equivalent models stay in place.
        </p>
        {/* One switch per provider, ON meaning "may be switched to". These
            were checkboxes reading "Never switch to X", so the common state -
            this provider is allowed - was an UNCHECKED box next to the word
            "Never", and a reader had to resolve a double negative per row to
            learn what the summary line above already says plainly. A switch
            also matches what the control does: each one saves on the spot,
            which is what the rest of this page uses switches for. */}
        {providers.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">
            Nothing to allow or deny yet. Add equivalent models on the
            Equivalent models tab to offer a destination.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border/60">
            {providers.map((harnessId) => {
              const label = harnessLabel(harnessId);
              return (
                <div
                  key={harnessId}
                  className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2 last:border-b-0"
                >
                  <span className="min-w-0 truncate text-ui-sm">{label}</span>
                  <Switch
                    checked={!exclusions.has(harnessId)}
                    aria-label={`Allow switching to ${label}`}
                    onCheckedChange={(allowedNow) => {
                      onChange({
                        ...policy,
                        destinationExclusions: allowedNow
                          ? policy.destinationExclusions.filter(
                              (existing) => existing !== harnessId,
                            )
                          : [
                              ...new Set([
                                ...policy.destinationExclusions,
                                harnessId,
                              ]),
                            ],
                      });
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </fieldset>
      {status}
    </SettingsGroup>
  );
}
