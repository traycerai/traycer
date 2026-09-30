import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { SHIPPED_DEFAULT_VALUES } from "@/lib/layout/layout-presets";
import {
  depictRegion,
  type HostContextId,
} from "@/components/layout-editor/region-depiction";
import { isWindowedRateLimitProvider } from "@/lib/rate-limits/rate-limit-window-catalog";
import type { LayoutArrangement } from "@/lib/layout/layout-arrangement";
import type { LayoutValues } from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * What a picture owes the thing it is a picture of, at the level a unit test
 * can decide: it is drawn in its real host's context, it draws what the values
 * ask for, and it draws at all whether or not the region is shown. Whether it
 * looks the same is the parity regression's question (L-53), in real Chrome.
 */

function frameOf(regionId: RegionId, container: HTMLElement): HTMLElement {
  const frame = container.querySelector("[data-layout-depiction]");
  if (!(frame instanceof HTMLElement)) {
    throw new Error(`no depiction frame for ${regionId}`);
  }
  return frame;
}

function hostOf(regionId: RegionId, container: HTMLElement): string | null {
  return frameOf(regionId, container).getAttribute("data-layout-depiction");
}

/**
 * The host a region is drawn in, read off the picture rather than off the
 * mapping that produced it: the mapping is private to the module, and what
 * callers actually depend on is the frame's own context attribute.
 */
function drawnHostOf(
  regionId: RegionId,
  arrangement: LayoutArrangement,
): string | null {
  const values: LayoutValues[RegionId] = SHIPPED_DEFAULT_VALUES[regionId];
  const { container } = render(depictRegion(regionId, values, arrangement));
  return hostOf(regionId, container);
}

describe("the host context a depiction is drawn in", () => {
  it("follows the arrangement for each region that moves bar (L-156)", () => {
    expect(drawnHostOf("usageLimits", DEFAULT_ARRANGEMENT)).toBe("status-bar");
    expect(
      drawnHostOf("usageLimits", {
        ...DEFAULT_ARRANGEMENT,
        usageHost: "header",
      }),
    ).toBe("top-bar");
    // The monitor's own pick, which is the branch L-156 added: its picture is
    // framed as the top bar without the usage cluster having moved anywhere.
    expect(
      drawnHostOf("resourceMonitor", {
        ...DEFAULT_ARRANGEMENT,
        resourceHost: "header",
      }),
    ).toBe("top-bar");
    expect(
      drawnHostOf("usageLimits", {
        ...DEFAULT_ARRANGEMENT,
        resourceHost: "header",
      }),
    ).toBe("status-bar");
  });

  it("puts every other region in its own surface", () => {
    const expected: ReadonlyArray<[RegionId, HostContextId]> = [
      ["homeTab", "top-bar"],
      ["resourceMonitor", "status-bar"],
      ["minimap", "chat"],
      ["contextUsage", "composer-foot"],
      ["background", "dock"],
      ["todo", "dock"],
      ["access", "toolbar"],
      ["railComments", "rail"],
    ];
    for (const [regionId, host] of expected) {
      expect(drawnHostOf(regionId, DEFAULT_ARRANGEMENT), regionId).toBe(host);
    }
  });

  /**
   * The second region that moves surface, and this one moves itself: a dock
   * member set to Chip is a pill in the strip above the composer, not a row in
   * the dock's joined frame (L-97). A picture framed by the region's SURFACE
   * alone drew the real pill inside the frame it had just left.
   */
  it("frames a dock member by the size it is drawn at", () => {
    const full = render(
      depictRegion(
        "changedFiles",
        { shown: "shown", size: "full" },
        DEFAULT_ARRANGEMENT,
      ),
    );
    expect(hostOf("changedFiles", full.container)).toBe("dock");

    const chip = render(
      depictRegion(
        "changedFiles",
        { shown: "shown", size: "chip" },
        DEFAULT_ARRANGEMENT,
      ),
    );
    expect(hostOf("changedFiles", chip.container)).toBe("chip-strip");
  });
});

describe("what a depiction draws", () => {
  // The Message queue no longer has a picture here at all (G1-G2): it is not
  // a `RegionId`, so it is not one of the layout editor's depictable regions
  // and carries no preset-card specimen.
  it("reports only the metrics the values switched on", () => {
    const { container } = render(
      depictRegion(
        "resourceMonitor",
        {
          shown: "shown",
          cpu: true,
          memory: false,
          processes: true,
          ramShare: false,
          agentRows: true,
          display: "full",
        },
        DEFAULT_ARRANGEMENT,
      ),
    );
    const text = frameOf("resourceMonitor", container).textContent;
    expect(text).toContain("cpu");
    expect(text).toContain("procs");
    expect(text).not.toContain("mem");
    expect(text).not.toContain("ram");
  });

  it("draws the context chip's three readings differently", () => {
    const base = SHIPPED_DEFAULT_VALUES.contextUsage;
    const text = render(
      depictRegion(
        "contextUsage",
        { ...base, style: "text" },
        DEFAULT_ARRANGEMENT,
      ),
    );
    expect(text.container.textContent).toContain("% context left");
    expect(text.container.querySelector("svg")).toBeNull();

    const ring = render(
      depictRegion(
        "contextUsage",
        { ...base, style: "ring" },
        DEFAULT_ARRANGEMENT,
      ),
    );
    expect(ring.container.querySelector("svg")).not.toBeNull();
    expect(ring.container.textContent).not.toContain("context left");
    const ringReading = ring.container.textContent;

    const ringOnly = render(
      depictRegion(
        "contextUsage",
        { ...base, style: "ring-only" },
        DEFAULT_ARRANGEMENT,
      ),
    );
    expect(ringOnly.container.querySelector("svg")).not.toBeNull();
    expect(ringOnly.container.textContent).toBe("");
    expect(ringReading).not.toBe("");
  });

  it("collapses the access pill to its icon as a chip", () => {
    const full = render(
      depictRegion("access", { size: "full" }, DEFAULT_ARRANGEMENT),
    );
    expect(full.container.textContent).toContain("Full access");

    const chip = render(
      depictRegion("access", { size: "chip" }, DEFAULT_ARRANGEMENT),
    );
    // The label is still in the tree for the accessible name, but the chip
    // hides it - which is the real component's own behaviour under `compact`.
    const label = chip.container.querySelector("span.hidden");
    expect(label?.textContent).toBe("Full access");
  });

  it("draws a region that is switched off, because the stage dims instead", () => {
    render(
      depictRegion(
        "attachImage",
        { ...SHIPPED_DEFAULT_VALUES.attachImage, shown: "hidden" },
        DEFAULT_ARRANGEMENT,
      ),
    );
    expect(screen.getByLabelText("Attach image")).toBeTruthy();
  });

  it("draws one rail icon per panel, from the sidebar's own definition", () => {
    const { container } = render(
      depictRegion(
        "railGitDiff",
        SHIPPED_DEFAULT_VALUES.railGitDiff,
        DEFAULT_ARRANGEMENT,
      ),
    );
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(hostOf("railGitDiff", container)).toBe("rail");
  });

  it("keeps the usage reading's parts under the values' control", () => {
    const base = SHIPPED_DEFAULT_VALUES.usageLimits;
    const withWord = render(
      depictRegion(
        "usageLimits",
        { ...base, word: true, amount: "remaining" },
        DEFAULT_ARRANGEMENT,
      ),
    );
    expect(withWord.container.textContent).toContain("remaining");

    const withoutWord = render(
      depictRegion(
        "usageLimits",
        { ...base, word: false, amount: "remaining" },
        DEFAULT_ARRANGEMENT,
      ),
    );
    expect(withoutWord.container.textContent).not.toContain("remaining");
  });

  it("draws every provider the arrangement still shows", () => {
    const visible = DEFAULT_ARRANGEMENT.usageProviders;
    // Only windowed providers get a picture (non-windowed ones report a
    // credit balance, not a window, so `depictUsageLimits` omits them).
    const windowed = visible.filter(isWindowedRateLimitProvider);
    const hiddenAll = render(
      depictRegion("usageLimits", SHIPPED_DEFAULT_VALUES.usageLimits, {
        ...DEFAULT_ARRANGEMENT,
        hiddenProviders: visible,
      }),
    );
    expect(hiddenAll.container.querySelectorAll("svg")).toHaveLength(0);

    const oneHidden = render(
      depictRegion("usageLimits", SHIPPED_DEFAULT_VALUES.usageLimits, {
        ...DEFAULT_ARRANGEMENT,
        hiddenProviders: visible.slice(1),
      }),
    );
    expect(
      oneHidden.container.querySelectorAll("[data-provider-id]"),
    ).toHaveLength(1);

    // The catalog, not a sample of it (R3-03). A picture never lies, and on
    // Settings ▸ Layout this band is the only feedback the providers list's
    // Shown/Hidden control has: a picture that stopped after three said
    // nothing when the fifth was hidden.
    const allShown = render(
      depictRegion(
        "usageLimits",
        SHIPPED_DEFAULT_VALUES.usageLimits,
        DEFAULT_ARRANGEMENT,
      ),
    );
    expect(windowed.length).toBeGreaterThan(3);
    expect(
      allShown.container.querySelectorAll("[data-provider-id]"),
    ).toHaveLength(windowed.length);

    const fifthHidden = render(
      depictRegion("usageLimits", SHIPPED_DEFAULT_VALUES.usageLimits, {
        ...DEFAULT_ARRANGEMENT,
        hiddenProviders: [windowed[4]],
      }),
    );
    const drawn = [
      ...fifthHidden.container.querySelectorAll("[data-provider-id]"),
    ].map((segment) => segment.getAttribute("data-provider-id"));
    expect(drawn).toHaveLength(windowed.length - 1);
    expect(drawn).not.toContain(windowed[4]);
  });

  it("gives neighbouring providers readings of their own", () => {
    // The finding this replaces: every segment was drawn from ONE fixed
    // window, so the strip printed the same "35% 5h" behind every icon and
    // read as filler rather than as a picture of a status bar (LV2-19).
    const { container } = render(
      depictRegion(
        "usageLimits",
        { ...SHIPPED_DEFAULT_VALUES.usageLimits, percent: true, reset: true },
        DEFAULT_ARRANGEMENT,
      ),
    );

    // The READING alone: a segment prints its provider's name first, so
    // comparing whole strings would be satisfied by the names and say nothing
    // about the numbers behind them ("Codex35% used 58m" -> "35% used 58m").
    const readings = [...container.querySelectorAll("[data-provider-id]")].map(
      (segment) => segment.textContent.replace(/^\D+/, ""),
    );

    const windowed = DEFAULT_ARRANGEMENT.usageProviders.filter(
      isWindowedRateLimitProvider,
    );
    expect(readings).toHaveLength(windowed.length);
    expect(readings.every((reading) => reading.length > 0)).toBe(true);
    // Three readings rotate across the catalog, so a strip longer than three
    // repeats - but never beside its own twin, which is where the "eight
    // identical strings" LV2-19 found was legible as filler.
    const repeatedNeighbour = readings.filter(
      (reading, index) => index > 0 && readings[index - 1] === reading,
    );
    expect(repeatedNeighbour).toHaveLength(0);
    expect(new Set(readings).size).toBe(3);
  });
});
