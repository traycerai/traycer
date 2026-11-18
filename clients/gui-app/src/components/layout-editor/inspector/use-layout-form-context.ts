import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import type {
  LayoutFacts,
  LayoutFormContext,
} from "@/components/layout-editor/regions/row-availability";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import { useLayoutSnapshot } from "@/stores/layout/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The one {@link LayoutFormContext} every row rule reads (P1): the layout as
 * the form shows it, the shell (with whether its phone layout is drawn, the
 * predicate the renderer reads) and the facts no layout value says.
 *
 * Built here and nowhere else, so two rows can never be asked about two
 * different layouts in one render.
 */
export function useLayoutFormContext(): LayoutFormContext {
  const snapshot = useLayoutSnapshot();
  const shell = useSettingsAvailabilityContext();
  const voiceInputEnabled = useSettingsStore(
    (state) => state.voiceInputEnabled,
  );
  return {
    values: effectiveLayoutValues(snapshot.basePreset, snapshot.overrides),
    arrangement: snapshot.arrangement,
    shell,
    facts: { voiceInputEnabled },
  };
}

/**
 * The same facts read once off the store, for a caller outside a render (the
 * canvas's hover chip), which must not subscribe.
 */
export function readLayoutFacts(): LayoutFacts {
  return { voiceInputEnabled: useSettingsStore.getState().voiceInputEnabled };
}
