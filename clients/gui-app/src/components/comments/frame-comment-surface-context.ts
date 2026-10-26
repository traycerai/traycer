import { createContext } from "react";

/** Portals for canvas comments stay inside the fullscreen surface. */
export const FrameFullscreenContext = createContext<HTMLElement | null>(null);

/** Stable portal target across canvas/fullscreen transitions, preserving drafts. */
export const FrameCommentPortalContext = createContext<HTMLElement | null>(
  null,
);
