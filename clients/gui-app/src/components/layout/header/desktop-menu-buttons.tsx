import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import type { DesktopTopLevelMenuId } from "@/lib/windows/types";
import { useDesktopMenu } from "@/hooks/runner/use-desktop-menu";
import {
  Menubar,
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
} from "@/components/ui/menubar";
import { DesktopMenuEntries } from "@/components/layout/header/desktop-menu-entries";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";

const NO_DRAG_STYLE = { WebkitAppRegion: "no-drag" } as CSSProperties;
const DESKTOP_MENU_ITEMS: ReadonlyArray<{
  readonly id: DesktopTopLevelMenuId;
  readonly label: string;
  readonly mnemonic: string;
}> = [
  { id: "file", label: "File", mnemonic: "F" },
  { id: "edit", label: "Edit", mnemonic: "E" },
  { id: "view", label: "View", mnemonic: "V" },
  { id: "window", label: "Window", mnemonic: "W" },
  { id: "help", label: "Help", mnemonic: "H" },
];

/** One active session: idle hover highlights, engaged hover switches menus. */
export function DesktopMenuButtons(props: {
  readonly active: boolean;
}): ReactNode {
  const { active } = props;
  const [openMenu, setOpenMenu] = useState("");
  const [mnemonicsVisible, setMnemonicsVisible] = useState(false);
  const openMenuRef = useRef("");
  const previousFocus = useRef<HTMLElement | null>(null);
  const restoreOnClose = useRef(true);
  const { snapshot, execute } = useDesktopMenu();
  const { refetch } = snapshot;
  useTitleBarDragSuppression("application-menu", openMenu !== "");

  const changeMenu = useCallback(
    (next: string) => {
      if (next !== "" && openMenuRef.current === "") {
        previousFocus.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        restoreOnClose.current = true;
        void refetch();
      }
      openMenuRef.current = next;
      setOpenMenu(next);
    },
    [refetch],
  );

  const restoreFocus = useCallback(() => {
    const target = previousFocus.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, []);

  const changeMenuFromEvent = useEffectEvent(changeMenu);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Alt") {
        setMnemonicsVisible(true);
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return;
      const item = DESKTOP_MENU_ITEMS.find(
        (candidate) =>
          candidate.mnemonic.toLowerCase() === event.key.toLowerCase(),
      );
      if (item === undefined) return;
      event.preventDefault();
      setMnemonicsVisible(false);
      changeMenuFromEvent(item.id);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt") setMnemonicsVisible(false);
    };
    const onBlur = () => {
      restoreOnClose.current = false;
      setMnemonicsVisible(false);
      changeMenuFromEvent("");
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [active]);

  if (!active) return null;
  return (
    <nav
      aria-label="Application menu"
      className="relative z-10 flex h-full shrink-0 items-center"
      style={NO_DRAG_STYLE}
    >
      <Menubar
        value={openMenu}
        onValueChange={changeMenu}
        className="flex h-full items-center"
        loop
        aria-label="Application menu"
      >
        {DESKTOP_MENU_ITEMS.map((item) => {
          let content: ReactNode = <MenubarItem disabled>Loading…</MenubarItem>;
          if (snapshot.data !== undefined)
            content = (
              <DesktopMenuEntries
                items={
                  snapshot.data.menus.find((menu) => menu.id === item.id)
                    ?.items ?? []
                }
                onSelect={(itemId) => {
                  const revision = snapshot.data.revision;
                  changeMenu("");
                  restoreFocus();
                  restoreOnClose.current = false;
                  execute.mutate({ revision, itemId });
                }}
              />
            );
          if (snapshot.isError)
            content = (
              <MenubarItem
                onSelect={(event) => {
                  event.preventDefault();
                  void refetch();
                }}
              >
                Couldn't load menu. Retry
              </MenubarItem>
            );
          return (
            <MenubarMenu key={item.id} value={item.id}>
              <MenubarTrigger
                aria-keyshortcuts={`Alt+${item.mnemonic}`}
                className="group inline-flex h-full items-center text-ui-xs text-canvas-foreground/70 outline-none select-none"
                onMouseDown={(event) => event.preventDefault()}
              >
                <span className="rounded-md px-2 py-1 transition-colors duration-100 ease-out group-hover:bg-canvas-foreground/5 group-hover:text-canvas-foreground/90 group-data-[state=open]:bg-canvas-foreground/8 group-data-[state=open]:text-canvas-foreground group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-inset motion-reduce:transition-none">
                  {renderMenuLabel(item.label, item.mnemonic, mnemonicsVisible)}
                </span>
              </MenubarTrigger>
              <MenubarContent
                aria-label={item.label}
                onInteractOutside={(event) => {
                  // Moving between triggers belongs to the same session. An
                  // outside interaction owns its focus; don't pull it back on close.
                  if (
                    !(
                      event.target instanceof Element &&
                      event.target.closest('[role="menubar"]')
                    )
                  )
                    restoreOnClose.current = false;
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  if (openMenuRef.current === "" && restoreOnClose.current)
                    restoreFocus();
                }}
              >
                {content}
              </MenubarContent>
            </MenubarMenu>
          );
        })}
      </Menubar>
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
