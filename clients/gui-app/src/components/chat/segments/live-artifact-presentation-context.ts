import { createContext } from "react";
import type { LiveArtifactReadyInput } from "./artifact-row";

/** What the raised surface reports: a raise, a lowering, or the surface leaving. */
export type ArtifactRaiseReport = "raised" | "lowered" | "gone";

/**
 * What a live card's provider hears from inside the row: whether its surface
 * is raised (presentation demand), and a missed entry object (the provider's
 * entry-miss latch). Absent, the row reports nothing.
 */
export interface LiveArtifactPresentation {
  readonly reportRaise: (report: ArtifactRaiseReport) => void;
  readonly reportEntryMissing: (artifact: LiveArtifactReadyInput) => void;
}

export const LiveArtifactPresentationContext =
  createContext<LiveArtifactPresentation | null>(null);
