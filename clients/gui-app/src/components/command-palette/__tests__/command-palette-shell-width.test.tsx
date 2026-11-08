/**
 * The modal palette's width and the tooltips on a row the column cuts.
 * A test RootList supplies the long task title; production is not edited
 * to inject one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  CommandPaletteShell,
  RootView,
  type PaletteRootListProps,
} from "@/components/command-palette/command-palette-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";

const LONG_LABEL =
  "Investigate the billing export that truncated the task result title in the command palette";
const LONG_HINT =
  "Northwind Observatory Workstation beside the east window of the studio";

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

const longTask: CommandItem = {
  id: "task-result-long",
  label: LONG_LABEL,
  description: null,
  keywords: ["billing"],
  group: "epics",
  scope: "epics",
  shortcut: null,
  actionId: null,
  run: () => undefined,
  subpage: null,
  hint: LONG_HINT,
};

function LongTitleRootList(props: PaletteRootListProps) {
  return <RootView {...props} items={[longTask]} loading={false} />;
}

function resetStore(): void {
  useCommandPaletteStore.setState({
    open: false,
    query: "",
    recentIds: [],
    pinnedIds: [],
  });
}

/** Radix opens a tooltip from pointermove, after the provider delay. */
function hover(trigger: Element): void {
  vi.useFakeTimers();
  fireEvent.pointerMove(trigger);
  act(() => {
    vi.advanceTimersByTime(1000);
  });
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  cleanup();
  resetStore();
  vi.useRealTimers();
});

function renderOpenPalette(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <CommandPaletteShell ctx={ctx} RootList={LongTitleRootList} />
    </TooltipProvider>,
  );
  act(() => {
    useCommandPaletteStore.getState().setOpen(true);
  });
}

describe("CommandPaletteShell", () => {
  it("widens past the dialog default and tooltips the full task title", async () => {
    renderOpenPalette();

    const label = await screen.findByText(LONG_LABEL);
    const dialog = label.closest('[data-slot="dialog-content"]');
    expect(dialog).not.toBeNull();
    const dialogClasses = dialog?.className.split(" ") ?? [];
    expect(dialogClasses).toContain("flex");
    expect(dialogClasses).toContain("flex-col");
    expect(dialogClasses).toContain("sm:max-w-[min(90vw,40rem)]");
    expect(dialogClasses).not.toContain("sm:max-w-sm");
    const command = dialog?.querySelector("[cmdk-root]");
    expect(command?.classList.contains("min-h-0")).toBe(true);
    const list = screen.getByTestId("command-palette-list");
    expect(list.classList.contains("min-h-0")).toBe(true);
    expect(list.classList.contains("overflow-y-auto")).toBe(true);

    hover(label);
    expect(screen.getByRole("tooltip").textContent).toBe(LONG_LABEL);
  });

  it("tooltips the full hint", async () => {
    renderOpenPalette();

    const hint = await screen.findByText(LONG_HINT);
    hover(hint);
    expect(screen.getByRole("tooltip").textContent).toBe(LONG_HINT);
  });
});
