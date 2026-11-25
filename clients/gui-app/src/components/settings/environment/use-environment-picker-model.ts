import { useLayoutEffect, useMemo } from "react";
import {
  isStaleLocalPick,
  type EnvironmentPickerModel,
} from "@/components/settings/environment/environment-picker-model";
import { useEnvironmentStatusModel } from "@/components/settings/environment/use-environment-status-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import {
  pickReading,
  useSettingsEnvironmentPickStore,
} from "@/stores/settings/settings-environment-pick-store";

/**
 * The model the Environment dropdown draws, from each computer's
 * `environment.status` (`isEnvironmentComputer`), and the pick this window
 * shows: the person's own, or the default once theirs is a Local pick on a
 * computer seen to have moved. Also keeps the store current: the store is
 * what every Environment page reads (`useEnvironmentPick`), and this is the
 * one place that knows each computer's state. The command palette's Settings
 * rows call it too: they filter by the pick in a window where Settings may
 * not have opened.
 */
export function useEnvironmentPickerModel(
  scope: HostScope,
): EnvironmentPickerModel & {
  readonly pick: EnvironmentPick;
} {
  const model = useEnvironmentStatusModel(scope);
  const storedPick = useSettingsEnvironmentPickStore((state) => state.pick);
  const gone = useSettingsEnvironmentPickStore((state) => state.gone);
  const setDefaultPick = useSettingsEnvironmentPickStore(
    (state) => state.setDefaultPick,
  );
  const markPickGone = useSettingsEnvironmentPickStore(
    (state) => state.markPickGone,
  );
  const { defaultPick } = model.picker;
  const goneNow = isStaleLocalPick(storedPick, model.picker, model.statuses);
  // Written before paint, so a page reading the store never shows a pick
  // other than this one.
  useLayoutEffect(() => {
    setDefaultPick(defaultPick, scope.activeHostId);
  }, [defaultPick, setDefaultPick, scope.activeHostId]);
  useLayoutEffect(() => {
    if (goneNow) markPickGone(null);
  }, [goneNow, storedPick, markPickGone]);
  const pick = (goneNow ? null : pickReading(storedPick, gone)) ?? defaultPick;
  return useMemo(() => ({ ...model.picker, pick }), [model.picker, pick]);
}
