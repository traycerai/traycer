import { useCallback } from "react";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import { FALLBACK_SETTINGS_SECTION_ID } from "@/lib/settings-sections";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/**
 * Opens Settings on the Fallback section **for the chat's own host**.
 *
 * The carry is the whole point and is not optional. Settings keeps its own host
 * pin and `use-system-tab-modal` never changes host scope - so a chat running on
 * host B whose card linked straight into Settings would edit host A's policy,
 * silently, through a panel that looks entirely correct.
 *
 * Every fallback surface with a settings link routes through this hook rather
 * than calling `openSettings` itself. That is not tidiness: the links are the
 * grace card, the waiting card, both attribution shapes (the divider-rule
 * notice's expanded details and the resumed-turn marker's body), the error
 * card's `auth` row, and the destination menu's empty state - and a rule
 * applied at six call sites is a rule that holds at five of them.
 *
 * The two fallback surfaces that deliberately carry NO link are the
 * switch-back banner and the background-items row. Both describe a chat that
 * is working: the banner is offering a return and the row is counting down a
 * wait, and neither is a moment where "why did this happen" is the question.
 *
 * `hostId` is the TAB's host (`useTabHostId()`), never the app-wide effective
 * host: a chat tab is bound to its host for life, and the policy the card
 * describes is the one on that machine.
 */
export function useOpenFallbackSettings(hostId: string | null): () => void {
  const { openSettings } = useSystemTabModalActions();
  return useCallback(() => {
    carryViewedHostIntoSettingsScope(hostId);
    openSettings({
      section: FALLBACK_SETTINGS_SECTION_ID,
      resetToGeneral: false,
    });
  }, [hostId, openSettings]);
}
