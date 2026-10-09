import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import type { BarRegionId } from "@/lib/layout/layout-arrangement";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => viewport.mobile,
}));

const openLayoutEditorMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("@/lib/layout/editor-session", () => ({
  openLayoutEditor: openLayoutEditorMock,
}));

import {
  STATUS_BAR_MENU_EXEMPT_ATTRIBUTE,
  StatusBarVisibilityMenu,
  type StatusBarMenuProvider,
} from "@/components/layout/status-bar/status-bar-visibility-menu";

function resetStore(): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  window.localStorage.clear();
  viewport.mobile = false;
}

const PROVIDERS: ReadonlyArray<StatusBarMenuProvider> = [
  { providerId: "codex", label: "Codex" },
  { providerId: "claude-code", label: "Claude Code" },
];

/** What the shipped strip is holding, which is both readings (L-156). */
const BOTH_READINGS: ReadonlyArray<BarRegionId> = [
  "usageLimits",
  "resourceMonitor",
];

function renderMenu(
  providers: ReadonlyArray<StatusBarMenuProvider>,
  regions: ReadonlyArray<BarRegionId>,
) {
  return render(
    <StatusBarVisibilityMenu providers={providers} regions={regions}>
      <div data-testid="status-bar-trigger">status bar</div>
    </StatusBarVisibilityMenu>,
  );
}

function openMenu(): void {
  fireEvent.contextMenu(screen.getByTestId("status-bar-trigger"));
}

beforeEach(resetStore);
afterEach(() => {
  cleanup();
  openLayoutEditorMock.mockClear();
  resetStore();
});

describe("<StatusBarVisibilityMenu />", () => {
  it("reflects store state: every passed provider checked, none hidden by default", () => {
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();

    for (const provider of PROVIDERS) {
      expect(
        screen
          .getByRole("menuitemcheckbox", { name: provider.label })
          .getAttribute("aria-checked"),
      ).toBe("true");
    }
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Resource monitor" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("unchecks a provider already in the hidden deny-list", () => {
    useLayoutStore.getState().setArrangement({
      ...useLayoutStore.getState().arrangement,
      hiddenProviders: ["codex"],
    });
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();

    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Codex" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Claude Code" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("unchecks the resource-monitor item when resources are disabled", () => {
    useLayoutStore
      .getState()
      .setRegionValues("resourceMonitor", { shown: "hidden" });
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();

    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Resource monitor" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("toggles a provider's membership in the hidden deny-list on click", () => {
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Codex" }));

    expect(useLayoutStore.getState().arrangement.hiddenProviders).toEqual([
      "codex",
    ]);
  });

  // The old "Status bar settings…" jump is gone: customizing goes through the
  // one door, on the region this menu is anchored on (L-19).
  it("opens the editor on the usage region from 'Customize layout...'", () => {
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Customize layout..." }),
    );

    expect(openLayoutEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({ entry: "pointer", target: "usageLimits" }),
    );
  });

  it("'Move to tab strip' takes everything the strip is holding, and only that", () => {
    useLayoutStore.getState().setArrangement({
      ...useLayoutStore.getState().arrangement,
      usageHost: "status-bar",
      resourceHost: "status-bar",
      resourceSide: "left",
    });
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Move to tab strip" }),
    );

    // The menu belongs to the STRIP, so it moves the strip's readings - both
    // of them here - and each keeps the end it was on (L-156).
    const { arrangement } = useLayoutStore.getState();
    expect([arrangement.usageHost, arrangement.resourceHost]).toEqual([
      "header",
      "header",
    ]);
    expect([arrangement.usageSide, arrangement.resourceSide]).toEqual([
      "left",
      "left",
    ]);
  });

  it("leaves a reading that is already in the header alone", () => {
    useLayoutStore.getState().setArrangement({
      ...useLayoutStore.getState().arrangement,
      usageHost: "header",
      usageSide: "right",
      resourceHost: "status-bar",
    });
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Move to tab strip" }),
    );

    const { arrangement } = useLayoutStore.getState();
    expect(arrangement.resourceHost).toBe("header");
    expect(arrangement.usageHost).toBe("header");
    expect(arrangement.usageSide).toBe("right");
  });

  it("drops 'Move to tab strip' on a narrow viewport, where it would move nothing", () => {
    // Below `md` the shell answers with `mobileFooter` and ignores `placement`
    // altogether, while the mobile header draws its usage controls whatever
    // `placement` says. The item would write a preference the user cannot see
    // the effect of, and leave it waiting for the next desktop window - so it
    // takes the same gate the Layout page puts on the placement row.
    viewport.mobile = true;
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();

    expect(
      screen.queryByRole("menuitem", { name: "Move to tab strip" }),
    ).toBeNull();
    // The gate is on that one item, not on the menu.
    expect(
      screen.getByRole("menuitem", { name: "Customize layout..." }),
    ).not.toBeNull();
  });

  it("does not open the menu for a right-click on an exempt subtree", () => {
    render(
      <StatusBarVisibilityMenu providers={PROVIDERS} regions={BOTH_READINGS}>
        <div data-testid="status-bar-trigger">
          <button
            type="button"
            data-testid="exempt-child"
            {...{ [STATUS_BAR_MENU_EXEMPT_ATTRIBUTE]: "" }}
          >
            host switcher
          </button>
        </div>
      </StatusBarVisibilityMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("exempt-child"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("still opens the menu for a right-click elsewhere in the trigger", () => {
    render(
      <StatusBarVisibilityMenu providers={PROVIDERS} regions={BOTH_READINGS}>
        <div data-testid="status-bar-trigger">
          <button
            type="button"
            data-testid="exempt-child"
            {...{ [STATUS_BAR_MENU_EXEMPT_ATTRIBUTE]: "" }}
          >
            host switcher
          </button>
          <span data-testid="plain-region">plain</span>
        </div>
      </StatusBarVisibilityMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("plain-region"));
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});

/**
 * The menu's shape as a reader hears it: every item's name in order, with a
 * rule written "|". A rule may only sit BETWEEN two groups that drew
 * something, so none leads, trails or doubles in any state the bar can be in.
 */
function menuShape(): ReadonlyArray<string> {
  return Array.from(screen.getByRole("menu").children).map((child) =>
    child.getAttribute("role") === "separator" ? "|" : child.textContent,
  );
}

function expectNoStrayRule(shape: ReadonlyArray<string>): void {
  expect(shape.at(0)).not.toBe("|");
  expect(shape.at(-1)).not.toBe("|");
  expect(shape.join(",")).not.toContain("|,|");
}

describe("<StatusBarVisibilityMenu /> shape", () => {
  it("offers Usage limits' own switch with the providers under it, then Resource monitor", () => {
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();

    const shape = menuShape();

    expect(shape).toEqual([
      "Usage limits",
      "Codex",
      "Claude Code",
      "Resource monitor",
      "Move to tab strip",
      "|",
      "Customize layout...",
    ]);
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Usage limits" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expectNoStrayRule(shape);
  });

  it("puts the providers on their own where this bar does not draw Usage limits", () => {
    renderMenu(PROVIDERS, ["resourceMonitor"]);
    openMenu();

    const shape = menuShape();

    expect(shape).toEqual([
      "Resource monitor",
      "Codex",
      "Claude Code",
      "Move to tab strip",
      "|",
      "Customize layout...",
    ]);
    expectNoStrayRule(shape);
  });

  it.each([
    {
      name: "no providers on the desktop layout",
      mobile: false,
      providers: [],
      regions: BOTH_READINGS,
      expected: [
        "Usage limits",
        "Resource monitor",
        "Move to tab strip",
        "|",
        "Customize layout...",
      ],
    },
    {
      name: "a narrow viewport with providers only",
      mobile: true,
      providers: PROVIDERS,
      regions: [],
      expected: ["Codex", "Claude Code", "|", "Customize layout..."],
    },
    {
      name: "a narrow viewport with no providers and a bar drawing nothing",
      mobile: true,
      providers: [],
      regions: [],
      expected: ["Customize layout..."],
    },
    {
      name: "a narrow viewport with one reading and no providers",
      mobile: true,
      providers: [],
      regions: ["resourceMonitor"],
      expected: ["Resource monitor", "|", "Customize layout..."],
    },
    {
      name: "the desktop layout with nothing else to offer",
      mobile: false,
      providers: [],
      regions: [],
      expected: ["Move to tab strip", "|", "Customize layout..."],
    },
  ] satisfies ReadonlyArray<{
    name: string;
    mobile: boolean;
    providers: ReadonlyArray<StatusBarMenuProvider>;
    regions: ReadonlyArray<BarRegionId>;
    expected: ReadonlyArray<string>;
  }>)("draws a rule only between two groups: $name", (scenario) => {
    viewport.mobile = scenario.mobile;
    renderMenu(scenario.providers, scenario.regions);
    openMenu();

    const shape = menuShape();

    expect(shape).toEqual(scenario.expected);
    expectNoStrayRule(shape);
  });
});

describe("<StatusBarVisibilityMenu /> while another window holds the editor (T6)", () => {
  afterEach(() => {
    useLayoutEditorStore.setState({ lockedBy: "none" });
  });

  it("disables 'Customize layout...' and describes it with the reason", () => {
    useLayoutEditorStore.setState({ lockedBy: "other-window" });
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();

    const item = screen.getByRole("menuitem", { name: "Customize layout..." });

    expect(item.getAttribute("aria-disabled")).toBe("true");
    const describedBy = item.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(
      describedBy === null
        ? null
        : document.getElementById(describedBy)?.textContent,
    ).toBe("Open in another window. Your layout is saved there.");

    fireEvent.click(item);
    expect(openLayoutEditorMock).not.toHaveBeenCalled();
  });

  it("is a plain, enabled item with no description while the editor is free", () => {
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();

    const item = screen.getByRole("menuitem", { name: "Customize layout..." });

    expect(item.getAttribute("aria-disabled")).toBeNull();
    expect(item.getAttribute("aria-describedby")).toBeNull();
  });
});

/**
 * L-159: the menu names what the BAR is drawing. Since L-156 either reading
 * can be in the top bar, where it carries its own menu, so a menu keyed on a
 * literal offered verbs for a region nowhere near the pointer and a switch
 * over a readout drawn in the other bar.
 */
describe("<StatusBarVisibilityMenu /> names what the bar holds (L-159)", () => {
  it("offers the monitor's switch only while the monitor is in this bar", () => {
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Resource monitor" }),
    ).not.toBeNull();
    cleanup();

    renderMenu(PROVIDERS, ["usageLimits"]);
    openMenu();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Resource monitor" }),
    ).toBeNull();
  });

  it("offers one way into the editor however many readings it names", () => {
    renderMenu(PROVIDERS, BOTH_READINGS);
    openMenu();

    // Two regions, one door: "Customize layout..." names a screen, and a menu
    // listing it twice would be the same door under two labels.
    expect(
      screen.getAllByRole("menuitem", { name: "Customize layout..." }),
    ).toHaveLength(1);
  });
});
