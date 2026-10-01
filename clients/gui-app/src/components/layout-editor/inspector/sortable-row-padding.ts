import { useLayoutFormHost } from "@/components/layout-editor/inspector/layout-form-host";
import { useSettingsDensity } from "@/providers/settings-density-context";

export interface SortableRowPadding {
  readonly row: string;
  readonly divider: string;
}

/**
 * The gutter a row sits in, which anything drawn as a row of the same card
 * has to sit in too - the rail's "Add divider" button, and whatever a host
 * puts beside the list.
 *
 * The page reads at the Settings form's scale and the dock at the instrument
 * panel's (P-4), so the answer depends on the host and, on the page, on the
 * density the modal and the routed pane pick between. A divider is a hairline
 * rather than a member, so its row is about half a member's height (LV2-12).
 *
 * Its own module rather than `sortable-list.tsx`'s: five files ask for this
 * gutter and only one of them is the list, so it is shared code sitting beside
 * a component file rather than inside one.
 */
export function sortableRowPadding(
  page: boolean,
  compact: boolean,
): SortableRowPadding {
  if (!page) {
    return {
      // The inspector's own edge (its header, back row and area heading).
      row: "px-3.5 py-1.5 text-ui-sm",
      divider: "px-3.5 py-0.5 text-ui-sm",
    };
  }
  return compact
    ? { row: "px-4 py-2.5 text-ui", divider: "px-4 py-1 text-ui" }
    : { row: "px-5 py-3 text-ui", divider: "px-5 py-1.5 text-ui" };
}

/** {@link sortableRowPadding}, for a caller that is already in the tree. */
export function useSortableRowPadding(): SortableRowPadding {
  return sortableRowPadding(
    useLayoutFormHost() === "page",
    useSettingsDensity() === "compact",
  );
}
