import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { openLayoutEditor } from "@/lib/layout/editor-session";
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
 */
export function CustomizeLayoutMenuItem(props: {
  /**
   * The region the menu was opened over, so the editor opens with that
   * section already selected; `null` opens the index.
   */
  readonly target: RegionId | null;
}): ReactNode {
  const navigate = useNavigate();
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
      Customize layout...
    </ContextMenuItem>
  );
}
