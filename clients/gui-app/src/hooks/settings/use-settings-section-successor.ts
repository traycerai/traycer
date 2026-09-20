import { useEffect } from "react";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

/**
 * Where a Settings section has moved to, or itself.
 *
 * Layout's rows moved to Appearance when the Customize editor took them over
 * (`customizeEditor`: the switch on AND a window at least `md`). Pure so it can
 * be asked anywhere; the hook below is what acts on the answer.
 */
export function settingsSectionSuccessor(
  section: SettingsSectionId,
  customizeEditor: boolean,
): SettingsSectionId {
  return section === "layout" && customizeEditor ? "appearance" : section;
}

/**
 * Keeps a Settings surface from resting on a section that has moved.
 *
 * The ONE place the move happens, used by BOTH presentations - the modal and
 * the Settings tab both render their panel through `SettingsPanelForSection`,
 * and each passes the writer that changes ITS OWN authority (the modal's
 * section store; the tab's route / remembered path). So the state the surface
 * keeps - what `captureSettingsOpener` reads, what promoting a modal to a tab
 * carries, the path a remembered tab restores - says the successor, never the
 * old section with a substituted render.
 *
 * Runs on the transition, not on a schedule: it arms the reveal for the
 * Customize card once (so the reader arrives at the card rather than the top
 * of the page) and writes the successor once. Turning the switch off later
 * leaves the reader where they are - the section they are on now IS Appearance,
 * and nothing maps Appearance anywhere - which is why this writes the section
 * and does not merely render a different one.
 *
 * `writeSection` must be stable (a `useCallback` or a module function), or the
 * effect would re-run before the write it just made has landed.
 */
export function useSettingsSectionSuccessor(
  section: SettingsSectionId,
  writeSection: (successor: SettingsSectionId) => void,
): void {
  const customizeEditor = useSettingsAvailabilityContext().customizeEditor;
  const requestReveal = useSettingsSearchStore((state) => state.requestReveal);
  const successor = settingsSectionSuccessor(section, customizeEditor);
  useEffect(() => {
    if (successor === section) return;
    requestReveal(successor, APPEARANCE.definitions.customizeCard.anchor);
    writeSection(successor);
  }, [section, successor, requestReveal, writeSection]);
}
