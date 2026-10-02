import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import { SurfaceSection } from "@/components/layout-editor/inspector/surface-section";
import { writeArrangement } from "@/lib/layout/arrangement-gestures";
import {
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The Usage and resources form: each reading's Show switch and Location
 * picker, the Density row and the rows a Compact reading hides, and the
 * Profiles list. Rendered through the real `SurfaceSection`, so what is held is
 * what the page and the inspector both draw.
 */

const HOST_ID = "host-1";

function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
  label: string,
): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: null, tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

const CODEX_PROFILES = [
  profile("ambient", "ambient", "Terminal"),
  profile("personal-profile", "managed", "personal"),
  profile("work-profile", "managed", "work"),
];
const CLAUDE_PROFILES = [profile("ambient", "ambient", "Terminal")];

// The Profiles list reads the watched host's profiles and its checked accounts
// through the usage context; the host is not what is under test, so the context
// is fixed and the checked accounts are read off the live store.
vi.mock(
  "@/components/layout-editor/inspector/use-layout-usage",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/components/layout-editor/inspector/use-layout-usage")
      >();
    const { useLayoutStore: store } =
      await import("@/stores/layout/layout-store");
    return {
      ...original,
      useLayoutUsage: () => ({
        ...original.EMPTY_USAGE,
        providerIds: ["codex", "claude-code"] as const,
        profilesByProvider: {
          codex: CODEX_PROFILES,
          "claude-code": CLAUDE_PROFILES,
        },
        hostId: HOST_ID,
        profileSelection: {
          shownProfiles:
            store.getState().arrangement.shownProfiles[HOST_ID] ?? {},
          lastProfileByHarness: {},
        },
      }),
    };
  },
);

function StatusBarSurface(): ReactNode {
  const snapshot = useLayoutSnapshot();
  return (
    <LayoutFormHostContext value="page">
      <SurfaceSection
        surface="statusBar"
        snapshot={snapshot}
        openRows={[]}
        onToggleRow={() => {}}
        onSelectRow={null}
        selectedRow={null}
      />
    </LayoutFormHostContext>
  );
}

function section(id: "usageLimits" | "resourceMonitor"): HTMLElement {
  const node = document.querySelector(`[data-region-section="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`no section: ${id}`);
  return node;
}

function profileRow(id: string): HTMLElement {
  const node = document.querySelector(`[data-profile-row="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`no profile row: ${id}`);
  return node;
}

/** Which of the rows a Compact reading ignores the section draws right now. */
function drawn(id: "usageLimits" | "resourceMonitor"): {
  readonly density: boolean;
  readonly percentShows: boolean;
  readonly resetTime: boolean;
  readonly metrics: boolean;
  readonly readingStyle: boolean;
} {
  const scope = within(section(id));
  return {
    density: scope.queryByRole("radiogroup", { name: "Density" }) !== null,
    percentShows:
      scope.queryByRole("radiogroup", { name: "Percent shows" }) !== null,
    resetTime: scope.queryByRole("switch", { name: "Reset time" }) !== null,
    metrics: scope.queryByRole("checkbox", { name: "CPU" }) !== null,
    readingStyle:
      scope.queryByRole("radiogroup", { name: "Reading style" }) !== null,
  };
}

function current(): LayoutArrangement {
  return useLayoutStore.getState().arrangement;
}

function setArrangement(patch: Partial<LayoutArrangement>): void {
  act(() => {
    useLayoutStore.getState().setArrangement({ ...current(), ...patch });
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutEditorStore.getState().endSession();
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("the rows a Compact reading ignores are hidden", () => {
  it("draws every row while both readings sit in the status bar, where Auto is Detailed", () => {
    render(<StatusBarSurface />);

    expect(drawn("usageLimits")).toEqual({
      density: true,
      percentShows: true,
      resetTime: true,
      metrics: false,
      readingStyle: true,
    });
    expect(drawn("resourceMonitor")).toEqual({
      density: true,
      percentShows: false,
      resetTime: false,
      metrics: true,
      readingStyle: false,
    });
  });

  it("hides Percent shows, Reset time and Metrics once a pick of Compact resolves", () => {
    act(() => {
      useLayoutStore.getState().setRegionValues("usageLimits", {
        density: "compact",
      });
      useLayoutStore.getState().setRegionValues("resourceMonitor", {
        density: "compact",
      });
    });
    render(<StatusBarSurface />);

    expect(drawn("usageLimits")).toEqual({
      density: true,
      percentShows: false,
      resetTime: false,
      metrics: false,
      readingStyle: false,
    });
    expect(drawn("resourceMonitor").metrics).toBe(false);
    expect(drawn("resourceMonitor").density).toBe(true);
  });

  it("hides them for Auto in the top tab strip and in a side strip, and brings them back for Detailed", () => {
    setArrangement({ usageHost: "header", resourceHost: "header" });
    render(<StatusBarSurface />);

    expect(drawn("usageLimits").percentShows).toBe(false);
    expect(drawn("resourceMonitor").metrics).toBe(false);

    setArrangement({ tabStripPlacement: "left" });
    expect(drawn("usageLimits").resetTime).toBe(false);
    expect(drawn("resourceMonitor").metrics).toBe(false);

    act(() => {
      useLayoutStore.getState().setRegionValues("usageLimits", {
        density: "detailed",
      });
      useLayoutStore.getState().setRegionValues("resourceMonitor", {
        density: "detailed",
      });
    });
    expect(drawn("usageLimits")).toMatchObject({
      percentShows: true,
      resetTime: true,
    });
    expect(drawn("resourceMonitor").metrics).toBe(true);
  });

  it("hides Reading style wherever the status bar is not drawing the reading, even for Detailed", () => {
    act(() => {
      useLayoutStore.getState().setRegionValues("usageLimits", {
        density: "detailed",
      });
    });
    setArrangement({ usageHost: "header" });
    render(<StatusBarSurface />);

    // Detailed in the tab strip is the strip's own form, with no calm profile.
    expect(drawn("usageLimits")).toMatchObject({
      percentShows: true,
      readingStyle: false,
    });

    setArrangement({ tabStripPlacement: "left" });
    expect(drawn("usageLimits").readingStyle).toBe(false);

    setArrangement({ usageHost: "status-bar" });
    expect(drawn("usageLimits").readingStyle).toBe(true);
  });

  it("writes the Reading style pick", () => {
    render(<StatusBarSurface />);

    const group = within(section("usageLimits")).getByRole("radiogroup", {
      name: "Reading style",
    });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-label")),
    ).toEqual(["Bar", "Percent", "Bar and percent", "Everything"]);
    expect(
      within(group)
        .getByRole("radio", { name: "Bar" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(within(group).getByRole("radio", { name: "Everything" }));

    expect(useLayoutStore.getState().overrides.usageLimits?.readingStyle).toBe(
      "full",
    );
  });

  it("names what Auto resolves to at the current spot", () => {
    render(<StatusBarSurface />);
    expect(
      within(section("usageLimits")).getByText(
        /^Auto is detailed in the status bar/,
      ),
    ).toBeTruthy();

    setArrangement({ usageHost: "header" });
    expect(
      within(section("usageLimits")).getByText(
        "Auto is compact in the top tab strip.",
      ),
    ).toBeTruthy();

    setArrangement({ tabStripPlacement: "right" });
    expect(
      within(section("usageLimits")).getByText(
        "Auto is compact in a side strip. Detailed shows one row per profile.",
      ),
    ).toBeTruthy();
  });

  it("writes the Density pick", () => {
    render(<StatusBarSurface />);

    fireEvent.click(
      within(
        within(section("resourceMonitor")).getByRole("radiogroup", {
          name: "Density",
        }),
      ).getByRole("radio", { name: "Compact" }),
    );

    expect(useLayoutStore.getState().overrides.resourceMonitor?.density).toBe(
      "compact",
    );
  });
});

describe("each reading's Show switch", () => {
  it("writes the reading's own shown value and takes its rows and the Profiles list with it", () => {
    render(<StatusBarSurface />);
    const usage = within(section("usageLimits"));
    expect(document.querySelector("[data-usage-profiles]")).not.toBeNull();

    fireEvent.click(usage.getByRole("switch", { name: "Show Usage limits" }));

    expect(useLayoutStore.getState().overrides.usageLimits?.shown).toBe(
      "hidden",
    );
    expect(document.querySelector("[data-usage-profiles]")).toBeNull();
    expect(
      usage.getByText("Show Usage limits to change these settings."),
    ).toBeTruthy();
    // The other reading is untouched.
    expect(
      useLayoutStore.getState().overrides.resourceMonitor?.shown,
    ).toBeUndefined();

    fireEvent.click(usage.getByRole("switch", { name: "Show Usage limits" }));
    expect(useLayoutStore.getState().overrides.usageLimits?.shown).not.toBe(
      "hidden",
    );
  });
});

describe("the Location picker", () => {
  it("is drawn as the window the tab strip is in, one radio per spot", () => {
    render(<StatusBarSurface />);
    const picker = within(section("usageLimits")).getByRole("radiogroup", {
      name: "Usage limits location",
    });
    expect(picker.getAttribute("data-reading-location-window")).toBe("top");
    expect(
      within(picker)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-label")),
    ).toEqual(["Tab strip", "Status bar left", "Status bar right"]);

    setArrangement({ tabStripPlacement: "left" });
    expect(
      within(section("usageLimits"))
        .getByRole("radiogroup", { name: "Usage limits location" })
        .getAttribute("data-reading-location-window"),
    ).toBe("left");
  });

  it("checks the spot the reading is in and writes the host and the end together", () => {
    render(<StatusBarSurface />);
    const picker = (): HTMLElement =>
      within(section("usageLimits")).getByRole("radiogroup", {
        name: "Usage limits location",
      });

    expect(
      within(picker())
        .getByRole("radio", { name: "Status bar left" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(
      within(picker()).getByRole("radio", { name: "Status bar right" }),
    );
    expect(current().usageHost).toBe("status-bar");
    expect(current().usageSide).toBe("right");

    fireEvent.click(within(picker()).getByRole("radio", { name: "Tab strip" }));
    expect(current().usageHost).toBe("header");
    // The tab strip has no end: the old one waits for the way back.
    expect(current().usageSide).toBe("right");
    expect(
      within(picker())
        .getByRole("radio", { name: "Tab strip" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("the Profiles list", () => {
  it("draws one row per provider, with the profiles of a provider that has several under it", () => {
    render(<StatusBarSurface />);

    expect(screen.getByText("Profiles")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide Codex" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Hide Claude Code" }),
    ).toBeTruthy();
    expect(profileRow("personal-profile")).toBeTruthy();
    expect(profileRow("work-profile")).toBeTruthy();
    // One profile is nothing to choose between.
    expect(
      screen.queryByRole("list", { name: "Claude Code profiles" }),
    ).toBeNull();
  });

  it("hides and shows a provider through its eye, writing hiddenProviders", () => {
    render(<StatusBarSurface />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Codex" }));
    expect(current().hiddenProviders).toEqual(["codex"]);

    fireEvent.click(screen.getByRole("button", { name: "Show Codex" }));
    expect(current().hiddenProviders).toEqual([]);
  });

  it("checks and unchecks a profile for the watched host, keeping the account already drawn", () => {
    render(<StatusBarSurface />);

    // Nothing checked draws one account (the first), and it cannot be hidden.
    expect(
      screen
        .getByRole("button", { name: "Hide Terminal" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Show personal" }));
    expect(current().shownProfiles).toEqual({
      [HOST_ID]: { codex: [null, "personal-profile"] },
    });

    fireEvent.click(screen.getByRole("button", { name: "Hide personal" }));
    expect(current().shownProfiles).toEqual({ [HOST_ID]: { codex: [null] } });
  });

  it("folds a provider's profiles away and opens them again", () => {
    render(<StatusBarSurface />);
    const codexRow = document.querySelector('[data-sortable-id="codex"]');
    if (!(codexRow instanceof HTMLElement)) throw new Error("no codex row");
    const grab = codexRow.querySelector("[data-row-grab]");
    if (!(grab instanceof HTMLElement)) throw new Error("no grab");

    fireEvent.click(grab);
    expect(
      document.querySelector('[data-profile-row="personal-profile"]'),
    ).toBeNull();

    fireEvent.click(grab);
    expect(profileRow("personal-profile")).toBeTruthy();
  });

  it("puts the provider order back from its revert, leaving a hidden provider alone", () => {
    act(() => {
      writeArrangement({
        ...current(),
        usageProviders: [...current().usageProviders].reverse(),
        hiddenProviders: ["codex"],
      });
    });
    render(<StatusBarSurface />);

    fireEvent.click(
      screen.getByRole("button", { name: "Revert Profiles order" }),
    );

    expect(current().hiddenProviders).toEqual(["codex"]);
    expect(current().usageProviders).toEqual(
      DEFAULT_ARRANGEMENT.usageProviders,
    );
    expect(
      screen.queryByRole("button", { name: "Revert Profiles order" }),
    ).toBeNull();
  });
});
