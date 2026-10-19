import { create } from "zustand";

/**
 * Which profile the Link dialog is linking, or `null` while it is closed.
 *
 * The dialog itself (its lines, the sign-in and the profile's link states)
 * mounts against this store; the Providers page's "On <host> only, link to use
 * everywhere" line is the opener, shown only on a host that serves
 * `providers.link`. One store rather than a prop so the dialog can be mounted
 * once, outside the page that opens it.
 */
export interface ProviderLinkTarget {
  readonly providerId: string;
  /** `null` links a new profile rather than one on this host only. */
  readonly profileId: string | null;
}

interface ProviderLinkDialogState {
  readonly target: ProviderLinkTarget | null;
  readonly open: (target: ProviderLinkTarget) => void;
  readonly close: () => void;
}

export const useProviderLinkDialogStore = create<ProviderLinkDialogState>(
  (set) => ({
    target: null,
    open: (target) => set({ target }),
    close: () => set({ target: null }),
  }),
);
