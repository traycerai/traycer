import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useHeaderTabAppearance } from "@/hooks/appearance/use-header-tab-appearance";
import { emptyTabStripLayout, tabRefKey } from "@/stores/tabs/layout";
import { TAB_KINDS } from "@/stores/tabs/registry";
import { useTabsStore } from "@/stores/tabs/store";
import { tabAppearance, type HeaderTab } from "@/stores/tabs/types";

/**
 * The three tiers of a tab's paint, through the real hook and the real store.
 *
 * The sample workspace is the tab that made this matter: its amber cap is a
 * property of the KIND (L-87), and the hook used to replace the whole
 * appearance object with what it found in `customizations`, so a kind that
 * shipped one had it erased on the way to the strip.
 */

const SAMPLE_TAB: HeaderTab = TAB_KINDS["sample-workspace"].build(null);
const SAMPLE_KEY = tabRefKey({
  kind: "sample-workspace",
  id: "sample-workspace",
});

/** What the strip item reads off the tab the hook hands back. */
function painted(tab: HeaderTab): {
  color: string | null;
  icon: string | null;
} {
  const { result } = renderHook(() => useHeaderTabAppearance(tab));
  const resolved = result.current;
  if (resolved === null) throw new Error("the hook dropped the tab");
  const appearance = tabAppearance(resolved);
  return {
    color: appearance?.color ?? null,
    icon: appearance?.icon ?? null,
  };
}

afterEach(() => {
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
});

describe("useHeaderTabAppearance", () => {
  it("keeps a kind's own appearance when the tab has no customization", () => {
    // Read off the kind rather than restated, so this measures whatever the
    // sample tab actually ships.
    expect(tabAppearance(SAMPLE_TAB)?.color).not.toBeNull();

    expect(painted(SAMPLE_TAB).color).toBe(tabAppearance(SAMPLE_TAB)?.color);
  });

  /**
   * No kind ships an `icon` today - the sample workspace sets it `null` and
   * draws its lucide glyph through the separate `icon` field - so this is the
   * hook's CONTRACT rather than a live path. It is pinned because the two
   * fields are one object: an appearance whose colour survives and whose icon
   * is silently dropped is the same bug this hook just had, waiting for the
   * next kind that ships one.
   */
  it("keeps a kind's own icon on the same terms as its colour", () => {
    const badged: HeaderTab = {
      ...SAMPLE_TAB,
      appearance: { color: "var(--warning-foreground)", icon: "🧪" },
    };

    expect(painted(badged).icon).toBe("🧪");
  });

  it("lets a user customization win over the kind's own appearance", () => {
    useTabsStore.setState({
      customizations: {
        [SAMPLE_KEY]: { color: "#81c995", icon: "🚀", groupId: null },
      },
    });

    expect(painted(SAMPLE_TAB)).toEqual({ color: "#81c995", icon: "🚀" });
  });

  it("lets a group's colour win over both", () => {
    useTabsStore.setState({
      customizations: {
        [SAMPLE_KEY]: { color: "#81c995", icon: null, groupId: "group-1" },
      },
      groups: {
        "group-1": { name: "Work", color: "#8ab4f8", collapsed: false },
      },
    });

    expect(painted(SAMPLE_TAB).color).toBe("#8ab4f8");
  });

  it("still paints nothing for a kind that ships no appearance", () => {
    const history = TAB_KINDS.history.build({
      id: "history",
      kind: "history",
      name: "History",
      lastPath: null,
    });
    expect(tabAppearance(history)).toBeNull();

    expect(painted(history)).toEqual({ color: null, icon: null });
  });
});
