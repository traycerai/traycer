import { useEffect } from "react";
import { useSandboxConfigurations } from "@/hooks/sandboxes/use-sandbox-configurations";
import type { SandboxPageConfiguration } from "@/lib/sandboxes/sandbox-row-lines";
import {
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  clearRequestedSandboxesConfiguration,
  useSandboxesPageStore,
  type SandboxesPageConfigurationId,
} from "@/stores/sandboxes/sandboxes-page-store";

/** The group's pick for a configuration, or `null` until its team's environment is known. */
function environmentPickFor(
  configuration: SandboxesPageConfigurationId,
  configurations: readonly SandboxPageConfiguration[],
): EnvironmentPick | null {
  if (configuration.kind === "personal") return PERSONAL_PICK;
  const team = configurations.find(
    (candidate) =>
      candidate.kind === "team" && candidate.teamId === configuration.teamId,
  );
  if (team === undefined || team.kind !== "team") return null;
  return team.environmentId === null
    ? null
    : { kind: "team", environmentId: team.environmentId };
}

/**
 * Moves the Environment group's pick, which the page shows, to the
 * configuration a caller opened the page on, once that team's environment is
 * known. A team that never resolves leaves the pick where it is.
 */
export function useApplyRequestedSandboxesConfiguration(): void {
  const { configurations, complete } = useSandboxConfigurations();
  const requested = useSandboxesPageStore((s) => s.requestedConfiguration);
  useEffect(() => {
    if (requested === null) return;
    const pick = environmentPickFor(requested, configurations);
    if (pick === null && !complete) return;
    if (pick !== null) {
      useSettingsEnvironmentPickStore.getState().setPick(pick);
    }
    clearRequestedSandboxesConfiguration();
  }, [complete, configurations, requested]);
}
