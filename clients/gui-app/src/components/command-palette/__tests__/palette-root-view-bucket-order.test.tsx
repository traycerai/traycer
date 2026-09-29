import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Command, CommandInput, CommandList } from "@/components/ui/command";
import { RootView } from "@/components/command-palette/command-palette-shell";
import { paletteFilter } from "@/components/command-palette/palette-cmdk-controller";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

/**
 * Item 5: with a non-empty query, `RootView` orders its buckets by their best
 * `paletteFilter` score ACROSS groups (C15) rather than by the fixed
 * "Tasks before Actions" default order - cmdk 1.1.1 never reorders groups
 * itself (it looks each one up by a generated id against a `data-value` that
 * holds the heading, so it never finds one and the DOM order the renderer
 * chose stands).
 */

function ctx(): CommandContext {
  return {
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
}

function epicItem(id: string, label: string): CommandItem {
  return {
    id,
    label,
    description: null,
    keywords: [],
    group: "epics",
    scope: "epics",
    shortcut: null,
    actionId: null,
    run: () => undefined,
    subpage: null,
  };
}

function customizeLayoutItem(): CommandItem {
  return {
    id: "customize:layout",
    label: "Customize layout",
    description: "Arrange your layout using sample content.",
    keywords: ["layout", "customize", "appearance", "chrome", "arrange"],
    group: "actions",
    scope: "actions",
    shortcut: null,
    actionId: null,
    run: () => undefined,
    subpage: null,
  };
}

function layoutSettingsItem(): CommandItem {
  return {
    id: "customize:layout-settings",
    label: "Layout settings",
    description: "Open Settings, Layout.",
    keywords: ["layout", "settings", "appearance", "chrome"],
    group: "actions",
    scope: "actions",
    shortcut: null,
    actionId: null,
    run: () => undefined,
    subpage: null,
  };
}

function navigationItem(): CommandItem {
  return {
    id: "nav:settings",
    label: "Open Settings",
    description: null,
    keywords: ["settings", "preferences"],
    group: "navigation",
    scope: "actions",
    shortcut: null,
    actionId: null,
    run: () => undefined,
    subpage: null,
  };
}

const ITEMS: ReadonlyArray<CommandItem> = [
  epicItem("epic:1", "Visual Layout Editor Redesign"),
  epicItem("epic:2", "Artifact Sidebar Layout Fix"),
  customizeLayoutItem(),
  layoutSettingsItem(),
  navigationItem(),
];

function Harness(props: { readonly initialQuery: string }): ReactNode {
  const [query, setQuery] = useState(props.initialQuery);
  return (
    <Command scoreItem={paletteFilter} label="Search commands">
      <CommandInput
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search commands"
      />
      <CommandList>
        <RootView
          items={ITEMS}
          loading={false}
          ctx={ctx()}
          effectiveQuery={query}
          effectiveScope={null}
          pinnedIds={[]}
          recentIds={[]}
          onSelect={() => undefined}
          onTogglePin={() => undefined}
        />
      </CommandList>
    </Command>
  );
}

/** The group headings cmdk renders, top to bottom. */
function groupHeadings(): ReadonlyArray<string | null> {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-slot="command-group-heading"]',
    ),
  ).map((el) => el.textContent);
}

function selectedRowLabel(): string | null {
  const selected = document.querySelector<HTMLElement>(
    '[data-slot="command-item"][data-selected="true"]',
  );
  return selected?.textContent ?? null;
}

afterEach(() => {
  cleanup();
});

describe("<RootView /> bucket order (C15)", () => {
  it("keeps the default group order - Tasks before Actions - at rest", () => {
    render(<Harness initialQuery="" />);

    expect(groupHeadings()).toEqual(["Tasks", "Actions", "Navigation"]);
  });

  it("puts Actions first and selects Customize layout for a 'layout' query", () => {
    render(<Harness initialQuery="" />);

    fireEvent.change(
      screen.getByRole("combobox", { name: "Search commands" }),
      {
        target: { value: "layout" },
      },
    );

    const headings = groupHeadings();
    expect(headings[0]).toBe("Actions");
    expect(headings.indexOf("Actions")).toBeLessThan(headings.indexOf("Tasks"));
    expect(selectedRowLabel()).toContain("Customize layout");
  });
});

/**
 * `palette-item-row.tsx` dropped its `hover:` fill classes: cmdk already
 * highlights the row under a moving pointer via `data-selected`, so a hover
 * fill only ever painted a SECOND highlight on whatever row a resting
 * pointer sat over when the palette opened or the list reordered.
 */
describe("<PaletteItemRow /> has no hover fill of its own", () => {
  it("carries no hover: class on any row, only the data-selected highlight", () => {
    render(<Harness initialQuery="" />);

    const rows = document.querySelectorAll<HTMLElement>(
      '[data-slot="command-item"]',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.className).not.toMatch(/(?:^|\s)hover:/);
    }
  });
});
