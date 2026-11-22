import { render } from "@testing-library/react";
import { navigationSource } from "@/lib/commands/sources/navigation.source";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

export function commandContext(pathname: string): CommandContext {
  return {
    pathname,
    router: {
      getPathname: () => pathname,
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
}

/** The palette's root rows at `pathname`, as of the first render. */
export function captureRoot(pathname: string): ReadonlyArray<CommandItem> {
  let captured: ReadonlyArray<CommandItem> = [];
  function Probe() {
    captured = navigationSource.useItems(commandContext(pathname));
    return null;
  }
  render(<Probe />);
  return captured;
}

/**
 * The settings sub-page at `pathname`, mounted. `latest` is its rows as of the
 * latest render, so a read that moves after mounting shows in it; `offered`
 * is whether `id` was among the rows at each render so far, for a row that
 * must never appear and then go.
 */
export function mountSettingsSubpage(pathname: string): {
  readonly latest: () => ReadonlyArray<CommandItem>;
  readonly offered: (id: string) => ReadonlyArray<boolean>;
} {
  const entry = captureRoot(pathname).find((i) => i.id === "nav:settings");
  if (entry === undefined || entry.subpage === null) {
    throw new Error("settings sub-page entry missing");
  }
  const subpage = entry.subpage;
  const renders: Array<ReadonlyArray<CommandItem>> = [];
  function Probe() {
    renders.push(subpage.useItems(commandContext(pathname)));
    return null;
  }
  render(<Probe />);
  return {
    latest: () => renders[renders.length - 1],
    offered: (id) => renders.map((rows) => rows.some((row) => row.id === id)),
  };
}
