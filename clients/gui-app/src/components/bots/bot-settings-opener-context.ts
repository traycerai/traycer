import { createContext, useContext } from "react";

/**
 * Opens the bot tab's Channel settings panel, for a surface inside the tab
 * that sends the person there (the switcher's "Bot settings" link).
 */
export const BotSettingsOpenerContext = createContext<(() => void) | null>(
  null,
);

/** The tab's settings opener; `null` outside a bot tab. */
export function useBotSettingsOpener(): (() => void) | null {
  return useContext(BotSettingsOpenerContext);
}
