import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import { RegionDisplayControl } from "@/components/layout-editor/inspector/region-controls";
import { SurfaceSection } from "@/components/layout-editor/inspector/surface-section";
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

describe("the last rail panel shown cannot be switched off (T3)", () => {
  const OTHER_PANELS = [
    "railArtifacts",
    "railTerminals",
    "railBrowsers",
    "railGitDiff",
    "railFileTree",
    "railSharing",
  ] as const;

  function onlyAgentsShown(): void {
    for (const panel of OTHER_PANELS) {
      useLayoutStore.getState().setRegionValues(panel, { shown: "hidden" });
    }
    // Both presence-gated panels keep their Auto: it never counts, since a
    // task with nothing for them draws neither.
    useLayoutStore
      .getState()
      .setRegionValues("railPullRequests", { shown: "auto" });
    useLayoutStore
      .getState()
      .setRegionValues("railComments", { shown: "auto" });
  }

  function SidebarSurface(): ReactNode {
    const snapshot = useLayoutSnapshot();
    return (
      <LayoutFormHostContext value="inspector">
        <SurfaceSection
          surface="sidebar"
          snapshot={snapshot}
          openRows={[]}
          onToggleRow={() => {}}
          onSelectRow={null}
          selectedRow={null}
        />
      </LayoutFormHostContext>
    );
  }

  function radiosOf(regionId: RegionId): ReadonlyArray<HTMLElement> {
    const row = document.querySelector(`[data-sortable-id="${regionId}"]`);
    if (!(row instanceof HTMLElement)) throw new Error(`no row: ${regionId}`);
    return within(row).getAllByRole("radio");
  }

  it("leaves only Shown operable on the one panel left Shown, though an auto panel is present", () => {
    onlyAgentsShown();
    render(<LiveControl regionId="railAgents" />);

    const options = screen.getAllByRole("radio");
    expect(
      options.map((option) => [
        option.textContent,
        option.matches(":disabled"),
      ]),
    ).toEqual([
      ["Shown", false],
      ["Hidden", true],
    ]);

    pick("Hidden");
    expect(railAgents().shown).toBe("shown");
  });

  it("disables Auto as well on a presence-gated panel that is the last one Shown", () => {
    onlyAgentsShown();
    useLayoutStore
      .getState()
      .setRegionValues("railAgents", { shown: "hidden" });
    useLayoutStore
      .getState()
      .setRegionValues("railPullRequests", { shown: "shown" });
    render(<LiveControl regionId="railPullRequests" />);

    expect(
      screen
        .getAllByRole("radio")
        .map((option) => [option.textContent, option.matches(":disabled")]),
    ).toEqual([
      ["Auto", true],
      ["Shown", false],
      ["Hidden", true],
    ]);
  });

  it("offers every option on every panel while two are shown", () => {
    onlyAgentsShown();
    useLayoutStore
      .getState()
      .setRegionValues("railFileTree", { shown: "shown" });
    render(<LiveControl regionId="railAgents" />);

    expect(
      screen
        .getAllByRole("radio")
        .some((option) => option.matches(":disabled")),
    ).toBe(false);
  });

  it("says why in the panel's own row, and in no other panel's", () => {
    onlyAgentsShown();
    render(<SidebarSurface />);

    const agents = document.querySelector('[data-sortable-id="railAgents"]');
    if (!(agents instanceof HTMLElement)) throw new Error("no Agents row");
    expect(
      within(agents).getByText("One panel always stays shown."),
    ).toBeTruthy();
    expect(screen.getAllByText("One panel always stays shown.")).toHaveLength(
      1,
    );
    expect(radiosOf("railAgents").some((o) => o.matches(":disabled"))).toBe(
      true,
    );
    expect(radiosOf("railArtifacts").some((o) => o.matches(":disabled"))).toBe(
      false,
    );
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

/**
 * The Microphone follows General > Voice input as well as its own Shown, and
 * what that means is the registry's rule for the row (`micRule`, P1), not the
 * control's: `RegionDisplayControl` draws the plain Shown / Hidden pair, and
 * the row it sits in - drawn here by the real Composer form - is absent in the
 * installed app and disabled, with its reason, while Voice input is off.
 */
describe("Microphone's row (mobile absence, voice-off gating)", () => {
  function ComposerSurface(props: {
    readonly host: "inspector" | "page";
  }): ReactNode {
    const snapshot = useLayoutSnapshot();
    return (
      <LayoutFormHostContext value={props.host}>
        <SurfaceSection
          surface="composer"
          snapshot={snapshot}
          openRows={[]}
          onToggleRow={() => {}}
          onSelectRow={null}
          selectedRow={null}
        />
      </LayoutFormHostContext>
    );
  }

  function micRow(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-sortable-id="mic"]');
  }

  afterEach(() => {
    setMobileApp(false);
    useSettingsStore.setState({ voiceInputEnabled: true });
  });

  it("is absent in the installed mobile app", () => {
    setMobileApp(true);
    render(<ComposerSurface host="inspector" />);

    expect(micRow()).toBeNull();
    expect(
      screen.queryByRole("radiogroup", { name: "Microphone display" }),
    ).toBeNull();
  });

  it("draws its Shown / Hidden pair live while Voice input is on, with no reason", () => {
    render(<ComposerSurface host="inspector" />);

    const options = within(micRow() ?? document.body).getAllByRole("radio");
    expect(options.map((option) => option.textContent)).toEqual([
      "Shown",
      "Hidden",
    ]);
    expect(options.some((option) => option.matches(":disabled"))).toBe(false);
    expect(
      screen.queryByText(
        "Turn on Voice input in General settings to use this.",
      ),
    ).toBeNull();
  });

  it("disables every option and names the reason when voice input is off", () => {
    useSettingsStore.setState({ voiceInputEnabled: false });
    render(<ComposerSurface host="inspector" />);

    const row = micRow();
    if (row === null) throw new Error("no microphone row");
    const options = within(row).getAllByRole("radio");
    expect(options.every((option) => option.matches(":disabled"))).toBe(true);
    // The reason is the row's own line under its name, and the control group
    // it disables is described by it.
    const reason = within(row).getByText(
      "Turn on Voice input in General settings to use this.",
    );
    expect(reason.getAttribute("data-row-availability")).toBe("disabled");
    expect(
      row
        .querySelector("fieldset")
        ?.getAttribute("aria-describedby")
        ?.split(" "),
    ).toContain(reason.id);
    // The editor must not leave its session for a settings page: no link.
    expect(
      within(row).queryByRole("button", { name: "Open General settings" }),
    ).toBeNull();
  });

  it("offers the Open General settings link on the Settings page host only", () => {
    useSettingsStore.setState({ voiceInputEnabled: false });
    render(<ComposerSurface host="page" />);

    const row = micRow();
    if (row === null) throw new Error("no microphone row");
    expect(
      within(row).getByRole("button", { name: "Open General settings" }),
    ).toBeTruthy();
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
