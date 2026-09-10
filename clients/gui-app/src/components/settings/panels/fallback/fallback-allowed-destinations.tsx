import { type ReactNode } from "react";
import type { FallbackPolicy } from "@traycer/protocol/host/fallback-policy";
import { harnessLabel } from "@/components/settings/panels/fallback/fallback-harness-label";
import { Checkbox } from "@/components/ui/checkbox";
import { SettingsGroup } from "@/components/settings/settings-group";

/** Destination preferences never edit equivalence groups or source membership. */
export function FallbackAllowedDestinations(props: {
  readonly policy: FallbackPolicy;
  readonly onChange: (next: FallbackPolicy) => void;
}): ReactNode {
  const { policy, onChange } = props;
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
      title="Allowed destinations"
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
          switching. Excluded providers remain valid sources; their equivalent
          models stay in place.
        </p>
        {providers.map((harnessId) => (
          <label key={harnessId} className="flex items-center gap-2 text-ui-sm">
            <Checkbox
              checked={exclusions.has(harnessId)}
              onCheckedChange={(checked) => {
                onChange({
                  ...policy,
                  destinationExclusions:
                    checked === true
                      ? [
                          ...new Set([
                            ...policy.destinationExclusions,
                            harnessId,
                          ]),
                        ]
                      : policy.destinationExclusions.filter(
                          (existing) => existing !== harnessId,
                        ),
                });
              }}
            />
            <span>Never switch to {harnessLabel(harnessId)}</span>
          </label>
        ))}
        {providers.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">
            Add equivalent models below to offer a destination.
          </p>
        ) : null}
      </fieldset>
    </SettingsGroup>
  );
}
