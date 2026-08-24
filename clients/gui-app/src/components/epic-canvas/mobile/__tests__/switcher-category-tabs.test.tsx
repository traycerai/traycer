import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SwitcherCategoryTabs } from "@/components/epic-canvas/mobile/switcher-category-tabs";

/**
 * The category bar is a horizontal scroll container, so its `overflow-y`
 * computes to `auto` and ANY vertical spill turns into a real, draggable
 * vertical scroller instead of clipping. It stays flat only because the bar
 * overrides two things `ui/tabs` imposes on every list - the fixed list height
 * and the active-state fill - and an override lands only when tailwind-merge
 * recognises it as the same utility, which it does only when the two spell
 * their Tailwind modifier the same way.
 *
 * That coupling is invisible in the bar's own source: its classes stay valid
 * Tailwind and the component keeps rendering when the primitive re-spells its
 * modifiers, so the overrides silently stop replacing anything and the base
 * height comes back. So these assertions never restate the primitive's
 * spelling - they read it off a plain `ui/tabs` render and require the bar to
 * have overridden THAT.
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

function renderBaselineTabs(): { list: Element; trigger: Element } {
  const { container } = render(
    <Tabs defaultValue="baseline">
      <TabsList variant="line">
        <TabsTrigger value="baseline">Baseline</TabsTrigger>
      </TabsList>
    </Tabs>,
  );
  const list = container.querySelector('[data-slot="tabs-list"]');
  const trigger = container.querySelector('[data-slot="tabs-trigger"]');
  if (list === null || trigger === null)
    throw new Error("ui/tabs rendered no list/trigger");
  return { list, trigger };
}

function renderCategoryBar(): { list: Element; trigger: Element } {
  const { container } = render(
    <Tabs defaultValue="chats">
      <SwitcherCategoryTabs hasPullRequests={false} />
    </Tabs>,
  );
  const list = container.querySelector('[data-slot="tabs-list"]');
  const trigger = container.querySelector(
    '[data-testid="mobile-switcher-tab-chats"]',
  );
  if (list === null || trigger === null)
    throw new Error("category bar rendered no list/trigger");
  return { list, trigger };
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

  it("keeps the active trigger fill-less and carries its own underline on the primitive's active modifier", () => {
    const baseline = classTokens(renderBaselineTabs().trigger);
    const activeFill = baseline.find(
      (token) =>
        utilityOf(token) === "bg-background" && modifierOf(token).length > 0,
    );
    expect(activeFill).toBeDefined();
    if (activeFill === undefined) return;
    const activeModifier = modifierOf(activeFill);

    const bar = classTokens(renderCategoryBar().trigger);
    // The fill is replaced, not merely competed with: a surviving
    // `bg-background` paints a box wherever the active `--background` differs
    // from the sheet surface.
    expect(bar).not.toContain(activeFill);
    expect(bar).toContain(`${activeModifier}bg-transparent`);
    // The bar draws its own `::before` underline because the touch scope claims
    // every trigger's single `::after`. It has to fire on the SAME modifier the
    // primitive uses for active, or the active tab is unmarked.
    expect(bar).toContain(`${activeModifier}before:opacity-100`);
  });
});
