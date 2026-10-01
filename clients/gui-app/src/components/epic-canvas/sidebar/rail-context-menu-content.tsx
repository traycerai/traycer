import type { ReactNode } from "react";
import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { CustomizeLayoutMenuItem } from "@/components/layout-editor/customize-layout-menu-item";
import {
  getLeftPanelDefinition,
  isLeftPanelVisible,
  LEFT_PANEL_DEFINITIONS,
  type LeftPanelAvailabilityContext,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import {
  setRailVisibilityOverride,
  setSidebarSide,
  unstackRailMember,
  useLayoutRail,
} from "@/lib/layout/rail-view";
import {
  leftPanelIdForRailRegion,
  railRegionForLeftPanelId,
  railStackOf,
} from "@/lib/layout/rail";
import { type LeftPanelId } from "@/lib/left-panel-ids";
import { useArrangementValue } from "@/lib/layout-overrides";

/**
 * Rail context menu: every panel we have, each with a checkmark for whether it
 * is in the rail right now. Unchecking hides a panel; checking one reveals it -
 * including the presence-gated `pull-requests` / `comments`, where an explicit
 * check keeps the icon there even before the thing that would reveal it exists.
 *
 * A choice is stored only when it disagrees with the panel's own rule (see
 * `setPanelVisibilityOverride`), so checking an already-auto-visible panel
 * leaves it following that rule rather than pinning today's answer forever.
 *
 * The last visible panel cannot be unchecked: the sidebar body always renders
 * some panel, so an empty rail would leave the two disagreeing with no icon to
 * click back.
 *
 * It lives in a module of its own because BOTH rails draw it (L-144): the real
 * sidebar, and the sample workspace's rail, which is the one the user
 * right-clicks while customizing (L-87). Every item here writes the layout
 * store through `rail-view.ts`, which records the write as a GESTURE exactly
 * as a quick verb does - so inside a session a hide made here is an Undo step
 * and a "Discard changes" takes it back (L-18, L-150(1)), and at rest the
 * recording is a pass-through. What the sample has none of is the app
 * behaviour BESIDE the menu (switching the active panel), and that was never
 * in here.
 */
export function RailContextMenuContent(props: {
  readonly context: LeftPanelAvailabilityContext;
  /** The panel the pointer was over, or `null` for empty rail space. */
  readonly contextPanelId: LeftPanelId | null;
}): ReactNode {
  const { context, contextPanelId } = props;
  const sidebarSide = useArrangementValue("sidebarSide");
  const rail = useLayoutRail();
  const visibility = LEFT_PANEL_DEFINITIONS.map((definition) => ({
    definition,
    visible: isLeftPanelVisible(definition, context),
    autoVisible: definition.isAutoVisible(context),
  }));
  const visibleCount = visibility.filter((entry) => entry.visible).length;
  const entries = visibility.map((entry) => ({
    ...entry,
    // The last one standing stays put; see the note above.
    locked: entry.visible && visibleCount === 1,
  }));
  const pointedEntry =
    entries.find((entry) => entry.definition.id === contextPanelId) ?? null;
  const pointedStack =
    pointedEntry === null
      ? null
      : railStackOf(rail, railRegionForLeftPanelId(pointedEntry.definition.id));

  return (
    <ContextMenuContent
      className="min-w-56"
      data-testid="epic-rail-context-menu"
    >
      {pointedEntry !== null && visibleCount > 1 ? (
        <>
          <ContextMenuItem
            onSelect={() =>
              setRailVisibilityOverride(pointedEntry.definition.id, false)
            }
            data-testid="epic-rail-hide-pointed-panel"
          >
            {`Hide '${pointedEntry.definition.title}'`}
          </ContextMenuItem>
          {/* Each member out of its stack (L-181), since the stack's one
              icon stands for all of them; out of a pair, the pair dissolves. */}
          {(pointedStack?.members ?? []).map((member) => {
            const panelId = leftPanelIdForRailRegion(member);
            const title = getLeftPanelDefinition(panelId).title;
            return (
              <ContextMenuItem
                key={member}
                onSelect={() => unstackRailMember(panelId)}
                data-testid={`epic-rail-unstack-${panelId}`}
              >
                {`Unstack '${title}'`}
              </ContextMenuItem>
            );
          })}
          <ContextMenuSeparator />
        </>
      ) : null}
      {entries.map((entry) => (
        <ContextMenuCheckboxItem
          key={entry.definition.id}
          checked={entry.visible}
          disabled={entry.locked}
          onCheckedChange={(next) =>
            setRailVisibilityOverride(
              entry.definition.id,
              next === entry.autoVisible ? null : next,
            )
          }
          data-testid={`epic-rail-toggle-${entry.definition.id}`}
        >
          <entry.definition.icon
            className="text-muted-foreground"
            aria-hidden
          />
          {entry.definition.title}
          {entry.visible && !entry.autoVisible ? (
            <span className="ml-auto pl-4 text-ui-xs text-muted-foreground">
              {entry.definition.forcedOnHint}
            </span>
          ) : null}
        </ContextMenuCheckboxItem>
      ))}
      <ContextMenuSeparator />
      {/* S-32: the sidebar's own side, beside its visibility verbs. Writes
          through the same recordGesture-wrapped path as every item above it,
          so a move made while customizing is an Undo step. */}
      <ContextMenuItem
        onSelect={() =>
          setSidebarSide(sidebarSide === "left" ? "right" : "left")
        }
        data-testid="epic-rail-move-sidebar"
      >
        {sidebarSide === "left"
          ? "Move sidebar to right"
          : "Move sidebar to left"}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {/* The way in (L-19), on the panel the pointer was over so the editor
          opens on that region's own section. This menu already carries its
          own placement verbs - the hide item and checkbox list for show/hide,
          and the item above for the sidebar's side (S-32, which supersedes
          L-19 / L-72 for this surface) - so there is nothing left for a quick
          verb to add. */}
      <CustomizeLayoutMenuItem
        target={
          pointedEntry === null
            ? null
            : railRegionForLeftPanelId(pointedEntry.definition.id)
        }
      />
    </ContextMenuContent>
  );
}
