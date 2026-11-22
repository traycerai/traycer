import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import {
  CommandPaletteShell,
  RootView,
  type PaletteRootListProps,
} from "@/components/command-palette/command-palette-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE COMMAND PALETTE, OPEN, WITH A LIST LONG ENOUGH TO SCROLL.
 *
 * The real `CommandPaletteShell`, opened the way
 * `command-palette-shell-width.test.tsx` opens it: the palette store's
 * `open` flag, and a `RootList` that hands `RootView` a fixed set of items.
 * No router and no host runtime. The shell renders standalone, so this
 * fixture is the palette rather than `ProviderMcpAddDialog`.
 *
 * Forty tasks are more than a 480px viewport can show under the list's own
 * cap. `browser-tests/anchored-dialog-cap.spec.ts` measures the dialog's
 * top edge and that this list scrolls.
 */
const ITEM_COUNT = 40;

const ctx: CommandContext = {
  pathname: "/",
  router: {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  },
  activeTabId: null,
  activeEpicId: null,
  focusedComposerKind: null,
  targetGroupId: null,
};

const items: readonly CommandItem[] = Array.from(
  { length: ITEM_COUNT },
  (_, index): CommandItem => ({
    id: `anchored-dialog-task-${String(index)}`,
    label: `Task ${String(index)}`,
    description: null,
    keywords: [],
    group: "epics",
    scope: "epics",
    shortcut: null,
    actionId: null,
    run: () => undefined,
    subpage: null,
  }),
);

function LongList(props: PaletteRootListProps): ReactElement {
  return <RootView {...props} items={items} loading={false} />;
}

export function Fixture(): ReactElement {
  return (
    <TooltipProvider>
      <CommandPaletteShell ctx={ctx} RootList={LongList} />
    </TooltipProvider>
  );
}

useCommandPaletteStore.setState({
  open: true,
  query: "",
  recentIds: [],
  pinnedIds: [],
});

const root = document.querySelector("#root");
if (root === null) throw new Error("anchored dialog cap fixture root missing");
createRoot(root).render(<Fixture />);
