import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerLayoutGroup } from "@/components/settings/panels/layout/composer-layout-group";
import {
  DEFAULT_COMPOSER_LAYOUT,
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
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
}

beforeEach(resetLayout);

afterEach(() => {
  cleanup();
  resetLayout();
  vi.clearAllMocks();
});

// Every id this group tracks must both (a) be the id the click actually
// fires, through the REAL `trackSettingChanged` (not a bare mock standing in
// for it), and (b) be present in the runtime `ANALYTICS_SETTINGS` allowlist -
// a value that is only in the `AnalyticsSetting` type and never added to that
// Set drops the event silently. `sanitizeAnalyticsProperties` is the
// allowlist's own gate (see `src/lib/__tests__/analytics.test.ts`), so
// checking through it here is the same proof that file already relies on.
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

describe("<ComposerLayoutGroup />", () => {
  it("writes Files changed to the store and tracks layout.composer.filesChanged", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<ComposerLayoutGroup />);

    const group = screen.getByRole("group", { name: "Files changed" });
    fireEvent.click(within(group).getByRole("button", { name: "Compact" }));

    expect(useLayoutStore.getState().composer.filesChanged).toBe("compact");
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.composer.filesChanged",
    );
    await expectSettingIdAccepted("layout.composer.filesChanged");
  });

  it("writes Active agents to the store and tracks layout.composer.activeAgents", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<ComposerLayoutGroup />);

    const group = screen.getByRole("group", { name: "Active agents" });
    fireEvent.click(within(group).getByRole("button", { name: "Compact" }));

    expect(useLayoutStore.getState().composer.activeAgents).toBe("compact");
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.composer.activeAgents",
    );
    await expectSettingIdAccepted("layout.composer.activeAgents");
  });

  it("writes Background to the store and tracks layout.composer.background", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<ComposerLayoutGroup />);

    const group = screen.getByRole("group", { name: "Background" });
    fireEvent.click(within(group).getByRole("button", { name: "Compact" }));

    expect(useLayoutStore.getState().composer.background).toBe("compact");
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.composer.background",
    );
    await expectSettingIdAccepted("layout.composer.background");
  });

  it("writes Attach image to the store and tracks layout.composer.attachImage", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<ComposerLayoutGroup />);

    const group = screen.getByRole("group", { name: "Attach image" });
    fireEvent.click(within(group).getByRole("button", { name: "Hidden" }));

    expect(useLayoutStore.getState().composer.attachImage).toBe("hidden");
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.composer.attachImage",
    );
    await expectSettingIdAccepted("layout.composer.attachImage");
  });

  it("writes Access to the store and tracks layout.composer.access", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<ComposerLayoutGroup />);

    const group = screen.getByRole("group", { name: "Access" });
    fireEvent.click(within(group).getByRole("button", { name: "Compact" }));

    expect(useLayoutStore.getState().composer.access).toBe("compact");
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.composer.access",
    );
    await expectSettingIdAccepted("layout.composer.access");
  });

  it("writes Microphone to the store and tracks layout.composer.mic", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<ComposerLayoutGroup />);

    const group = screen.getByRole("group", { name: "Microphone" });
    fireEvent.click(within(group).getByRole("button", { name: "Hidden" }));

    expect(useLayoutStore.getState().composer.mic).toBe("hidden");
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.composer.mic",
    );
    await expectSettingIdAccepted("layout.composer.mic");
  });

  it("writes Compact conversation to the store and tracks layout.composer.compactButton", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<ComposerLayoutGroup />);

    const group = screen.getByRole("group", {
      name: "Compact conversation",
    });
    fireEvent.click(within(group).getByRole("button", { name: "Hidden" }));

    expect(useLayoutStore.getState().composer.compactButton).toBe("hidden");
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.composer.compactButton",
    );
    await expectSettingIdAccepted("layout.composer.compactButton");
  });

  it("does not track or write when the already-active option is clicked again", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<ComposerLayoutGroup />);

    const group = screen.getByRole("group", { name: "Files changed" });
    fireEvent.click(within(group).getByRole("button", { name: "Visible" }));

    expect(useLayoutStore.getState().composer.filesChanged).toBe("visible");
    expect(trackSettingChanged).not.toHaveBeenCalled();
  });
});
