import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  useComposerLayout,
  useLayoutSetting,
  useStatusBarLayout,
  type LayoutOverride,
} from "@/lib/layout-overrides";
import { LayoutOverrideProvider } from "@/providers/layout-override-provider";
import {
  DEFAULT_COMPOSER_LAYOUT,
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import {
  DEFAULT_MINIMAP_SIDE,
  useSettingsStore,
} from "@/stores/settings/settings-store";

function resetStores(): void {
  useLayoutStore.setState({
    statusBar: DEFAULT_STATUS_BAR_LAYOUT,
    composer: DEFAULT_COMPOSER_LAYOUT,
  });
  useSettingsStore.setState({ chatTurnMinimapSide: DEFAULT_MINIMAP_SIDE });
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  resetStores();
});

/** Renders `read()` in a probe and hands back whatever it returned. */
function readUnder<Value>(
  read: () => Value,
  wrap: (children: ReactNode) => ReactNode,
): Value {
  // A list rather than a `let … | null`: assigning inside the probe is
  // invisible to control-flow narrowing, so the null check afterwards reads as
  // a comparison against a literal `null` type.
  const seen: Value[] = [];
  function Probe(): null {
    seen.push(read());
    return null;
  }
  render(<>{wrap(<Probe />)}</>);
  const value = seen.at(-1);
  if (value === undefined) throw new Error("the probe did not render");
  return value;
}

const bare = (children: ReactNode): ReactNode => children;

function under(value: LayoutOverride) {
  return (children: ReactNode): ReactNode => (
    <LayoutOverrideProvider value={value}>{children}</LayoutOverrideProvider>
  );
}

describe("layout override seam", () => {
  describe("with no provider mounted", () => {
    it("returns the store's own slice object, not a copy", () => {
      // Referential identity is the point: a copy per render would make every
      // consumer of these hooks re-render on every parent render, and the app
      // renders them in the composer and the strip.
      expect(readUnder(useComposerLayout, bare)).toBe(
        useLayoutStore.getState().composer,
      );
      expect(readUnder(useStatusBarLayout, bare)).toBe(
        useLayoutStore.getState().statusBar,
      );
    });

    it("returns the stored value for a settings key", () => {
      useSettingsStore.setState({ chatTurnMinimapSide: "left" });

      expect(
        readUnder(() => useLayoutSetting("chatTurnMinimapSide"), bare),
      ).toBe("left");
    });
  });

  it("draws the override while the store says otherwise", () => {
    expect(useLayoutStore.getState().composer.mic).toBe("visible");

    expect(
      readUnder(useComposerLayout, under({ composer: { mic: "hidden" } })).mic,
    ).toBe("hidden");
    // The store is untouched: an override is a drawing, never a write.
    expect(useLayoutStore.getState().composer.mic).toBe("visible");
  });

  it("leaves every unstated leaf on the stored value", () => {
    useLayoutStore.getState().setComposerAccess("compact");

    const composer = readUnder(
      useComposerLayout,
      under({ composer: { mic: "hidden" } }),
    );

    expect(composer.mic).toBe("hidden");
    expect(composer.access).toBe("compact");
  });

  it("keeps the outer override when an inner one names a different leaf", () => {
    const composer = readUnder(useComposerLayout, (children) => (
      <LayoutOverrideProvider value={{ composer: { mic: "hidden" } }}>
        <LayoutOverrideProvider value={{ composer: { attachImage: "hidden" } }}>
          {children}
        </LayoutOverrideProvider>
      </LayoutOverrideProvider>
    ));

    expect(composer.mic).toBe("hidden");
    expect(composer.attachImage).toBe("hidden");
  });

  it("lets the inner override win on the leaf both name", () => {
    const composer = readUnder(useComposerLayout, (children) => (
      <LayoutOverrideProvider value={{ composer: { mic: "hidden" } }}>
        <LayoutOverrideProvider value={{ composer: { mic: "visible" } }}>
          {children}
        </LayoutOverrideProvider>
      </LayoutOverrideProvider>
    ));

    expect(composer.mic).toBe("visible");
  });

  it("merges the status bar's nested groups leaf by leaf", () => {
    const statusBar = readUnder(useStatusBarLayout, (children) => (
      <LayoutOverrideProvider
        value={{ statusBar: { rateLimits: { showBar: false } } }}
      >
        <LayoutOverrideProvider
          value={{ statusBar: { rateLimits: { showTimer: false } } }}
        >
          {children}
        </LayoutOverrideProvider>
      </LayoutOverrideProvider>
    ));

    // Both overrides survive, and the group's other leaves stay stored.
    expect(statusBar.rateLimits.showBar).toBe(false);
    expect(statusBar.rateLimits.showTimer).toBe(false);
    expect(statusBar.rateLimits.percentMode).toBe(
      DEFAULT_STATUS_BAR_LAYOUT.rateLimits.percentMode,
    );
    expect(statusBar.resources).toBe(DEFAULT_STATUS_BAR_LAYOUT.resources);
  });

  it("overrides a settings key without touching its neighbours", () => {
    useSettingsStore.setState({ chatTurnMinimapSide: "left" });

    expect(
      readUnder(
        () => useLayoutSetting("chatTurnMinimapSide"),
        under({ settings: { chatTurnMinimapSide: "hide" } }),
      ),
    ).toBe("hide");
    expect(
      readUnder(
        () => useLayoutSetting("homeTabEnabled"),
        under({ settings: { chatTurnMinimapSide: "hide" } }),
      ),
    ).toBe(useSettingsStore.getState().homeTabEnabled);
  });
});
