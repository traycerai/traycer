import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SwitcherCategoryTabs } from "@/components/epic-canvas/mobile/switcher-category-tabs";

/**
 * The category bar is a horizontal scroll container, so its `overflow-y` computes to `auto` and ANY vertical spill turns into a real, draggable vertical scroller instead of clipping.
 * It stays flat only because the bar overrides what `ui/tabs` imposes on every list and trigger - the fixed list height, the active-state fill, the indicator offset - and an override lands only when tailwind-merge recognises it as the same utility, which it does only when the two spell their Tailwind modifier the same way.
 */

function classTokens(element: Element): readonly string[] {
  return element.className.split(/\s+/).filter((token) => token.length > 0);
}

/** The utility a Tailwind class ends in, with its variant modifiers stripped. */
function utilityOf(token: string): string {
  return token.replace(/^.*:/, "");
}

/** The `variant:` chain a Tailwind class carries, trailing colon included. */
function modifierOf(token: string): string {
  return token.slice(0, token.length - utilityOf(token).length);
}

function renderBaselineTabs(): { list: HTMLElement; trigger: HTMLElement } {
  const { container } = render(
    <Tabs defaultValue="baseline">
      <TabsList variant="line">
        <TabsTrigger value="baseline">Baseline</TabsTrigger>
      </TabsList>
    </Tabs>,
  );
  // Scoped to this render's own container: a test that renders the baseline
  // AND the bar has two tablists on screen at once.
  const scope = within(container);
  return {
    list: scope.getByRole("tablist"),
    trigger: scope.getByRole("tab", { name: "Baseline" }),
  };
}

function renderCategoryBar(): { list: HTMLElement; trigger: HTMLElement } {
  const { container } = render(
    <Tabs defaultValue="chats">
      <SwitcherCategoryTabs hasPullRequests={false} />
    </Tabs>,
  );
  const scope = within(container);
  return {
    list: scope.getByRole("tablist", { name: "Tab categories" }),
    trigger: scope.getByRole("tab", { name: "Chats" }),
  };
}

describe("<SwitcherCategoryTabs />", () => {
  afterEach(cleanup);

  it("replaces the fixed list height ui/tabs imposes, so nothing spills into the horizontal scroller", () => {
    const baseline = classTokens(renderBaselineTabs().list);
    const imposedHeight = baseline.find((token) =>
      /^h-\d/.test(utilityOf(token)),
    );
    // If `ui/tabs` ever stops sizing its list, this is where that shows up - and the override below has become dead weight rather than load-bearing.
    expect(imposedHeight).toBeDefined();
    if (imposedHeight === undefined) return;

    const bar = classTokens(renderCategoryBar().list);
    expect(bar).not.toContain(imposedHeight);
    expect(bar).toContain(`${modifierOf(imposedHeight)}h-auto`);
  });

  it("gives each trigger a pixel-literal 44px minimum, matching the touch-scope hit slop", () => {
    // Only a px literal makes the fit exact.
    expect(classTokens(renderCategoryBar().trigger)).toContain("min-h-[44px]");
  });

  it("keeps the active trigger fill-less in both themes and carries its own underline on the primitive's active modifier", () => {
    const baseline = classTokens(renderBaselineTabs().trigger);
    // Every fill the primitive can paint on the TRIGGER ITSELF: the light one and the `dark:`-scoped one, which is a separate utility tailwind-merge only replaces when the bar scopes its own the same way.
    const isPseudo = (modifier: string): boolean =>
      modifier.includes("before:") || modifier.includes("after:");
    const imposedFills = baseline.filter(
      (token) =>
        utilityOf(token).startsWith("bg-") &&
        utilityOf(token) !== "bg-transparent" &&
        modifierOf(token).length > 0 &&
        !isPseudo(modifierOf(token)),
    );
    expect(imposedFills.length).toBeGreaterThan(0);

    const bar = classTokens(renderCategoryBar().trigger);
    const activeModifiers: string[] = [];
    for (const fill of imposedFills) {
      // The fill is replaced, not merely competed with: a surviving `bg-background` paints a box wherever the active `--background` differs from the sheet surface.
      expect(bar).not.toContain(fill);
      expect(bar).toContain(`${modifierOf(fill)}bg-transparent`);
      activeModifiers.push(modifierOf(fill));
    }

    // That is the unscoped one - the `dark:` variant would only mark it in one theme.
    const activeModifier = activeModifiers.find(
      (modifier) => !modifier.startsWith("dark:"),
    );
    expect(activeModifier).toBeDefined();
    if (activeModifier === undefined) return;
    expect(bar).toContain(`${activeModifier}before:opacity-100`);
  });

  it("pins the primitive's own indicator flush, so it cannot hang below the trigger", () => {
    const baseline = classTokens(renderBaselineTabs().trigger);
    const imposedOffset = baseline.find(
      (token) =>
        modifierOf(token).includes("after:") &&
        utilityOf(token).startsWith("bottom-"),
    );
    expect(imposedOffset).toBeDefined();
    if (imposedOffset === undefined) return;

    const bar = classTokens(renderCategoryBar().trigger);
    expect(bar).not.toContain(imposedOffset);
    expect(bar).toContain(`${modifierOf(imposedOffset)}bottom-0`);
  });
});
