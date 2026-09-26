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
 * than calling `openSettings` itself. That is not tidiness: the entry points
 * are the routing card's gear (countdown and waiting), the settled card's gear,
 * both attribution shapes (the divider-rule notice's expanded details and the
 * resumed-turn marker's body), and the destination picker's empty state - and
 * a rule applied at five call sites is a rule that holds at four of them.
 *
 * The routing surfaces that deliberately carry NO entry point are the
 * switch-back offer, the background-items row and the plain failed-turn card.
 * The first two describe a chat that is working - one offers a return, the
 * other counts down a wait - and the failed-turn card's job is the next action
 * on the turn, not the policy behind it.
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
      tab: null,
      draft: null,
      hostId: null,
    });
  }, [hostId, openSettings]);
}
