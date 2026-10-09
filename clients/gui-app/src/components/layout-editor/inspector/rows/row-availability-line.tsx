import type { ReactNode } from "react";
import { useLayoutFormHost } from "@/components/layout-editor/inspector/layout-form-host";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import {
  rowAvailabilityText,
  type RowJump,
  type ShownRowAvailability,
} from "@/components/layout-editor/regions/row-availability";
import { Button } from "@/components/ui/button";
import {
  navigateToLayoutRegion,
  navigateToLayoutRegionRow,
  navigateToSettingsSection,
} from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

/**
 * What a row says about its own availability (P1): a disabled row's reason or
 * a live row's note, in the description slot - the same column and type size
 * as a description in that host - with the controller's link where it is out
 * of sight.
 *
 * The ONE place this is drawn, for every row kind in both hosts: a form row
 * (`LayoutFormRow`) draws it under its description and a list row
 * (`SortableRowLine`) under its name. Each points its control group's
 * `aria-describedby` at `id`, so the reason is heard on the control it
 * explains rather than found by reading around it.
 *
 * Nothing at all for a plain live row.
 */
export function RowAvailabilityLine(props: {
  readonly id: string;
  readonly availability: ShownRowAvailability;
  /** Where the host places the line in its own row, or `null`. */
  readonly layoutClassName: string | null;
}): ReactNode {
  const { id, availability, layoutClassName } = props;
  const page = useLayoutFormHost() === "page";
  const text = rowAvailabilityText(availability);
  if (text === null) return null;
  const jump = availability.kind === "disabled" ? availability.jump : null;
  return (
    <p
      id={id}
      data-row-availability={availability.kind}
      className={cn(
        "mt-0.5 max-w-[72ch] text-pretty text-muted-foreground",
        page ? "text-ui-sm" : "text-ui-xs",
        layoutClassName,
      )}
    >
      {text}
      {jump === null ? null : <RowJumpLink jump={jump} page={page} />}
    </p>
  );
}

/**
 * The controller's link. A settings page outside Layout is reachable from the
 * page host only: from the editor it would end the session the user is
 * editing in, so there the reason's words, which name the page, stand alone.
 */
function RowJumpLink(props: {
  readonly jump: RowJump;
  readonly page: boolean;
}): ReactNode {
  const { jump, page } = props;
  if (jump.kind === "settings" && !page) return null;
  return (
    <>
      {" "}
      <Button
        type="button"
        variant="link"
        size={page ? "inline" : "inline-xs"}
        onClick={() => {
          followRowJump(jump, page);
        }}
      >
        {jump.label}
      </Button>
    </>
  );
}

function followRowJump(jump: RowJump, page: boolean): void {
  if (jump.kind === "settings") {
    // Armed before navigating, as a search result's reveal is: the watcher
    // beside the panel outlet polls for the anchor until its deadline.
    useSettingsSearchStore.getState().requestReveal(jump.section, jump.anchor);
    navigateToSettingsSection(jump.section);
    return;
  }
  // Each host lands on the region's own row its own way: the page as a
  // settings result does, the editor by opening its area with the row open.
  if (page) {
    if (jump.row === null) navigateToLayoutRegion(jump.regionId);
    else navigateToLayoutRegionRow(jump.regionId, jump.row);
    return;
  }
  useLayoutEditorStore
    .getState()
    .openArea(LAYOUT_REGIONS[jump.regionId].surface, jump.regionId);
}
