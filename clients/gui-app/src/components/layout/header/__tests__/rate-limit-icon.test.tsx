import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { ColumnEdgeContext } from "@/components/layout/column-edge-context";
import { SampleSceneContext } from "@/components/sample-workspace/sample-scene-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  StatusBarProviderSegmentModel,
  StatusBarProviderSegmentState,
  StatusBarRateLimitCluster,
  StatusBarRateLimitMode,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import type { RateLimitWindowSeverity } from "@/lib/rate-limits/window-severity";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { RUNNING_LOW_TEXT_CLASS_NAME } from "@/lib/rate-limits/window-severity";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import type { BarReadingForm } from "@/components/layout/tabs/side-strip/side-strip-tokens";

const DYNAMIC_ACTION_ROUTER: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};

/**
 * The cluster the mocked selector hands back. Default: nothing configured -
 * the same starting point `useStatusBarRateLimitSegments` reports before any
 * provider is connected.
 */
let cluster: StatusBarRateLimitCluster = { kind: "no-providers" };
/** Default: one host, followed — the glyph's pre-picker world. */
let scope: HostScope = hostScopeFixture({});
/** Default: following the active host, not an explicit pick. */
let hasExplicitPick = false;
/**
 * The scope's client, kept beside the scope rather than inside the fixture
 * because nothing here CALLS it: `useScopedHostBinding` checks it for null and
 * hands it to a context provider this suite stubs out. So the stub is an
 * identity, not a shape — naming it says that, where casting an empty object to
 * `HostClient` would claim a surface nothing in this file provides.
 *
 * It is what separates a pick that has RESOLVED (a scoped binding exists) from
 * one still resolving, which is the difference the re-mount case below turns on.
 */
const SCOPE_CLIENT_STUB = { stub: "scope-host-client" };
let scopeClient: typeof SCOPE_CLIENT_STUB | null = null;
/** The ambient binding `useScopedHostBinding` spreads. Same reasoning. */
const AMBIENT_BINDING_STUB = { stub: "ambient-binding" };
/**
 * Whether `useStatusBarRateLimitSegments` was mounted this render. A plain
 * counter rather than `vi.fn()` because the return value already flows
 * through the mutable `cluster` above - this only needs to answer "did the
 * icon mount the selector at all", which is the fetch-against-the-wrong-host
 * guarantee the placeholder-glyph tests below exist to prove.
 */
let useStatusBarRateLimitSegmentsCalled = false;
/**
 * The `mode` the icon last asked the selector for - `live` for every form,
 * the phone header's glyph included: each one owns its own fetching the way
 * the status bar's cluster does (G6 review A). See `LiveRateLimitGlyph`.
 */
let lastMode: StatusBarRateLimitMode | null = null;
/** The `sample` flag `LiveRateLimitGlyph` last asked the selector for. */
let lastSample: boolean | null = null;

vi.mock("@/hooks/rate-limits/use-status-bar-rate-limit-segments", () => ({
  useStatusBarWindowedProviders: () => [],
  useStatusBarRateLimitSegments: (input: {
    readonly mode: StatusBarRateLimitMode;
    readonly sample: boolean;
  }) => {
    useStatusBarRateLimitSegmentsCalled = true;
    lastMode = input.mode;
    lastSample = input.sample;
    return { cluster, mountTargets: [] };
  },
}));
// Mocked at the SCOPE, not at the six hooks behind it — the same boundary
// every Settings panel suite mocks, and the reason `hostScopeFixture` lives
// outside `__tests__/`. `useScopedHostBinding` is left real: it is a pure
// function of the scope, and stubbing it would hide the one thing this suite
// cares about (that a null binding means the glyph must not draw).
vi.mock("@/hooks/rate-limits/use-rate-limit-host-scope", () => ({
  // The client is spread OVER the fixture rather than passed into it: the
  // fixture's type demands a real `HostClient`, and the stub deliberately is
  // not one (see `SCOPE_CLIENT_STUB`).
  useRateLimitResolveHostScope: () => ({
    scope: { ...scope, client: scopeClient },
    hasExplicitPick,
  }),
}));
vi.mock("@/lib/host", () => ({
  HostRuntimeContext: {
    Provider: (props: { readonly children: unknown }) => props.children,
  },
  // A binding EXISTS here, as it does in the app — `useScopedHostBinding`
  // spreads it and swaps in the scope's client. Returning null instead would
  // make it answer null for every scope alike, and the re-mount case below
  // turns on that answer changing.
  useHostBinding: () => AMBIENT_BINDING_STUB,
}));
vi.mock("@/hooks/rate-limits/use-rate-limit-profile-selection", () => ({
  useRateLimitProfileSelection: () => ({
    shownProfiles: {},
    lastProfileByHarness: {},
  }),
}));

// The popover's contents are another suite's subject, but WHETHER it is
// presented is this one's: the stand-in keeps the real `PopoverContent`, which
// Radix mounts only while the root is open. So the testid below is a readout of
// the open state itself, not of a component that renders either way.
vi.mock("@/components/layout/header/rate-limit-popover", async () => {
  const { PopoverContent } = await import("@/components/ui/popover");
  return {
    RateLimitPopover: (_props: { readonly onClose: () => void }) => (
      <PopoverContent data-testid="rate-limit-popover" />
    ),
  };
});

import { RateLimitIconButton } from "@/components/layout/header/rate-limit-icon";

function tree(form: BarReadingForm) {
  return (
    <TooltipProvider>
      <RateLimitIconButton form={form} />
    </TooltipProvider>
  );
}

function iconTree() {
  return tree("glyph");
}

function renderIcon() {
  return render(iconTree());
}

function renderInline() {
  return render(tree("inline"));
}

// Exact class-token membership, not substring containment - the button's base
// variant classes always carry `disabled:opacity-50`, which would otherwise
// false-positive a substring check for the bare `opacity-50` utility.
function hasClass(element: Element, className: string): boolean {
  return (element.getAttribute("class") ?? "").split(/\s+/).includes(className);
}

function windowFixture(overrides: {
  readonly windowKey: string;
  readonly usedPercent: number;
  readonly severity: RateLimitWindowSeverity;
  readonly label?: string;
  readonly resetsAt?: number | null;
}): StatusBarRateLimitWindow {
  return {
    windowKey: overrides.windowKey,
    label: overrides.label ?? "5h",
    labelIsDuration: true,
    kind: "session",
    usedPercent: overrides.usedPercent,
    resetsAt: overrides.resetsAt ?? null,
    severity: overrides.severity,
  };
}

function segmentFixture(overrides: {
  readonly providerId: RateLimitProviderId;
  readonly windows: ReadonlyArray<StatusBarRateLimitWindow>;
  readonly state?: StatusBarProviderSegmentState;
}): StatusBarProviderSegmentModel {
  const windows = overrides.windows;
  return {
    providerId: overrides.providerId,
    profileId: null,
    account: null,
    hidden: false,
    state: overrides.state ?? "live",
    reason: null,
    readAt: null,
    windows,
    shown: windows,
    tightest: windows.at(0) ?? null,
  };
}

function segmentsCluster(
  segments: ReadonlyArray<StatusBarProviderSegmentModel>,
): StatusBarRateLimitCluster {
  return { kind: "segments", segments };
}

afterEach(() => {
  cleanup();
  cluster = { kind: "no-providers" };
  scope = hostScopeFixture({});
  scopeClient = null;
  hasExplicitPick = false;
  useStatusBarRateLimitSegmentsCalled = false;
  lastMode = null;
  lastSample = null;
  useTitleBarDragStore.setState({ suppressors: new Set() });
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

describe("<RateLimitIconButton />", () => {
  it("opens through the usage-limits keybinding action", () => {
    renderIcon();

    expect(screen.queryByTestId("rate-limit-popover")).toBeNull();
    act(() => {
      expect(
        dispatchAction("app.rate-limits.open", DYNAMIC_ACTION_ROUTER),
      ).toBe(true);
    });
    expect(screen.getByTestId("rate-limit-popover")).toBeTruthy();
  });

  it("renders a clickable icon button with an accessible name, even with no bars", () => {
    renderIcon();
    const button = screen.getByRole("button", { name: "Usage limits" });
    expect(button).toBeTruthy();
    expect(button.getAttribute("data-variant")).toBe("outline");
    expect(screen.getByTestId("rate-limit-gauge-icon")).toBeTruthy();
  });

  it("suppresses title-bar dragging only while the popover is open", () => {
    renderIcon();

    const isSuppressed = () =>
      useTitleBarDragStore.getState().suppressors.has("rate-limits");
    const button = screen.getByRole("button", { name: "Usage limits" });

    expect(isSuppressed()).toBe(false);

    fireEvent.click(button);
    expect(isSuppressed()).toBe(true);

    fireEvent.click(button);
    expect(isSuppressed()).toBe(false);
  });

  it("renders zero providers as visible empty tracks without fabricated usage", () => {
    cluster = { kind: "no-providers" };
    renderIcon();
    const button = screen.getByTestId("rate-limit-header-button");
    const tracks = within(button).getAllByTestId("rate-limit-bar-track");
    expect(tracks).toHaveLength(2);
    expect(within(button).queryAllByTestId("rate-limit-bar-fill")).toHaveLength(
      0,
    );
    for (const track of tracks) {
      expect(track.className).toContain("bg-muted-foreground/35");
    }
  });

  it("keeps valid 0% readings empty while preserving visible tracks", () => {
    cluster = segmentsCluster([
      segmentFixture({
        providerId: "codex",
        windows: [
          windowFixture({
            windowKey: "codex:5h",
            usedPercent: 0,
            severity: "healthy",
          }),
          windowFixture({
            windowKey: "codex:weekly",
            usedPercent: 0,
            severity: "healthy",
            label: "Weekly",
          }),
        ],
      }),
    ]);
    renderIcon();
    const button = screen.getByTestId("rate-limit-header-button");
    const tracks = within(button).getAllByTestId("rate-limit-bar-track");
    const fills = within(button).getAllByTestId("rate-limit-bar-fill");
    expect(tracks).toHaveLength(2);
    expect(fills).toHaveLength(2);
    expect(fills[0].style.width).toBe("0%");
    expect(fills[1].style.width).toBe("0%");
    for (const track of tracks) {
      expect(track.className).toContain("bg-muted-foreground/35");
    }
  });

  it("renders one bar per configured provider (Codex + Claude Code)", () => {
    cluster = segmentsCluster([
      segmentFixture({
        providerId: "codex",
        windows: [
          windowFixture({
            windowKey: "codex:5h",
            usedPercent: 70,
            severity: "healthy",
          }),
        ],
      }),
      segmentFixture({
        providerId: "claude-code",
        windows: [
          windowFixture({
            windowKey: "claude-code:5h",
            usedPercent: 40,
            severity: "healthy",
          }),
        ],
      }),
    ]);
    renderIcon();
    const button = screen.getByTestId("rate-limit-header-button");
    const fills = within(button).getAllByTestId("rate-limit-bar-fill");
    expect(fills).toHaveLength(2);
    expect(fills[0].className).toContain("bg-info");
    expect(fills[0].style.width).toBe("70%");
    expect(fills[1].className).toContain("bg-info");
    expect(fills[1].style.width).toBe("40%");
  });

  it("renders both of a single provider's windows without a key collision", () => {
    // Single-provider case: both bars share a providerId and are disambiguated
    // by their window key - both must still render.
    cluster = segmentsCluster([
      segmentFixture({
        providerId: "codex",
        windows: [
          windowFixture({
            windowKey: "codex:5h",
            usedPercent: 92,
            severity: "running_low",
          }),
          windowFixture({
            windowKey: "codex:weekly",
            usedPercent: 20,
            severity: "healthy",
            label: "Weekly",
          }),
        ],
      }),
    ]);
    renderIcon();
    const button = screen.getByTestId("rate-limit-header-button");
    const fills = within(button).getAllByTestId("rate-limit-bar-fill");
    expect(fills).toHaveLength(2);
    expect(fills[0].className).toContain("bg-warning");
    expect(fills[0].style.width).toBe("92%");
    expect(fills[1].className).toContain("bg-info");
    expect(fills[1].style.width).toBe("20%");
  });

  it("renders Running low and Limited as distinct amber and red tones", () => {
    cluster = segmentsCluster([
      segmentFixture({
        providerId: "codex",
        windows: [
          windowFixture({
            windowKey: "codex:5h",
            usedPercent: 80,
            severity: "running_low",
          }),
          windowFixture({
            windowKey: "codex:weekly",
            usedPercent: 100,
            severity: "limited",
            label: "Weekly",
          }),
        ],
      }),
    ]);
    renderIcon();
    const fills = within(
      screen.getByTestId("rate-limit-header-button"),
    ).getAllByTestId("rate-limit-bar-fill");
    // Highest used first: the limited window leads.
    expect(fills[0].className).toContain("bg-destructive");
    expect(fills[1].className).toContain("bg-warning");
  });

  it("marks the gauge without dimming the whole button when data is degraded", () => {
    cluster = segmentsCluster([
      segmentFixture({
        providerId: "claude-code",
        state: "degraded",
        windows: [
          windowFixture({
            windowKey: "claude-code:5h",
            usedPercent: 65,
            severity: "healthy",
          }),
        ],
      }),
      segmentFixture({
        providerId: "codex",
        windows: [
          windowFixture({
            windowKey: "codex:5h",
            usedPercent: 30,
            severity: "healthy",
          }),
        ],
      }),
    ]);
    renderIcon();
    const button = screen.getByTestId("rate-limit-header-button");
    expect(hasClass(button, "opacity-[0.55]")).toBe(false);
    // Checked class by class against the shared token rather than a
    // hard-coded string, so this stays true if the degraded gauge's shade
    // ever moves without the two drifting apart unnoticed.
    const gaugeIcon = screen.getByTestId("rate-limit-gauge-icon");
    for (const runningLowClass of RUNNING_LOW_TEXT_CLASS_NAME.split(" ")) {
      expect(hasClass(gaugeIcon, runningLowClass)).toBe(true);
    }
    // Both bars keep their own severity fill while the gauge carries the
    // degraded-state treatment.
    const fills = within(button).getAllByTestId("rate-limit-bar-fill");
    expect(fills).toHaveLength(2);
  });

  describe("host scope", () => {
    function twoSegmentCluster(): StatusBarRateLimitCluster {
      return segmentsCluster([
        segmentFixture({
          providerId: "codex",
          windows: [
            windowFixture({
              windowKey: "codex:5h",
              usedPercent: 45,
              severity: "healthy",
            }),
          ],
        }),
        segmentFixture({
          providerId: "claude-code",
          windows: [
            windowFixture({
              windowKey: "claude-code:5h",
              usedPercent: 10,
              severity: "healthy",
            }),
          ],
        }),
      ]);
    }

    it("mounts the live selector for a usable explicit pick", () => {
      hasExplicitPick = true;
      scope = hostScopeFixture({
        status: "ready",
        isViewingActive: false,
        hostLabel: "Other Machine",
      });
      cluster = twoSegmentCluster();

      renderIcon();

      expect(useStatusBarRateLimitSegmentsCalled).toBe(true);
      const fills = within(
        screen.getByTestId("rate-limit-header-button"),
      ).getAllByTestId("rate-limit-bar-fill");
      expect(fills).toHaveLength(2);
    });

    // The no-regression case: without an explicit pick, an `unreachable`
    // scope is the routine blip a single-host user's active host can have at
    // any time - the rate-limit envelope's own lastGood/degraded retention
    // already rides that out. Blanking the bars here would make every
    // single-host user worse off for a picker they never opened.
    it("keeps the live bars visible while following the active host, even when its status looks unreachable", () => {
      hasExplicitPick = false;
      scope = hostScopeFixture({
        status: "unreachable",
        isViewingActive: true,
      });
      cluster = twoSegmentCluster();

      renderIcon();

      expect(useStatusBarRateLimitSegmentsCalled).toBe(true);
      const button = screen.getByTestId("rate-limit-header-button");
      expect(within(button).getAllByTestId("rate-limit-bar-fill")).toHaveLength(
        2,
      );
      expect(
        within(button).queryAllByTestId("rate-limit-bar-track"),
      ).toHaveLength(2);
    });

    // The fetch-against-the-wrong-host guarantee: an explicit pick that has
    // not resolved to its own client must not mount the live selector at
    // all, not just hide its output - a mounted-but-hidden selector still
    // fires against the ambient host and caches the answer under its key.
    it("falls back to the neutral placeholder and never mounts the live selector when an explicit pick is unusable", () => {
      hasExplicitPick = true;
      scope = hostScopeFixture({
        host: null,
        hosts: [],
        vanishedHostId: "host-gone",
        hostLabel: "host-gone",
        status: "vanished",
        isViewingActive: false,
      });
      cluster = twoSegmentCluster();

      renderIcon();

      expect(useStatusBarRateLimitSegmentsCalled).toBe(false);
      const button = screen.getByTestId("rate-limit-header-button");
      const tracks = within(button).getAllByTestId("rate-limit-bar-track");
      expect(tracks).toHaveLength(2);
      expect(
        within(button).queryAllByTestId("rate-limit-bar-fill"),
      ).toHaveLength(0);
      for (const track of tracks) {
        expect(track.className).toContain("bg-muted-foreground/35");
      }
    });

    // The picker that changes this scope lives INSIDE the popover, so a
    // re-mount here is not a cosmetic flicker: it takes the popover's own
    // `open` state with it and the surface closes the instant someone chooses a
    // host in it — the one interaction the picker exists for. Mounting the
    // scoped `HostRuntimeContext` only when a scoped binding exists did exactly
    // that: the element type at that position changed the moment a pick
    // resolved, so React tore the subtree down and built a new one.
    it("stays open when a pick resolves into its own scoped binding", () => {
      const { rerender } = renderIcon();
      fireEvent.click(screen.getByRole("button", { name: "Usage limits" }));
      expect(screen.getByTestId("rate-limit-popover")).toBeTruthy();

      // Exactly the transition a click in the picker produces: an explicit pick
      // on another host, resolved far enough to have a client of its own — the
      // first scope for which `useScopedHostBinding` returns a binding.
      hasExplicitPick = true;
      scopeClient = SCOPE_CLIENT_STUB;
      scope = hostScopeFixture({
        status: "ready",
        isViewingActive: false,
        hostLabel: "Other Machine",
      });
      rerender(iconTree());

      expect(screen.queryByTestId("rate-limit-popover")).not.toBeNull();
    });

    it("omits the host name from the tooltip while viewing the active host", async () => {
      renderIcon();

      fireEvent.focus(screen.getByRole("button", { name: "Usage limits" }));
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toBe(
        `Usage limits (${formatChordForDisplay("mod+shift+u")})`,
      );
    });

    it("names the host in the tooltip label when not viewing the active host", async () => {
      hasExplicitPick = true;
      scope = hostScopeFixture({
        status: "ready",
        isViewingActive: false,
        hostLabel: "Other Machine",
      });

      renderIcon();

      fireEvent.focus(screen.getByRole("button", { name: "Usage limits" }));
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toBe(
        `Usage limits · Other Machine (${formatChordForDisplay("mod+shift+u")})`,
      );
    });
  });

  describe("accessible name (R1-A3)", () => {
    function twoProviderCluster(): StatusBarRateLimitCluster {
      return segmentsCluster([
        segmentFixture({
          providerId: "codex",
          windows: [
            windowFixture({
              windowKey: "codex:5h",
              usedPercent: 19,
              severity: "healthy",
            }),
          ],
        }),
        segmentFixture({
          providerId: "claude-code",
          windows: [
            windowFixture({
              windowKey: "claude-code:5h",
              usedPercent: 62,
              severity: "healthy",
            }),
          ],
        }),
      ]);
    }

    // The Detailed forms name themselves from their readings.
    it.each(["inline", "rows"] as const)(
      "names populated %s readings from their provider, window and used percentage",
      (form) => {
        cluster = twoProviderCluster();
        render(tree(form));

        expect(
          screen.getByRole("button", {
            name: "Usage limits: Codex 19% used, Claude Code 62% used",
          }),
        ).toBeTruthy();
      },
    );

    it("names an empty readout plainly", () => {
      cluster = { kind: "no-providers" };
      render(tree("rows"));

      expect(screen.getByRole("button", { name: "Usage limits" })).toBeTruthy();
    });

    it("keeps the plain 'Usage limits' name for the glyph form", () => {
      cluster = twoProviderCluster();
      renderIcon();

      expect(screen.getByRole("button", { name: "Usage limits" })).toBeTruthy();
    });
  });

  describe("column overlay placement (D7)", () => {
    it("opens the tooltip toward the content when hosted in a right column", async () => {
      render(
        <ColumnEdgeContext.Provider value="right">
          {iconTree()}
        </ColumnEdgeContext.Provider>,
      );
      fireEvent.focus(screen.getByRole("button", { name: "Usage limits" }));
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.getAttribute("data-side")).toBe("left");
      expect(tooltip.getAttribute("data-align")).toBe("end");
    });

    it("keeps the top-side tooltip outside a column", async () => {
      renderIcon();
      fireEvent.focus(screen.getByRole("button", { name: "Usage limits" }));
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.getAttribute("data-side")).toBe("top");
    });
  });

  // Item 9 of the audit: the tab strip used to read a fixed pair of its own
  // (`useHeaderRateLimitBars`), so Style, Fine-tune, hidden providers, order
  // and limits all did nothing while the reading lived there. `inline` and
  // `readout` now draw through the exact selector and display value the
  // status bar's own cluster does, so what changes one changes both.
  describe("inline form draws the shared readings (G6)", () => {
    function twoSegmentCluster(): StatusBarRateLimitCluster {
      return segmentsCluster([
        segmentFixture({
          providerId: "codex",
          windows: [
            windowFixture({
              windowKey: "codex:5h",
              usedPercent: 70,
              severity: "healthy",
            }),
          ],
        }),
        segmentFixture({
          providerId: "claude-code",
          windows: [
            windowFixture({
              windowKey: "claude-code:5h",
              usedPercent: 40,
              severity: "healthy",
            }),
          ],
        }),
      ]);
    }

    it("renders the profiles' value and mini bar, and honors Percent shows", () => {
      cluster = twoSegmentCluster();
      renderInline();

      // Readings, not the compact icon form: no glyph bar tracks at all here.
      expect(screen.queryByTestId("rate-limit-bar-track")).toBeNull();
      expect(screen.getByTestId("usage-profile-codex:").textContent).toContain(
        "70%",
      );
      expect(
        screen.getByTestId("usage-profile-claude-code:").textContent,
      ).toContain("40%");
      expect(
        screen.getAllByTestId("status-bar-provider-mini-bar"),
      ).toHaveLength(2);

      cleanup();
      useLayoutStore
        .getState()
        .setRegionValues("usageLimits", { amount: "remaining" });
      renderInline();

      expect(screen.getByTestId("usage-profile-codex:").textContent).toContain(
        "30%",
      );
      expect(
        screen.getByRole("button", {
          name: "Usage limits: Codex 30% remaining, Claude Code 60% remaining",
        }),
      ).toBeTruthy();
    });
  });

  describe("button looks per form", () => {
    it.each([
      ["strip", "ghost"],
      ["glyph", "outline"],
      ["readout", "outline"],
      ["tile", "outline"],
    ] as const)("%s draws the glyph in the %s variant", (form, variant) => {
      cluster = { kind: "no-providers" };
      render(tree(form));

      const button = screen.getByTestId("rate-limit-header-button");
      expect(button.getAttribute("data-variant")).toBe(variant);
      expect(within(button).getByTestId("rate-limit-gauge-icon")).toBeTruthy();
    });
  });

  describe("the glyph's bars and limit state", () => {
    const threeDaysAndAHour = () => Date.now() + 73 * 60 * 60 * 1000;

    it("draws the two highest-used windows among the shown profiles", () => {
      cluster = segmentsCluster([
        segmentFixture({
          providerId: "codex",
          windows: [
            windowFixture({
              windowKey: "codex:5h",
              usedPercent: 20,
              severity: "healthy",
            }),
          ],
        }),
        segmentFixture({
          providerId: "claude-code",
          windows: [
            windowFixture({
              windowKey: "claude-code:5h",
              usedPercent: 90,
              severity: "running_low",
            }),
            windowFixture({
              windowKey: "claude-code:weekly",
              usedPercent: 55,
              severity: "healthy",
              label: "Weekly",
            }),
          ],
        }),
      ]);
      renderIcon();

      const fills = within(
        screen.getByTestId("rate-limit-header-button"),
      ).getAllByTestId("rate-limit-bar-fill");
      expect(fills.map((fill) => fill.style.width)).toEqual(["90%", "55%"]);
    });

    it("turns the gauge destructive and prints the short reset when a window is limited", () => {
      cluster = segmentsCluster([
        segmentFixture({
          providerId: "codex",
          windows: [
            windowFixture({
              windowKey: "codex:weekly",
              usedPercent: 100,
              severity: "limited",
              label: "Weekly",
              resetsAt: threeDaysAndAHour(),
            }),
            windowFixture({
              windowKey: "codex:5h",
              usedPercent: 86,
              severity: "running_low",
            }),
          ],
        }),
      ]);
      renderIcon();

      const button = screen.getByTestId("rate-limit-header-button");
      expect(
        within(button)
          .getByTestId("rate-limit-gauge-icon")
          .getAttribute("class"),
      ).toContain("text-destructive");
      const reset = within(button).getByTestId("rate-limit-glyph-reset");
      expect(reset.textContent).toBe("3d");
      expect(reset.className).toContain("text-destructive");
    });

    it("reads the limit off every shown window, not only the two it draws", () => {
      cluster = segmentsCluster([
        segmentFixture({
          providerId: "codex",
          windows: [
            windowFixture({
              windowKey: "codex:a",
              usedPercent: 90,
              severity: "running_low",
            }),
            windowFixture({
              windowKey: "codex:b",
              usedPercent: 80,
              severity: "running_low",
            }),
            windowFixture({
              windowKey: "codex:c",
              usedPercent: 50,
              severity: "limited",
              resetsAt: threeDaysAndAHour(),
            }),
          ],
        }),
      ]);
      renderIcon();

      expect(
        within(screen.getByTestId("rate-limit-header-button")).getAllByTestId(
          "rate-limit-bar-fill",
        ),
      ).toHaveLength(2);
      expect(
        screen.getByTestId("rate-limit-gauge-icon").getAttribute("class"),
      ).toContain("text-destructive");
    });

    it("leaves the gauge and reset alone when nothing is limited", () => {
      cluster = segmentsCluster([
        segmentFixture({
          providerId: "codex",
          windows: [
            windowFixture({
              windowKey: "codex:5h",
              usedPercent: 40,
              severity: "healthy",
              resetsAt: threeDaysAndAHour(),
            }),
          ],
        }),
      ]);
      renderIcon();

      expect(
        screen.getByTestId("rate-limit-gauge-icon").getAttribute("class"),
      ).not.toContain("text-destructive");
      expect(screen.queryByTestId("rate-limit-glyph-reset")).toBeNull();
    });

    it("drops the reset text on the 40px rail tile but keeps the destructive gauge", () => {
      cluster = segmentsCluster([
        segmentFixture({
          providerId: "codex",
          windows: [
            windowFixture({
              windowKey: "codex:weekly",
              usedPercent: 100,
              severity: "limited",
              resetsAt: threeDaysAndAHour(),
            }),
          ],
        }),
      ]);
      render(tree("tile"));

      expect(screen.queryByTestId("rate-limit-glyph-reset")).toBeNull();
      expect(
        screen.getByTestId("rate-limit-gauge-icon").getAttribute("class"),
      ).toContain("text-destructive");
    });
  });

  describe("Detailed in the top strip (inline)", () => {
    function profile(
      providerId: RateLimitProviderId,
      usedPercent: number,
    ): StatusBarProviderSegmentModel {
      return segmentFixture({
        providerId,
        windows: [
          windowFixture({
            windowKey: `${providerId}:5h`,
            usedPercent,
            severity: "healthy",
          }),
        ],
      });
    }

    it("draws at most the two most-used profiles, in profile order, then +N", () => {
      cluster = segmentsCluster([
        profile("codex", 30),
        profile("claude-code", 80),
        profile("cursor", 55),
        profile("grok", 10),
      ]);
      renderInline();

      const drawn = screen
        .getAllByTestId(/^usage-profile-/)
        .map((node) => node.getAttribute("data-testid"));
      // The two highest (claude-code 80, cursor 55), kept in profile order.
      expect(drawn).toEqual([
        "usage-profile-claude-code:",
        "usage-profile-cursor:",
      ]);
      expect(screen.getByTestId("top-strip-usage-more").textContent).toBe("+2");
    });

    it("draws no +N while every profile fits", () => {
      cluster = segmentsCluster([
        profile("codex", 30),
        profile("claude-code", 80),
      ]);
      renderInline();

      expect(screen.getAllByTestId(/^usage-profile-/)).toHaveLength(2);
      expect(screen.queryByTestId("top-strip-usage-more")).toBeNull();
    });

    it("says Limit with the reset for a limited profile", () => {
      cluster = segmentsCluster([
        segmentFixture({
          providerId: "codex",
          windows: [
            windowFixture({
              windowKey: "codex:weekly",
              usedPercent: 100,
              severity: "limited",
              resetsAt: Date.now() + 73 * 60 * 60 * 1000,
            }),
          ],
        }),
      ]);
      renderInline();

      expect(screen.getByTestId("usage-profile-codex:").textContent).toContain(
        "Limitresets 3d",
      );
    });

    it("shows no reset text with Reset time off", () => {
      useLayoutStore
        .getState()
        .setRegionValues("usageLimits", { reset: false });
      cluster = segmentsCluster([
        segmentFixture({
          providerId: "codex",
          windows: [
            windowFixture({
              windowKey: "codex:5h",
              usedPercent: 40,
              severity: "healthy",
              resetsAt: Date.now() + 73 * 60 * 60 * 1000,
            }),
          ],
        }),
      ]);
      renderInline();

      expect(
        screen.getByTestId("usage-profile-codex:").textContent,
      ).not.toContain("3d");
    });
  });

  describe("Detailed in the side strip (rows)", () => {
    it("draws one row per profile in profile order, each over a bar", () => {
      cluster = segmentsCluster([
        segmentFixture({
          providerId: "codex",
          windows: [
            windowFixture({
              windowKey: "codex:5h",
              usedPercent: 30,
              severity: "healthy",
            }),
          ],
        }),
        segmentFixture({
          providerId: "claude-code",
          windows: [
            windowFixture({
              windowKey: "claude-code:5h",
              usedPercent: 100,
              severity: "limited",
            }),
          ],
        }),
        segmentFixture({
          providerId: "cursor",
          windows: [
            windowFixture({
              windowKey: "cursor:5h",
              usedPercent: 60,
              severity: "healthy",
            }),
          ],
        }),
      ]);
      render(tree("rows"));

      // No cap here, and the order is the profile order, not the usage order.
      expect(
        screen
          .getAllByTestId(/^usage-profile-/)
          .map((node) => node.getAttribute("data-testid")),
      ).toEqual([
        "usage-profile-codex:",
        "usage-profile-claude-code:",
        "usage-profile-cursor:",
      ]);
      expect(screen.getAllByTestId("side-strip-usage-bar")).toHaveLength(3);
      expect(
        screen.getByTestId("usage-profile-claude-code:").textContent,
      ).toContain("Limit");
      expect(screen.getByTestId("usage-profile-codex:").textContent).toContain(
        "30%",
      );
      expect(screen.queryByTestId("top-strip-usage-more")).toBeNull();
    });
  });

  // Every form, the phone header's glyph included, owns its own fetching the
  // way the status bar's cluster does: HTTP providers are not in the
  // background poll, and the phone footer is opt-in and off by default, so a
  // glyph that left fetching to the footer read a cold cache (G6 review A).
  // The glyph's own fetch is proven over the real selector in
  // `rate-limit-icon-glyph-fetch.test.tsx`.
  it.each(["tile", "readout", "inline"] as const)(
    "asks the selector for live mode in the %s form",
    (form) => {
      render(tree(form));
      expect(lastMode).toBe("live");
    },
  );

  // The header glyph reads `useSampleScene()` itself (C12) - the same wiring
  // `StatusBarRateLimitCluster` gets from its caller - rather than the
  // sample scene routing through it another way.
  it.each([true, false])(
    "asks the selector for sample readings exactly when inside the sample scene (%s)",
    (inside) => {
      render(
        <SampleSceneContext.Provider value={inside}>
          {iconTree()}
        </SampleSceneContext.Provider>,
      );
      expect(lastSample).toBe(inside);
    },
  );
});
