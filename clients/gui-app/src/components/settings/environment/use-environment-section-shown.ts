import { useCallback } from "react";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { useEnvironmentPickerModel } from "@/components/settings/environment/use-environment-picker-model";
import { environmentSectionShown } from "@/lib/settings-environment-pages";
import type { SettingsSectionId } from "@/lib/settings-sections";

/**
 * `environmentSectionShown` under the current pick: the one filter the
 * Settings rows, Settings search and the command palette's Settings rows
 * share. It reads the kind of pick alone, so no row waits on, or leaves on, a
 * host's answer; a section the picked computer lacks answers in its own body.
 * `windowScope` is the window's own host scope (`WINDOW_HOST_SELECTION`),
 * which the caller already holds.
 */
export function useEnvironmentSectionShown(
  windowScope: HostScope,
): (section: SettingsSectionId) => boolean {
  const { pick } = useEnvironmentPickerModel(windowScope);
  return useCallback(
    (section: SettingsSectionId) => environmentSectionShown(pick, section),
    [pick],
  );
}
