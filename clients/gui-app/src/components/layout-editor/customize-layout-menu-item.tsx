import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { openLayoutEditor } from "@/lib/layout/editor-session";
import { isLayoutEditorAvailable } from "@/lib/settings/settings-availability";
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
 * menus around it keep their separators.
 */
export function CustomizeLayoutMenuItem(props: {
  /**
   * The region the menu was opened over, so the editor opens with that
   * section already selected; `null` opens the index.
   */
  readonly target: RegionId | null;
}): ReactNode {
  const navigate = useNavigate();
  const availability = useSettingsAvailabilityContext();
  return (
    <ContextMenuItem
      data-testid="customize-layout-menu-item"
      onSelect={() => {
        openLayoutEditor({
          source: "direct_ui",
          entry: "pointer",
          target: props.target,
          origin: { kind: "tab" },
          navigateToTabIntent: (intent) =>
            activateTabIntent(navigate, intent, undefined),
        });
      }}
    >
      <SlidersHorizontal aria-hidden />
      {isLayoutEditorAvailable(availability)
        ? "Customize layout..."
        : "Layout settings..."}
    </ContextMenuItem>
  );
}
