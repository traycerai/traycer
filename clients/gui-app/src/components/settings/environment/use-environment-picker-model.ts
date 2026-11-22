import { useEffect } from "react";
import {
  isStaleLocalPick,
  type EnvironmentPickerModel,
} from "@/components/settings/environment/environment-picker-model";
import { useEnvironmentStatusModel } from "@/components/settings/environment/use-environment-status-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

/**
 * The model the Environment dropdown draws, from each computer's
 * `environment.status` (`isEnvironmentComputer`). Also keeps the window's
 * default pick current and drops a Local pick whose computer has since moved:
 * the store is what every Environment page reads (`useEnvironmentPick`), and
 * this is the one place that knows each computer's state. The command
 * palette's Settings rows call it too: they filter by the pick in a window
 * where Settings may not have opened.
 */
export function useEnvironmentPickerModel(
  scope: HostScope,
): EnvironmentPickerModel {
  const model = useEnvironmentStatusModel(scope);
  const pick = useSettingsEnvironmentPickStore((state) => state.pick);
  const setPick = useSettingsEnvironmentPickStore((state) => state.setPick);
  const setDefaultPick = useSettingsEnvironmentPickStore(
    (state) => state.setDefaultPick,
  );
  const statuses = model.statuses;
  const stale = isStaleLocalPick(pick, model.picker, statuses);
  const { defaultPick } = model.picker;
  // Syncs host-reported state into the window's pick: the store is read by
  // pages that do not mount this hook.
  useEffect(() => {
    setDefaultPick(defaultPick, scope.activeHostId);
  }, [defaultPick, setDefaultPick, scope.activeHostId]);
  useEffect(() => {
    if (stale) setPick(null);
  }, [stale, setPick]);
  return model.picker;
}
