import { create } from "zustand";
import type { LinkLoginFailureKind } from "@/lib/auth/auth-service";

/** Every terminal outcome a person needs told about. */
export type LinkLoginDeepLinkNotice = LinkLoginFailureKind;

/**
 * How a claim the OS started actually ended, parked for the sign-in surface to
 * render.
 *
 * The deep-link path is where a dead code is MOST likely, not least: the
 * account holds one live unclaimed code, so a re-mint invalidates the QR still
 * sitting on the desktop screen, and camera-scanning a stale QR is the
 * mainline mistake. "Sign-in failed - please try again" is actively wrong
 * advice there — retrying an expired code cannot succeed — so the precise
 * reason has to survive the trip from the bridge that claimed to the surface
 * that speaks.
 *
 * A store rather than a call into the surface's own state: the claim can
 * outlive, or precede, any mounted sign-in surface. The surface READS this as
 * ordinary state and the writer never reaches into it.
 */
interface LinkLoginDeepLinkOutcomeState {
  readonly notice: LinkLoginDeepLinkNotice | null;
  readonly report: (notice: LinkLoginDeepLinkNotice) => void;
  /** Cleared by whoever moves on — a new claim, or typing a fresh code. */
  readonly clear: () => void;
}

export const useLinkLoginDeepLinkOutcomeStore =
  create<LinkLoginDeepLinkOutcomeState>()((set) => ({
    notice: null,
    report: (notice: LinkLoginDeepLinkNotice) => {
      set({ notice });
    },
    clear: () => {
      set({ notice: null });
    },
  }));
