import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  useArrangementValue,
  useReadingWidthStyle,
  useRegionDensity,
  useRegionShown,
  useRegionValue,
  useRegionValues,
  type LayoutOverride,
} from "@/lib/layout-overrides";
import { LayoutOverrideProvider } from "@/providers/layout-override-provider";
import { PRESET_VALUES } from "@/lib/layout/layout-presets";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

function resetStore(): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutEditorStore.getState().endSession();
  window.localStorage.clear();
}

beforeEach(resetStore);
afterEach(() => {
  cleanup();
  resetStore();
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
    it("returns the effective value of a region", () => {
      act(() => {
        useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
      });

      expect(readUnder(() => useRegionValues("mic"), bare)).toEqual({
        shown: "hidden",
      });
      expect(readUnder(() => useRegionShown("mic"), bare)).toBe(false);
    });

    it("falls back to the base preset for an untouched region", () => {
      expect(readUnder(() => useRegionValue("model", "style"), bare)).toBe(
        PRESET_VALUES[DEFAULT_LAYOUT_SNAPSHOT.basePreset].model.style,
      );
    });

    it("returns the stored arrangement field", () => {
      act(() => {
        useLayoutStore.getState().setArrangement({
          ...useLayoutStore.getState().arrangement,
          minimapSide: "left",
        });
      });

      expect(readUnder(() => useArrangementValue("minimapSide"), bare)).toBe(
        "left",
      );
    });
  });

  it("reads each reading's density, auto until one is chosen", () => {
    expect(readUnder(() => useRegionDensity("usageLimits"), bare)).toBe("auto");

    act(() => {
      useLayoutStore
        .getState()
        .setRegionValues("resourceMonitor", { density: "detailed" });
    });

    expect(readUnder(() => useRegionDensity("resourceMonitor"), bare)).toBe(
      "detailed",
    );
    expect(readUnder(() => useRegionDensity("usageLimits"), bare)).toBe("auto");
    expect(
      readUnder(
        () => useRegionDensity("resourceMonitor"),
        under({ values: { resourceMonitor: { density: "compact" } } }),
      ),
    ).toBe("compact");
  });

  it("draws the override while the store says otherwise", () => {
    expect(readUnder(() => useRegionShown("mic"), bare)).toBe(true);

    expect(
      readUnder(
        () => useRegionShown("mic"),
        under({ values: { mic: { shown: "hidden" } } }),
      ),
    ).toBe(false);
    // The store is untouched: an override is a drawing, never a write.
    expect(useLayoutStore.getState().overrides.mic).toBeUndefined();
  });

  it("leaves every unstated leaf on the stored value", () => {
    act(() => {
      useLayoutStore
        .getState()
        .setRegionValues("changedFiles", { size: "chip" });
    });

    const changedFiles = readUnder(
      () => useRegionValues("changedFiles"),
      under({ values: { changedFiles: { shown: "hidden" } } }),
    );

    expect(changedFiles.shown).toBe("hidden");
    expect(changedFiles.size).toBe("chip");
  });

  it("keeps the outer override when an inner one names a different leaf", () => {
    const changedFiles = readUnder(
      () => useRegionValues("changedFiles"),
      (children) => (
        <LayoutOverrideProvider
          value={{ values: { changedFiles: { size: "chip" } } }}
        >
          <LayoutOverrideProvider
            value={{ values: { changedFiles: { shown: "hidden" } } }}
          >
            {children}
          </LayoutOverrideProvider>
        </LayoutOverrideProvider>
      ),
    );

    expect(changedFiles.size).toBe("chip");
    expect(changedFiles.shown).toBe("hidden");
  });

  it("keeps the outer override when an inner one names a different region", () => {
    const wrap = (children: ReactNode): ReactNode => (
      <LayoutOverrideProvider value={{ values: { mic: { shown: "hidden" } } }}>
        <LayoutOverrideProvider
          value={{ values: { minimap: { shown: "hidden" } } }}
        >
          {children}
        </LayoutOverrideProvider>
      </LayoutOverrideProvider>
    );

    expect(readUnder(() => useRegionShown("mic"), wrap)).toBe(false);
    expect(readUnder(() => useRegionShown("minimap"), wrap)).toBe(false);
  });

  it("lets the inner override win on the leaf both name", () => {
    const model = readUnder(
      () => useRegionValues("model"),
      (children) => (
        <LayoutOverrideProvider
          value={{ values: { model: { style: "bars" } } }}
        >
          <LayoutOverrideProvider
            value={{ values: { model: { style: "text" } } }}
          >
            {children}
          </LayoutOverrideProvider>
        </LayoutOverrideProvider>
      ),
    );

    expect(model.style).toBe("text");
  });

  it("merges the arrangement field by field", () => {
    // One field per read, because that is the only way the seam is read now:
    // a whole-arrangement hook made every consumer of one edge rerender on any
    // other field's write (G1-12, G1-21). Nesting still merges, and a field
    // nobody overrode still comes through by identity from the store.
    const nested = (children: ReactNode): ReactNode => (
      <LayoutOverrideProvider value={{ arrangement: { minimapSide: "left" } }}>
        <LayoutOverrideProvider
          value={{ arrangement: { resourceSide: "left" } }}
        >
          {children}
        </LayoutOverrideProvider>
      </LayoutOverrideProvider>
    );

    expect(readUnder(() => useArrangementValue("minimapSide"), nested)).toBe(
      "left",
    );
    expect(readUnder(() => useArrangementValue("resourceSide"), nested)).toBe(
      "left",
    );
    expect(readUnder(() => useArrangementValue("dock"), nested)).toBe(
      useLayoutStore.getState().arrangement.dock,
    );
  });

  describe("leaf hooks subscribe to one field", () => {
    it("does not rerender when another region changes", () => {
      // The regression this pins: routing one-field readers through a
      // whole-store read made the mic button rerender whenever any other
      // region changed - an element on screen all day, rerendering on a value
      // about a different element.
      let renders = 0;
      function MicProbe(): null {
        useRegionValue("mic", "shown");
        renders += 1;
        return null;
      }
      render(<MicProbe />);
      const before = renders;

      act(() => {
        useLayoutStore.getState().setRegionValues("access", { size: "chip" });
      });

      expect(renders).toBe(before);

      // …and it still rerenders for its OWN region, or the hook would be
      // useless.
      act(() => {
        useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
      });
      expect(renders).toBeGreaterThan(before);
    });

    it("does not rerender an arrangement reader when a values region changes", () => {
      let renders = 0;
      function SideProbe(): null {
        useArrangementValue("minimapSide");
        renders += 1;
        return null;
      }
      render(<SideProbe />);
      const before = renders;

      act(() => {
        useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
      });

      expect(renders).toBe(before);
    });
  });

  describe("useReadingWidthStyle", () => {
    it("returns the static class for comfortable, with no maxWidth", () => {
      const result = readUnder(() => useReadingWidthStyle(), bare);

      expect(result.className).toBe("[--md-block-measure:none] max-w-3xl");
      expect(result.maxWidth).toBeUndefined();
    });

    it("returns a viewport-clamped maxWidth for wide, with only the measure hand-off", () => {
      act(() => {
        useLayoutStore.getState().setArrangement({
          ...useLayoutStore.getState().arrangement,
          readingWidth: "wide",
        });
      });

      const result = readUnder(() => useReadingWidthStyle(), bare);

      // No fixed column, but `.md-prose`'s 72ch block cap still stands down:
      // left in place it capped every paragraph at 72ch however wide this went.
      expect(result.className).toBe("[--md-block-measure:none]");
      // 1024 is DEFAULT_ARRANGEMENT.wideReadingWidthPx, left untouched here.
      expect(result.maxWidth).toBe("min(1024px, calc(100vw - 24px))");
    });

    it("reflects a chosen wide width in the viewport clamp", () => {
      act(() => {
        useLayoutStore.getState().setArrangement({
          ...useLayoutStore.getState().arrangement,
          readingWidth: "wide",
          wideReadingWidthPx: 1600,
        });
      });

      const result = readUnder(() => useReadingWidthStyle(), bare);

      expect(result.maxWidth).toBe("min(1600px, calc(100vw - 24px))");
    });

    it("respects a LayoutOverrideProvider arrangement override", () => {
      const result = readUnder(
        () => useReadingWidthStyle(),
        under({ arrangement: { readingWidth: "wide" } }),
      );

      expect(result.className).toBe("[--md-block-measure:none]");
      expect(result.maxWidth).toBe("min(1024px, calc(100vw - 24px))");
      // The store is untouched: an override is a drawing, never a write.
      expect(useLayoutStore.getState().arrangement.readingWidth).toBe(
        "comfortable",
      );
    });
  });
});
