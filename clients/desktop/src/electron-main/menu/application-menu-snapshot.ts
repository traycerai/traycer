import {
  BrowserWindow,
  Menu,
  webContents,
  type MenuItem,
  type WebContents,
} from "electron";
import {
  DESKTOP_TOP_LEVEL_MENU_IDS,
  desktopTopLevelMenuItemId,
  type DesktopMenuEntry,
  type DesktopMenuSection,
  type DesktopMenuSnapshot,
} from "../../ipc-contracts/window-types";

interface MenuAction {
  readonly item: MenuItem;
  readonly ancestors: readonly MenuItem[];
}
interface MenuSnapshotBinding {
  readonly menu: Menu;
  readonly revision: number;
  readonly actions: ReadonlyMap<string, MenuAction>;
}
const revisions = new WeakMap<Menu, number>();
const snapshots = new WeakMap<WebContents, MenuSnapshotBinding>();
let nextRevision = 0;

/** Project the canonical native menu, including role defaults, into renderer data. */
export function readApplicationMenuSnapshot(
  sender: WebContents,
): DesktopMenuSnapshot {
  const window = BrowserWindow.fromWebContents(sender);
  const menu = Menu.getApplicationMenu();
  if (window === null || window.isDestroyed() || menu === null) {
    snapshots.delete(sender);
    return { revision: 0, menus: [] };
  }
  let revision = revisions.get(menu);
  if (revision === undefined) {
    revision = ++nextRevision;
    revisions.set(menu, revision);
  }
  const actions = new Map<string, MenuAction>();
  const menus: DesktopMenuSection[] = [];
  for (const id of DESKTOP_TOP_LEVEL_MENU_IDS) {
    const top = menu.getMenuItemById(desktopTopLevelMenuItemId(id));
    if (top === null || !top.visible || (top.submenu ?? null) === null)
      continue;
    menus.push({
      id,
      label: top.label,
      items: projectItems(top.submenu?.items ?? [], id, [top], actions),
    });
  }
  snapshots.set(sender, { menu, revision, actions });
  return { revision, menus };
}

function projectItems(
  items: readonly MenuItem[],
  prefix: string,
  ancestors: readonly MenuItem[],
  actions: Map<string, MenuAction>,
): DesktopMenuEntry[] {
  return items.flatMap((item, index) => {
    if (!item.visible) return [];
    const id = `${prefix}/${index}`;
    const type = item.type;
    if (
      type !== "normal" &&
      type !== "separator" &&
      type !== "checkbox" &&
      type !== "radio" &&
      type !== "submenu"
    )
      return [];
    actions.set(id, { item, ancestors });
    // Electron uses null for absent submenus despite its optional submenu type.
    return [
      {
        id,
        type,
        label: item.label,
        enabled:
          item.enabled && ancestors.every((ancestor) => ancestor.enabled),
        checked: item.checked,
        accelerator: item.accelerator ?? null,
        children: item.submenu
          ? projectItems(item.submenu.items, id, [...ancestors, item], actions)
          : [],
      },
    ];
  });
}

/** A renderer may only execute a currently visible, enabled item it was shown. */
export function executeApplicationMenuItem(
  sender: WebContents,
  revision: number,
  itemId: string,
): void {
  const window = BrowserWindow.fromWebContents(sender);
  if (window === null || window.isDestroyed()) return;
  const binding = snapshots.get(sender);
  if (
    binding === undefined ||
    binding.revision !== revision ||
    binding.menu !== Menu.getApplicationMenu()
  ) {
    throw new Error("The application menu changed. Open it again to continue.");
  }
  const action = binding.actions.get(itemId);
  if (
    action === undefined ||
    !action.item.enabled ||
    !action.item.visible ||
    action.ancestors.some((item) => !item.enabled || !item.visible) ||
    action.item.type === "separator" ||
    (action.item.submenu ?? null) !== null
  ) {
    throw new Error("This application menu action is unavailable.");
  }
  // The renderer restores its original editor before invoking. Electron's
  // documented click method handles native roles and checkbox/radio changes.
  const focused = webContents.getFocusedWebContents();
  const target =
    focused !== null &&
    BrowserWindow.fromWebContents(focused.hostWebContents ?? focused) === window
      ? focused
      : sender;
  action.item.click({}, window, target);
}
