import { type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { appLogger } from "@/lib/logger";
import { resolveDesktopMenuPopupBridge } from "@/lib/windows/desktop-capabilities";
import type { DesktopTopLevelMenuId } from "@/lib/windows/types";
import { useRunnerHost } from "@/providers/use-runner-host";

const NO_DRAG_STYLE = { WebkitAppRegion: "no-drag" } as CSSProperties;

const WINDOWS_MENU_ITEMS: ReadonlyArray<{
  readonly id: DesktopTopLevelMenuId;
  readonly label: string;
}> = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "view", label: "View" },
  { id: "window", label: "Window" },
  { id: "help", label: "Help" },
];

/**
 * Visible top-level menus for the Windows frameless shell. The dropdowns are
 * still native Electron Menu instances, so command behavior, enabled state,
 * roles, and accelerators have one source of truth in main.
 */
export function WindowsMenuBar(): ReactNode {
  const menu = resolveDesktopMenuPopupBridge(useRunnerHost());
  if (menu === null || menu.platform !== "win32") return null;

  const openMenu = (
    menuId: DesktopTopLevelMenuId,
    event: MouseEvent<HTMLButtonElement>,
  ): void => {
    const anchor = event.currentTarget.getBoundingClientRect();
    void menu
      .openTopLevel(menuId, anchor.left, anchor.bottom)
      .catch((error) => {
        appLogger.error(
          "Failed to open Windows application menu",
          { menuId },
          error,
        );
      });
  };

  return (
    <nav
      aria-label="Application menu"
      className="relative z-10 flex h-full shrink-0 items-center"
      style={NO_DRAG_STYLE}
    >
      {WINDOWS_MENU_ITEMS.map((item) => (
        <button
          key={item.id}
          className="h-full rounded-none px-2 text-ui-xs text-canvas-foreground outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={(event) => openMenu(item.id, event)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
