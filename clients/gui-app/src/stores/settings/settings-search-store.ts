import { create } from "zustand";
import type { SettingsSectionId } from "@/lib/settings-sections";

/**
 * One pending "scroll here and say so" request, handed from the search result
 * that was clicked to the panel that has not mounted yet.
 *
 * A result click does two things that cannot happen in the same frame: it
 * navigates to a section, and it asks for an element INSIDE that section's
 * panel. The panel is the thing that renders the element, and it renders after
 * the navigation — often several frames after, because most panels wait on a
 * host RPC. So the request has to outlive the click, and the clicker and the
 * revealer are far enough apart in the tree (the sidebar and whatever the
 * outlet holds) that passing it down as a prop would thread it through every
 * panel. A store is the seam.
 *
 * It holds ONE request. A second click before the first resolves means the
 * user changed their mind, and the newer request is the one they are waiting
 * on.
 */
export interface SettingsRevealRequest {
  readonly section: SettingsSectionId;
  /**
   * The `data-settings-anchor` token to scroll to and flash, or `null` for a
   * page result: scroll that section's pane back to its top and mark nothing.
   * A page result still needs a request — when the section is already on
   * screen, navigating to it moves nothing.
   */
  readonly anchor: string | null;
  /**
   * Distinguishes two consecutive requests for the SAME anchor, which is what
   * clicking one result twice produces. Without it the second click is a no-op
   * — the store's value is unchanged, so nothing re-runs and the user, who
   * clicked precisely because they wanted to be shown again, sees nothing.
   *
   * It is also the request's age: the revealer gives up a fixed time after
   * THIS, not after whenever it happened to start looking, so a request that
   * outlives its panel cannot fire when a panel mounts again later.
   */
  readonly requestedAt: number;
}

interface SettingsSearchState {
  /**
   * The rail's search query. Held here rather than in the rail because the
   * modal frame around the rail has to know whether a search is running: its
   * Escape handler clears the search instead of closing the modal. The rail
   * clears it when it unmounts, so a query never greets the next visit.
   */
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly pendingReveal: SettingsRevealRequest | null;
  readonly requestReveal: (
    section: SettingsSectionId,
    anchor: string | null,
  ) => void;
  /**
   * Called by the revealer once it has scrolled — or once it has given up.
   * Both are the same outcome for this store: the request is spent, and it
   * must not fire again on the next unrelated re-render of the panel.
   */
  readonly clearReveal: () => void;
}

export const useSettingsSearchStore = create<SettingsSearchState>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
  pendingReveal: null,
  requestReveal: (section, anchor) =>
    set({ pendingReveal: { section, anchor, requestedAt: Date.now() } }),
  clearReveal: () => set({ pendingReveal: null }),
}));
