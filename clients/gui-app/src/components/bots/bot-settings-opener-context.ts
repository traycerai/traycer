import { createContext } from "react";

/**
 * Opens the bot tab's Channel settings panel, for a surface inside the tab
 * that sends the person there (the switcher's "Bot settings" link).
 */
export const BotSettingsOpenerContext = createContext<(() => void) | null>(
  null,
);
