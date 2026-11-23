import { useEffect, useMemo } from "react";
import {
  isStaleLocalPick,
  staleLocalHostIds,
  type EnvironmentPickerModel,
} from "@/components/settings/environment/environment-picker-model";
import { useEnvironmentStatusModel } from "@/components/settings/environment/use-environment-status-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

/**
 * The model the Environment dropdown draws, from each computer's
 * `environment.status` (`isEnvironmentComputer`), and the pick this window
 * shows: the person's own, or the default while theirs is a Local pick on a
 * computer that has since moved. Also keeps the store's mirror of host state
 * current: the store is what every Environment page reads
 * (`useEnvironmentPick`), and this is the one place that knows each
 * computer's state. The command palette's Settings rows call it too: they
 * filter by the pick in a window where Settings may not have opened.
 */
export function useEnvironmentPickerModel(
  scope: HostScope,
): EnvironmentPickerModel & {
  readonly pick: EnvironmentPick;
} {
  const model = useEnvironmentStatusModel(scope);
  const storedPick = useSettingsEnvironmentPickStore((state) => state.pick);
  const setDefaultPick = useSettingsEnvironmentPickStore(
    (state) => state.setDefaultPick,
  );
  const setStaleLocalHostIds = useSettingsEnvironmentPickStore(
    (state) => state.setStaleLocalHostIds,
  );
  const { defaultPick } = model.picker;
  const stale = useMemo(
    () => staleLocalHostIds(model.picker, model.statuses),
    [model.picker, model.statuses],
  );
  // Syncs host-reported state into the store, which pages that do not mount
  // this hook read.
  useEffect(() => {
    setDefaultPick(defaultPick, scope.activeHostId);
  }, [defaultPick, setDefaultPick, scope.activeHostId]);
  useEffect(() => {
    setStaleLocalHostIds(stale);
  }, [stale, setStaleLocalHostIds]);
  const pick =
    storedPick === null ||
    isStaleLocalPick(storedPick, model.picker, model.statuses)
      ? defaultPick
      : storedPick;
  return useMemo(() => ({ ...model.picker, pick }), [model.picker, pick]);
}
