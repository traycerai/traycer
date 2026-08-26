import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SwitcherCategoryTabs } from "@/components/epic-canvas/mobile/switcher-category-tabs";

/**
 * The category bar is a horizontal scroll container, so its `overflow-y`
 * computes to `auto` and ANY vertical spill turns into a real, draggable
 * vertical scroller instead of clipping. It stays flat only because the bar
 * overrides what `ui/tabs` imposes on every list and trigger - the fixed list
 * height, the active-state fill, the indicator offset - and an override lands
 * only when tailwind-merge recognises it as the same utility, which it does
 * only when the two spell their Tailwind modifier the same way.
 *
 * That coupling is invisible in the bar's own source: its classes stay valid
 * Tailwind and the component keeps rendering when the primitive re-spells its
 * modifiers, so the overrides silently stop replacing anything and the base
 * comes back. So these assertions never restate the primitive's spelling -
 * they read it off a plain `ui/tabs` render and require the bar to have
 * overridden THAT.
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
    // Positive control: a guard that derives nothing reports success forever.
    // If `ui/tabs` ever stops sizing its list, this is where that shows up -
    // and the override below has become dead weight rather than load-bearing.
    expect(imposedHeight).toBeDefined();
    if (imposedHeight === undefined) return;

    const bar = classTokens(renderCategoryBar().list);
    expect(bar).not.toContain(imposedHeight);
    expect(bar).toContain(`${modifierOf(imposedHeight)}h-auto`);
  });

  it("gives each trigger a pixel-literal 44px minimum, matching the touch-scope hit slop", () => {
    // The slop pseudo in `mobile-shell-touch-targets.css` is `max(100%, 44px)`
    // in REAL pixels; this surface's root font is 15px, so the rem-based
    // `min-h-11` idiom is 41.25px and leaves the pseudo hanging out of the
    // list. Only a px literal makes the fit exact.
    expect(classTokens(renderCategoryBar().trigger)).toContain("min-h-[44px]");
  });

  it("keeps the active trigger fill-less in both themes and carries its own underline on the primitive's active modifier", () => {
    const baseline = classTokens(renderBaselineTabs().trigger);
    // Every fill the primitive can paint on the TRIGGER ITSELF: the light one
    // and the `dark:`-scoped one, which is a separate utility tailwind-merge
    // only replaces when the bar scopes its own the same way. Already-
    // transparent utilities are not a box and need no override, and a pseudo's
    // paint is a different surface - ui/tabs' `after:bg-foreground` indicator
    // is deliberately left alone, since the touch scope neutralises it.
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
      // The fill is replaced, not merely competed with: a surviving
      // `bg-background` paints a box wherever the active `--background` differs
      // from the sheet surface.
      expect(bar).not.toContain(fill);
      expect(bar).toContain(`${modifierOf(fill)}bg-transparent`);
      activeModifiers.push(modifierOf(fill));
    }

    // The bar draws its own `::before` underline because the touch scope claims
    // every trigger's single `::after`. It has to fire on the SAME modifier the
    // primitive uses for active, or the active tab is unmarked. That is the
    // unscoped one - the `dark:` variant would only mark it in one theme.
    const activeModifier = activeModifiers.find(
      (modifier) => !modifier.startsWith("dark:"),
    );
    expect(activeModifier).toBeDefined();
    if (activeModifier === undefined) return;
    expect(bar).toContain(`${activeModifier}before:opacity-100`);
  });

  it("pins the primitive's own indicator flush, so it cannot hang below the trigger", () => {
    // ui/tabs offsets its `::after` indicator BELOW the trigger. On a coarse
    // pointer the touch scope's slop overrides that geometry, but this shell
    // also renders in a narrow desktop window, where nothing does and the
    // offset spills straight back into the scroller.
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
