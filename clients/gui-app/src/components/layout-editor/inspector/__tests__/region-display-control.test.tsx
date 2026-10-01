import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegionDisplayControl } from "@/components/layout-editor/inspector/region-controls";
import { regionFacts } from "@/components/layout-editor/regions/region-facts";
import { setMobileApp } from "@/lib/mobile-app";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import type { LayoutValues } from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The page row's one merged state control (L-121, L-128).
 *
 * `Full row / Chip / Hidden` is the claim under test: it is not a new stored
 * value, it is `size` and `shown` read together and written apart, so the
 * round trip has to be lossless and each pick has to be ONE undo step. The
 * two option sets either side of it - the rail's three and everything else's
 * two - are here because "one control per row" is only true if every row
 * reaches its whole value through it. Access (never hidden, and gone on a
 * narrow page) and the Microphone (gone in the installed mobile app, disabled
 * while voice input is off) are the gates the same one control carries.
 *
 * Rendered live off the store rather than off a captured snapshot: what a pick
 * writes is only half of it, and the other half is what the control reads back
 * afterwards.
 */

function LiveControl(props: { readonly regionId: RegionId }): ReactNode {
  const snapshot = useLayoutSnapshot();
  return (
    <RegionDisplayControl
      regionId={props.regionId}
      values={effectiveLayoutValues(snapshot.basePreset, snapshot.overrides)}
    />
  );
}

function changedFiles(): LayoutValues["changedFiles"] {
  const state = useLayoutStore.getState();
  return effectiveLayoutValues(state.basePreset, state.overrides).changedFiles;
}

function minimap(): LayoutValues["minimap"] {
  const state = useLayoutStore.getState();
  return effectiveLayoutValues(state.basePreset, state.overrides).minimap;
}

function railAgents(): LayoutValues["railAgents"] {
  const state = useLayoutStore.getState();
  return effectiveLayoutValues(state.basePreset, state.overrides).railAgents;
}

function optionLabels(): ReadonlyArray<string> {
  return screen.getAllByRole("radio").map((node) => node.textContent);
}

function pick(label: string): void {
  fireEvent.click(screen.getByRole("radio", { name: label }));
}

function historyDepth(): number {
  return useLayoutEditorStore.getState().history.past.length;
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.getState().beginSession({
    entry: "keyboard",
    source: "direct_ui",
    startedAt: 0,
    origin: { kind: "tab" },
  });
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("a sizeable region's Full row / Chip / Hidden", () => {
  beforeEach(() => {
    useLayoutStore
      .getState()
      .setRegionValues("changedFiles", { size: "full", shown: "shown" });
  });

  it("offers the size words the dock uses, plus Hidden", () => {
    render(<LiveControl regionId="changedFiles" />);

    expect(optionLabels()).toEqual(["Full row", "Chip", "Hidden"]);
    expect(screen.getByRole("radiogroup").getAttribute("aria-label")).toBe(
      `${regionFacts("changedFiles").name} display`,
    );
  });

  it("writes size and shown in one gesture when a size is picked", () => {
    render(<LiveControl regionId="changedFiles" />);
    useLayoutStore.getState().setRegionValues("changedFiles", {
      shown: "hidden",
    });
    const before = historyDepth();

    pick("Chip");

    expect(changedFiles().size).toBe("chip");
    expect(changedFiles().shown).toBe("shown");
    // One pick, one undo step - not a size write and a visibility write.
    expect(historyDepth()).toBe(before + 1);
  });

  it("leaves the size alone when Hidden is picked, so a hidden chip comes back as a chip", () => {
    render(<LiveControl regionId="changedFiles" />);

    pick("Chip");
    pick("Hidden");

    expect(changedFiles().shown).toBe("hidden");
    // L-113: a hidden dock member whose size is Chip materialises as a chip
    // ghost, which it cannot do if hiding it forgot the size.
    expect(changedFiles().size).toBe("chip");
    expect(
      screen
        .getByRole("radio", { name: "Hidden" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    pick("Chip");

    expect(changedFiles().shown).toBe("shown");
    expect(changedFiles().size).toBe("chip");
    expect(
      screen.getByRole("radio", { name: "Chip" }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("the option set a region's own value asks for", () => {
  it("gives a rail panel with a presence rule all three of its states (L-47, L-93)", () => {
    render(<LiveControl regionId="railPullRequests" />);

    expect(optionLabels()).toEqual(["Auto", "Shown", "Hidden"]);

    pick("Shown");

    // The state a two-position switch could not reach at all.
    expect(useLayoutStore.getState().overrides.railPullRequests?.shown).toBe(
      "shown",
    );
    expect(historyDepth()).toBe(1);
  });

  it("gives a rail panel with no presence rule two, not three (G6)", () => {
    // railAgents has no hint (isAutoRailRegionId is false), so its `shown` is
    // plain Visibility (L-93 overturned) and the control collapses to
    // Shown/Hidden like any other region.
    expect(regionFacts("railAgents").hint).toBeNull();

    render(<LiveControl regionId="railAgents" />);

    expect(optionLabels()).toEqual(["Shown", "Hidden"]);

    pick("Hidden");

    expect(railAgents().shown).toBe("hidden");
    pick("Shown");
    // Writes the plain literal `shown` - this panel's value can no longer
    // even hold `auto`.
    expect(railAgents().shown).toBe("shown");
  });

  it("gives a plain region two, and no switch anywhere", () => {
    render(<LiveControl regionId="minimap" />);

    expect(optionLabels()).toEqual(["Shown", "Hidden"]);
    expect(screen.queryByRole("switch")).toBeNull();

    pick("Hidden");

    expect(minimap().shown).toBe("hidden");
    expect(historyDepth()).toBe(1);
  });
});

describe("a region with no `shown` leaf at all (regionHides false)", () => {
  it("gives Access Icon and label/Icon only only, no Hidden", () => {
    render(<LiveControl regionId="access" />);

    expect(optionLabels()).toEqual(["Icon and label", "Icon only"]);
  });

  it("drops Access's own display control on a narrow page - it has no applicable size", () => {
    const original = window.innerWidth;
    window.innerWidth = 500;
    try {
      render(<LiveControl regionId="access" />);
      expect(screen.queryAllByRole("radio")).toHaveLength(0);
    } finally {
      window.innerWidth = original;
    }
  });
});

describe("a rail panel on a narrow page, where there is no rail", () => {
  it("names the off state In More - the tab switcher's More menu - and still writes hidden", () => {
    const original = window.innerWidth;
    window.innerWidth = 500;
    try {
      render(<LiveControl regionId="railAgents" />);
      expect(optionLabels()).toEqual(["Shown", "In More"]);
      pick("In More");
      expect(railAgents().shown).toBe("hidden");
      cleanup();
      render(<LiveControl regionId="railPullRequests" />);
      expect(optionLabels()).toEqual(["Auto", "Shown", "In More"]);
    } finally {
      window.innerWidth = original;
    }
  });
});

describe("Microphone's own control (mobile absence, voice-off gating)", () => {
  afterEach(() => {
    setMobileApp(false);
    useSettingsStore.setState({ voiceInputEnabled: true });
  });

  it("is absent in the installed mobile app", () => {
    setMobileApp(true);
    render(<LiveControl regionId="mic" />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("disables every option and names the reason when voice input is off", () => {
    useSettingsStore.setState({ voiceInputEnabled: false });
    render(<LiveControl regionId="mic" />);

    const options = screen.getAllByRole("radio");
    expect(options.every((option) => option.hasAttribute("disabled"))).toBe(
      true,
    );
    const describedById = options[0]?.getAttribute("aria-describedby");
    expect(describedById).not.toBeNull();
    expect(document.getElementById(describedById as string)?.textContent).toBe(
      "Enable Voice input in General settings to show the microphone.",
    );
  });
});

describe("Chat display settings' disclosure regions (Thinking, Tool activity)", () => {
  it("gives Thinking Open/Closed/Hidden, and Hidden keeps size", () => {
    useLayoutStore
      .getState()
      .setRegionValues("thinking", { size: "full", shown: "shown" });
    render(<LiveControl regionId="thinking" />);

    expect(optionLabels()).toEqual(["Open", "Closed", "Hidden"]);

    pick("Hidden");

    const state = useLayoutStore.getState();
    const thinking = effectiveLayoutValues(
      state.basePreset,
      state.overrides,
    ).thinking;
    expect(thinking.shown).toBe("hidden");
    expect(thinking.size).toBe("full");
  });

  it("gives Tool activity only Open/Closed, never Hidden", () => {
    render(<LiveControl regionId="toolActivity" />);

    expect(optionLabels()).toEqual(["Open", "Closed"]);
  });
});
