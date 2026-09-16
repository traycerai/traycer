import type { DesktopTopLevelMenuId } from "./types";

/** Shared labels/mnemonics for the menubar and guest keyboard forwarding. */
export const DESKTOP_MENU_ITEMS: ReadonlyArray<{
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
