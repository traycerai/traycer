import { createContext, use } from "react";

/**
 * Which of the one form's two hosts (L-03) is drawing this row.
 *
 * The tree is the same in both; exactly two things legitimately differ, and
 * both are properties of the HOST rather than of any row:
 *
 * - **Density.** A 380px instrument panel and a full-width settings page do not
 *   read at the same type scale, and a page that mixed the two read as a panel
 *   pasted into a form (P-4).
 * - **Where a deeper level opens.** In the dock it is a screen with a back row;
 *   on the page it expands in place, which is L-89 satisfied by never leaving
 *   the page at all (L-95).
 *
 * A context rather than a prop threaded through every list and row: the rows
 * that need the answer are the leaves, and nothing between them has an opinion.
 * `inspector` is the default because the dock is where the form lives; the
 * Settings page says otherwise once, at its root.
 */
export type LayoutFormHost = "inspector" | "page";

export const LayoutFormHostContext = createContext<LayoutFormHost>("inspector");

export function useLayoutFormHost(): LayoutFormHost {
  return use(LayoutFormHostContext);
}
