import { createContext } from "react";
import type { WindowHostPersonalAnswer } from "@/components/settings/personal/use-window-host-runs-personal";

/**
 * The window host's Personal answer as the page's gate read it
 * (`PageOrNotOnComputer`). The page's frame takes it from here instead of
 * reading it again: a second read starts with no history of its own, so it
 * can disagree with the gate and leave the page with neither the gate's
 * stand-in nor the frame's page. With no gate above, the answer is unknown.
 */
export const WindowHostAnswerContext = createContext<WindowHostPersonalAnswer>({
  runs: null,
  retryStatus: null,
});
