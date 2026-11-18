import { useId, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { explainedMenuItemProps } from "@/components/layout-editor/explained-menu-item";
import { ExplainedMenuItemLabel } from "@/components/layout-editor/explained-menu-item-label";
import { LAYOUT_EDITOR_HELD_ELSEWHERE_REASON } from "@/lib/layout/editor-lease";
import { openLayoutEditor } from "@/lib/layout/editor-session";
import { useLayoutEditorDoor } from "@/lib/layout/use-layout-editor-door";
import { activateTabIntent } from "@/lib/tab-navigation";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * "Customize layout..." in a menu on the app's own chrome (L-19, L-33).
 *
 * Its own module rather than a second export beside the quick verbs: those
 * need the whole region registry, and the registry reaches every real leaf the
 * depictions draw. A menu that only wants the way in - the sidebar rail, whose
 * own items already are its show/hide verbs - should not pull the app's chrome
 * into its module graph to get one item.
 *
 * Where the editor can never open (the installed app) the door lands on the
 * region's own row in Settings > Layout instead, so the item says that rather
 * than naming an editor the press will not reach. One item either way, so the
 * menus around it keep their separators. All three states come from
 * `useLayoutEditorDoor`, the answer every door shares.
 */
export function CustomizeLayoutMenuItem(props: {
  /**
   * The region the menu was opened over, so the editor opens with that
   * section already selected; `null` opens the index.
   */
  readonly target: RegionId | null;
}): ReactNode {
  const navigate = useNavigate();
  const door = useLayoutEditorDoor();
  const reasonId = useId();
  const heldElsewhere = door === "held-elsewhere";
  return (
    <ContextMenuItem
      data-testid="customize-layout-menu-item"
      // While another window holds the editor the press would do nothing, so
      // the item is off and says why, in the palette's words (T6) - still
      // focusable, with the reason as its description.
      {...explainedMenuItemProps({
        off: heldElsewhere,
        reasonId,
        onSelect: () => {
          openLayoutEditor({
            source: "direct_ui",
            entry: "pointer",
            target: props.target,
            origin: { kind: "tab" },
            navigateToTabIntent: (intent) =>
              activateTabIntent(navigate, intent, undefined),
          });
        },
      })}
    >
      <SlidersHorizontal aria-hidden />
      <ExplainedMenuItemLabel
        label={door === "absent" ? "Layout settings..." : "Customize layout..."}
        reason={heldElsewhere ? LAYOUT_EDITOR_HELD_ELSEWHERE_REASON : null}
        reasonId={reasonId}
      />
    </ContextMenuItem>
  );
}
