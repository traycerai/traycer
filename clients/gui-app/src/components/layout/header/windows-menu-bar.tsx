import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useWindowsMenuBarActive } from "@/components/layout/header/use-windows-menu-bar-active";
import type { DesktopTopLevelMenuId } from "@/lib/windows/types";
import { useRunnerOpenTopLevelMenuMutation } from "@/hooks/runner/use-open-top-level-menu-mutation";

const NO_DRAG_STYLE = { WebkitAppRegion: "no-drag" } as CSSProperties;

const WINDOWS_MENU_ITEMS: ReadonlyArray<{
  readonly id: DesktopTopLevelMenuId;
  readonly label: string;
  // Alt access key, mirroring the native "&File"/"&Edit" mnemonics Electron
  // registers for these same submenus. Uppercase; matched case-insensitively.
  readonly mnemonic: string;
}> = [
  { id: "file", label: "File", mnemonic: "F" },
  { id: "edit", label: "Edit", mnemonic: "E" },
  { id: "view", label: "View", mnemonic: "V" },
  { id: "window", label: "Window", mnemonic: "W" },
  { id: "help", label: "Help", mnemonic: "H" },
];

/**
 * Visible top-level menus for the Windows frameless shell. The dropdowns are
 * still native Electron Menu instances, so command behavior, enabled state,
 * roles, and accelerators have one source of truth in main.
 *
 * Alt+<letter> opens the matching menu and holding Alt underlines each access
 * key, reproducing the native Windows menu bar this frameless window replaces.
 */
export function WindowsMenuBar(): ReactNode {
  const active = useWindowsMenuBarActive();
  const buttonsRef = useRef<Map<DesktopTopLevelMenuId, HTMLButtonElement>>(
    new Map(),
  );
  const [mnemonicsVisible, setMnemonicsVisible] = useState(false);
  const { mutate: openTopLevelMenu } = useRunnerOpenTopLevelMenuMutation();

  const openMenu = useCallback(
    (menuId: DesktopTopLevelMenuId, anchorX: number, anchorY: number): void => {
      openTopLevelMenu({ menuId, anchorX, anchorY });
    },
    [openTopLevelMenu],
  );

  useEffect(() => {
    if (!active) return;
    const openFromMnemonic = (event: KeyboardEvent): void => {
      const item = WINDOWS_MENU_ITEMS.find(
        (candidate) =>
          candidate.mnemonic.toLowerCase() === event.key.toLowerCase(),
      );
      const button =
        item !== undefined ? buttonsRef.current.get(item.id) : undefined;
      if (item === undefined || button === undefined) return;
      // Swallow the keystroke so it opens the menu instead of reaching the
      // focused control, matching a native menu bar's Alt access keys.
      event.preventDefault();
      setMnemonicsVisible(false);
      const anchor = button.getBoundingClientRect();
      openMenu(item.id, anchor.left, anchor.bottom);
    };
    const hideMnemonics = (): void => setMnemonicsVisible(false);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Alt") {
        setMnemonicsVisible(true);
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      openFromMnemonic(event);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === "Alt") hideMnemonics();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    // Releasing Alt outside the window never fires keyup, so drop the hint when
    // focus leaves rather than leaving the underlines stuck on.
    window.addEventListener("blur", hideMnemonics);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", hideMnemonics);
    };
  }, [active, openMenu]);

  if (!active) return null;

  return (
    <nav
      aria-label="Application menu"
      className="relative z-10 flex h-full shrink-0 items-center"
      style={NO_DRAG_STYLE}
    >
      {WINDOWS_MENU_ITEMS.map((item) => (
        <button
          key={item.id}
          ref={(node) => {
            if (node === null) buttonsRef.current.delete(item.id);
            else buttonsRef.current.set(item.id, node);
          }}
          aria-keyshortcuts={`Alt+${item.mnemonic}`}
          className="h-full rounded-none px-2 text-ui-xs text-canvas-foreground outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          // Keep the editor/input focused so the native Edit menu's roles
          // (Cut/Copy/Paste/Undo/Select All) act on the real target: a click
          // would otherwise move focus to this button before the popup opens,
          // leaving those commands with nothing to act on. The Alt access-key
          // path never moves focus, so it stays correct without this.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            const anchor = event.currentTarget.getBoundingClientRect();
            openMenu(item.id, anchor.left, anchor.bottom);
          }}
          type="button"
        >
          {renderMenuLabel(item.label, item.mnemonic, mnemonicsVisible)}
        </button>
      ))}
    </nav>
  );
}

function renderMenuLabel(
  label: string,
  mnemonic: string,
  underlineMnemonic: boolean,
): ReactNode {
  if (!underlineMnemonic) return label;
  const index = label.toLowerCase().indexOf(mnemonic.toLowerCase());
  if (index < 0) return label;
  return (
    <>
      {label.slice(0, index)}
      <span className="underline">{label.slice(index, index + 1)}</span>
      {label.slice(index + 1)}
    </>
  );
}
