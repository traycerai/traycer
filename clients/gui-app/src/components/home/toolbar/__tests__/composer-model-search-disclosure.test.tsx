import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CustomizePopover } from "@/components/customize/customize-popover";
import { registerComposerToolbarCustomizeOptions } from "@/lib/customize/options/composer-toolbar-options";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import type { HotspotInstance } from "@/stores/customize/customize-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

/**
 * Wave-3 fixup regression (review w3, should-fix 10): searching "slider"
 * finds `composer.model` at the catalog level (its keywords already include
 * it), but the word only lives inside the composite's `more` item's OPTION
 * labels ("Slider" / "List" on `composer.model.reasoningFooterControl") - not
 * in that item's own id or label ("Picker footer control"). The popover's
 * disclosure match used to check only `item.id`/`item.label`, so Enter opened
 * the popover with "More" still closed even though the catalog found the
 * right setting.
 *
 * `customize-popover.test.tsx` already covers the generic disclosure-match
 * mechanics with a fixture matching on the inner item's own label; this
 * suite is the missing case - matching against an inner CHOICE control's
 * OPTION labels - through the real `composer.model` factory rather than a
 * fixture, so a regression in that specific branch shows up here.
 */

registerComposerToolbarCustomizeOptions();

function modelInstance(): HotspotInstance {
  return {
    key: "composer.model@shell:landing",
    settingId: "composer.model",
    sceneId: "shell",
    tileId: "landing",
    node: document.createElement("div"),
    ghost: false,
    condition: null,
  };
}

function resetStores(): void {
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    popoverKey: null,
    disclosure: null,
    history: { past: [], future: [] },
  });
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  act(() => {
    useCustomizeStore.setState({ session: null });
  });
});

describe("composer.model search disclosure (S10)", () => {
  it("a 'slider' search target opens More even though the word only appears in an inner option's label", () => {
    const instance = modelInstance();
    useCustomizeStore.getState().register(instance);
    // This is exactly what `customize-search.tsx`'s `open()` does on Enter:
    // `openPopover(instance.key, "search", search.query)`.
    useCustomizeStore.setState({
      popoverKey: instance.key,
      disclosure: "slider",
    });
    const rects = new Map([[instance.key, new DOMRect(10, 10, 20, 20)]]);

    render(<CustomizePopover rects={rects} />);

    expect(
      screen
        .getByRole("button", { name: "More" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("a search target matching neither the id/label nor any inner option's label leaves More closed", () => {
    const instance = modelInstance();
    useCustomizeStore.getState().register(instance);
    useCustomizeStore.setState({
      popoverKey: instance.key,
      disclosure: "unrelated-nonsense-query",
    });
    const rects = new Map([[instance.key, new DOMRect(10, 10, 20, 20)]]);

    render(<CustomizePopover rects={rects} />);

    expect(
      screen
        .getByRole("button", { name: "More" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
