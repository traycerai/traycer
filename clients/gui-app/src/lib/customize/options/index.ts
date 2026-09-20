import { registerStatusBarCustomizeOptions } from "@/lib/customize/options/status-bar-options";
import { registerTabsSidebarCustomizeOptions } from "@/lib/customize/options/tabs-sidebar-options";
import { registerComposerToolbarCustomizeOptions } from "@/lib/customize/options/composer-toolbar-options";
import { registerComposerDockCustomizeOptions } from "@/lib/customize/options/composer-dock-options";
import { registerChatSurfacesCustomizeOptions } from "@/lib/customize/options/chat-surfaces-options";

/**
 * Every real surface's `CustomizeOptionSpec` factories, registered once at
 * import time. A permanent app-wide registration never needs the cleanup
 * `registerCustomizeOptions` offers - only a component-scoped factory would.
 * Imported once, for its side effect, from `CustomizeOverlay` (always
 * mounted at the app root) so every setting is registered before any
 * popover can ask for one.
 */
export function registerBuiltinCustomizeOptions(): void {
  registerStatusBarCustomizeOptions();
  registerTabsSidebarCustomizeOptions();
  registerComposerToolbarCustomizeOptions();
  registerComposerDockCustomizeOptions();
  registerChatSurfacesCustomizeOptions();
}
