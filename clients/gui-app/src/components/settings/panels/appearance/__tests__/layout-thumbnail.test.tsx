import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LayoutThumbnail } from "@/components/settings/panels/appearance/layout-thumbnail";
import { layoutOverrideForPreset } from "@/lib/layout-presets";
import { LayoutOverrideProvider } from "@/providers/layout-override-provider";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

function reset(): void {
  useLayoutStore.setState({
    statusBar: DEFAULT_STATUS_BAR_LAYOUT,
    composer: DEFAULT_COMPOSER_LAYOUT,
  });
  useCustomizeStore.setState({ session: null, instances: new Map() });
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

const MIC = "Start voice input";

describe("<LayoutThumbnail />", () => {
  it("draws the stored layout when nothing overrides it", () => {
    render(<LayoutThumbnail />);

    expect(screen.getByRole("button", { name: MIC })).toBeTruthy();
    expect(screen.queryAllByTestId("customize-dock-picture")).toHaveLength(0);
  });

  it("follows the store live", () => {
    const { rerender } = render(<LayoutThumbnail />);
    expect(screen.getByRole("button", { name: MIC })).toBeTruthy();

    useLayoutStore.getState().setComposerMic("hidden");
    rerender(<LayoutThumbnail />);

    expect(screen.queryByRole("button", { name: MIC })).toBeNull();
  });

  it("draws Compact as chips with no dictation button, without applying it", () => {
    render(
      <LayoutOverrideProvider value={layoutOverrideForPreset("compact")}>
        <LayoutThumbnail />
      </LayoutOverrideProvider>,
    );

    expect(screen.getAllByTestId("customize-dock-picture")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: MIC })).toBeNull();
    // A picture, not an edit: the store still holds the default.
    expect(useLayoutStore.getState().composer.mic).toBe("visible");
    expect(useLayoutStore.getState().composer.filesChanged).toBe("visible");
  });

  it("draws Detailed with open dock rows and every button", () => {
    render(
      <LayoutOverrideProvider value={layoutOverrideForPreset("detailed")}>
        <LayoutThumbnail />
      </LayoutOverrideProvider>,
    );

    expect(screen.queryAllByTestId("customize-dock-picture")).toHaveLength(0);
    expect(screen.getByRole("button", { name: MIC })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach image" })).toBeTruthy();
  });

  it("honours a stored order under a preset that carries none", () => {
    useLayoutStore
      .getState()
      .setComposerDockOrder(["background", "activeAgents", "filesChanged"]);
    render(
      <LayoutOverrideProvider value={layoutOverrideForPreset("compact")}>
        <LayoutThumbnail />
      </LayoutOverrideProvider>,
    );

    expect(screen.getAllByTestId("customize-dock-picture")).toHaveLength(3);
  });

  it("registers no hotspot while a Customize session is running", () => {
    useCustomizeStore.setState({
      session: {
        scene: "in-place",
        opener: { kind: "none" },
        startedAt: Date.now(),
      },
    });

    render(
      <LayoutOverrideProvider value={layoutOverrideForPreset("detailed")}>
        <LayoutThumbnail />
      </LayoutOverrideProvider>,
    );

    expect(useCustomizeStore.getState().instances.size).toBe(0);
  });
});
