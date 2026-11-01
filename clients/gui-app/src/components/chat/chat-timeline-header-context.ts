import { createContext, type ReactNode } from "react";

/**
 * What a transcript shows above its first row, inside the list so it scrolls
 * with the rows: a bot channel's setup history (Tracy Bots T67b), a bot
 * thread's post. With no row yet it stands in for the empty state, so it is
 * there before the rows are. `null`, the default, shows nothing there.
 */
export const ChatTimelineHeaderContext = createContext<ReactNode>(null);
