import { create } from "zustand";
import type { LinkLoginFailureKind } from "@/lib/auth/auth-service";

/** Every terminal outcome a person needs told about. */
export type LinkLoginDeepLinkNotice = LinkLoginFailureKind;

/** How a claim the OS started actually ended, parked for the sign-in surface to render. */
interface LinkLoginDeepLinkOutcomeState {
  readonly notice: LinkLoginDeepLinkNotice | null;
  readonly report: (notice: LinkLoginDeepLinkNotice) => void;
  /** Cleared by whoever moves on - a new claim, or typing a fresh code. */
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
