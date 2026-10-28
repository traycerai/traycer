import { createContext, type ReactNode } from "react";

/**
 * What a read-only chat's composer notice offers beside its sentence: a
 * destroyed sandbox's "Continue on another host" and "Details", which belong
 * to that one line rather than to a second banner. `null` offers nothing.
 */
export const ReadOnlyNoticeActionsContext = createContext<ReactNode>(null);
