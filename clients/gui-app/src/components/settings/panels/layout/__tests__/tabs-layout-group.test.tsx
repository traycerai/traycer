import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabsLayoutGroup } from "@/components/settings/panels/layout/tabs-layout-group";
import { SETTINGS_SEARCH_ENTRIES } from "@/lib/settings-search/settings-search-entries";
import {
  DEFAULT_HOME_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    trackSettingChanged: vi.fn(actual.trackSettingChanged),
  };
});

function resetLayout(): void {
  useLayoutStore.setState({ home: DEFAULT_HOME_LAYOUT });
}

beforeEach(resetLayout);

afterEach(() => {
  cleanup();
  resetLayout();
  vi.clearAllMocks();
});

// The same two-part proof `composer-layout-group.test.tsx` relies on: the id
// the click actually fires, through the REAL `trackSettingChanged`, and that
// id's presence in the runtime `ANALYTICS_SETTINGS` allowlist, which is what
// `sanitizeAnalyticsProperties` gates. An id that lives only in the
// `AnalyticsSetting` type drops the event silently.
async function expectSettingIdAccepted(setting: string): Promise<void> {
  const { AnalyticsEvent, sanitizeAnalyticsProperties } =
    await import("@/lib/analytics");
  expect(
    sanitizeAnalyticsProperties(AnalyticsEvent.SettingChanged, {
      source: "direct_ui",
      section: "layout",
      setting,
    }),
  ).toEqual({ source: "direct_ui", section: "layout", setting });
}

const DENSITY_DESCRIPTION =
  "Row spacing on the Home tab. Compact keeps touch targets on phones.";

describe("<TabsLayoutGroup /> Home density", () => {
  it("writes Compact to the store and tracks layout.home.density", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<TabsLayoutGroup />);

    const group = screen.getByRole("group", { name: "Home density" });
    fireEvent.click(within(group).getByRole("button", { name: "Compact" }));

    expect(useLayoutStore.getState().home.density).toBe("compact");
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.home.density",
    );
    await expectSettingIdAccepted("layout.home.density");
  });

  it("starts on Comfortable and returns to it", () => {
    render(<TabsLayoutGroup />);
    const group = screen.getByRole("group", { name: "Home density" });
    expect(
      within(group)
        .getByRole("button", { name: "Comfortable" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(within(group).getByRole("button", { name: "Compact" }));
    fireEvent.click(within(group).getByRole("button", { name: "Comfortable" }));
    expect(useLayoutStore.getState().home.density).toBe("comfortable");
  });

  it("does not track or write when the already-active option is clicked again", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<TabsLayoutGroup />);

    const group = screen.getByRole("group", { name: "Home density" });
    fireEvent.click(within(group).getByRole("button", { name: "Comfortable" }));

    expect(useLayoutStore.getState().home.density).toBe("comfortable");
    expect(trackSettingChanged).not.toHaveBeenCalled();
  });

  it("carries the anchor settings search scrolls to, with the row's own copy", () => {
    const { container } = render(<TabsLayoutGroup />);
    const row = container.querySelector(
      "[data-settings-anchor='layout-home-density']",
    );
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Home density");
    expect(row?.textContent).toContain(DENSITY_DESCRIPTION);
  });

  // The index is hand-written, so the label and description are what rot -
  // the anchor half is covered by `settings-search-index.test.ts`.
  it("is indexed under Tabs with the verbatim label and description", () => {
    const entry = SETTINGS_SEARCH_ENTRIES.find(
      (candidate) => candidate.anchor === "layout-home-density",
    );
    expect(entry).toBeDefined();
    expect(entry?.section).toBe("layout");
    expect(entry?.group).toBe("Tabs");
    expect(entry?.label).toBe("Home density");
    expect(entry?.description).toBe(DENSITY_DESCRIPTION);
    expect(entry?.keywords).toEqual(["home", "density", "compact", "rows"]);
  });

  // The view is written by the page's own control, so Settings must not grow a
  // second answer to the same question.
  it("offers no row for the Home view", () => {
    render(<TabsLayoutGroup />);
    expect(screen.queryByRole("group", { name: "Home view" })).toBeNull();
    expect(
      SETTINGS_SEARCH_ENTRIES.some(
        (candidate) => candidate.anchor === "layout-home-view",
      ),
    ).toBe(false);
  });
});
