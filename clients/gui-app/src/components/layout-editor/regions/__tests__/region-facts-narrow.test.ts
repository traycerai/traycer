import { describe, expect, it } from "vitest";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import {
  regionFacts,
  type AnyGrammarRow,
} from "@/components/layout-editor/regions/region-facts";
import {
  ABSENT,
  LIVE,
  liveWithNote,
  WIDER_WINDOWS_NOTE,
  type LayoutFormContext,
  type RowDependency,
} from "@/components/layout-editor/regions/row-availability";
import {
  orderGroupHeaded,
  toolbarMembers,
} from "@/components/layout-editor/regions/surface-groups";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import type { RegionId } from "@/lib/layout/region-id";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { DEFAULT_LAYOUT_SNAPSHOT } from "@/stores/layout/layout-store";

/**
 * What a narrow (phone-layout) form can honor is each row's own rule in the
 * registry (`depends.availability`, a region's `availability`), asked of the
 * one {@link LayoutFormContext} the form builds: `RegionSection`'s dock rows
 * and `SurfaceSection`'s detail-row disclosure draw whatever those answer,
 * and `toolbarMembers` / `orderGroupHeaded` say what the phone's toolbar
 * lists keep. Real registry rows, not hand-built fixtures: the point is that
 * THESE rows, as the app actually declares them, answer as the phone layout
 * needs. `phoneLayout` is `useIsMobileViewport()` and is always true in the
 * installed app; a browser tab below 768px is the same layout, and the one
 * place a widening window is the way back.
 */

type Shell = Pick<SettingsAvailabilityContext, "mobileApp" | "phoneLayout">;

const DESKTOP: Shell = { mobileApp: false, phoneLayout: false };
const NARROW_BROWSER: Shell = { mobileApp: false, phoneLayout: true };
const INSTALLED_APP: Shell = { mobileApp: true, phoneLayout: true };

function contextFor(shell: Shell): LayoutFormContext {
  return {
    values: effectiveLayoutValues(
      DEFAULT_LAYOUT_SNAPSHOT.basePreset,
      DEFAULT_LAYOUT_SNAPSHOT.overrides,
    ),
    arrangement: DEFAULT_ARRANGEMENT,
    shell: { runnerHost: null, featureSettings: null, ...shell },
    facts: { voiceInputEnabled: true },
  };
}

/** A region's detail row of one kind, by `key` where it has several. */
function dependencyOf(
  regionId: RegionId,
  kind: "position-host" | "position-side" | "style",
  key: string | null,
): RowDependency {
  const row: AnyGrammarRow | undefined = LAYOUT_REGIONS[regionId].rows.find(
    (entry) =>
      entry.kind === kind &&
      (entry.kind !== "style" || key === null || entry.key === key),
  );
  if (
    row === undefined ||
    (row.kind !== "position-host" &&
      row.kind !== "position-side" &&
      row.kind !== "style")
  ) {
    throw new Error(`no such row: ${regionId}/${kind}`);
  }
  return row.depends;
}

function answer(dependency: RowDependency, shell: Shell) {
  return dependency.availability(contextFor(shell));
}

const MODEL_STYLE_NOTE =
  "Bars show only for models with several effort levels.";
const REASONING_CONTROL_NOTE = "For models with several effort levels.";
const MINIMAP_NOTE = "Shows on wider windows with a mouse.";

describe("a reading's Location row", () => {
  const location = dependencyOf("usageLimits", "position-host", null);

  it("is plain on the desktop layout", () => {
    expect(answer(location, DESKTOP)).toEqual(LIVE);
  });

  it("is absent from the installed app - which bar it lives in is a desktop-layout choice", () => {
    expect(answer(location, INSTALLED_APP)).toEqual(ABSENT);
  });

  it("stays in a narrow browser tab with a note, since widening the window is the way back", () => {
    expect(answer(location, NARROW_BROWSER)).toEqual(
      liveWithNote(WIDER_WINDOWS_NOTE),
    );
  });
});

describe("the minimap", () => {
  it("keeps its own row plain on the desktop layout", () => {
    expect(regionFacts("minimap").shellGate(contextFor(DESKTOP).shell)).toBe(
      true,
    );
    expect(regionFacts("minimap").availability(contextFor(DESKTOP))).toEqual(
      LIVE,
    );
  });

  it("is gated out of the installed app, whose minimap is the tile bar's drawer, and its Side row goes with it", () => {
    expect(
      regionFacts("minimap").shellGate(contextFor(INSTALLED_APP).shell),
    ).toBe(false);
  });

  it("says once, on its own row, that it shows on wider windows with a mouse in a narrow browser tab", () => {
    expect(
      regionFacts("minimap").shellGate(contextFor(NARROW_BROWSER).shell),
    ).toBe(true);
    expect(
      regionFacts("minimap").availability(contextFor(NARROW_BROWSER)),
    ).toEqual(liveWithNote(MINIMAP_NOTE));
    // The Side row under it carries no second copy of the note.
    expect(
      answer(dependencyOf("minimap", "position-side", null), NARROW_BROWSER),
    ).toEqual(LIVE);
  });
});

describe("the composer toolbar's lists on the phone layout", () => {
  it("draw no header over their rows, and the dock's does not lose its own", () => {
    expect(orderGroupHeaded("toolbarLeft", true)).toBe(false);
    expect(orderGroupHeaded("toolbarRight", true)).toBe(false);
    expect(orderGroupHeaded("dock", true)).toBe(true);
    // Wider than the phone layout, every list keeps its header.
    expect(orderGroupHeaded("toolbarLeft", false)).toBe(true);
    expect(orderGroupHeaded("toolbarRight", false)).toBe(true);
  });

  it("are the phone's own fixed members: Attach image, then the label-less Model chip and the microphone", () => {
    const context = contextFor(NARROW_BROWSER);
    expect(toolbarMembers("toolbarLeft", true, context)).toEqual([
      "attachImage",
    ]);
    expect(toolbarMembers("toolbarRight", true, context)).toEqual([
      "model",
      "mic",
    ]);
  });

  it("keep every member the arrangement holds on the desktop layout", () => {
    const context = contextFor(DESKTOP);
    expect(toolbarMembers("toolbarLeft", false, context)).toEqual(
      DEFAULT_ARRANGEMENT.toolbarLeft,
    );
    expect(toolbarMembers("toolbarRight", false, context)).toEqual(
      DEFAULT_ARRANGEMENT.toolbarRight,
    );
  });

  it("leave the microphone out of the installed app, which refuses dictation", () => {
    expect(
      toolbarMembers("toolbarRight", true, contextFor(INSTALLED_APP)),
    ).toEqual(["model"]);
  });
});

describe("Model's two style rows", () => {
  const style = dependencyOf("model", "style", "style");
  const reasoningControl = dependencyOf("model", "style", "reasoningControl");

  it("drops Model's own Style row from the installed app - the phone chip has no label to style", () => {
    expect(answer(style, INSTALLED_APP)).toEqual(ABSENT);
  });

  it("keeps Style on the desktop layout, noting only what a model decides", () => {
    expect(answer(style, DESKTOP)).toEqual(liveWithNote(MODEL_STYLE_NOTE));
  });

  it("keeps Style in a narrow browser tab, saying it applies on wider windows as well", () => {
    expect(answer(style, NARROW_BROWSER)).toEqual(
      liveWithNote(`${WIDER_WINDOWS_NOTE} ${MODEL_STYLE_NOTE}`),
    );
  });

  it("keeps Reasoning control in every layout - the phone's picker footer is the same picker", () => {
    for (const shell of [DESKTOP, NARROW_BROWSER, INSTALLED_APP]) {
      expect(answer(reasoningControl, shell)).toEqual(
        liveWithNote(REASONING_CONTROL_NOTE),
      );
    }
  });

  it("leaves another region's style row alone", () => {
    for (const shell of [DESKTOP, NARROW_BROWSER, INSTALLED_APP]) {
      expect(
        answer(dependencyOf("contextUsage", "style", null), shell),
      ).toEqual(LIVE);
    }
  });
});
