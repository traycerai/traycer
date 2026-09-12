import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { domAnimation, LazyMotion } from "motion/react";
import type { ReactElement } from "react";
import { ContextUsagePreview } from "@/components/settings/panels/layout/context-usage-preview";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import {
  DEFAULT_CONTEXT_INDICATOR_STYLE,
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
  useSettingsStore,
  type ContextBreakdownField,
} from "@/stores/settings/settings-store";

/**
 * The app mounts `LazyMotion` at its root, so the pinned strip's animated
 * percentage has its features there. Nothing else about a chat is provided -
 * that is the point of this suite.
 */
function renderPreview(ui: ReactElement) {
  return render(<LazyMotion features={domAnimation}>{ui}</LazyMotion>);
}

function resetStores(): void {
  window.localStorage.clear();
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  useSettingsStore.setState({
    pinContextUsageBreakdown: false,
    pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    contextIndicatorStyle: DEFAULT_CONTEXT_INDICATOR_STYLE,
  });
}

/** One selection and the labels the strip should print for it, in strip order. */
const FIELD_CASES: ReadonlyArray<
  readonly [ReadonlyArray<ContextBreakdownField>, ReadonlyArray<string>]
> = [
  [["used"], ["Used"]],
  [
    ["cacheRead", "output"],
    ["Cache read", "Output"],
  ],
  [
    ["fresh", "used", "cacheWrite"],
    ["Used", "Fresh", "Cache write"],
  ],
];

/** Every field, with the label the strip prints for it. */
const FIELD_TOGGLE_CASES: ReadonlyArray<
  readonly [ContextBreakdownField, string]
> = [
  ["used", "Used"],
  ["fresh", "Fresh"],
  ["cacheRead", "Cache read"],
  ["cacheWrite", "Cache write"],
  ["output", "Output"],
];

function pinnedFieldLabels(): string[] {
  const details = screen.getByTestId("context-usage-pinned-details");
  return Array.from(details.children).map(
    (row) => row.firstElementChild?.textContent ?? "",
  );
}

beforeEach(resetStores);

afterEach(() => {
  cleanup();
  resetStores();
});

describe("<ContextUsagePreview />", () => {
  it("renders the sample reading in an inert, hidden frame with its caption", () => {
    renderPreview(<ContextUsagePreview />);

    const frame = screen.getByTestId("context-usage-preview-frame");
    // A picture of the strip, not the strip: the controls in it are configured
    // by the rows below, so they are out of the tab order and unannounced.
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(within(frame).getByTestId("context-usage-chip").textContent).toBe(
      "5% context left",
    );
    expect(
      screen.getByTestId("context-usage-preview-caption").textContent,
    ).toBe("Sample figures — the real strip reads the open chat's usage.");
  });

  it("needs no chat, host client or query provider to render", () => {
    // The whole justification for rendering the real chip here: its only
    // inputs are the usage it is handed and the settings stores.
    expect(() => renderPreview(<ContextUsagePreview />)).not.toThrow();
    expect(screen.getByTestId("context-usage-chip")).toBeTruthy();
  });

  it("follows the pin switch into the pinned strip", () => {
    useSettingsStore.setState({ pinContextUsageBreakdown: true });
    renderPreview(<ContextUsagePreview />);

    const strip = screen.getByTestId("context-usage-pinned-strip");
    expect(
      within(strip).getByTestId("context-usage-pinned-primary").textContent,
    ).toMatch(/Context\s+5%/);
    expect(within(strip).getByText("947K / 1M")).toBeTruthy();
    expect(screen.queryByTestId("context-usage-chip")).toBeNull();
  });

  it("prints every field of the sample by default", () => {
    useSettingsStore.setState({ pinContextUsageBreakdown: true });
    renderPreview(<ContextUsagePreview />);

    // The sample carries both cache figures on purpose, so each chip in the
    // Fields row has a row in here to take away.
    expect(pinnedFieldLabels()).toEqual([
      "Used",
      "Fresh",
      "Cache read",
      "Cache write",
      "Output",
    ]);
    const strip = screen.getByTestId("context-usage-pinned-strip");
    expect(within(strip).getByText("56")).toBeTruthy();
    expect(within(strip).getByText("945.8k")).toBeTruthy();
    expect(within(strip).getByText("1.1k")).toBeTruthy();
    expect(within(strip).getByText("3")).toBeTruthy();
  });

  it.each(FIELD_CASES)(
    "prints the selected fields %j in strip order",
    (fields, labels) => {
      useSettingsStore.setState({
        pinContextUsageBreakdown: true,
        pinnedContextBreakdownFields: fields,
      });
      renderPreview(<ContextUsagePreview />);

      expect(pinnedFieldLabels()).toEqual(labels);
    },
  );

  it.each(FIELD_TOGGLE_CASES)(
    "drops and restores %s live, through the store's own toggle",
    (field, label) => {
      useSettingsStore.setState({ pinContextUsageBreakdown: true });
      renderPreview(<ContextUsagePreview />);
      const withEveryField = pinnedFieldLabels();
      expect(withEveryField).toContain(label);

      act(() => {
        useSettingsStore.getState().togglePinnedContextBreakdownField(field);
      });
      expect(pinnedFieldLabels()).toEqual(
        withEveryField.filter((printed) => printed !== label),
      );

      // Back on, and back in canonical order rather than appended - the same
      // strip the reader started from.
      act(() => {
        useSettingsStore.getState().togglePinnedContextBreakdownField(field);
      });
      expect(pinnedFieldLabels()).toEqual(withEveryField);
    },
  );

  it("follows the indicator style through all three shapes", () => {
    renderPreview(<ContextUsagePreview />);
    expect(screen.getByTestId("context-usage-chip").textContent).toBe(
      "5% context left",
    );
    expect(screen.queryByTestId("context-usage-ring")).toBeNull();

    act(() => {
      useSettingsStore.getState().setContextIndicatorStyle("ring");
    });
    expect(screen.getByTestId("context-usage-ring-value").textContent).toBe(
      "5",
    );

    act(() => {
      useSettingsStore.getState().setContextIndicatorStyle("ring-only");
    });
    expect(screen.getByTestId("context-usage-ring")).toBeTruthy();
    expect(screen.queryByTestId("context-usage-ring-value")).toBeNull();
    expect(screen.getByTestId("context-usage-chip").textContent).toBe("");
  });

  it("returns to the chosen indicator style when the pin goes back off", () => {
    useSettingsStore.setState({ contextIndicatorStyle: "ring" });
    renderPreview(<ContextUsagePreview />);
    expect(screen.getByTestId("context-usage-ring-value").textContent).toBe(
      "5",
    );

    act(() => {
      useSettingsStore.getState().setPinContextUsageBreakdown(true);
    });
    expect(screen.getByTestId("context-usage-pinned-strip")).toBeTruthy();
    expect(screen.queryByTestId("context-usage-ring")).toBeNull();

    // The style is not something pinning consumed: unpinning restores the
    // gauge, not the sentence the default would draw.
    act(() => {
      useSettingsStore.getState().setPinContextUsageBreakdown(false);
    });
    expect(screen.queryByTestId("context-usage-pinned-strip")).toBeNull();
    expect(screen.getByTestId("context-usage-ring-value").textContent).toBe(
      "5",
    );
    expect(useSettingsStore.getState().contextIndicatorStyle).toBe("ring");
  });

  it("draws the compaction shortcut and drops it with the composer setting", () => {
    renderPreview(<ContextUsagePreview />);
    expect(screen.getByTestId("context-usage-compact-action")).toBeTruthy();

    act(() => {
      useLayoutStore.getState().setComposerCompactButton("hidden");
    });

    expect(screen.queryByTestId("context-usage-compact-action")).toBeNull();
  });
});
