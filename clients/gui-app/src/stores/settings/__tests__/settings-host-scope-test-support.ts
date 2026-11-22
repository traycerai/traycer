import { environmentPickValue } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

export function setSettingsHostSelection(hostId: string | null): void {
  const environment = useSettingsEnvironmentPickStore.getState();
  const pick = environment.pick ?? environment.defaultPick;
  useSettingsHostScopeStore
    .getState()
    .selectHost(pick, hostId === null ? null : { hostId, name: hostId });
}

export function settingsHostSelection(): {
  readonly hostId: string;
  readonly name: string;
} | null {
  const environment = useSettingsEnvironmentPickStore.getState();
  const pick = environment.pick ?? environment.defaultPick;
  return (
    useSettingsHostScopeStore.getState().hostByEnvironment[
      environmentPickValue(pick)
    ] ?? null
  );
}
