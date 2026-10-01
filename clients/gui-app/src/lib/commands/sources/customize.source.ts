import { useMemo } from "react";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { openLayoutEditor } from "@/lib/layout/editor-session";
import { isLayoutEditorAvailable } from "@/lib/settings/settings-availability";
import type { CommandItem, ReactCommandSource } from "@/lib/commands/types";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/**
 * The palette's two layout doors (L-15, L-33, C15): "Customize layout" opens
 * the editor on the sample workspace, "Layout settings" opens the same form in
 * Settings. Both outrank tasks for "layout" (`paletteFilter`).
 *
 * `entry: "keyboard"` unconditionally - the palette is reached by typing, and
 * the entry method gates the View Transition as well as being reported (L-30,
 * L-54). A palette row selected with the mouse is still a palette row.
 */
export const customizeSource: ReactCommandSource = {
  id: "customize",
  useItems: () => {
    const editing = useLayoutEditorStore((state) => state.session !== null);
    const locked = useLayoutEditorStore(
      (state) => state.lockedBy === "other-window",
    );
    const availability = useSettingsAvailabilityContext();
    const editorAvailable = isLayoutEditorAvailable(availability);
    return useMemo<ReadonlyArray<CommandItem>>(() => {
      // Nothing to offer from inside a session: the editor is already open and
      // its own chrome is how it is left.
      if (editing) return [];
      const settingsItem: CommandItem = {
        id: "customize:layout-settings",
        label: "Layout settings",
        description: "Open Settings, Layout.",
        keywords: ["layout", "settings", "appearance", "chrome"],
        group: "actions",
        scope: "actions",
        shortcut: null,
        actionId: null,
        subpage: null,
        run: (ctx) => ctx.router.navigateSettingsSection("layout"),
      };
      // Where the editor can never open (the installed app), its door would
      // only redirect to the settings row beside it.
      if (!editorAvailable) return [settingsItem];
      const item = {
        id: "customize:layout",
        label: "Customize layout",
        keywords: ["layout", "customize", "appearance", "chrome", "arrange"],
        group: "actions",
        scope: "actions",
        shortcut: null,
        actionId: null,
        subpage: null,
      } as const;
      // Said rather than silently refused: the door declines while another
      // window holds the lease (L-32), and a row that does nothing when
      // pressed is worse than a row that explains itself.
      if (locked) {
        return [
          {
            ...item,
            description: "Open in another window. Your layout is saved there.",
            disabled: true,
            run: () => undefined,
          },
        ];
      }
      return [
        {
          ...item,
          description: "Arrange your layout using sample content.",
          // `ctx.router`, never `useNavigate()`: the palette mounts above
          // `RouterProvider`, where the hook has no router to navigate with.
          run: (ctx) => {
            openLayoutEditor({
              source: "command_palette",
              entry: "keyboard",
              target: null,
              origin: { kind: "tab" },
              navigateToTabIntent: ctx.router.navigateToTabIntent,
            });
          },
        },
        settingsItem,
      ];
    }, [editing, locked, editorAvailable]);
  },
};
